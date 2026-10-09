import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, statSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { startNativeRecording, type NativeRecording, type RecordingPart } from "./native-recording";
import { adbExecOut } from "./adb";
import {
  subscribeEventLog,
  recordEventLogEvent,
  type EventLogEntry,
} from "./event-log";
import type {
  CaptureArtifact,
  RecordingState,
} from "./workspace-types";

export const MAX_RECORDING_SECONDS = 1800;
export const MAX_CAPTURE_BYTES = 256 * 1024 * 1024;
export function videoFormat(value: unknown): "mp4" | "webm" | "gif" {
  if (value === undefined) return "mp4";
  if (value === "mp4" || value === "webm" || value === "gif") return value;
  throw new Error("Format must be mp4, webm or gif");
}
export function encodingArgs(format: "mp4" | "webm" | "gif"): string[] {
  return format === "mp4"
    ? [
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
      ]
    : format === "webm"
      ? [
          "-c:v",
          "libvpx-vp9",
          "-deadline",
          "realtime",
          "-cpu-used",
          "8",
          "-b:v",
          "2M",
        ]
      : ["-loop", "0"];
}
export function ffmpeg(args: string[], timeout = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.SERVE_AVD_FFMPEG || "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-y", ...args],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let error = "";
    child.stderr.on("data", (chunk) => (error = (error + chunk).slice(-4000)));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    timer.unref();
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg unavailable: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(new Error(error || `ffmpeg exited ${code}`));
    });
  });
}
export function keySubtitles(
  events: EventLogEntry[],
  start: number,
  end: number,
): string {
  const stamp = (ms: number) => {
    const t = Math.max(0, Math.floor(ms / 10));
    return `${Math.floor(t / 360000)}:${String(Math.floor(t / 6000) % 60).padStart(2, "0")}:${String(Math.floor(t / 100) % 60).padStart(2, "0")}.${String(t % 100).padStart(2, "0")}`;
  };
  const keys = events.filter(
    (e) =>
      ["key", "button"].includes(e.kind) &&
      Date.parse(e.timestamp) >= start &&
      Date.parse(e.timestamp) <= end,
  );
  return (
    "[Script Info]\nScriptType: v4.00+\nPlayResX: 1280\nPlayResY: 720\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,DejaVu Sans,28,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,3,2,0,2,20,20,28,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
    keys
      .map(
        (e) =>
          `Dialogue: 0,${stamp(Date.parse(e.timestamp) - start)},${stamp(Math.min(end, Date.parse(e.timestamp) + 900) - start)},Default,,0,0,0,,${e.summary.replace(/[{}\\\r\n]/g, " ").slice(0, 120)}`,
      )
      .join("\n")
  );
}
interface VideoProbe {
  format: { duration?: string };
  streams: { codec_type: string; width?: number; height?: number; avg_frame_rate?: string; duration?: string }[];
}
function probeVideo(path: string): Promise<VideoProbe> {
  return new Promise((resolve, reject) =>
    execFile(process.env.SERVE_AVD_FFPROBE || "ffprobe",
      ["-v", "error", "-show_format", "-show_streams", "-of", "json", path],
      { timeout: 10_000 }, (err, out) => {
        if (err) return reject(new Error(`Unable to verify recorded video: ${err.message}`));
        try { resolve(JSON.parse(out)); } catch (error) { reject(error); }
      }));
}
interface ActiveRecording {
  state: RecordingState;
  native: NativeRecording;
  output: string;
  stopping: boolean;
  logs: boolean;
  burn: boolean;
  timer: ReturnType<typeof setTimeout>;
  events: EventLogEntry[];
  unsubscribe: () => void;
}
export class DeviceMedia {
  readonly captures: CaptureArtifact[] = [];
  private active: ActiveRecording | null = null;
  private starting = false;
  private closed = false;
  recordingError: string | null = null;
  private pendingNative: NativeRecording | null = null;
  private stopPromise: Promise<CaptureArtifact> | null = null;
  constructor(
    private serial: string,
    private dir: string,
    private logs: (
      start: number,
      end: number,
    ) => { at: number; line: string }[],
    private screenshot: () => Promise<Buffer> = () =>
      adbExecOut(serial, ["screencap", "-p"], { timeout: 10_000 }),
    private recordNative = startNativeRecording,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  get recording(): RecordingState | null {
    return this.active?.state ?? null;
  }
  path(id: string, part: "file" | "logs" | "keys" = "file"): string {
    const artifact = this.captures.find((c) => c.id === id);
    if (!artifact) throw new Error("Capture not found");
    return join(
      this.dir,
      `${id}.${part === "file" ? artifact.format : part === "logs" ? "log.txt" : "keys.json"}`,
    );
  }
  sharedFile(id: string): { path: string; format: string } | null {
    const capture = this.captures.find(item => item.id === id);
    return !this.closed && capture ? { path: this.path(id), format: capture.format } : null;
  }
  private add(artifact: CaptureArtifact): CaptureArtifact {
    this.captures.unshift(artifact);
    let total = this.captures.reduce((n, c) => n + c.bytes, 0);
    while (this.captures.length > 30 || total > 512 * 1024 * 1024) {
      const old = this.captures.pop()!;
      total -= old.bytes;
      for (const suffix of [old.format, "log.txt", "keys.json"]) {
        try {
          unlinkSync(join(this.dir, `${old.id}.${suffix}`));
        } catch {}
      }
    }
    return artifact;
  }
  async shot(): Promise<CaptureArtifact> {
    const data = await this.screenshot();
    const id = randomUUID();
    writeFileSync(join(this.dir, `${id}.png`), data, { mode: 0o600 });
    const artifact = this.add({
      id,
      device: this.serial,
      name: this.serial,
      createdAt: new Date().toISOString(),
      duration: 0,
      format: "png",
      bytes: data.length,
      hasLogs: false,
      hasKeys: false,
    });
    recordEventLogEvent({
      device: this.serial,
      source: "ui",
      kind: "capture",
      summary: "Screenshot",
      details: { captureId: id },
    });
    return artifact;
  }
  async start(
    options: {
      format?: unknown;
      maxSeconds?: unknown;
      attachLogs?: boolean;
      burnKeys?: boolean;
    } = {},
    authorized: () => boolean = () => true,
  ): Promise<RecordingState> {
    if (this.active || this.starting)
      throw new Error("Recording is already running");
    const format = videoFormat(options.format);
    const duration = Number(options.maxSeconds ?? MAX_RECORDING_SECONDS);
    if (
      !Number.isFinite(duration) ||
      duration < 1 ||
      duration > MAX_RECORDING_SECONDS
    )
      throw new Error("Recording length must be 1–1800 seconds");
    if (this.closed) throw new Error("Device session is closed");
    this.starting = true;
    this.recordingError = null;
    const id = randomUUID();
    const output = join(this.dir, `${id}.mp4`);
    const native = this.recordNative(this.serial, this.dir, id, duration, MAX_CAPTURE_BYTES);
    this.pendingNative = native;
    try {
      await native.ready;
      if (!authorized() || this.closed) throw new Error("Device session closed or authorization expired");
    } catch (error) {
      native.abort();
      this.recordingError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.starting = false;
      this.pendingNative = null;
    }
    const active: ActiveRecording = {
      state: { id, startedAt: new Date().toISOString(), format, maxSeconds: duration, captureFps: 60 },
      native, output, stopping: false,
      logs: options.attachLogs !== false, burn: options.burnKeys === true,
      events: [], unsubscribe: () => {},
      timer: setTimeout(() => void this.stop().catch(() => {}), duration * 1000),
    };
    active.timer.unref();
    this.active = active;
    active.unsubscribe = subscribeEventLog(event => {
      if (event.device === this.serial && active.events.length < 10_000) active.events.push(event);
    });
    // Auto-stop and device failures take the same finalization/error path as Stop.
    void native.done.then(
      () => { if (this.active === active && !active.stopping) void this.stop().catch(() => {}); },
      () => { if (this.active === active && !active.stopping) void this.stop().catch(() => {}); },
    );
    recordEventLogEvent({
      device: this.serial,
      source: "ui",
      kind: "capture",
      summary: `Recording started (${format.toUpperCase()})`,
      details: { captureId: id },
    });
    return active.state;
  }
  stop(): Promise<CaptureArtifact> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.finish().finally(() => (this.stopPromise = null));
    return this.stopPromise;
  }
  private async finish(): Promise<CaptureArtifact> {
    const active = this.active;
    if (!active) throw new Error("No active recording");
    active.stopping = true;
    clearTimeout(active.timer);
    let end = Date.now();
    let parts: RecordingPart[] = [];
    const normalized: string[] = [];
    try {
      await active.native.stop();
      parts = await active.native.done;
      const lastPart = parts.at(-1);
      if (lastPart) end = Math.min(end, lastPart.startedAt + lastPart.duration * 1000);
      if (this.closed) throw new Error("Device session closed during recording");
      // Native screenrecord emits frames only when Android redraws. Preserve its
      // timestamps, then hold the last frame through the real recording interval.
      // A completely static Android clip has one frame with zero sample duration;
      // only that case needs an input frame rate to make ffmpeg decode the sample.
      let geometry: { width: number; height: number } | undefined;
      for (const [index, part] of parts.entries()) {
        const source = await probeVideo(part.path);
        const stream = source.streams.find(item => item.codec_type === "video");
        if (!stream?.width || !stream.height) throw new Error("Android recording has no video stream");
        geometry ??= { width: stream.width, height: stream.height };
        const next = parts[index + 1];
        const segmentEnd = next ? next.startedAt : Math.min(end, part.startedAt + part.duration * 1000);
        const duration = Math.max(1 / 60, (segmentEnd - part.startedAt) / 1000);
        const path = join(this.dir, `${active.state.id}-normalized-${index}.mp4`);
        normalized.push(path);
        const filter = `scale=${geometry.width}:${geometry.height}:force_original_aspect_ratio=decrease,pad=${geometry.width}:${geometry.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=stop_mode=clone:stop_duration=${duration},fps=60`;
        const staticClip = !(Number(stream.duration ?? source.format.duration) > 0);
        await ffmpeg([...(staticClip ? ["-discard", "none", "-ignore_editlist", "1", "-r", "60"] : []),
          "-i", part.path, "-map", "0:v:0", "-vf", filter, "-t", String(duration),
          ...encodingArgs("mp4"), "-fs", String(MAX_CAPTURE_BYTES), path]);
      }
      const manifest = join(this.dir, `${active.state.id}.concat`);
      try {
        writeFileSync(manifest, normalized.map(path => `file '${basename(path)}'`).join("\n"));
        await ffmpeg(["-f", "concat", "-safe", "1", "-i", manifest,
          "-map", "0:v:0", "-c", "copy", "-movflags", "+faststart", active.output]);
      } finally { try { unlinkSync(manifest); } catch {} }
      if (statSync(active.output).size > MAX_CAPTURE_BYTES) throw new Error("Recording exceeds the 256 MB limit");
      const probe = await probeVideo(active.output);
      const duration = Number(probe.format.duration);
      const video = probe.streams.find((stream) => stream.codec_type === "video");
      if (!video || !Number.isFinite(duration) || duration <= 0) throw new Error("Recording contains no playable video");
      const expectedDuration = Math.max(1 / 60, (end - parts[0]!.startedAt) / 1000);
      if (duration < expectedDuration - 0.2) throw new Error("Recording ended before the selected interval was saved (encoder or file-size limit)");
      const [numerator, denominator] = String(video.avg_frame_rate).split("/").map(Number);
      const fps = denominator ? numerator! / denominator : undefined;
      const events = active.events.filter(
        (e) => Date.parse(e.timestamp) <= end,
      );
      const logs = this.logs(Date.parse(active.state.startedAt), end);
      writeFileSync(
        join(this.dir, `${active.state.id}.keys.json`),
        JSON.stringify({ events, logs }),
        { mode: 0o600 },
      );
      if (active.logs)
        writeFileSync(
          join(this.dir, `${active.state.id}.log.txt`),
          logs.map((l) => l.line).join("\n"),
          { mode: 0o600 },
        );
      const artifact = this.add({
        id: active.state.id,
        device: this.serial,
        name: this.serial,
        createdAt: active.state.startedAt,
        duration,
        width: video.width, height: video.height, fps,
        format: "mp4",
        bytes: statSync(active.output).size,
        hasLogs: active.logs,
        hasKeys: events.some((e) => ["key", "button"].includes(e.kind)),
      });
      const result =
        active.state.format === "mp4" && !active.burn
          ? artifact
          : await this.convert(artifact.id, {
              format: active.state.format,
              burnKeys: active.burn,
            });
      recordEventLogEvent({
        device: this.serial,
        source: "ui",
        kind: "capture",
        summary: `Recorded ${result.format.toUpperCase()} ${duration.toFixed(1)}s`,
        details: { captureId: result.id, duration },
      });
      return result;
    } catch (err) {
      this.recordingError = err instanceof Error ? err.message : String(err);
      active.native.abort();
      void active.native.done.then(remaining => {
        for (const part of remaining) { try { unlinkSync(part.path); } catch {} }
      }, () => {});
      recordEventLogEvent({
        device: this.serial,
        source: "server",
        kind: "capture",
        summary: `Recording failed: ${err instanceof Error ? err.message : String(err)}`,
        status: "error",
      });
      if (!this.captures.some((c) => c.id === active.state.id))
        try {
          unlinkSync(active.output);
        } catch {}
      throw err;
    } finally {
      active.unsubscribe();
      for (const path of [...parts.map(part => part.path), ...normalized]) { try { unlinkSync(path); } catch {} }
      this.active = null;
    }
  }
  async convert(
    id: string,
    options: {
      format?: unknown;
      trimStart?: unknown;
      trimEnd?: unknown;
      burnKeys?: boolean;
    },
    authorized: () => boolean = () => true,
  ): Promise<CaptureArtifact> {
    const source = this.captures.find((c) => c.id === id);
    if (!source || source.format === "png")
      throw new Error("Video capture not found");
    const format = videoFormat(options.format ?? source.format);
    const start = Number(options.trimStart ?? 0),
      end = Number(options.trimEnd ?? source.duration);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      end > source.duration + 0.1
    )
      throw new Error("Trim must select a valid interval within the clip");
    const newId = randomUUID();
    const output = join(this.dir, `${newId}.${format}`);
    let filter =
      format === "gif"
        ? "fps=8,scale=640:-2:flags=lanczos"
        : "scale=trunc(iw/2)*2:trunc(ih/2)*2";
    let subtitle: string | undefined;
    const sidecar = JSON.parse(
      await import("node:fs/promises").then((fs) =>
        fs.readFile(this.path(id, "keys"), "utf8"),
      ),
    ) as { events: EventLogEntry[]; logs: { at: number; line: string }[] };
    const events = sidecar.events;
    if (!authorized()) throw new Error("Session expired");
    if (options.burnKeys) {
      subtitle = join(this.dir, `${newId}.ass`);
      writeFileSync(
        subtitle,
        keySubtitles(
          events,
          Date.parse(source.createdAt) + start * 1000,
          Date.parse(source.createdAt) + end * 1000,
        ),
      );
      filter += `,subtitles='${subtitle.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'")}'`;
    }
    try {
      await ffmpeg([
        "-ss",
        String(start),
        "-i",
        this.path(id),
        "-t",
        String(end - start),
        "-vf",
        filter,
        "-an",
        ...encodingArgs(format),
        "-fs",
        String(MAX_CAPTURE_BYTES),
        output,
      ]);
    } catch (err) {
      try {
        unlinkSync(output);
      } catch {}
      throw err;
    } finally {
      if (subtitle)
        try {
          unlinkSync(subtitle);
        } catch {}
    }
    const converted = await probeVideo(output);
    const convertedVideo = converted.streams.find(stream => stream.codec_type === "video");
    const [n, d] = String(convertedVideo?.avg_frame_rate).split("/").map(Number);
    const artifact = {
      ...source,
      width: convertedVideo?.width, height: convertedVideo?.height, fps: d ? n! / d : undefined,
      id: newId,
      createdAt: new Date(
        Date.parse(source.createdAt) + start * 1000,
      ).toISOString(),
      format,
      duration: end - start,
      bytes: statSync(output).size,
    };
    const rangeStart = Date.parse(artifact.createdAt),
      rangeEnd = rangeStart + artifact.duration * 1000;
    const selectedEvents = events.filter(
      (e) =>
        Date.parse(e.timestamp) >= rangeStart &&
        Date.parse(e.timestamp) <= rangeEnd,
    );
    const selectedLogs = sidecar.logs.filter(
      (l) => l.at >= rangeStart && l.at <= rangeEnd,
    );
    writeFileSync(
      join(this.dir, `${newId}.keys.json`),
      JSON.stringify({ events: selectedEvents, logs: selectedLogs }),
    );
    if (source.hasLogs)
      writeFileSync(
        join(this.dir, `${newId}.log.txt`),
        selectedLogs.map((l) => l.line).join("\n"),
      );
    return this.add(artifact);
  }
  close(): void {
    this.closed = true;
    this.pendingNative?.abort();
    if (this.active) {
      clearTimeout(this.active.timer);
      this.active.stopping = true;
      this.active.unsubscribe();
      this.active.native.abort();
      const native = this.active.native;
      void native.done.then(parts => { for (const part of parts) { try { unlinkSync(part.path); } catch {} } }, () => {});
      this.active = null;
    }
  }
}
