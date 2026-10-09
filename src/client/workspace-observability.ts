import { node, control, field, row, request, errorText } from "./feature-dom";
import type { EventLogEntry } from "../event-log";
import type {
  CaptureArtifact,
  CaptureFormat,
  CrashReport,
  RecordingState,
  WorkspaceState,
} from "../workspace-types";
import type { MacroStep } from "./macro-model";
import { eventsToScript } from "../replay";
import {
  EVENT_COLORS,
  timelineKind,
  selectedEvents,
  rangeToMacro,
  type TimelineKind,
} from "./timeline-model";
import { zipFiles, zipText, downloadBlob, type ZipFile } from "./zip";

export interface ObserverDevice {
  device: string;
  name: string;
  actionEndpoint: string;
  axEndpoint: string;
  screenshotEndpoint: string;
}
interface DeviceDecoration {
  entry: ObserverDevice;
  header: HTMLElement;
  footer: HTMLElement;
  screen: HTMLElement;
  controls: HTMLElement;
  record: HTMLButtonElement;
  crash: HTMLButtonElement;
  alert: HTMLElement;
  state: WorkspaceState | null;
  pending: boolean;
}
export interface ObservabilityOptions {
  capturesRoot: HTMLElement;
  activityRoot: HTMLElement;
  eventsEndpoint?: string;
  onNotice: (message: string) => void;
  onSaveMacro?: (steps: MacroStep[], name: string) => void;
  onOpenCrash?: (serial: string) => void;
  onOpenCaptures?: () => void;
  onOpenActivity?: () => void;
  visibleDevices?: () => string[];
  onChange?: () => void;
  onCrashChange?: (serial: string) => void;
}
function base(entry: ObserverDevice): string {
  return entry.actionEndpoint.replace(/\/action\/?$/, "");
}
function select(
  label: string,
  values: string[],
  current: string,
): HTMLSelectElement {
  const input = node("select");
  input.setAttribute("aria-label", label);
  for (const value of values) {
    const option = node("option", value);
    option.value = value;
    input.append(option);
  }
  input.value = current;
  return input;
}
function check(
  label: string,
  checked: boolean,
  changed: (value: boolean) => void,
): HTMLLabelElement {
  const item = node("label");
  const input = field(label, "", "checkbox");
  input.checked = checked;
  input.addEventListener("change", () => changed(input.checked));
  item.append(input, document.createTextNode(label));
  return item;
}
function button(
  text: string,
  action: () => void,
  label = text,
): HTMLButtonElement {
  const item = control(text, action, label);
  item.className = "observer-button";
  return item;
}
function timestamp(value: string | number): string {
  return new Date(value).toLocaleTimeString([], { hour12: false });
}
function elapsed(start: string): string {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(start)) / 1000),
  );
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Captures, independent crash monitoring, and session timeline share one observed state boundary. */
export class WorkspaceObservability {
  private devices = new Map<string, DeviceDecoration>();
  private retainedNames = new Map<string, string>();
  private retainedCaptures = new Map<
    string,
    { entry: ObserverDevice; captures: CaptureArtifact[] }
  >();
  get counts(): {
    captures: number;
    events: number;
    crashes: number;
    recordings: number;
  } {
    return {
      captures: this.allCaptures().length,
      events: this.events.size,
      crashes: [...this.devices.values()].reduce(
        (n, d) => n + (d.state?.crashes.length ?? 0),
        0,
      ),
      recordings: [...this.devices.values()].filter((d) => d.state?.recording)
        .length,
    };
  }
  private events = new Map<number, EventLogEntry>();
  private selected: string | null = null;
  private captureId: string | null = null;
  private hiddenKinds = new Set<TimelineKind>();
  private range: { start: number; end: number } | null = null;
  private pinned = false;
  private format: "mp4" | "gif" | "webm" = "mp4";
  private maxSeconds = 1800;
  private attachLogs = true;
  private burnKeys = false;
  private polling = false;
  private timer: ReturnType<typeof setInterval>;
  private source: EventSource | null = null;
  private destroyed = false;
  private seenCrashes = new Set<string>();
  constructor(private options: ObservabilityOptions) {
    options.capturesRoot.classList.add("observer-panel");
    options.activityRoot.classList.add("observer-panel");
    this.timer = setInterval(() => {
      void this.refresh();
      this.updateRecordingLabels();
    }, 1000);
    if (options.eventsEndpoint) {
      this.source = new EventSource(options.eventsEndpoint);
      this.source.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as {
            events?: EventLogEntry[];
            event?: EventLogEntry;
          };
          this.acceptEvents(data.events ?? (data.event ? [data.event] : []));
        } catch {}
      };
    }
    this.renderCaptures();
    this.renderTimeline();
  }
  attachDevice(
    entry: ObserverDevice,
    mount: { header: HTMLElement; footer: HTMLElement; screen: HTMLElement },
  ): void {
    this.removeDevice(entry.device);
    const controls = node("div", "", "observer-controls");
    const record = button(
      "○",
      () => void this.toggleRecording(entry.device),
      "Record screen",
    );
    const shot = button(
      "▣",
      () => void this.screenshot(entry.device),
      "Screenshot to captures",
    );
    const crash = button(
      "CRASH",
      () => this.openCrash(entry.device),
      "View crash report",
    );
    crash.classList.add("observer-crash-badge");
    crash.hidden = true;
    controls.append(record, crash);
    mount.header.append(controls);
    const alert = node("div", "", "observer-crash-alert");
    alert.setAttribute("role", "alert");
    alert.hidden = true;
    Object.assign(alert.style, {
      position: "absolute",
      bottom: "8px",
      left: "8px",
      right: "8px",
      zIndex: "7",
    });
    mount.screen.append(alert);
    this.retainedCaptures.delete(entry.device);
    this.devices.set(entry.device, {
      entry,
      ...mount,
      controls,
      record,
      crash,
      alert,
      state: null,
      pending: false,
    });
    this.retainedNames.set(entry.device, entry.name);
    this.selected ??= entry.device;
    void this.refresh();
  }
  removeDevice(serial: string): void {
    const device = this.devices.get(serial);
    if (device?.state)
      this.retainedCaptures.set(serial, {
        entry: device.entry,
        captures: device.state.captures,
      });
    device?.controls.remove();
    device?.alert.remove();
    this.devices.delete(serial);
    this.renderTimeline();
  }
  selectDevice(serial: string): void {
    this.selected = serial;
    this.renderCaptures();
  }
  acceptEvents(entries: EventLogEntry[]): void {
    for (const event of entries) {
      this.events.set(event.id, event);
      if (this.events.size > 5000)
        this.events.delete(this.events.keys().next().value!);
    }
    this.renderTimeline();
    this.options.onChange?.();
  }
  private notice(error: unknown): void {
    this.options.onNotice(errorText(error));
  }
  private async refresh(): Promise<void> {
    if (this.polling || this.destroyed) return;
    this.polling = true;
    let captureChanged = false;
    try {
      await Promise.all(
        [...this.devices.values()].map(async (device) => {
          try {
            const state = await request<WorkspaceState>(
              `${base(device.entry)}/workspace`,
            );
            if (
              !Array.isArray(state.captures) ||
              !Array.isArray(state.crashes) ||
              !Array.isArray(state.builds)
            )
              return;
            if (
              this.destroyed ||
              this.devices.get(device.entry.device) !== device
            )
              return;
            captureChanged ||=
              JSON.stringify(device.state?.captures) !==
                JSON.stringify(state.captures) ||
              JSON.stringify(device.state?.recording) !==
                JSON.stringify(state.recording);
            device.state = state;
            this.options.onChange?.();
            this.updateCrash(device);
          } catch {
            /* Detached/temporarily unavailable devices retain their events. */
          }
        }),
      );
      if (captureChanged) this.renderCaptures();
      this.options.onChange?.();
    } finally {
      this.polling = false;
    }
  }
  private updateRecordingLabels(): void {
    for (const device of this.devices.values()) {
      const rec = device.state?.recording;
      device.record.textContent = rec ? `■ ${elapsed(rec.startedAt)}` : "○";
      device.record.classList.toggle("observer-rec", !!rec);
      device.record.setAttribute(
        "aria-label",
        rec ? "Stop recording" : "Record screen",
      );
      device.record.setAttribute("aria-pressed", String(!!rec));
      device.record.disabled = device.pending;
      device.screen.classList.toggle("recording", !!rec);
    }
  }
  private async post<T>(
    entry: ObserverDevice,
    path: string,
    data: unknown,
  ): Promise<T> {
    return request<T>(`${base(entry)}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  }
  async screenshot(serial: string): Promise<void> {
    const device = this.devices.get(serial);
    if (!device) return;
    try {
      const state = await this.post<WorkspaceState>(
        device.entry,
        "/recording",
        { op: "screenshot" },
      );
      device.state = state;
      this.options.onChange?.();
      this.captureId = state.captures[0]?.id ?? null;
      this.options.onOpenCaptures?.();
      this.renderCaptures();
    } catch (err) {
      this.notice(err);
    }
  }
  private async toggleRecording(serial: string): Promise<void> {
    const device = this.devices.get(serial);
    if (!device || device.pending) return;
    device.pending = true;
    this.updateRecordingLabels();
    try {
      const op = device.state?.recording ? "stop" : "start";
      const state = await this.post<WorkspaceState>(
        device.entry,
        "/recording",
        {
          op,
          format: this.format,
          maxSeconds: this.maxSeconds,
          attachLogs: this.attachLogs,
          burnKeys: this.burnKeys,
        },
      );
      device.state = state;
      this.options.onChange?.();
      if (op === "stop") {
        this.captureId = state.captures[0]?.id ?? null;
        this.options.onOpenCaptures?.();
      }
      this.renderCaptures();
    } catch (err) {
      this.notice(err);
    } finally {
      device.pending = false;
      this.updateRecordingLabels();
    }
  }
  private allCaptures(): { capture: CaptureArtifact; entry: ObserverDevice }[] {
    return [
      ...this.devices.values(),
      ...[...this.retainedCaptures.values()].map((item) => ({
        entry: item.entry,
        state: { captures: item.captures },
      })),
    ]
      .flatMap((device) =>
        (device.state?.captures ?? []).map((capture) => ({
          capture,
          entry: device.entry,
        })),
      )
      .sort(
        (a, b) =>
          Date.parse(b.capture.createdAt) - Date.parse(a.capture.createdAt),
      );
  }
  private renderCaptures(): void {
    const root = this.options.capturesRoot;
    const artifacts = this.allCaptures();
    root.replaceChildren();
    const format = select(
      "Recording format",
      ["mp4", "gif", "webm"],
      this.format,
    );
    format.addEventListener(
      "change",
      () => (this.format = format.value as typeof this.format),
    );
    const length = select(
      "Recording length",
      ["10 s", "30 s", "60 s", "Until stop"],
      this.maxSeconds === 1800 ? "Until stop" : `${this.maxSeconds} s`,
    );
    length.addEventListener(
      "change",
      () =>
        (this.maxSeconds =
          length.value === "Until stop"
            ? 1800
            : Number(length.value.split(" ")[0])),
    );
    const toolbar = node("div", "", "observer-toolbar");
    toolbar.append(
      node("strong", `Captures · ${artifacts.length}`),
      format,
      length,
      check("Burn keys", this.burnKeys, (value) => (this.burnKeys = value)),
      check(
        "Attach logcat",
        this.attachLogs,
        (value) => (this.attachLogs = value),
      ),
      button("Record visible", () => {
        for (const device of this.devices.values())
          if (
            (!this.options.visibleDevices ||
              this.options.visibleDevices().includes(device.entry.device)) &&
            !device.state?.recording
          )
            void this.toggleRecording(device.entry.device);
      }),
      button("Stop all", () => {
        for (const device of this.devices.values())
          if (device.state?.recording)
            void this.toggleRecording(device.entry.device);
      }),
      button("Download all (.zip)", () => void this.downloadCaptures()),
    );
    root.append(
      toolbar,
      node(
        "small",
        "Recording samples the real display at up to 4 fps. Until stop has a 30-minute limit.",
      ),
    );
    const tray = node("div", "", "observer-captures");
    for (const { capture, entry } of artifacts) {
      const item = node("button", "", "capture-item");
      item.type = "button";
      item.classList.toggle("selected", capture.id === this.captureId);
      item.setAttribute(
        "aria-label",
        `${capture.format.toUpperCase()} ${entry.name} ${timestamp(capture.createdAt)}`,
      );
      const url = `${base(entry)}/captures/${capture.id}/file`;
      if (capture.format === "mp4" || capture.format === "webm") {
        const video = node("video");
        video.src = url;
        video.preload = "metadata";
        video.muted = true;
        item.append(video);
      } else {
        const image = node("img");
        image.src = url;
        image.alt = `${entry.name} ${capture.format} capture`;
        item.append(image);
      }
      item.append(
        node("span", entry.name),
        node(
          "small",
          `${capture.format.toUpperCase()} ${capture.duration ? capture.duration.toFixed(1) + "s" : ""} · ${timestamp(capture.createdAt)}`,
        ),
      );
      item.addEventListener("click", () => {
        this.captureId = capture.id;
        this.renderCaptures();
      });
      tray.append(item);
    }
    root.append(tray);
    if (!artifacts.length)
      root.append(
        node("p", "Take a screenshot or record a device to save a capture."),
      );
    const selected = artifacts.find(
      (item) => item.capture.id === this.captureId,
    );
    if (selected)
      this.renderCaptureDetail(root, selected.capture, selected.entry);
  }
  private renderCaptureDetail(
    root: HTMLElement,
    capture: CaptureArtifact,
    entry: ObserverDevice,
  ): void {
    const detail = node("div", "", "capture-detail");
    const url = `${base(entry)}/captures/${capture.id}/file`;
    if (capture.format === "mp4" || capture.format === "webm") {
      const video = node("video");
      video.src = url;
      video.controls = true;
      detail.append(video);
    } else {
      const image = node("img");
      image.src = url;
      image.alt = "Selected capture";
      detail.append(image);
    }
    const form = node("div", "", "capture-detail-form");
    const download = node("a", "Download capture");
    download.href = url;
    download.download = `capture-${entry.device}.${capture.format}`;
    form.append(download);
    if (capture.hasLogs) {
      const logs = node("a", "Attached logcat");
      logs.href = `${base(entry)}/captures/${capture.id}/logs`;
      logs.download = "logcat.txt";
      form.append(logs);
    }
    form.append(
      button("Copy share link", () => {
        void navigator.clipboard
          .writeText(new URL(url, location.href).href)
          .then(
            () =>
              this.options.onNotice(
                "Capture link copied. Opening it requires access to this workspace.",
              ),
            (err) => this.notice(err),
          );
      }),
      button("Open in timeline", () =>
        this.selectRange(
          Date.parse(capture.createdAt),
          Date.parse(capture.createdAt) +
            Math.max(1000, capture.duration * 1000),
        ),
      ),
    );
    if (capture.format !== "png") {
      const start = field("Trim start (seconds)", "0", "number");
      start.min = "0";
      start.max = String(capture.duration);
      start.step = "0.1";
      const end = field(
        "Trim end (seconds)",
        String(capture.duration),
        "number",
      );
      end.min = "0.1";
      end.max = String(capture.duration);
      end.step = "0.1";
      const format = select(
        "Export format",
        ["mp4", "gif", "webm"],
        capture.format,
      );
      let burn = false;
      const exportButton = button("Export trimmed clip", () => {
        exportButton.disabled = true;
        void this.post<{ capture: CaptureArtifact }>(
          entry,
          `/captures/${capture.id}/export`,
          {
            format: format.value,
            trimStart: Number(start.value),
            trimEnd: Number(end.value),
            burnKeys: burn,
          },
        )
          .then((result) => {
            this.captureId = result.capture.id;
            return this.refresh();
          })
          .catch((err) => this.notice(err))
          .finally(() => (exportButton.disabled = false));
      });
      form.append(
        row(node("label", "Start"), start, node("label", "End"), end),
        format,
        check("Burn recorded keys", burn, (value) => (burn = value)),
        exportButton,
      );
    }
    detail.append(form);
    root.append(detail);
  }
  private async fetchFile(
    entry: ObserverDevice,
    capture: CaptureArtifact,
    part: "file" | "logs",
  ): Promise<ZipFile> {
    const response = await fetch(
      `${base(entry)}/captures/${capture.id}/${part}`,
    );
    if (!response.ok)
      throw new Error(`Capture download failed (${response.status})`);
    const data = new Uint8Array(await response.arrayBuffer());
    return {
      name: `captures/${entry.device}/${capture.id}.${part === "logs" ? "log.txt" : capture.format}`,
      data,
    };
  }
  private async downloadCaptures(): Promise<void> {
    try {
      const captures = this.allCaptures();
      if (
        captures.reduce((sum, item) => sum + item.capture.bytes, 0) >
        256 * 1024 * 1024
      )
        throw new Error(
          "Choose fewer captures: ZIP downloads are limited to 256 MB.",
        );
      const files: ZipFile[] = [
        zipText(
          "captures.json",
          captures.map((item) => item.capture),
        ),
      ];
      for (const { capture, entry } of captures) {
        files.push(await this.fetchFile(entry, capture, "file"));
        if (capture.hasLogs)
          files.push(await this.fetchFile(entry, capture, "logs"));
      }
      downloadBlob("serve-avd-captures.zip", zipFiles(files));
    } catch (err) {
      this.notice(err);
    }
  }
  private updateCrash(device: DeviceDecoration): void {
    const crashes = device.state?.crashes ?? [];
    device.crash.hidden = !crashes.length;
    device.crash.textContent = `${crashes.length} CRASH${crashes.length === 1 ? "" : "ES"}`;
    const latest = crashes.at(-1);
    if (!latest || this.seenCrashes.has(latest.id)) return;
    this.seenCrashes.add(latest.id);
    device.alert.hidden = false;
    device.alert.replaceChildren(
      node("strong", `${latest.packageName ?? "App"} crashed`),
      node("span", latest.exception),
      button("View trace", () => this.openCrash(device.entry.device)),
      button("Restart app", () => void this.restartCrash(device.entry, latest)),
      button("Dismiss", () => (device.alert.hidden = true)),
    );
    this.options.onNotice(`${device.entry.name}: ${latest.exception}`);
    this.options.onCrashChange?.(device.entry.device);
  }
  private async restartCrash(
    entry: ObserverDevice,
    crash: CrashReport,
  ): Promise<void> {
    try {
      await this.post(entry, "/crashes", { op: "restart", id: crash.id });
      this.options.onNotice("App restarted");
    } catch (err) {
      this.notice(err);
    }
  }
  private openCrash(serial: string): void {
    this.options.onOpenCrash?.(serial);
    const dialog = node("dialog", "", "observer-panel");
    dialog.style.cssText =
      "width:min(720px,90vw);max-height:80vh;background:#121417;color:#eceef0;border:1px solid #5a2e31";
    dialog.setAttribute("aria-label", "Crash report");
    const content = node("div");
    dialog.append(
      button("Close", () => {
        dialog.close();
        dialog.remove();
      }),
      content,
    );
    this.renderInApp(content, serial);
    document.body.append(dialog);
    dialog.addEventListener("close", () => dialog.remove());
    dialog.showModal();
  }
  renderInApp(root: HTMLElement, serial: string): void {
    const device = this.devices.get(serial);
    const reports = device?.state?.crashes ?? [];
    root.replaceChildren();
    if (!device || !reports.length) {
      root.append(node("p", "No observed crashes on this device."));
      return;
    }
    let index = reports.length - 1;
    let ownOnly = false;
    const render = () => {
      const report = reports[index]!;
      root.replaceChildren();
      const toolbar = node("div", "", "observer-toolbar");
      toolbar.append(
        node("strong", `FATAL · ${report.exception}`),
        node("span", `${index + 1} of ${reports.length}`),
        button(
          "‹",
          () => {
            index = Math.max(0, index - 1);
            render();
          },
          "Previous crash",
        ),
        button(
          "›",
          () => {
            index = Math.min(reports.length - 1, index + 1);
            render();
          },
          "Next crash",
        ),
      );
      root.append(
        toolbar,
        node("p", report.message),
        node(
          "small",
          `${report.device} · ${timestamp(report.timestamp)} · ${report.versionName ?? "version unavailable"} (${report.versionCode ?? "?"}) · thread ${report.thread} · API ${report.apiLevel ?? "?"}`,
        ),
        check("App frames only", ownOnly, (value) => {
          ownOnly = value;
          render();
        }),
      );
      const trace = node("div", "", "observer-crash-detail");
      for (const line of report.lines) {
        const own = !!report.packageName && line.includes(report.packageName);
        if (
          ownOnly &&
          !own &&
          !line.startsWith("Caused by") &&
          !line.includes("Exception")
        )
          continue;
        trace.append(node("div", line, own ? "own-frame" : ""));
      }
      root.append(trace);
      const reportText = `${report.exception}: ${report.message}\n${report.device} ${report.packageName ?? ""} ${report.timestamp}\n${report.lines.join("\n")}\n\nPre-crash logcat:\n${report.logs.join("\n")}`;
      root.append(
        row(
          button(
            "Copy report",
            () =>
              void navigator.clipboard.writeText(reportText).then(
                () => this.options.onNotice("Crash report copied"),
                (err) => this.notice(err),
              ),
          ),
          button("Download .txt", () =>
            downloadBlob(
              `crash-${serial}.txt`,
              new Blob([reportText], { type: "text/plain" }),
            ),
          ),
          button(
            "Restart app",
            () => void this.restartCrash(device.entry, report),
          ),
          button("Open in timeline", () =>
            this.selectRange(
              Date.parse(report.timestamp) - 10_000,
              Date.parse(report.timestamp) + 1000,
            ),
          ),
        ),
      );
    };
    render();
  }
  private selectRange(start: number, end: number): void {
    this.range = { start, end };
    this.pinned = true;
    this.options.onOpenActivity?.();
    this.renderTimeline();
  }
  private renderTimeline(): void {
    const root = this.options.activityRoot;
    const all = [...this.events.values()].sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
    );
    root.replaceChildren();
    const first = all.length ? Date.parse(all[0]!.timestamp) : Date.now();
    const last = all.length ? Date.parse(all.at(-1)!.timestamp) : first + 1000;
    const from = Math.min(first, this.range?.start ?? first),
      to = Math.max(last, this.range?.end ?? last, from + 1000);
    if (!this.pinned) this.range = { start: from, end: to };
    const selection = this.range ?? { start: from, end: to };
    const chosen = selectedEvents(
      all,
      selection.start,
      selection.end,
      this.hiddenKinds,
    );
    const toolbar = node("div", "", "observer-toolbar");
    toolbar.append(
      node("strong", "Activity"),
      node("small", `${timestamp(from)} – ${timestamp(to)}`),
    );
    for (const kind of Object.keys(EVENT_COLORS) as TimelineKind[]) {
      const filter = button(kind, () => {
        this.hiddenKinds.has(kind)
          ? this.hiddenKinds.delete(kind)
          : this.hiddenKinds.add(kind);
        this.renderTimeline();
      });
      filter.setAttribute("aria-pressed", String(!this.hiddenKinds.has(kind)));
      filter.style.borderColor = this.hiddenKinds.has(kind)
        ? "#262a2f"
        : EVENT_COLORS[kind];
      toolbar.append(filter);
    }
    toolbar.append(
      node("span", `${chosen.length} events selected`),
      button("Export repro", () => void this.exportRepro(chosen)),
      button("Save as macro", () => this.saveRange(chosen)),
    );
    root.append(toolbar);
    const start = field("Selection start", String(selection.start), "range"),
      end = field("Selection end", String(selection.end), "range");
    for (const input of [start, end]) {
      input.min = String(from);
      input.max = String(to);
      input.step = "100";
    }
    start.addEventListener("change", () =>
      this.selectRange(
        Math.min(Number(start.value), Number(end.value)),
        Number(end.value),
      ),
    );
    end.addEventListener("change", () =>
      this.selectRange(
        Number(start.value),
        Math.max(Number(start.value), Number(end.value)),
      ),
    );
    root.append(
      row(
        node("label", `Start ${timestamp(selection.start)}`),
        start,
        node("label", `End ${timestamp(selection.end)}`),
        end,
        button("Whole session", () => {
          this.pinned = false;
          this.renderTimeline();
        }),
      ),
    );
    const content = node("div", "", "timeline-content");
    const lanes = node("div", "", "timeline-lanes");
    const ticks = node("div", "", "timeline-ticks");
    for (let i = 0; i < 5; i++)
      ticks.append(node("span", timestamp(from + ((to - from) * i) / 4)));
    lanes.append(ticks);
    const serials = new Set([
      ...this.retainedNames.keys(),
      ...all.map((e) => e.device).filter((id): id is string => !!id),
    ]);
    for (const serial of serials) {
      const lane = node("div", "", "timeline-lane");
      const name = node(
        "div",
        this.retainedNames.get(serial) ?? serial,
        "timeline-lane-name",
      );
      name.append(
        node(
          "small",
          `${serial}${this.devices.has(serial) ? "" : " · disconnected"}`,
        ),
      );
      const track = node("div", "", "timeline-track");
      const shade = node("div", "", "timeline-selection");
      shade.style.left = `${((selection.start - from) / (to - from)) * 100}%`;
      shade.style.width = `${((selection.end - selection.start) / (to - from)) * 100}%`;
      track.append(shade);
      for (const event of all.filter(
        (e) => e.device === serial && !this.hiddenKinds.has(timelineKind(e)),
      )) {
        const mark = button(
          "",
          () =>
            this.selectRange(
              Date.parse(event.timestamp) - 500,
              Date.parse(event.timestamp) + 500,
            ),
          `${timestamp(event.timestamp)} ${event.summary}`,
        );
        mark.title = `${timestamp(event.timestamp)} ${event.summary}`;
        mark.className = `timeline-mark ${timelineKind(event)}`;
        mark.style.left = `${((Date.parse(event.timestamp) - from) / (to - from)) * 100}%`;
        mark.style.background = EVENT_COLORS[timelineKind(event)];
        track.append(mark);
      }
      lane.append(name, track);
      lanes.append(lane);
    }
    const list = node("ol", "", "timeline-list");
    list.setAttribute("aria-label", "Selected events");
    for (const event of chosen) {
      const item = node("li");
      const dot = node("span", "", "timeline-event-dot");
      dot.style.background = EVENT_COLORS[timelineKind(event)];
      item.append(
        node("time", timestamp(event.timestamp)),
        dot,
        node(
          "span",
          `${this.retainedNames.get(event.device ?? "") ?? event.device ?? "Server"} · ${event.summary}`,
        ),
      );
      list.append(item);
    }
    content.append(lanes, list);
    root.append(content);
    if (!all.length)
      root.append(
        node(
          "p",
          "Device input, settings, installs, captures and crashes appear here as they happen.",
        ),
      );
  }
  private saveRange(events: EventLogEntry[]): void {
    const serial = this.selected ?? events.find((e) => e.device)?.device;
    if (!serial) {
      this.options.onNotice("Select a device with replayable input.");
      return;
    }
    const { steps, excluded } = rangeToMacro(events, serial);
    if (!steps.length) {
      this.options.onNotice(
        "The selected device has no replayable input in this range.",
      );
      return;
    }
    const name = window.prompt(
      "Macro name",
      `Activity ${timestamp(this.range?.start ?? Date.now())}`,
    );
    if (!name?.trim()) return;
    this.options.onSaveMacro?.(steps, name.trim());
    this.options.onNotice(
      `Saved ${steps.length} steps for ${this.retainedNames.get(serial) ?? serial}. Excluded ${excluded} settings, artifacts, and other-device events.`,
    );
  }
  private async exportRepro(events: EventLogEntry[]): Promise<void> {
    try {
      const files: ZipFile[] = [
        zipText("events.json", events),
        zipText("range.json", {
          ...this.range,
          hiddenKinds: [...this.hiddenKinds],
        }),
      ];
      const serials = [
        ...new Set(
          events.map((e) => e.device).filter((id): id is string => !!id),
        ),
      ];
      const context: unknown[] = [];
      for (const serial of serials) {
        const device = this.devices.get(serial);
        files.push(
          zipText(
            `replay/${serial}.json`,
            eventsToScript(
              events.filter((e) => e.device === serial),
              { device: serial, name: "Activity reproduction" },
            ),
          ),
        );
        if (device) {
          const apps = await request(`${base(device.entry)}/apps`).catch(
            () => ({ unavailable: true }),
          );
          const state = device.state;
          context.push({
            device: device.entry,
            apps,
            crashes: state?.crashes.filter((c) =>
              events.some((e) => e.details?.crashId === c.id),
            ),
          });
          const query = new URLSearchParams({
            start: String(this.range?.start ?? 0),
            end: String(this.range?.end ?? Date.now()),
          });
          const logs = await request(
            `${base(device.entry)}/log-history?${query}`,
          ).catch(() => ({ unavailable: true }));
          files.push(zipText(`logs/${serial}.json`, logs));
        }
      }
      files.push(zipText("context.json", context));
      let bytes = 0;
      for (const { capture, entry } of this.allCaptures().filter((item) =>
        events.some((event) => event.details?.captureId === item.capture.id),
      )) {
        bytes += capture.bytes;
        if (bytes > 128 * 1024 * 1024) {
          files.push(
            zipText(
              "omitted-captures.txt",
              "Related media exceeded 128 MB. Download remaining captures from the workspace.",
            ),
          );
          break;
        }
        files.push(await this.fetchFile(entry, capture, "file"));
        if (capture.hasLogs)
          files.push(await this.fetchFile(entry, capture, "logs"));
      }
      files.push(
        zipText(
          "README.txt",
          `serve-avd reproduction\n\nSelected interval: ${new Date(this.range?.start ?? 0).toISOString()} to ${new Date(this.range?.end ?? Date.now()).toISOString()}\nHidden event kinds: ${[...this.hiddenKinds].join(", ") || "none"}\n\nFor each device, replay inputs and supported settings with:\n  serve-avd replay replay/<device>.json -d <target-device>\n\nInstall the same app build/version from context.json before replay. Artifacts and crashes are evidence, not executable steps. Captures and available logcat are included. Authorization is required to access original workspace links.\n`,
        ),
      );
      downloadBlob("serve-avd-repro.zip", zipFiles(files));
    } catch (err) {
      this.notice(err);
    }
  }
  destroy(): void {
    this.destroyed = true;
    clearInterval(this.timer);
    this.source?.close();
    for (const device of this.devices.values()) {
      device.controls.remove();
      device.alert.remove();
    }
    this.devices.clear();
  }
}
