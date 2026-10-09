/** Parse the server's `logcat -v time` stream and common threadtime/brief formats. */
export interface LogRecord {
  line: string; level: string; time: string; tag: string; message: string; pid: number | null; count: number;
}
export const logLevels: Record<string, number> = { V: 1, D: 2, I: 3, W: 4, E: 5, F: 6, A: 6 };
export function parseLogcat(line: string): LogRecord {
  line = line.slice(0, 16_384);
  const thread = /^(\d{2}-\d{2}\s+(\d{2}:\d{2}:\d{2}\.\d+))\s+(\d+)\s+\d+\s+([VDIWEFA])\s+([^:]+):\s?(.*)$/.exec(line);
  const timed = /^(\d{2}-\d{2}\s+(\d{2}:\d{2}:\d{2}\.\d+))\s+([VDIWEFA])\/([^(:]+)\(\s*(\d+)\s*\):\s?(.*)$/.exec(line);
  const brief = /^([VDIWEFA])\/([^(:]+)(?:\(\s*(\d+)\s*\))?:\s?(.*)$/.exec(line);
  return { line, level: thread?.[4] ?? timed?.[3] ?? brief?.[1] ?? "",
    time: thread?.[2] ?? timed?.[2] ?? "", tag: (thread?.[5] ?? timed?.[4] ?? brief?.[2] ?? "").trim(),
    message: thread?.[6] ?? timed?.[6] ?? brief?.[4] ?? line,
    pid: thread ? Number(thread[3]) : timed ? Number(timed[5]) : brief?.[3] ? Number(brief[3]) : null, count: 1 };
}

export interface LogcatState { filter: string; minimum: number; paused: boolean; appOnly: boolean }
export const createLogcatState = (): LogcatState => ({ filter: "", minimum: 1, paused: false, appOnly: false });

export class LogBuffer {
  readonly records: LogRecord[] = [];
  constructor(private limit = 1_000) {}
  push(line: string): void {
    const next = parseLogcat(line), last = this.records.at(-1);
    if (last && last.level === next.level && last.pid === next.pid && last.tag === next.tag && last.message === next.message) {
      last.count++;
      last.time = next.time;
      last.line = next.line;
    } else {
      this.records.push(next);
      if (this.records.length > this.limit) this.records.splice(0, this.records.length - this.limit);
    }
  }
  clear(): void { this.records.length = 0; }
  visible(state: LogcatState, pid: number | null): LogRecord[] {
    const query = state.filter.trim().toLowerCase();
    return this.records.filter(record => (!query || record.line.toLowerCase().includes(query)) &&
      (record.level ? (logLevels[record.level] ?? 0) >= state.minimum : state.minimum <= 1) &&
      (!state.appOnly || (pid !== null && record.pid === pid)));
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
}

/** Owns one selected device's stream, foreground lookup and rendered log list. */
export class WorkspaceLogcat {
  readonly root = element("div", "logs");
  private buffer = new LogBuffer();
  private source: EventSource;
  private lifetime = new AbortController();
  private destroyed = false;
  private frame: number | null = null;
  private timer: number;
  private foregroundRequest: AbortController | null = null;
  private foregroundGeneration = 0;
  private pid: number | null = null;
  private foregroundLabel = "Finding foreground app…";
  private streamStatus = "Connecting…";
  private list = element("div", "log-lines");
  private count = element("span", "log-count", "Waiting for logs…");
  private appButton: HTMLButtonElement;
  private levelButtons = new Map<number, HTMLButtonElement>();

  constructor(private target: { name: string; logsEndpoint: string; foregroundEndpoint: string },
    private state: LogcatState, private onSeverity: (count: number, level: string) => void) {
    const button = (text: string, label: string, action: () => void) => {
      const node = element("button", "btn", text); node.type = "button"; node.setAttribute("aria-label", label);
      node.title = label; node.addEventListener("click", action, { signal: this.lifetime.signal }); return node;
    };
    const filter = element("input", "input"); filter.type = "search"; filter.placeholder = "Filter logcat…";
    filter.setAttribute("aria-label", "Filter Logcat"); filter.value = state.filter;
    filter.addEventListener("input", () => { state.filter = filter.value; this.schedule(); }, { signal: this.lifetime.signal });
    const pause = button(state.paused ? "Resume" : "Pause", "Pause/resume the log stream", () => {
      state.paused = !state.paused; pause.textContent = state.paused ? "Resume" : "Pause";
      pause.setAttribute("aria-pressed", String(state.paused));
    });
    pause.setAttribute("aria-pressed", String(state.paused));
    const clear = button("Clear", "Clear displayed logs", () => { this.buffer.clear(); this.schedule(); });
    const toolbar = element("div", "logs-toolbar"); toolbar.append(pause, clear);
    const head = element("div", "logs-head"); head.append(filter, toolbar);
    const controls = element("div", "logcat-controls"), levels = element("div", "logcat-levels");
    levels.setAttribute("role", "group"); levels.setAttribute("aria-label", "Minimum log level");
    levels.append(element("span", "muted logcat-level-label", "Min level"));
    for (const [level, value] of Object.entries(logLevels).slice(0, 5)) {
      const node = button(level, `Minimum log level ${level}`, () => { state.minimum = value; this.schedule(); });
      node.classList.add(`log-level-${level.toLowerCase()}`); this.levelButtons.set(value, node); levels.append(node);
    }
    this.appButton = button("App only", "App only", () => {
      state.appOnly = !state.appOnly;
      if (state.appOnly) { this.pid = null; this.foregroundLabel = "Finding foreground app…"; void this.refreshForeground(); }
      else { this.foregroundGeneration++; this.foregroundRequest?.abort(); this.foregroundRequest = null; }
      this.schedule();
    });
    this.appButton.setAttribute("role", "switch"); controls.append(levels, this.appButton);
    this.list.setAttribute("role", "log"); this.list.setAttribute("aria-label", `Logcat for ${target.name}`);
    this.root.append(head, controls, this.list, this.count);
    this.source = new EventSource(target.logsEndpoint);
    this.source.onopen = () => { if (!this.destroyed) { this.streamStatus = "Live"; this.schedule(); } };
    this.source.onerror = () => { if (!this.destroyed) { this.streamStatus = "Reconnecting…"; this.schedule(); } };
    this.source.onmessage = event => {
      if (this.destroyed || state.paused) return;
      try {
        const data = JSON.parse(event.data);
        if (typeof data.line !== "string") return;
        this.buffer.push(data.line); this.schedule();
      } catch { /* Malformed log messages do not interrupt the stream. */ }
    };
    this.timer = window.setInterval(() => { if (state.appOnly && !document.hidden) void this.refreshForeground(); }, 2_000);
    if (state.appOnly) void this.refreshForeground();
    this.render();
  }

  private async refreshForeground(): Promise<void> {
    if (this.destroyed || this.foregroundRequest) return;
    const generation = ++this.foregroundGeneration;
    const request = new AbortController(); this.foregroundRequest = request;
    try {
      const response = await fetch(this.target.foregroundEndpoint, { signal: request.signal });
      if (!response.ok) throw new Error("Foreground app unavailable");
      const app = await response.json() as { pid?: number; packageName?: string } | null;
      if (this.destroyed || generation !== this.foregroundGeneration) return;
      this.pid = Number.isSafeInteger(app?.pid) && app!.pid! > 0 ? app!.pid! : null;
      this.foregroundLabel = this.pid === null ? "Foreground app PID unavailable" : `Showing ${app?.packageName ?? "foreground app"} (PID ${this.pid})`;
    } catch {
      if (this.destroyed || generation !== this.foregroundGeneration) return;
      this.pid = null; this.foregroundLabel = "Foreground app unavailable";
    } finally {
      if (generation === this.foregroundGeneration) { this.foregroundRequest = null; this.schedule(); }
    }
  }

  private schedule(): void {
    if (this.destroyed || this.frame !== null) return;
    this.frame = requestAnimationFrame(() => { this.frame = null; this.render(); });
  }

  private render(): void {
    const visible = this.buffer.visible(this.state, this.pid), fragment = document.createDocumentFragment();
    const follow = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 32;
    let severity = "", severityCount = 0;
    for (const record of visible) {
      const row = element("div", `log-line log-level-${record.level.toLowerCase() || "unknown"}`);
      row.title = record.line;
      if (record.level) {
        const content = element("span", "log-content"), tag = element("span", "log-tag", record.tag);
        content.append(tag);
        if (record.count > 1) content.append(element("span", "log-repeat", `×${record.count}`));
        content.append(element("span", "log-message", record.message));
        row.append(element("span", "log-time", record.time), element("span", "log-level", record.level), content);
      } else { row.classList.add("log-unparsed"); row.textContent = record.message; }
      fragment.append(row);
      if ((logLevels[record.level] ?? 0) >= 4) {
        severityCount += record.count;
        if ((logLevels[record.level] ?? 0) > (logLevels[severity] ?? 0)) severity = record.level;
      }
    }
    this.list.replaceChildren(fragment);
    if (follow) this.list.scrollTop = this.list.scrollHeight;
    this.count.textContent = `${this.streamStatus} · ${visible.length} of ${this.buffer.records.length} rows${this.state.appOnly ? ` · ${this.foregroundLabel}` : ""}`;
    this.appButton.setAttribute("aria-checked", String(this.state.appOnly)); this.appButton.title = this.state.appOnly ? this.foregroundLabel : "Show only the foreground app's process";
    this.levelButtons.forEach((button, value) => button.setAttribute("aria-pressed", String(value === this.state.minimum)));
    this.onSeverity(severityCount, severity);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.foregroundGeneration++;
    this.source.onmessage = null; this.source.onopen = null; this.source.onerror = null; this.source.close(); this.foregroundRequest?.abort();
    clearInterval(this.timer); if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.lifetime.abort(); this.buffer.clear();
  }
}
