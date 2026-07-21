/**
 * In-process emulator session. One session per connected device owns the
 * capture pipelines + input injector and serves the same wire endpoints
 * serve-sim's helper does, byte-for-byte:
 *
 *   /stream.mjpeg    multipart/x-mixed-replace image fan-out (?raw=1 → octet-stream)
 *   /stream.avcc     length-prefixed AVCC envelopes (seed + decoder config replay)
 *   /ws              binary input protocol ([tag][JSON]) → adb input injection
 *   /config          { width, height, orientation }   (rotated display space)
 *   /health          { status: "ok" }
 *   /ax              UI hierarchy JSON (uiautomator; one-shot)
 *   /foreground      { packageName, activity, pid }
 *   /logs            Server-sent events of logcat lines
 *   /screenshot.png  one-shot screenshot
 */
import type { IncomingMessage, ServerResponse } from "http";
import { spawn, type ChildProcess } from "child_process";
import {
  AdbShell,
  adbPath,
  deviceDisplayName,
  screenGeometry,
  screenRotation,
} from "./adb";
import { VideoCapture, StillCapture, type StillFrame } from "./capture";
import { InputInjector, orientationNameForRotation } from "./input";
import { wrapEnvelope, AVCC_TAG_SEED } from "./h264";
import { dumpUiHierarchy } from "./ax";
import { androidKeycodeForBrowserCode } from "./keymap";
import {
  recordEventLogEvent,
  updateEventLogEvent,
} from "./event-log";
import { formatEventLogPoint } from "./event-log-format";
import { createDebug } from "./debug";

const debug = createDebug("session");

/**
 * Minimal WebSocket surface the input channel needs — satisfied by `ws`
 * sockets and by hand-rolled raw-socket adapters alike.
 */
export interface HidSocket {
  send(data: Buffer): void;
  on(event: "message", cb: (data: Buffer) => void): void;
  on(event: "close" | "error", cb: () => void): void;
  close(): void;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// WS server→client screen-config push.
const WS_MSG_CONFIG = 0x82;

const MJPEG_TRAILER = Buffer.from("\r\n", "ascii");
const TOUCH_TAP_MAX_DISTANCE = 0.004;
const ROTATION_POLL_MS = 1_000;
const LOGCAT_RING_MAX = 500;

type TouchGestureLog = {
  eventId?: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moveCount: number;
};

function touchGestureSummary(gesture: TouchGestureLog): string {
  return `Drag ${formatEventLogPoint(gesture.startX, gesture.startY)} -> ${formatEventLogPoint(gesture.lastX, gesture.lastY)}`;
}

function touchGestureMoved(gesture: TouchGestureLog): boolean {
  const dx = gesture.lastX - gesture.startX;
  const dy = gesture.lastY - gesture.startY;
  return Math.hypot(dx, dy) > TOUCH_TAP_MAX_DISTANCE;
}

function mjpegHeader(contentType: string, length: number): Buffer {
  return Buffer.from(
    `--frame\r\nContent-Type: ${contentType}\r\nContent-Length: ${length}\r\n\r\n`,
    "ascii",
  );
}

export interface SessionOptions {
  bitRateMbps?: number;
  size?: string;
}

export class EmulatorSession {
  readonly shell: AdbShell;
  readonly injector: InputInjector;
  private readonly video: VideoCapture;
  private readonly still: StillCapture;
  private phase: "unstarted" | "running" | "stopped" = "unstarted";

  /** Natural (unrotated) panel size. */
  private naturalWidth = 0;
  private naturalHeight = 0;
  private rotation = 0;
  private rotationTimer: ReturnType<typeof setInterval> | null = null;

  private readonly hidSockets = new Set<HidSocket>();
  private touchGestureLog?: TouchGestureLog;
  private pinchWarned = false;

  private logcatProc: ChildProcess | null = null;
  private logcatRing: string[] = [];
  private readonly logcatSubscribers = new Set<(line: string) => void>();
  private logcatCarry = "";

  name = "";

  constructor(
    public readonly serial: string,
    options: SessionOptions = {},
  ) {
    this.shell = new AdbShell(serial);
    this.injector = new InputInjector(serial, this.shell, () => this.rotation);
    this.video = new VideoCapture(serial, options, () => this.displaySize());
    this.still = new StillCapture(serial);
    this.video.onUnavailable = (reason) => {
      recordEventLogEvent({
        device: serial,
        source: "server",
        kind: "stream",
        summary: "H.264 capture unavailable — falling back to screenshots",
        details: { reason },
        status: "error",
      });
    };
  }

  private startPromise: Promise<void> | null = null;

  /** Begin capture. Throws when the device can't be reached. Idempotent —
   *  concurrent callers share one startup. */
  start(): Promise<void> {
    this.startPromise ??= this.doStart();
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    if (this.phase !== "unstarted") return;
    this.phase = "running";
    const geometry = await screenGeometry(this.serial); // throws when offline/unauthorized
    this.naturalWidth = geometry.width;
    this.naturalHeight = geometry.height;
    this.rotation = await screenRotation(this.serial, this.shell);
    this.name = await deviceDisplayName(this.serial);
    void this.injector.wake().catch(() => {});
    this.video.start();
    this.rotationTimer = setInterval(() => void this.pollRotation(), ROTATION_POLL_MS);
    debug(
      `session ${this.serial} started (${this.naturalWidth}x${this.naturalHeight} rotation=${this.rotation})`,
    );
  }

  close(): void {
    if (this.phase !== "running") return;
    this.phase = "stopped";
    if (this.rotationTimer) clearInterval(this.rotationTimer);
    for (const ws of this.hidSockets) ws.close();
    this.hidSockets.clear();
    this.video.stop();
    this.stopLogcat();
    this.shell.close();
  }

  get videoAvailable(): boolean {
    return !this.video.unavailable;
  }

  // ── Geometry ─────────────────────────────────────────────────────────────

  /** Rotated (display) dimensions — what the stream shows and touch maps onto. */
  private displaySize(): { width: number; height: number } {
    const swap = this.rotation % 2 === 1;
    return {
      width: swap ? this.naturalHeight : this.naturalWidth,
      height: swap ? this.naturalWidth : this.naturalHeight,
    };
  }

  screenConfig(): { width: number; height: number; orientation: string; rotation: number } {
    const { width, height } = this.displaySize();
    return { width, height, orientation: orientationNameForRotation(this.rotation), rotation: this.rotation };
  }

  private async pollRotation(): Promise<void> {
    if (this.phase !== "running") return;
    try {
      const rotation = await screenRotation(this.serial, this.shell);
      if (rotation !== this.rotation) {
        debug(`rotation ${this.rotation} → ${rotation} for ${this.serial}`);
        this.rotation = rotation;
        this.broadcastConfig();
        // screenrecord can't follow rotation — restart for a correctly-sized stream.
        this.video.restart();
      }
    } catch {
      // transient adb hiccup — next poll retries
    }
  }

  /** Adopt a rotation we initiated ourselves without waiting for the poll. */
  private adoptRotation(rotation: number): void {
    if (rotation === this.rotation) return;
    this.rotation = rotation;
    this.broadcastConfig();
    this.video.restart();
  }

  // ── HTTP handlers ────────────────────────────────────────────────────────

  handleMjpeg(req: IncomingMessage, res: ServerResponse): void {
    const raw = new URL(req.url ?? "", "http://x").searchParams.get("raw") === "1";
    res.writeHead(200, {
      "Content-Type": raw ? "application/octet-stream" : "multipart/x-mixed-replace; boundary=frame",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      ...CORS,
    });
    const unsubscribe = this.still.subscribe((frame) => {
      if (res.writableEnded || res.destroyed) return;
      // MJPEG frames are stateless — drop instead of buffering behind a slow client.
      if (res.writableNeedDrain) return;
      if (raw) {
        res.write(frame.data);
      } else {
        res.write(mjpegHeader(frame.contentType, frame.data.length));
        res.write(frame.data);
        res.write(MJPEG_TRAILER);
      }
    });
    res.on("close", unsubscribe);
    res.on("error", unsubscribe);
  }

  handleAvcc(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      ...CORS,
    });

    // Subscribing replays decoder config + the cached GOP, so an active stream
    // paints instantly. A fresh session has no keyframe yet — seed with a
    // screenshot so the viewer isn't black until the first IDR.
    const unsubscribe = this.video.subscribe((envelope) => {
      if (res.writableEnded || res.destroyed) return;
      // AVCC deltas can't be dropped (decode would corrupt); guard runaway buffering.
      if (res.writableLength > 64 * 1024 * 1024) {
        res.destroy();
        return;
      }
      res.write(envelope);
    });
    if (!this.video.hasKeyframe) {
      void this.still.screenshot(2_000).then((shot) => {
        if (!shot || res.writableEnded || res.destroyed) return;
        if (!this.video.hasKeyframe) res.write(wrapEnvelope(AVCC_TAG_SEED, shot.data));
      });
    }
    res.on("close", unsubscribe);
    res.on("error", unsubscribe);
  }

  handleConfig(_req: IncomingMessage, res: ServerResponse): void {
    this.sendJson(res, 200, this.screenConfig());
  }

  handleHealth(_req: IncomingMessage, res: ServerResponse): void {
    this.sendJson(res, 200, { status: "ok" });
  }

  async handleAx(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const dump = await dumpUiHierarchy(this.shell);
      if (res.writableEnded) return;
      this.sendJson(res, 200, dump);
    } catch (err) {
      if (res.writableEnded) return;
      this.sendJson(res, 503, {
        error: "ax_unavailable",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async handleForeground(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const app = await this.injector.foregroundApp();
      if (res.writableEnded) return;
      if (!app) {
        this.sendJson(res, 503, { error: "foreground_unavailable", message: "No resumed activity found" });
        return;
      }
      this.sendJson(res, 200, app);
    } catch (err) {
      if (res.writableEnded) return;
      this.sendJson(res, 503, {
        error: "foreground_unavailable",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async handleScreenshot(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const shot = await this.still.screenshot();
    if (res.writableEnded) return;
    if (!shot) {
      this.sendJson(res, 503, { error: "screenshot_unavailable" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": shot.contentType,
      "Content-Length": String(shot.data.length),
      "Cache-Control": "no-cache, no-store",
      ...CORS,
    });
    res.end(shot.data);
  }

  /** One-shot screenshot for CLI use. */
  screenshot(): Promise<StillFrame | null> {
    return this.still.screenshot();
  }

  // ── Logcat ───────────────────────────────────────────────────────────────

  handleLogs(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      ...CORS,
    });
    for (const line of this.logcatRing) {
      res.write(`data: ${JSON.stringify({ line })}\n\n`);
    }
    const listener = (line: string) => {
      if (res.writableEnded || res.destroyed || res.writableNeedDrain) return;
      res.write(`data: ${JSON.stringify({ line })}\n\n`);
    };
    this.logcatSubscribers.add(listener);
    this.ensureLogcat();
    const cleanup = () => {
      this.logcatSubscribers.delete(listener);
      if (this.logcatSubscribers.size === 0) this.stopLogcat();
    };
    res.on("close", cleanup);
    res.on("error", cleanup);
  }

  private ensureLogcat(): void {
    if (this.logcatProc) return;
    const proc = spawn(adbPath(), ["-s", this.serial, "logcat", "-v", "time", "-T", "50"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    this.logcatProc = proc;
    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => {
      const text = this.logcatCarry + chunk;
      const lines = text.split("\n");
      this.logcatCarry = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        this.logcatRing.push(line);
        if (this.logcatRing.length > LOGCAT_RING_MAX) this.logcatRing.shift();
        for (const cb of this.logcatSubscribers) cb(line);
      }
    });
    proc.on("exit", () => {
      if (this.logcatProc === proc) this.logcatProc = null;
    });
  }

  private stopLogcat(): void {
    const proc = this.logcatProc;
    this.logcatProc = null;
    this.logcatCarry = "";
    if (proc) {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
  }

  // ── Input WebSocket ──────────────────────────────────────────────────────

  attachHidSocket(ws: HidSocket): void {
    this.hidSockets.add(ws);
    const cfg = this.configFrame();
    if (cfg) ws.send(cfg); // seed dimensions/orientation
    ws.on("message", (data: Buffer) =>
      void this.handleHidMessage(Buffer.isBuffer(data) ? data : Buffer.from(data)),
    );
    ws.on("close", () => this.hidSockets.delete(ws));
    ws.on("error", () => this.hidSockets.delete(ws));
  }

  private async handleHidMessage(data: Buffer): Promise<void> {
    if (data.length < 1) return;
    const tag = data[0]!;
    const body = data.length > 1 ? data.subarray(1) : null;
    const json = <T>(): T | null => {
      if (!body) return null;
      try {
        return JSON.parse(body.toString("utf8")) as T;
      } catch {
        return null;
      }
    };
    const { width: W, height: H } = this.displaySize();

    try {
      switch (tag) {
        case 0x03: {
          const m = json<{ type: "begin" | "move" | "end"; x: number; y: number }>();
          if (m) {
            this.recordTouchEvent(m);
            await this.injector.touchEvent(m.type, m.x, m.y, W, H);
          }
          break;
        }
        case 0x04: {
          const m = json<{ button: string }>();
          if (!m) break;
          this.record({ kind: "button", action: m.button, summary: `Button ${m.button}`, details: { button: m.button } });
          await this.injector.button(m.button);
          break;
        }
        case 0x05: {
          const m = json<{ type: "begin" | "move" | "end"; x1: number; y1: number; x2: number; y2: number }>();
          if (m) {
            if (m.type === "begin") {
              this.record({ kind: "pinch", action: "pinch", summary: "Pinch gesture" });
            }
            const injected = await this.injector.multiTouch(m.type, m.x1, m.y1, m.x2, m.y2);
            if (!injected && m.type === "begin" && !this.pinchWarned) {
              this.pinchWarned = true;
              this.record({
                kind: "pinch",
                summary:
                  "Pinch unavailable on this image — /dev/input is not writable (use a non-Play AVD and `adb root`)",
                status: "error",
              });
            }
          }
          break;
        }
        case 0x06: {
          const m = json<{ type: "down" | "up"; code: string }>();
          if (!m || m.type !== "down") break; // keyevent is a full press
          const keycode = androidKeycodeForBrowserCode(m.code);
          if (keycode == null) break;
          this.record({ kind: "key", action: "down", summary: `Key ${m.code}`, details: { code: m.code, key: m.code } });
          await this.injector.keyevent(keycode);
          break;
        }
        case 0x07: {
          const m = json<{ orientation: string }>();
          if (!m) break;
          this.record({ kind: "rotate", action: m.orientation, summary: `Rotate ${m.orientation}` });
          const rotation = await this.injector.rotate(m.orientation);
          this.adoptRotation(rotation);
          break;
        }
        case 0x08: {
          const m = json<{ option: string; enabled: boolean }>();
          if (m) {
            this.record({
              kind: "debug",
              action: m.option,
              summary: `Debug ${m.option} ${m.enabled ? "on" : "off"}`,
              details: { option: m.option, enabled: m.enabled },
            });
            await this.injector.setDebugFlag(m.option, m.enabled);
          }
          break;
        }
        case 0x09: {
          this.record({ kind: "memory", action: "memory-warning", summary: "Memory warning" });
          await this.injector.memoryWarning();
          break;
        }
        case 0x0b: {
          const m = json<{ dx: number; dy: number; x?: number; y?: number }>();
          if (m) {
            this.record({ kind: "scroll", action: "scroll", summary: "Scroll", details: { dx: m.dx, dy: m.dy } });
            await this.injector.scroll(m.dx, m.dy, W, H, m.x, m.y);
          }
          break;
        }
        case 0x0c: {
          this.record({ kind: "keyboard", action: "toggle", summary: "Toggle software keyboard" });
          await this.injector.toggleSoftwareKeyboard();
          break;
        }
        case 0x0d: {
          const m = json<{ text: string }>();
          if (m && typeof m.text === "string" && m.text.length > 0) {
            this.record({ kind: "text", action: "type", summary: "Type text", details: { text: m.text } });
            await this.injector.text(m.text);
          }
          break;
        }
        case 0x0e: {
          const m = json<{ theme: "light" | "dark" }>();
          if (m && (m.theme === "light" || m.theme === "dark")) {
            this.record({ kind: "theme", action: m.theme, summary: `Theme ${m.theme}` });
            await this.injector.setTheme(m.theme);
          }
          break;
        }
      }
    } catch (err) {
      debug(`hid message 0x${tag.toString(16)} failed:`, err);
      this.record({
        kind: "error",
        summary: `Input failed: ${err instanceof Error ? err.message : String(err)}`,
        status: "error",
      });
    }
  }

  // ── Event log ────────────────────────────────────────────────────────────

  private record(entry: {
    kind: string;
    summary: string;
    action?: string;
    details?: Record<string, unknown>;
    status?: "ok" | "error";
  }): void {
    recordEventLogEvent({ device: this.serial, source: "hid", ...entry });
  }

  private recordTouchEvent(payload: { type: string; x: number; y: number }): void {
    if (payload.type === "begin") {
      this.touchGestureLog = {
        startX: payload.x,
        startY: payload.y,
        lastX: payload.x,
        lastY: payload.y,
        moveCount: 0,
      };
      return;
    }

    const gesture = this.touchGestureLog;
    if (!gesture) return;

    if (payload.type === "move") {
      gesture.lastX = payload.x;
      gesture.lastY = payload.y;
      gesture.moveCount++;
      if (touchGestureMoved(gesture)) {
        const details = this.touchGestureDetails(gesture, "drag");
        if (gesture.eventId == null) {
          const entry = recordEventLogEvent({
            device: this.serial,
            source: "hid",
            kind: "drag",
            action: "drag",
            summary: touchGestureSummary(gesture),
            details,
          });
          gesture.eventId = entry.id;
        } else {
          // Keep the stored drag current without streaming every touchmove.
          updateEventLogEvent(
            gesture.eventId,
            { summary: touchGestureSummary(gesture), details },
            { notify: false },
          );
        }
      }
      return;
    }

    // end
    gesture.lastX = payload.x;
    gesture.lastY = payload.y;
    if (gesture.moveCount > 0 && touchGestureMoved(gesture)) {
      const patch = {
        summary: touchGestureSummary(gesture),
        details: this.touchGestureDetails(gesture, "drag"),
      };
      if (gesture.eventId == null) {
        recordEventLogEvent({ device: this.serial, source: "hid", kind: "drag", action: "drag", ...patch });
      } else {
        updateEventLogEvent(gesture.eventId, patch);
      }
    } else {
      recordEventLogEvent({
        device: this.serial,
        source: "hid",
        kind: "tap",
        action: "tap",
        summary: `Tap ${formatEventLogPoint(payload.x, payload.y)}`,
        details: this.touchGestureDetails(gesture, "tap"),
      });
    }
    this.touchGestureLog = undefined;
  }

  private touchGestureDetails(gesture: TouchGestureLog, type: "drag" | "tap"): Record<string, unknown> {
    const { width, height } = this.displaySize();
    return {
      type,
      start: { x: gesture.startX, y: gesture.startY },
      current: { x: gesture.lastX, y: gesture.lastY },
      moveCount: gesture.moveCount,
      ...(width > 0 && height > 0 ? { screen: { width, height } } : {}),
    };
  }

  // ── Config push ──────────────────────────────────────────────────────────

  private configFrame(): Buffer | null {
    if (this.naturalWidth === 0 && this.naturalHeight === 0) return null;
    return Buffer.concat([Buffer.from([WS_MSG_CONFIG]), Buffer.from(JSON.stringify(this.screenConfig()))]);
  }

  private broadcastConfig(): void {
    const frame = this.configFrame();
    if (!frame) return;
    for (const ws of this.hidSockets) ws.send(frame);
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const buf = Buffer.from(JSON.stringify(body), "utf8");
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache, no-store",
      "Content-Length": String(buf.length),
      ...CORS,
    });
    res.end(buf);
  }
}

// ── Registry ───────────────────────────────────────────────────────────────

const sessions = new Map<string, EmulatorSession>();

/**
 * Get (lazily creating + starting) the in-process session for a serial.
 * Throws when the device can't be reached. Lives until `closeDeviceSession`.
 */
export async function getDeviceSession(serial: string, options?: SessionOptions): Promise<EmulatorSession> {
  let session = sessions.get(serial);
  if (!session) {
    session = new EmulatorSession(serial, options);
    sessions.set(serial, session);
  }
  try {
    await session.start(); // shared across concurrent callers
  } catch (err) {
    session.close();
    if (sessions.get(serial) === session) sessions.delete(serial);
    throw err;
  }
  return session;
}

export function peekDeviceSession(serial: string): EmulatorSession | undefined {
  return sessions.get(serial);
}

export function listDeviceSessions(): EmulatorSession[] {
  return [...sessions.values()];
}

export function closeDeviceSession(serial: string): void {
  const session = sessions.get(serial);
  if (session) {
    session.close();
    sessions.delete(serial);
  }
}

export function closeAllDeviceSessions(): void {
  for (const serial of [...sessions.keys()]) closeDeviceSession(serial);
}
