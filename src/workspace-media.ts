import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { adbExecOut } from "./adb";
import {
  listEventLogEvents,
  subscribeEventLog,
  recordEventLogEvent,
  type EventLogEntry,
} from "./event-log";
import type {
  CaptureArtifact,
  CaptureFormat,
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
interface ActiveRecording {
  state: RecordingState;
  proc: ChildProcessWithoutNullStreams;
  output: string;
  stopping: boolean;
  finished: Promise<void>;
  frames: number;
  logs: boolean;
  burn: boolean;
  error: string;
  task: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
  events: EventLogEntry[];
  unsubscribe: () => void;
}
export class DeviceMedia {
  readonly captures: CaptureArtifact[] = [];
  private active: ActiveRecording | null = null;
  private starting = false;
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
    // Probe a real frame first: a missing device must not create a phantom recording.
    this.starting = true;
    let first: Buffer;
    try {
      first = await this.screenshot();
    } finally {
      this.starting = false;
    }
    const id = randomUUID();
    const output = join(this.dir, `${id}.mp4`);
    const proc = spawn(
      process.env.SERVE_AVD_FFMPEG || "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-use_wallclock_as_timestamps",
        "1",
        "-f",
        "image2pipe",
        "-framerate",
        "4",
        "-i",
        "pipe:0",
        "-vf",
        "fps=4,scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-an",
        ...encodingArgs("mp4"),
        "-fs",
        String(MAX_CAPTURE_BYTES),
        output,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const finished = new Promise<void>((r, j) => {
      resolve = r;
      reject = j;
    });
    void finished.catch(() => {});
    const active: ActiveRecording = {
      state: {
        id,
        startedAt: new Date().toISOString(),
        format,
        maxSeconds: duration,
        captureFps: 4,
      },
      proc,
      output,
      stopping: false,
      finished,
      frames: 1,
      logs: options.attachLogs !== false,
      burn: options.burnKeys === true,
      error: "",
      task: Promise.resolve(),
      events: [],
      unsubscribe: () => {},
      timer: setTimeout(
        () => void this.stop().catch(() => {}),
        duration * 1000,
      ),
    };
    active.timer.unref();
    this.active = active;
    active.unsubscribe = subscribeEventLog((event) => {
      if (event.device === this.serial && active.events.length < 10_000)
        active.events.push(event);
    });
    proc.stderr.on(
      "data",
      (chunk) => (active.error = (active.error + chunk).slice(-4000)),
    );
    proc.stdout.resume();
    proc.stdin.on("error", () => {});
    proc.on("error", (err) => {
      reject(new Error(`ffmpeg unavailable: ${err.message}`));
      void this.stop().catch(() => {});
    });
    proc.on("close", (code) => {
      code === 0
        ? resolve()
        : reject(new Error(active.error || `Recording encoder exited ${code}`));
      if (!active.stopping) void this.stop().catch(() => {});
    });
    proc.stdin.write(first);
    active.task = (async () => {
      while (!active.stopping && proc.exitCode === null) {
        await new Promise((r) => setTimeout(r, 250));
        if (active.stopping) break;
        const data = await this.screenshot();
        if (active.stopping) break;
        if (!proc.stdin.write(data))
          await Promise.race([once(proc.stdin, "drain"), finished]);
        active.frames++;
      }
    })().catch((err) => {
      active.error = String(err);
      proc.stdin.end();
      void this.stop().catch(() => {});
    });
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
    const end = Date.now();
    try {
      await active.task;
      active.proc.stdin.end();
      const kill = setTimeout(() => active.proc.kill("SIGKILL"), 20_000);
      kill.unref();
      try {
        await active.finished;
      } finally {
        clearTimeout(kill);
      }
      const measured = await new Promise<number>((resolve) =>
        execFile(
          process.env.SERVE_AVD_FFPROBE || "ffprobe",
          [
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            active.output,
          ],
          { timeout: 10_000 },
          (err, out) => resolve(err ? NaN : Number(out.trim())),
        ),
      );
      const duration =
        Number.isFinite(measured) && measured > 0
          ? measured
          : Math.max(0.25, (end - Date.parse(active.state.startedAt)) / 1000);
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
    const artifact = {
      ...source,
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
    if (this.active) {
      clearTimeout(this.active.timer);
      this.active.stopping = true;
      this.active.unsubscribe();
      this.active.proc.kill("SIGKILL");
      this.active = null;
    }
  }
}
