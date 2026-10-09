import type { AxNode, AxBounds } from "../ax";
import type { PerformanceSample, StreamQuality } from "../workspace-types";
import {
  control,
  errorText,
  helperBase,
  node,
  readSaved,
  request,
  row,
  saveItems,
  type FeatureDevice,
} from "./feature-dom";
export interface FocusObservation {
  node: AxNode;
  key: string;
}
/** Only a genuinely focused AX node proves a focus position. */
export function focusedNode(root: AxNode | null): FocusObservation | null {
  if (!root) return null;
  if (
    root.focused &&
    root.bounds &&
    root.bounds.right > root.bounds.left &&
    root.bounds.bottom > root.bounds.top
  )
    return {
      node: root,
      key: JSON.stringify([
        root.resourceId,
        root.class,
        root.text,
        root.bounds,
      ]),
    };
  for (const child of root.children ?? []) {
    const found = focusedNode(child);
    if (found) return found;
  }
  return null;
}
export function focusRect(
  bounds: AxBounds,
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number } | null {
  if (!(width > 0 && height > 0)) return null;
  const left = Math.max(0, Math.min(width, bounds.left)),
    top = Math.max(0, Math.min(height, bounds.top));
  const right = Math.max(left, Math.min(width, bounds.right)),
    bottom = Math.max(top, Math.min(height, bounds.bottom));
  if (right === left || bottom === top) return null;
  return {
    left: (left / width) * 100,
    top: (top / height) * 100,
    width: ((right - left) / width) * 100,
    height: ((bottom - top) / height) * 100,
  };
}
export function adaptiveQuality(
  current: StreamQuality,
  latencyMs: number,
  dropped: number,
): StreamQuality {
  if (!current.adaptive || !(latencyMs > 180 || dropped > 0.15)) return current;
  const resolutions: StreamQuality["resolution"][] = [
    "native",
    "1080p",
    "720p",
    "540p",
  ];
  const index = resolutions.indexOf(current.resolution);
  if (index < resolutions.length - 1)
    return {
      ...current,
      resolution: resolutions[index + 1]!,
      bitRateMbps: Math.max(1, current.bitRateMbps * 0.7),
    };
  return {
    ...current,
    fps: current.fps === 60 ? 30 : 15,
    bitRateMbps: Math.max(1, current.bitRateMbps * 0.7),
  };
}
export interface BrowserMetrics {
  decodeLatencyMs: number;
  decodedFps: number;
  renderedFps: number;
  droppedFraction: number;
  streamMbps: number;
  codec: "h264" | "mjpeg";
}
interface ToolsConfig {
  device: FeatureDevice;
  header: HTMLElement;
  footer: HTMLElement;
  screen: HTMLElement;
  storageKey: string;
  screenSize: () => { width: number; height: number };
  browserMetrics: () => BrowserMetrics;
  onQuality: (quality: StreamQuality) => void;
  onPerformance: () => void;
}
export class DeviceTools {
  private readonly focusToggle: HTMLButtonElement;
  private readonly focusLayer = node("div", "", "device-focus-layer");
  private readonly focusOptions = node("div", "", "device-focus-options");
  private readonly focusInfo = node("div", "", "device-focus-info");
  private readonly qualityToggle: HTMLButtonElement;
  private readonly metrics = node("div", "", "device-performance");
  private readonly qualityPanel = node("div", "", "device-quality-panel");
  private readonly performanceDetail = node(
    "details",
    "",
    "device-performance-detail",
  );
  private readonly detailBody = node("div");
  private readonly samples: PerformanceSample[] = [];
  private metricError = "";
  private qualityHost: HTMLElement | null = null;
  private readonly trail: FocusObservation[] = [];
  private current: FocusObservation | null = null;
  private pendingDirection: { key: string; before: string | null } | null =
    null;
  private unchanged = 0;
  private lastDirection = "";
  private lastCodec = "";
  private qualityApplied = false;
  private deadEnds = 0;
  private moves = 0;
  private lost = 0;
  private focusOn = false;
  private outline = true;
  private showTrail = true;
  private showInfo = true;
  private destroyed = false;
  private readonly abort = new AbortController();
  private busyFocus = false;
  private busyMetrics = false;
  private timer: ReturnType<typeof setInterval>;
  private lastAdaptive = 0;
  private quality: StreamQuality;
  constructor(private readonly config: ToolsConfig) {
    const saved = readSaved<Partial<StreamQuality>>(config.storageKey, {});
    this.quality = {
      resolution: ["native", "1080p", "720p", "540p"].includes(
        saved.resolution ?? "",
      )
        ? saved.resolution!
        : "native",
      fps: [15, 30, 60].includes(saved.fps ?? 0) ? saved.fps! : 30,
      bitRateMbps:
        typeof saved.bitRateMbps === "number" &&
        saved.bitRateMbps >= 1 &&
        saved.bitRateMbps <= 12
          ? saved.bitRateMbps
          : 4,
      adaptive: saved.adaptive === true,
    };
    this.focusToggle = control(
      "◎",
      () => {
        this.focusOn = !this.focusOn;
        this.focusToggle.setAttribute("aria-pressed", String(this.focusOn));
        this.focusLayer.hidden = this.focusOptions.hidden = !this.focusOn;
        if (this.focusOn) void this.refreshFocus();
      },
      `Focus overlay for ${config.device.entry.name}`,
    );
    this.focusToggle.className = "btn small device-focus-overlay-toggle";
    this.focusToggle.title = "Show D-pad focus";
    this.focusToggle.setAttribute("aria-pressed", "false");
    config.header.append(this.focusToggle);
    for (const [label, key] of [
      ["Outline", "outline"],
      ["Trail", "showTrail"],
      ["View info", "showInfo"],
    ] as const) {
      const button = control(label, () => {
        this[key] = !this[key];
        button.setAttribute("aria-pressed", String(this[key]));
        this.paintFocus();
      });
      button.setAttribute("aria-pressed", "true");
      this.focusOptions.append(button);
    }
    this.focusLayer.hidden = this.focusOptions.hidden = true;
    this.focusLayer.append(this.focusInfo);
    config.screen.append(this.focusLayer, this.focusOptions);
    this.qualityToggle = control(
      "",
      () => {
        this.qualityPanel.hidden = !this.qualityPanel.hidden;
        this.qualityToggle.setAttribute(
          "aria-expanded",
          String(!this.qualityPanel.hidden),
        );
      },
      `Stream quality for ${config.device.entry.name}`,
    );
    this.qualityToggle.setAttribute("aria-expanded", "false");
    this.qualityToggle.className = "btn small device-quality-toggle";
    this.qualityPanel.hidden = true;
    this.qualityPanel.setAttribute("role", "dialog");
    this.qualityPanel.setAttribute(
      "aria-label",
      `Stream quality for ${config.device.entry.name}`,
    );
    this.performanceDetail.append(
      node("summary", "Performance"),
      control("Open performance workspace", config.onPerformance),
      this.detailBody,
    );
    config.footer.append(
      this.metrics,
      this.qualityToggle,
      this.performanceDetail,
    );
    config.screen.parentElement?.append(this.qualityPanel);
    this.qualityApplied = Object.keys(saved).length > 0;
    this.renderQuality();
    if (this.qualityApplied) config.onQuality(this.quality);
    this.timer = setInterval(() => {
      if (this.destroyed || document.hidden || !config.device.connected) return;
      if (this.focusOn) void this.refreshFocus();
      void this.refreshMetrics();
      this.adapt();
      const codec = this.config.browserMetrics().codec;
      if (codec !== this.lastCodec) {
        this.lastCodec = codec;
        this.renderQuality();
      }
    }, 1000);
    void this.refreshMetrics();
  }
  observeInput(tag: number, body: Record<string, unknown>): void {
    if (!this.focusOn) return;
    const button =
      tag === 4
        ? String(body.button)
        : tag === 6 && body.type === "down"
          ? String(body.code)
          : "";
    if (
      ![
        "dpad-up",
        "dpad-down",
        "dpad-left",
        "dpad-right",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
      ].includes(button)
    )
      return;
    this.pendingDirection = { key: button, before: this.current?.key ?? null };
    window.setTimeout(() => void this.refreshFocus(), 160);
  }
  private async refreshFocus(): Promise<void> {
    if (
      this.busyFocus ||
      this.destroyed ||
      !this.focusOn ||
      !this.config.device.connected
    )
      return;
    this.busyFocus = true;
    const pendingAtRequest = this.pendingDirection;
    try {
      const dump = await request<{ root: AxNode | null }>(
        this.config.device.entry.axEndpoint,
        { signal: this.abort.signal },
      );
      if (this.destroyed || !this.focusOn) return;
      const current = focusedNode(dump.root);
      const changed = current?.key !== this.current?.key;
      if (changed && current) {
        this.trail.push(current);
        if (this.trail.length > 6) this.trail.shift();
        this.moves++;
        this.unchanged = 0;
      }
      if (!current && this.current) this.lost++;
      if (this.pendingDirection && this.pendingDirection === pendingAtRequest) {
        if (current && this.pendingDirection.before === current.key) {
          this.unchanged =
            this.lastDirection === this.pendingDirection.key
              ? this.unchanged + 1
              : 1;
          this.lastDirection = this.pendingDirection.key;
          if (this.unchanged === 3) this.deadEnds++;
        } else this.unchanged = 0;
        this.pendingDirection = null;
      }
      this.current = current;
      this.paintFocus();
    } catch (error) {
      if (!this.destroyed) {
        this.focusInfo.textContent = `Focus data unavailable: ${errorText(error)}`;
        this.focusInfo.classList.add("unavailable");
        this.focusLayer
          .querySelectorAll(".device-focus-box")
          .forEach((item) => item.remove());
      }
    } finally {
      this.busyFocus = false;
    }
  }
  private paintFocus(): void {
    this.focusLayer
      .querySelectorAll(".device-focus-box")
      .forEach((item) => item.remove());
    const size = this.config.screenSize();
    const paint = (
      observation: FocusObservation,
      index: number,
      old: boolean,
    ) => {
      const rect = focusRect(observation.node.bounds!, size.width, size.height);
      if (!rect) return;
      const box = node("div", old ? String(index) : "", "device-focus-box");
      box.classList.toggle("trail", old);
      for (const [key, value] of Object.entries(rect))
        box.style.setProperty(key, `${value}%`);
      this.focusLayer.prepend(box);
    };
    if (this.showTrail)
      this.trail
        .slice(0, -1)
        .forEach((item, index) => paint(item, index + 1, true));
    if (this.outline && this.current) paint(this.current, 0, false);
    this.focusInfo.hidden = !this.showInfo;
    this.focusInfo.classList.remove("unavailable");
    this.focusInfo.classList.toggle("warning", this.unchanged >= 3);
    if (!this.current) {
      this.focusInfo.textContent = `No focused view observed · ${this.moves} moves · ${this.lost} focus lost`;
      return;
    }
    const item = this.current.node;
    this.focusInfo.textContent = `${item.text ?? item.contentDesc ?? item.class ?? "Focused view"}\n${item.resourceId ?? "No resource ID"} · ${item.class ?? ""}\n[${item.bounds!.left},${item.bounds!.top}]–[${item.bounds!.right},${item.bounds!.bottom}] · ${this.moves} moves · ${this.deadEnds} dead ends · ${this.lost} lost${this.unchanged >= 3 ? `\n${this.lastDirection} did not move focus after ${this.unchanged} attempts.` : ""}`;
  }
  get performance() {
    return { samples: [...this.samples], browser: { ...this.config.browserMetrics() },
      error: this.metricError, connected: this.config.device.connected };
  }
  mountQuality(host: HTMLElement | null): void {
    this.qualityHost = host;
    this.renderQuality();
  }
  private renderQuality(panel: HTMLElement = this.qualityPanel, expanded = false): void {
    const supported = this.config.browserMetrics().codec === "h264";
    this.qualityToggle.textContent = supported
      ? `${this.quality.resolution === "native" ? "Native" : this.quality.resolution} · ${this.quality.fps}${this.quality.adaptive ? " · Auto" : ""}`
      : "MJPEG";
    panel.replaceChildren(
      node("strong", "Stream quality"),
      node(
        "small",
        this.qualityApplied
          ? "Applied profile"
          : "Default stream · change a control to apply a profile",
      ),
      node(
        "small",
        supported
          ? "This browser · H.264 encoder"
          : "MJPEG fallback · encoder quality controls unavailable",
      ),
    );
    if (!expanded) panel.append(control("Close", () => {
      this.qualityPanel.hidden = true;
      this.qualityToggle.setAttribute("aria-expanded", "false");
    }));
    const auto = node("input");
    auto.type = "checkbox";
    auto.checked = this.quality.adaptive;
    auto.disabled = !supported;
    auto.addEventListener("change", () =>
      this.changeQuality({ ...this.quality, adaptive: auto.checked }),
    );
    const label = node("label", "Adapt to my connection");
    label.prepend(auto);
    panel.append(label);
    for (const [title, key, values] of [
      ["Resolution", "resolution", ["native", "1080p", "720p", "540p"]],
      ["Max frame rate", "fps", ["15", "30", "60"]],
    ] as const) {
      const select = node("select", "", "select");
      select.setAttribute(
        "aria-label",
        `${title} for ${this.config.device.entry.name}`,
      );
      for (const value of values) {
        const option = node("option", value === "native" ? "Native" : value);
        option.value = value;
        select.append(option);
      }
      select.value = String(this.quality[key]);
      select.disabled = this.quality.adaptive || !supported;
      select.addEventListener("change", () =>
        this.changeQuality({
          ...this.quality,
          [key]: key === "fps" ? Number(select.value) : select.value,
        } as StreamQuality),
      );
      panel.append(row(node("span", title), select));
    }
    const bitrate = node("input");
    bitrate.type = "range";
    bitrate.min = "1";
    bitrate.max = "12";
    bitrate.value = String(this.quality.bitRateMbps);
    bitrate.setAttribute(
      "aria-label",
      `Max bitrate for ${this.config.device.entry.name}`,
    );
    bitrate.disabled = this.quality.adaptive || !supported;
    bitrate.addEventListener("change", () =>
      this.changeQuality({
        ...this.quality,
        bitRateMbps: Number(bitrate.value),
      }),
    );
    panel.append(
      node("span", `Max bitrate ${this.quality.bitRateMbps.toFixed(1)} Mbps`),
      bitrate,
      node(
        "small",
        "H.265 and AV1 are unavailable. MJPEG fallback keeps its existing encoding.",
      ),
    );
    if (!expanded && this.qualityHost) this.renderQuality(this.qualityHost, true);
  }
  private changeQuality(quality: StreamQuality): void {
    this.quality = quality;
    this.qualityApplied = true;
    saveItems(this.config.storageKey, quality);
    this.renderQuality();
    this.config.onQuality(quality);
  }
  private adapt(): void {
    const now = Date.now();
    if (now - this.lastAdaptive < 10000) return;
    const metric = this.config.browserMetrics();
    if (metric.codec !== "h264" || metric.decodedFps === 0) return;
    const quality = adaptiveQuality(
      this.quality,
      metric.decodeLatencyMs,
      metric.droppedFraction,
    );
    if (quality !== this.quality) {
      this.lastAdaptive = now;
      this.changeQuality(quality);
    }
  }
  private async refreshMetrics(): Promise<void> {
    if (this.busyMetrics || this.destroyed) return;
    this.busyMetrics = true;
    try {
      let sample = await request<PerformanceSample>(
        `${helperBase(this.config.device)}/metrics`,
        { signal: this.abort.signal },
      );
      if (this.destroyed) return;
      if (!Number.isFinite(Date.parse(sample.timestamp))) throw new Error("No measurements received");
      this.metricError = "";
      const browser = this.config.browserMetrics();
      sample = {
        ...sample,
        streamMbps: browser.codec === "h264" ? browser.streamMbps : NaN,
      };
      // The server may return its cached app sample between collection passes.
      if (this.samples.at(-1)?.timestamp === sample.timestamp) this.samples[this.samples.length - 1] = sample;
      else this.samples.push(sample);
      if (this.samples.length > 600) this.samples.shift();
      this.paintMetrics(sample);
    } catch (error) {
      this.metricError = errorText(error);
      if (!this.destroyed) {
        this.metrics.textContent = "Performance unavailable";
        this.metrics.classList.add("unavailable");
      }
    } finally {
      this.busyMetrics = false;
    }
  }
  private paintMetrics(sample: PerformanceSample): void {
    const delivered = this.config.browserMetrics();
    sample = {
      ...sample,
      streamMbps: delivered.codec === "h264" ? delivered.streamMbps : NaN,
    };
    this.metrics.classList.remove("unavailable");
    this.metrics.replaceChildren();
    this.detailBody.replaceChildren();
    const browser = this.config.browserMetrics();
    const readings: Array<[string, keyof PerformanceSample, string, string]> = [
      ["CPU", "cpuPercent", "%", "#7cb7ff"],
      ["MEM", "memoryMb", " MB", "#c9b2ff"],
      ["APP FPS", "appFps", "", "#6ee7b7"],
      ["NET", "streamMbps", " Mb", "#f5b544"],
    ];
    for (const [label, key, unit, color] of readings) {
      const value = sample[key];
      const item = node("span", "", "device-metric");
      const values = this.samples
        .map((item) => item[key])
        .filter(
          (value): value is number =>
            typeof value === "number" && Number.isFinite(value),
        );
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 40 16");
      svg.setAttribute("aria-hidden", "true");
      const line = document.createElementNS(svg.namespaceURI, "polyline");
      const max = Math.max(1, ...values);
      line.setAttribute(
        "points",
        values
          .map(
            (value, index) =>
              `${(index / Math.max(1, values.length - 1)) * 40},${16 - (value / max) * 14}`,
          )
          .join(" "),
      );
      line.setAttribute("fill", "none");
      line.setAttribute("stroke", color);
      line.setAttribute("stroke-width", "1.5");
      svg.append(line);
      item.append(
        node("span", label),
        svg,
        node(
          "span",
          typeof value === "number" && Number.isFinite(value)
            ? `${Number(value.toFixed(1))}${unit}`
            : "—",
        ),
      );
      item.title =
        typeof value === "number" && Number.isFinite(value)
          ? `${label} measured for ${sample.packageName ?? "device"}`
          : `${label} unavailable`;
      this.metrics.append(item);
      this.detailBody.append(
        row(
          node("span", label),
          node(
            "span",
            typeof value === "number" && Number.isFinite(value)
              ? `${Number(value.toFixed(1))}${unit}`
              : "Unavailable",
          ),
        ),
      );
    }
    this.detailBody.append(
      node(
        "small",
        `${sample.packageName ?? "No foreground app"} · ${new Date(sample.timestamp).toLocaleTimeString()}`,
      ),
      node(
        "small",
        `${browser.codec === "h264" ? "H.264" : "MJPEG"} · decoded ${browser.decodedFps} fps · rendered ${browser.renderedFps} fps · decode latency ${Math.round(browser.decodeLatencyMs)} ms · ${(browser.droppedFraction * 100).toFixed(1)}% stale frames skipped`,
      ),
    );
    if (sample.unavailable?.length)
      this.detailBody.append(node("small", sample.unavailable.join(" · ")));
  }
  destroy(): void {
    this.destroyed = true;
    this.qualityHost = null;
    clearInterval(this.timer);
    this.abort.abort();
    this.focusLayer.remove();
    this.focusOptions.remove();
    this.focusToggle.remove();
    this.qualityToggle.remove();
    this.qualityPanel.remove();
    this.metrics.remove();
    this.performanceDetail.remove();
  }
}
