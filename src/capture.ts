/**
 * Screen capture for one device.
 *
 * Video path: `adb exec-out screenrecord --output-format=h264 -` → Annex B →
 * AVCC envelopes (see h264.ts). screenrecord hard-stops at 180 s, so the
 * process is respawned in a loop; each session re-emits SPS/PPS, which flows
 * to viewers as a fresh `description` envelope (decoders reconfigure
 * seamlessly). screenrecord also only emits frames when the screen *changes*
 * and cannot follow display rotation — both are handled here: a GOP cache
 * (decoder config + last keyframe + deltas since) is replayed to late joiners
 * so they paint instantly, and the session layer calls `restart()` on
 * rotation.
 *
 * Still path: `adb exec-out screencap` per frame — used for the MJPEG
 * fallback stream, the AVCC seed image, and screenshots. JPEG output is
 * probed (newer Android builds support it); PNG is the universal fallback.
 * Browsers accept either inside `multipart/x-mixed-replace`.
 */
import { spawn, type ChildProcess } from "child_process";
import { adbPath, adbExecOut } from "./adb";
import { AvccEncoder, type AvccEvent } from "./h264";
import { createDebug } from "./debug";

const debug = createDebug("capture");

// Cap the delta run replayed to late joiners. screenrecord GOPs can be
// effectively infinite (no periodic IDR on a static screen), so past this we
// restart the recorder to force a fresh keyframe instead of replaying an
// ever-growing tail.
const GOP_MAX_FRAMES = 900;
const GOP_MAX_BYTES = 48 * 1024 * 1024;

const RESTART_DELAY_MS = 250;
const FAST_EXIT_MS = 2_000;
const FAST_EXIT_LIMIT = 3;

export interface VideoCaptureOptions {
  /** Encoder bitrate in Mbps (screenrecord --bit-rate). */
  bitRateMbps?: number;
  /** Explicit capture size, e.g. "720x1560" (screenrecord --size). */
  size?: string;
}

export type VideoSubscriber = (envelope: Buffer, kind: AvccEvent["kind"] | "seed") => void;

/**
 * Without an explicit `--size`, screenrecord silently falls back to 720x1280
 * when the display exceeds the encoder's limits — *letterboxing* modern
 * phone aspect ratios inside 16:9. So we always pass a size: the current
 * rotated display dimensions scaled to a cap, stepping down when the encoder
 * rejects it (detected as instant exits).
 */
const SIZE_CAPS = [1920, 1280, 720];

export function fitToCap(width: number, height: number, cap: number): string {
  const long = Math.max(width, height);
  const scale = Math.min(1, cap / long);
  const even = (v: number) => Math.max(2, Math.round((v * scale) / 2) * 2);
  return `${even(width)}x${even(height)}`;
}

export class VideoCapture {
  private proc: ChildProcess | null = null;
  private encoder = new AvccEncoder();
  private readonly subscribers = new Set<VideoSubscriber>();
  private running = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private spawnedAt = 0;
  private fastExits = 0;
  private sawFrame = false;
  /** True between our own SIGKILL and the resulting `exit` (restart, not failure). */
  private killing = false;
  private lastStderr = "";

  private description: Buffer | null = null;
  private gopFrames: Buffer[] = [];
  private gopBytes = 0;

  /** Total frames emitted (diagnostics). */
  framesEmitted = 0;
  private lastFrameAt = 0;

  /** True when video frames flowed within the last few seconds. */
  get recentlyActive(): boolean {
    return Date.now() - this.lastFrameAt < 5_000;
  }
  /** Set when screenrecord keeps dying instantly — video is not available. */
  unavailable = false;
  onUnavailable?: (reason: string) => void;

  private sizeCapIndex = 0;

  constructor(
    public readonly serial: string,
    private readonly options: VideoCaptureOptions = {},
    /** Supplier of the current rotated display size (for `--size`). */
    private readonly displaySize?: () => { width: number; height: number },
  ) {}

  private currentSizeArg(): string | undefined {
    if (this.options.size) return this.options.size;
    const dims = this.displaySize?.();
    if (!dims || dims.width <= 0 || dims.height <= 0) return undefined;
    const cap = SIZE_CAPS[Math.min(this.sizeCapIndex, SIZE_CAPS.length - 1)]!;
    return fitToCap(dims.width, dims.height, cap);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.unavailable = false;
    this.fastExits = 0;
    this.spawnProc();
  }

  stop(): void {
    this.running = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    this.killProc();
  }

  /** Force a new screenrecord session (fresh SPS/PPS + IDR). Used on rotation. */
  restart(): void {
    if (!this.running) return;
    debug(`restarting screenrecord for ${this.serial}`);
    this.killProc(); // exit handler respawns
  }

  /**
   * Subscribe to framed envelopes. Replays the current decoder description and
   * GOP synchronously so new viewers paint without waiting for screen activity.
   */
  subscribe(cb: VideoSubscriber): () => void {
    if (this.description) cb(this.description, "description");
    for (let i = 0; i < this.gopFrames.length; i++) {
      cb(this.gopFrames[i]!, i === 0 ? "keyframe" : "delta");
    }
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  get hasKeyframe(): boolean {
    return this.gopFrames.length > 0;
  }

  /**
   * Fan out a pre-wrapped envelope (a still seed) to current viewers without
   * caching it — it isn't part of the GOP and must not be replayed to joiners.
   */
  broadcastSeed(envelope: Buffer): void {
    for (const cb of this.subscribers) {
      try {
        cb(envelope, "seed");
      } catch (err) {
        debug("subscriber error", err);
      }
    }
  }

  private spawnProc(): void {
    if (!this.running || this.proc) return;
    const args = [
      "-s",
      this.serial,
      "exec-out",
      "screenrecord",
      "--output-format=h264",
      "--time-limit",
      "179",
      "--bit-rate",
      String(Math.round((this.options.bitRateMbps ?? 8) * 1_000_000)),
    ];
    const size = this.currentSizeArg();
    if (size) args.push("--size", size);
    args.push("-");

    this.encoder = new AvccEncoder();
    this.sawFrame = false;
    this.spawnedAt = Date.now();
    this.lastStderr = "";
    const proc = spawn(adbPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    debug(`spawned screenrecord for ${this.serial} (pid ${proc.pid})`);

    // Bind the handler to *this* process: a killed session's stdout keeps
    // draining after its `exit` fires, and those bytes must not land in the
    // successor's parser — a half-NAL tail spliced onto the new stream makes
    // the first keyframe undecodable, which strands every viewer (they drop
    // deltas while waiting for a keyframe that only comes with the next IDR).
    proc.stdout!.on("data", (chunk: Buffer) => {
      if (this.proc !== proc) {
        debug(`dropping ${chunk.length}B from a stale screenrecord for ${this.serial}`);
        return;
      }
      this.onChunk(chunk);
    });
    proc.stderr!.on("data", (chunk: Buffer) => {
      this.lastStderr = (this.lastStderr + chunk.toString("utf8")).slice(-2000);
    });
    proc.on("error", (err) => {
      debug("screenrecord spawn error", err);
      this.lastStderr ||= String(err);
    });
    proc.on("exit", (code, signal) => {
      if (this.proc !== proc) return;
      this.proc = null;
      // The session is over: flush its tail now, and drop the settle-timer
      // flush it had queued so it can't fire against the successor's encoder.
      if (this.settleTimer) {
        clearTimeout(this.settleTimer);
        this.settleTimer = null;
      }
      for (const event of this.encoder.flush()) this.dispatch(event);
      debug(`screenrecord for ${this.serial} exited (code=${code} signal=${signal})`);

      // A session *we* killed says nothing about the encoder: rotating twice in
      // quick succession would otherwise look like two size rejections and walk
      // the capture down to 720p for the rest of the session.
      const deliberate = this.killing;
      this.killing = false;

      if (!this.running) return;
      const lifetime = Date.now() - this.spawnedAt;
      if (!deliberate && lifetime < FAST_EXIT_MS && !this.sawFrame) {
        this.fastExits++;
        // The encoder may reject the requested size — retry smaller first.
        if (!this.options.size && this.sizeCapIndex < SIZE_CAPS.length - 1) {
          this.sizeCapIndex++;
          this.fastExits = 0;
          debug(`stepping capture size down for ${this.serial} (cap ${SIZE_CAPS[this.sizeCapIndex]})`);
        } else if (this.fastExits >= FAST_EXIT_LIMIT) {
          this.unavailable = true;
          this.running = false;
          const reason = this.lastStderr.trim() || `screenrecord exited with code ${code}`;
          debug(`video capture unavailable for ${this.serial}: ${reason}`);
          this.onUnavailable?.(reason);
          return;
        }
      } else {
        this.fastExits = 0;
      }
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.spawnProc();
      }, RESTART_DELAY_MS);
    });
  }

  private killProc(): void {
    const proc = this.proc;
    if (!proc) return;
    this.killing = true;
    try {
      proc.kill("SIGKILL");
    } catch {}
  }

  private onChunk(chunk: Buffer): void {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    for (const event of this.encoder.push(chunk)) this.dispatch(event);
    // An Annex B NAL is only *provably* complete when the next start code
    // arrives — but screenrecord writes whole access units and then goes
    // quiet until the screen changes again, which would hold the freshest
    // frame hostage. Flush the tail once the pipe settles briefly.
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      for (const event of this.encoder.flush()) this.dispatch(event);
    }, 25);
  }

  private dispatch(event: AvccEvent): void {
    switch (event.kind) {
      case "description":
        this.description = event.envelope;
        break;
      case "keyframe":
        this.sawFrame = true;
        this.framesEmitted++;
        this.lastFrameAt = Date.now();
        this.gopFrames = [event.envelope];
        this.gopBytes = event.envelope.length;
        break;
      case "delta":
        this.sawFrame = true;
        this.framesEmitted++;
        this.lastFrameAt = Date.now();
        // Only cache deltas that chain to a cached keyframe.
        if (this.gopFrames.length > 0) {
          this.gopFrames.push(event.envelope);
          this.gopBytes += event.envelope.length;
        }
        break;
    }
    for (const cb of this.subscribers) {
      try {
        cb(event.envelope, event.kind);
      } catch (err) {
        debug("subscriber error", err);
      }
    }
    if (this.gopFrames.length > GOP_MAX_FRAMES || this.gopBytes > GOP_MAX_BYTES) {
      debug(`GOP cache over budget for ${this.serial} (${this.gopFrames.length} frames) — forcing keyframe`);
      this.gopFrames = this.gopFrames.slice(0, 1); // keep the keyframe for joiners during restart
      this.gopBytes = this.gopFrames[0]?.length ?? 0;
      this.restart();
    }
  }
}

// ── Still frames ───────────────────────────────────────────────────────────

export interface StillFrame {
  data: Buffer;
  contentType: "image/jpeg" | "image/png";
  capturedAt: number;
}

function contentTypeFor(data: Buffer): StillFrame["contentType"] | null {
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (data.length > 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return "image/png";
  }
  return null;
}

export type StillSubscriber = (frame: StillFrame) => void;

/**
 * On-demand screenshot loop. Runs only while subscribers are attached (or a
 * one-shot is requested); paces itself by capture latency with a small floor.
 */
export class StillCapture {
  private readonly subscribers = new Set<StillSubscriber>();
  private looping = false;
  private jpegSupported: boolean | null = null;
  private latest: StillFrame | null = null;
  private pendingShot: Promise<StillFrame | null> | null = null;

  constructor(
    public readonly serial: string,
    private readonly minIntervalMs = 150,
  ) {}

  subscribe(cb: StillSubscriber): () => void {
    if (this.latest) cb(this.latest);
    this.subscribers.add(cb);
    void this.runLoop();
    return () => this.subscribers.delete(cb);
  }

  /** Latest frame if fresh enough, else capture a new one. */
  async screenshot(maxAgeMs = 400): Promise<StillFrame | null> {
    if (this.latest && Date.now() - this.latest.capturedAt <= maxAgeMs) return this.latest;
    return this.captureOnce();
  }

  private async runLoop(): Promise<void> {
    if (this.looping) return;
    this.looping = true;
    try {
      while (this.subscribers.size > 0) {
        const started = Date.now();
        const frame = await this.captureOnce();
        if (frame) {
          for (const cb of this.subscribers) {
            try {
              cb(frame);
            } catch (err) {
              debug("still subscriber error", err);
            }
          }
        }
        const elapsed = Date.now() - started;
        const wait = frame ? Math.max(0, this.minIntervalMs - elapsed) : 1_000;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    } finally {
      this.looping = false;
    }
  }

  /** Deduplicated single capture: concurrent callers share one screencap. */
  private captureOnce(): Promise<StillFrame | null> {
    if (this.pendingShot) return this.pendingShot;
    this.pendingShot = this.doCapture().finally(() => {
      this.pendingShot = null;
    });
    return this.pendingShot;
  }

  private async doCapture(): Promise<StillFrame | null> {
    // Probe JPEG support once — much cheaper frames when available.
    if (this.jpegSupported === null) {
      try {
        const jpeg = await adbExecOut(this.serial, ["screencap", "-j"], { timeout: 15_000 });
        if (contentTypeFor(jpeg) === "image/jpeg") {
          this.jpegSupported = true;
          return (this.latest = { data: jpeg, contentType: "image/jpeg", capturedAt: Date.now() });
        }
      } catch {}
      this.jpegSupported = false;
    }
    try {
      const args = this.jpegSupported ? ["screencap", "-j"] : ["screencap", "-p"];
      const data = await adbExecOut(this.serial, args, { timeout: 15_000 });
      const contentType = contentTypeFor(data);
      if (!contentType) {
        debug(`screencap for ${this.serial} returned non-image data (${data.length} bytes)`);
        return null;
      }
      return (this.latest = { data, contentType, capturedAt: Date.now() });
    } catch (err) {
      debug("screencap failed", err);
      return null;
    }
  }
}
