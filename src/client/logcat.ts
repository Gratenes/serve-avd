import { Compartment, EditorState, StateEffect, StateField, type ChangeSpec, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, lineNumbers, type DecorationSet } from "@codemirror/view";
import { search, searchKeymap } from "@codemirror/search";

/** Parse the server's `logcat -v time` stream and common threadtime/brief formats. */
export interface LogRecord {
  line: string; level: string; time: string; tag: string; message: string; pid: number | null; count: number;
}
export const logLevels: Record<string, number> = { V: 1, D: 2, I: 3, W: 4, E: 5, F: 6, A: 6 };
export function parseLogcat(line: string): LogRecord {
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
  readonly raw: LogRecord[] = [];
  constructor(private limit = 1_000) {}
  push(line: string): void {
    const next = parseLogcat(line), last = this.records.at(-1);
    this.raw.push({ ...next });
    if (this.raw.length > this.limit * 5) this.raw.splice(0, this.raw.length - this.limit * 5);
    if (last && last.level === next.level && last.pid === next.pid && last.tag === next.tag && last.message === next.message) {
      last.count++;
      last.time = next.time;
      last.line = next.line;
    } else {
      this.records.push(next);
      if (this.records.length > this.limit) this.records.splice(0, this.records.length - this.limit);
    }
  }
  clear(): void { this.records.length = 0; this.raw.length = 0; }
  visible(state: LogcatState, pid: number | null, records = this.records): LogRecord[] {
    const query = state.filter.trim().toLowerCase();
    return records.filter(record => (!query || record.line.toLowerCase().includes(query)) &&
      (record.level ? (logLevels[record.level] ?? 0) >= state.minimum : state.minimum <= 1) &&
      (!state.appOnly || (pid !== null && record.pid === pid)));
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
}

class RepeatCount extends WidgetType {
  constructor(private count: number) { super(); }
  eq(other: RepeatCount): boolean { return other.count === this.count; }
  toDOM(): HTMLElement { return element("span", "log-repeat", `×${this.count}`); }
}

class EntryAction extends WidgetType {
  constructor(private record: LogRecord, private inspect: (record: LogRecord) => void) { super(); }
  eq(other: EntryAction): boolean { return other.record === this.record; }
  toDOM(): HTMLElement {
    const button = element("button", "log-inspect", "↗"); button.type = "button";
    button.setAttribute("aria-label", "View full log entry"); button.title = "View and copy full log entry";
    button.addEventListener("click", () => this.inspect(this.record)); return button;
  }
}

const readerEntries = StateEffect.define<DecorationSet>();
const entriesField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(readerEntries)) return effect.value;
    return value.map(transaction.changes);
  },
  provide: field => EditorView.decorations.from(field),
});

/** CodeMirror owns layout, selection, viewport rendering and the single scrollport. */
class LogReader {
  readonly view: EditorView;
  private wrapping = new Compartment();
  private previous: { record: LogRecord; line: string }[] = [];
  private following: boolean;
  private destroyed = false;
  private measureKey = {};

  constructor(parent: HTMLElement, label: string, private onFollow: (following: boolean) => void,
    private inspect?: (record: LogRecord) => void, private live = true) {
    this.following = live;
    this.view = new EditorView({ parent, state: EditorState.create({ extensions: [
      EditorState.readOnly.of(true), EditorView.editable.of(false),
      EditorView.contentAttributes.of({ "aria-label": label, "aria-readonly": "true", "aria-multiline": "true", role: "textbox", tabindex: "0" }),
      this.wrapping.of(EditorView.lineWrapping), entriesField, lineNumbers(),
      search({ top: true }), keymap.of([{ key: "Mod-a", run: view => {
        view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }); return true;
      } }, ...searchKeymap]),
      EditorView.theme({
        "&": { height: "100%", fontSize: "12px", backgroundColor: "#0e0f12", color: "#d6d9df" },
        ".cm-scroller": { overflow: "auto", fontFamily: "var(--mono, monospace)", lineHeight: "1.8" },
        ".cm-content": { padding: "8px 0", caretColor: "transparent" },
        ".cm-line": { padding: "0 10px" },
        ".cm-gutters": { backgroundColor: "#0e0f12", color: "#7c838b", borderRight: "1px solid #262a2f" },
        ".cm-gutterElement": { padding: "0 3px" },
        ".cm-panels": { backgroundColor: "#171b20", color: "#d6d9df" },
        ".cm-searchMatch": { backgroundColor: "#66531a" },
        ".cm-searchMatch-selected": { backgroundColor: "#866f2b" },
        "&.cm-focused": { outline: "none" },
      }, { dark: true }),
    ] }) });
    this.view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    // Editor and search shortcuts must not also control the device behind the reader.
    this.view.dom.addEventListener("keydown", event => event.stopPropagation());
  }

  private onScroll = (): void => {
    if (!this.live) return;
    const scroll = this.view.scrollDOM;
    const following = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 24;
    if (following !== this.following) { this.following = following; this.onFollow(following); }
  };

  setWrapped(wrapped: boolean): void {
    this.view.dispatch({ effects: this.wrapping.reconfigure(wrapped ? EditorView.lineWrapping : []) });
    if (wrapped) this.view.scrollDOM.scrollLeft = 0;
    if (this.following) this.jumpToLatest();
  }

  jumpToLatest(): void {
    this.following = true; this.onFollow(true);
    this.queueTail();
  }

  private queueTail(): void {
    // Scrolling to a document position also reveals its horizontal coordinate.
    // Follow only the vertical axis, after CodeMirror measures the new document.
    this.view.requestMeasure({ key: this.measureKey, read: view => view.scrollDOM.scrollHeight,
      write: height => { if (this.following && !this.destroyed) this.view.scrollDOM.scrollTop = height; } });
  }

  update(records: LogRecord[], query = "", grouped = true): void {
    const oldText = this.view.state.doc.toString(), text = records.map(record => record.line).join("\n");
    // Removing a bounded buffer's oldest entries is a separate change. That lets
    // CodeMirror map a reader's selection and viewport to the surviving text.
    let removed = 0;
    const overlap = records.length ? this.previous.findIndex(item => item.record === records[0]) : -1;
    if (overlap > 0 && records.slice(0, Math.min(records.length, this.previous.length - overlap))
      .every((record, index) => this.previous[overlap + index]?.record === record)) {
      removed = this.previous.slice(0, overlap).reduce((length, item) => length + item.line.length + 1, 0);
    }
    const remaining = oldText.slice(removed);
    let prefix = 0, suffix = 0;
    while (prefix < Math.min(remaining.length, text.length) && remaining[prefix] === text[prefix]) prefix++;
    while (suffix < Math.min(remaining.length, text.length) - prefix &&
      remaining[remaining.length - suffix - 1] === text[text.length - suffix - 1]) suffix++;
    const changes: ChangeSpec[] = [];
    if (removed) changes.push({ from: 0, to: removed });
    if (remaining !== text) changes.push({ from: removed + prefix, to: oldText.length - suffix,
      insert: text.slice(prefix, text.length - suffix) });
    const decorations: Range<Decoration>[] = [];
    const needle = query.trim().toLowerCase();
    let position = 0;
    for (const record of records) {
      decorations.push(Decoration.line({ attributes: { class: `log-line log-level-${record.level.toLowerCase() || "unknown"}` } }).range(position));
      if (this.inspect) decorations.push(Decoration.widget({ widget: new EntryAction(record, this.inspect), side: -1 }).range(position));
      if (grouped && record.count > 1) decorations.push(Decoration.widget({ widget: new RepeatCount(record.count), side: 1 }).range(position + record.line.length));
      if (needle) {
        const line = record.line.toLowerCase();
        for (let at = line.indexOf(needle); at >= 0; at = line.indexOf(needle, at + needle.length))
          decorations.push(Decoration.mark({ class: "log-match" }).range(position + at, position + at + needle.length));
      }
      position += record.line.length + 1;
    }
    const horizontal = this.view.scrollDOM.scrollLeft;
    this.view.dispatch({ changes, effects: readerEntries.of(Decoration.set(decorations, true)) });
    this.view.scrollDOM.scrollLeft = horizontal;
    this.previous = records.map(record => ({ record, line: record.line }));
    if (this.following) this.queueTail();
  }

  remeasure(): void { this.view.requestMeasure(); }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.view.scrollDOM.removeEventListener("scroll", this.onScroll); this.view.destroy();
  }
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
  private reader: LogReader;
  private empty = element("div", "log-empty");
  private followButton: HTMLButtonElement;
  private count = element("span", "log-count", "Waiting for logs…");
  private appButton: HTMLButtonElement;
  private pausedRecords: LogRecord[] | null = null;
  private pausedRaw: LogRecord[] | null = null;
  private detail = element("section", "log-entry-detail");
  private feedback = element("span", "log-feedback");
  private dialog: HTMLDialogElement | null = null;
  private placeholder: Comment | null = null;
  private expandButton!: HTMLButtonElement;
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
      this.pausedRecords = state.paused ? this.buffer.records.map(record => ({ ...record })) : null;
      this.pausedRaw = state.paused ? [...this.buffer.raw] : null;
      this.schedule();
    });
    pause.setAttribute("aria-pressed", String(state.paused));
    const clear = button("Clear", "Clear displayed logs", () => {
      this.buffer.clear(); this.pausedRecords = state.paused ? [] : null;
      this.pausedRaw = state.paused ? [] : null; this.detail.hidden = true; this.schedule();
    });
    const toolbar = element("div", "logs-toolbar"); toolbar.append(pause, clear);
    const actions = element("div", "logcat-actions");
    const wrap = button("Wrap lines", "Wrap log lines", () => {
      const wrapped = !this.root.classList.toggle("logs-nowrap");
      wrap.setAttribute("aria-pressed", String(wrapped));
      this.reader.setWrapped(wrapped);
    });
    wrap.setAttribute("aria-pressed", "true");
    const raw = button("Raw", "Show raw log lines", () => {
      const enabled = this.root.classList.toggle("logs-raw");
      raw.setAttribute("aria-pressed", String(enabled)); this.schedule();
    });
    raw.setAttribute("aria-pressed", "false");
    this.expandButton = button("Expand", "Expand log viewer", () => this.toggleExpanded());
    this.followButton = button("Following latest", "Jump to latest logs", () => this.reader.jumpToLatest());
    this.followButton.setAttribute("aria-pressed", "true");
    actions.append(wrap, raw, this.followButton,
      button("Copy", "Copy filtered logs", () => void this.copy(this.exportText())),
      button("Download", "Download filtered logs", () => {
        const url = URL.createObjectURL(new Blob([this.exportText()], { type: "text/plain;charset=utf-8" }));
        const link = element("a", ""); link.href = url; link.download = "logcat.txt"; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }), this.expandButton);
    const heading = element("div", "logcat-heading");
    heading.append(element("strong", "", "Device logs"), element("span", "muted", target.name));
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
    this.list.setAttribute("aria-live", "off");
    this.reader = new LogReader(this.list, `Log text for ${target.name}`, following => {
      this.followButton.textContent = following ? "Following latest" : "Jump to latest";
      this.followButton.setAttribute("aria-pressed", String(following));
    }, record => this.showEntry(record));
    this.list.append(this.empty);
    this.detail.hidden = true;
    this.feedback.setAttribute("role", "status");
    this.root.append(heading, head, controls, actions, this.list, this.detail, this.count, this.feedback);
    if (state.paused) { this.pausedRecords = []; this.pausedRaw = []; }
    this.source = new EventSource(target.logsEndpoint);
    this.source.onopen = () => { if (!this.destroyed) { this.streamStatus = "Live"; this.schedule(); } };
    this.source.onerror = () => { if (!this.destroyed) { this.streamStatus = "Reconnecting…"; this.schedule(); } };
    this.source.onmessage = event => {
      if (this.destroyed) return;
      try {
        const data = JSON.parse(event.data);
        if (typeof data.line !== "string") return;
        this.buffer.push(data.line); if (!state.paused) this.schedule();
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
    const records = this.root.classList.contains("logs-raw")
      ? this.pausedRaw ?? this.buffer.raw : this.pausedRecords ?? this.buffer.records;
    const visible = this.buffer.visible(this.state, this.pid, records);
    let severity = "", severityCount = 0;
    for (const record of visible) {
      if ((logLevels[record.level] ?? 0) >= 4) {
        severityCount += record.count;
        if ((logLevels[record.level] ?? 0) > (logLevels[severity] ?? 0)) severity = record.level;
      }
    }
    this.reader.update(visible, this.state.filter, !this.root.classList.contains("logs-raw"));
    this.empty.hidden = visible.length > 0;
    this.empty.textContent = records.length ? "No matching logs. Adjust the search, level or App only filter." : "Waiting for device logs…";
    this.count.textContent = `${this.state.paused ? "Paused display · still collecting" : this.streamStatus} · ${visible.length} of ${records.length} entries${this.state.appOnly ? ` · ${this.foregroundLabel}` : ""}`;
    this.appButton.setAttribute("aria-checked", String(this.state.appOnly)); this.appButton.title = this.state.appOnly ? this.foregroundLabel : "Show only the foreground app's process";
    this.levelButtons.forEach((button, value) => button.setAttribute("aria-pressed", String(value === this.state.minimum)));
    this.onSeverity(severityCount, severity);
  }

  private exportText(): string {
    return this.buffer.visible(this.state, this.pid, this.pausedRaw ?? this.buffer.raw).map(record => record.line).join("\n");
  }

  private async copy(text: string): Promise<void> {
    try { await navigator.clipboard.writeText(text); this.feedback.textContent = "Copied logs"; }
    catch { this.feedback.textContent = "Copy unavailable. Select the log text or download it instead."; }
  }

  private showEntry(record: LogRecord): void {
    const header = element("div", "log-entry-heading");
    const copy = element("button", "btn", "Copy entry"); copy.type = "button";
    copy.addEventListener("click", () => void this.copy(record.line));
    const close = element("button", "btn", "Close entry"); close.type = "button";
    close.addEventListener("click", () => { this.detail.hidden = true; });
    header.append(element("strong", "", "Full log entry"), copy, close);
    const text = element("pre", "", record.line); text.tabIndex = 0;
    this.detail.replaceChildren(header, text); this.detail.hidden = false;
  }

  private toggleExpanded(): void {
    if (this.dialog) { this.closeExpanded(); return; }
    this.placeholder = document.createComment("log-viewer"); this.root.before(this.placeholder);
    const dialog = element("dialog", "logcat-dialog"); dialog.setAttribute("aria-label", `Device logs for ${this.target.name}`);
    this.dialog = dialog; document.body.append(dialog); dialog.append(this.root);
    this.expandButton.textContent = "Collapse"; this.expandButton.setAttribute("aria-label", "Collapse log viewer");
    dialog.addEventListener("cancel", event => { event.preventDefault(); this.closeExpanded(); });
    dialog.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); this.closeExpanded(); }
    });
    dialog.showModal();
    this.reader.remeasure();
  }

  private closeExpanded(): void {
    if (!this.dialog) return;
    this.placeholder?.replaceWith(this.root); this.placeholder = null;
    this.dialog.close(); this.dialog.remove(); this.dialog = null;
    this.reader.remeasure();
    this.expandButton.textContent = "Expand"; this.expandButton.setAttribute("aria-label", "Expand log viewer");
    this.expandButton.focus();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.closeExpanded();
    this.destroyed = true; this.foregroundGeneration++;
    this.source.onmessage = null; this.source.onopen = null; this.source.onerror = null; this.source.close(); this.foregroundRequest?.abort();
    clearInterval(this.timer); if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.lifetime.abort(); this.reader.destroy(); this.buffer.clear();
  }
}

/** Read the actual attached log artifact without navigating away from the video. */
export async function openLogFile(title: string, url: string): Promise<void> {
  const dialog = element('dialog', 'logcat-dialog saved-log-dialog');
  dialog.setAttribute('aria-label', title);
  const header = element('div', 'log-entry-heading');
  const close = element('button', 'btn', 'Close logs'); close.type = 'button';
  const controller = new AbortController();
  let reader: LogReader;
  const dismiss = () => { controller.abort(); reader.destroy(); dialog.close(); dialog.remove(); };
  close.addEventListener('click', dismiss);
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  const filter = element('input', 'input'); filter.type = 'search'; filter.placeholder = 'Search attached logs…'; filter.setAttribute('aria-label', 'Search attached logs');
  const content = element('div', 'saved-log-content');
  const status = element('div', 'log-empty', 'Loading logs…');
  const count = element('span', 'log-count');
  const copy = element('button', 'btn', 'Copy logs'); copy.type = 'button'; copy.disabled = true;
  const download = element('a', 'btn', 'Download .txt'); download.href = url; download.download = 'logcat.txt';
  const wrap = element('button', 'btn', 'Wrap lines'); wrap.type = 'button'; wrap.setAttribute('aria-label', 'Wrap attached log lines');
  let wrapped = true; wrap.setAttribute('aria-pressed', 'true');
  wrap.addEventListener('click', () => { wrapped = !wrapped; wrap.setAttribute('aria-pressed', String(wrapped)); reader.setWrapped(wrapped); });
  header.append(element('strong', '', title), wrap, copy, download, close);
  dialog.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); dismiss(); } });
  dialog.append(header, filter, content, count); document.body.append(dialog); dialog.showModal();
  reader = new LogReader(content, 'Attached log text', () => {}, undefined, false); content.append(status);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Could not load logs (${response.status})`);
    const text = await response.text();
    if (controller.signal.aborted) return;
    const lines = text ? text.replace(/\n$/, '').split('\n').map(line => parseLogcat(line)) : [];
    let filtered = text;
    const render = () => {
      const query = filter.value.toLowerCase();
      const selected = lines.filter(record => record.line.toLowerCase().includes(query));
      filtered = selected.map(record => record.line).join('\n'); reader.update(selected, query, false);
      reader.view.scrollDOM.scrollTop = 0;
      status.hidden = selected.length > 0;
      status.textContent = lines.length ? 'No matching logs.' : 'No logs were captured during this interval.';
      count.textContent = `${selected.length} of ${lines.length} lines`; copy.disabled = !selected.length;
    };
    filter.addEventListener('input', render);
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(filtered).then(() => { count.textContent = 'Copied logs'; }, () => { count.textContent = 'Select the text or download it to copy logs.'; });
    });
    render();
  } catch (error) { if (!controller.signal.aborted) status.textContent = error instanceof Error ? error.message : String(error); }
}
