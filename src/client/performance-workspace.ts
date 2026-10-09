import { control, node, row } from "./feature-dom";
import type { DeviceTools } from "./device-tools";
import type { PerformanceSample } from "../workspace-types";

type Source = { id: string; name: string; tool: DeviceTools };
type Snapshot = DeviceTools["performance"];
const metrics = [
  ["CPU (app)", "cpuPercent", "%", "#7cb7ff"],
  ["Memory (app)", "memoryMb", " MB", "#c9b2ff"],
  ["Frame rate (app)", "appFps", " fps", "#6ee7b7"],
  ["Stream to you", "streamMbps", " Mbps", "#f5b544"],
] as const;
const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const format = (v: unknown, unit: string) => number(v) ? `${Number(v.toFixed(1))}${unit}` : "Unavailable";

/** Reuses the device samplers; opening this view never creates another polling loop. */
export class PerformanceWorkspace {
  readonly root = node("section", "", "workspace-tool-card performance-workspace");
  private readonly body = node("div", "", "performance-body");
  private readonly charts = node("div", "", "performance-devices");
  private readonly quality = node("div", "", "performance-quality-controls");
  private readonly target = node("select", "", "select");
  private readonly status = node("p", "", "performance-status");
  private readonly range = node("select", "", "select");
  private paused: Map<string, Snapshot> | null = null;
  private end = Date.now();
  private sources: Source[] = [];
  private mounted: DeviceTools | null = null;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly lifetime = new AbortController();
  constructor(private readonly getSources: () => Source[], onClose: () => void, onExpand: () => void) {
    this.root.hidden = true;
    this.root.setAttribute("aria-label", "Performance workspace");
    const head = node("header", "", "device-head");
    const expand = control("Expand", onExpand, "Expand performance workspace");
    expand.dataset.toolExpand = "performance";
    expand.setAttribute("aria-pressed", "false");
    head.append(node("strong", "Performance"), node("span", "APP & STREAM", "performance-eyebrow"),
      expand, control("Close", onClose, "Close performance workspace"));
    this.target.setAttribute("aria-label", "Performance device");
    this.range.setAttribute("aria-label", "Performance history window");
    for (const [value, label] of [["60", "Last minute"], ["300", "Last 5 minutes"], ["600", "Last 10 minutes"]]) {
      const option = node("option", label); option.value = value!; this.range.append(option);
    }
    const pause = control("Pause", () => {
      this.paused = this.paused ? null : new Map(this.sources.map(s => [s.id, s.tool.performance]));
      this.end = Date.now();
      pause.textContent = this.paused ? "Resume" : "Pause";
      pause.setAttribute("aria-pressed", String(!!this.paused));
      pause.setAttribute("aria-label", this.paused ? "Resume performance display" : "Pause performance display");
      this.paint();
    }, "Pause performance display");
    pause.setAttribute("aria-pressed", "false");
    const exportButton = control("Export JSON", () => this.export(), "Export performance measurements");
    this.body.append(row(this.target, this.range, pause, exportButton), this.status, this.charts);
    const quality = node("details", "", "performance-quality");
    quality.append(node("summary", "Stream quality · this browser"), this.quality);
    this.body.append(quality);
    this.root.append(head, this.body);
    this.target.addEventListener("change", () => { this.paint(); });
    this.range.addEventListener("change", () => this.paint());
    // Keyboard input here must never reach Android or activate canvas panning.
    this.body.addEventListener("keydown", e => e.stopPropagation());
    this.timer = setInterval(() => { if (!this.root.hidden && !document.hidden) this.paint(); }, 1000);
    window.addEventListener("auth-expired", () => this.destroy(), { signal: this.lifetime.signal });
  }
  open(id?: string): void {
    this.root.hidden = false;
    this.refreshSources(id);
    this.paint();
    this.target.focus({ preventScroll: true });
  }
  close(): void {
    this.root.hidden = true;
    this.mounted?.mountQuality(null);
    this.mounted = null;
  }
  private refreshSources(id?: string): void {
    this.sources = this.getSources();
    const selected = id ?? this.target.value;
    const signature = this.sources.map(s => `${s.id}:${s.name}`).join("|");
    if (this.target.dataset.sources !== signature) {
      this.target.dataset.sources = signature;
      this.target.replaceChildren();
      const all = node("option", "Compare visible devices"); all.value = "*"; this.target.append(all);
      for (const source of this.sources) { const option = node("option", source.name); option.value = source.id; this.target.append(option); }
    }
    this.target.value = this.sources.some(s => s.id === selected) ? selected : "*";
  }
  private snapshot(source: Source): Snapshot | undefined { return this.paused ? this.paused.get(source.id) : source.tool.performance; }
  private history(snapshot: Snapshot): PerformanceSample[] {
    const end = this.paused ? this.end : Date.now();
    return snapshot.samples.filter(s => Date.parse(s.timestamp) >= end - Number(this.range.value) * 1000 && Date.parse(s.timestamp) <= end);
  }
  private paint(): void {
    if (this.root.hidden) return;
    this.refreshSources();
    const selected = this.sources.filter(s => this.target.value === "*" || s.id === this.target.value);
    const tool = this.target.value === "*" ? null : selected[0]?.tool ?? null;
    if (tool !== this.mounted) {
      this.mounted?.mountQuality(null);
      this.mounted = tool;
      this.quality.replaceChildren();
      if (tool) tool.mountQuality(this.quality);
      else this.quality.append(node("p", "Choose one device to adjust its stream. Comparison does not change encoding."));
    }
    if (!tool && !this.quality.childElementCount) this.quality.append(node("p", "Choose one device to adjust its stream."));
    this.status.textContent = `${this.paused ? "Display paused · collection continues" : "Live · up to 10 minutes of session history"} · ${selected.length} device${selected.length === 1 ? "" : "s"}`;
    // Only replace chart content, leaving all interactive controls and their focus intact.
    this.charts.replaceChildren();
    if (!selected.length) this.charts.append(node("p", "Show a connected device to inspect its performance.", "muted"));
    for (const source of selected) {
      const snapshot = this.snapshot(source);
      const block = node("section", "", "performance-device");
      block.dataset.device = source.id;
      block.setAttribute("aria-label", `Performance for ${source.name}`);
      block.append(node("h3", source.name));
      if (!snapshot) { block.append(node("p", "No snapshot for this device. Resume to collect measurements.")); this.charts.append(block); continue; }
      const history = this.history(snapshot);
      const latest = history.at(-1);
      const stale = !snapshot.connected || !!snapshot.error || !latest || (!this.paused && Date.now() - Date.parse(latest.timestamp) > 10000);
      const state = node("p", !snapshot.connected ? "Disconnected · showing retained measurements" : snapshot.error ? `Measurements unavailable: ${snapshot.error}` : !latest ? "Waiting for measurements in this time window" : `${latest.packageName ?? "No foreground app"} · sampled ${new Date(latest.timestamp).toLocaleTimeString()}${stale ? " · stale" : ""}`, "performance-caption");
      state.classList.toggle("unavailable", stale);
      block.append(state);
      const grid = node("div", "", "performance-chart-grid");
      for (const [label, key, unit, color] of metrics) {
        const card = node("section", "", "performance-chart-card");
        card.setAttribute("aria-label", label);
        const values = history.map(s => s[key]).filter(number);
        card.append(node("span", label), node("strong", format(latest?.[key], unit)), this.graph(history, key, color));
        const min = values.length ? Math.min(...values) : null;
        const max = values.length ? Math.max(...values) : null;
        const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
        card.append(node("small", `Chart scale: 0–${format(Math.max(1, ...values), unit)}`));
        card.append(node("small", values.length ? `Min ${format(min, unit)} · Avg ${format(avg, unit)} · Peak ${format(max, unit)}` : "No supported measurements in this window"));
        grid.append(card);
      }
      block.append(grid, node("small", `${new Date((this.paused ? this.end : Date.now()) - Number(this.range.value) * 1000).toLocaleTimeString()} — ${new Date(this.paused ? this.end : Date.now()).toLocaleTimeString()} · ${history.length} samples · gaps indicate missing data`, "performance-axis"));
      const b = snapshot.browser;
      block.append(node("p", b.codec === "h264" ? `H.264 · decoded ${format(b.decodedFps, " fps")} · rendered ${format(b.renderedFps, " fps")} · decode latency ${format(b.decodeLatencyMs, " ms")} · stale frames skipped ${format(b.droppedFraction * 100, "%")}` : "MJPEG · browser decode, bitrate and dropped-frame measurements unavailable", "performance-stream-summary"));
      block.append(node("small", "App frame rate is measured on Android. Decode/render rate and decode latency describe this browser, not app FPS or end-to-end latency. App changes split graph lines; statistics cover the foreground apps observed in this window."));
      if (latest?.unavailable?.length) block.append(node("p", latest.unavailable.join(" · "), "performance-caption unavailable"));
      this.charts.append(block);
    }
  }
  private graph(history: PerformanceSample[], key: typeof metrics[number][1], color: string): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 400 100"); svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("aria-hidden", "true");
    const values = history.map(s => s[key]).filter(number);
    const max = Math.max(1, ...values);
    const end = this.paused ? this.end : Date.now(), span = Number(this.range.value) * 1000;
    let path = "", previous: PerformanceSample | undefined;
    for (const sample of history) {
      const value = sample[key];
      if (!number(value)) { previous = undefined; continue; }
      const continuous = previous && sample.packageName === previous.packageName && Date.parse(sample.timestamp) - Date.parse(previous.timestamp) < 5000;
      const x = (Date.parse(sample.timestamp) - end + span) / span * 400, y = 95 - value / max * 85;
      path += `${continuous ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)} `;
      // A short mark keeps isolated readings visible without fabricating history.
      if (!continuous) path += `l0.1,0 `;
      previous = sample;
    }
    const line = document.createElementNS(svg.namespaceURI, "path");
    line.setAttribute("d", path); line.setAttribute("fill", "none"); line.setAttribute("stroke", color); line.setAttribute("stroke-width", "2"); line.setAttribute("vector-effect", "non-scaling-stroke"); svg.append(line);
    return svg;
  }
  private export(): void {
    const data = this.sources.filter(s => this.target.value === "*" || s.id === this.target.value).map(source => {
      const snapshot = this.snapshot(source);
      return { device: source.id, name: source.name, samples: snapshot ? this.history(snapshot) : [], browser: snapshot?.browser, error: snapshot?.error };
    });
    const url = URL.createObjectURL(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), paused: !!this.paused, windowSeconds: Number(this.range.value), devices: data }, null, 2)], { type: "application/json" }));
    const link = node("a"); link.href = url; link.download = "serve-avd-performance.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  destroy(): void { clearInterval(this.timer); this.close(); this.lifetime.abort(); this.paused = null; this.root.remove(); }
}
