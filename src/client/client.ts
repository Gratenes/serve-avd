/**
 * serve-avd preview client. Vanilla DOM app: per-device stage (H.264 via
 * WebCodecs onto canvas, or MJPEG <img> fallback), full input forwarding over
 * the binary [tag][JSON] WebSocket, and side panes (devices / tools / logs).
 */
import { AvccDemuxer, avcCodecString, isAvccSupported } from "./avcc-codec";
import { icons, type IconName } from "./icons";
import { WorkspaceRemote } from "./remote-controls";
import { WorkspaceCanvas, type CanvasLayout } from "./workspace-canvas";
import { workspaceIcons } from "./workspace-icons";

declare const __SERVE_AVD_VERSION__: string | undefined;

interface BootConfig {
  basePath: string;
  authEnabled?: boolean;
  codec: "auto" | "mjpeg";
  initialState: { panes?: string[] };
  version: string;
}

interface ScreenConfig {
  width: number;
  height: number;
  orientation: string;
  rotation: number;
}

interface DeviceEntry {
  device: string;
  name: string;
  videoAvailable: boolean;
  config: ScreenConfig | null;
  streamMjpegEndpoint: string;
  streamAvccEndpoint: string;
  wsEndpoint: string;
  configEndpoint: string;
  logsEndpoint: string;
  screenshotEndpoint: string;
  axEndpoint: string;
  foregroundEndpoint: string;
  actionEndpoint: string;
}

interface ApiState {
  version: string;
  codec: "auto" | "mjpeg";
  basePath: string;
  initialState: { panes?: string[] };
  devices: DeviceEntry[];
  gridApiEndpoint: string;
  gridStartEndpoint: string;
  eventLogEndpoint: string;
  eventLogEventsEndpoint: string;
}

interface EventLogEntry {
  id: number;
  timestamp: string;
  device?: string;
  kind: string;
  summary: string;
  status?: string;
}

const BOOT: BootConfig = (window as unknown as { __SERVE_AVD__: BootConfig }).__SERVE_AVD__ ?? {
  basePath: "",
  codec: "auto",
  initialState: {},
  version: "dev",
};

interface AccountIdentity { id: string; username: string; role: "admin" | "operator"; mustChangePassword: boolean }
let account: AccountIdentity | null = null;
let csrfToken = "";
let authExpired = false;
const nativeFetch = window.fetch.bind(window);
const loginUrl = () => `${BOOT.basePath}/login?returnTo=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
function expireAuthentication(): void {
  if (authExpired) return;
  authExpired = true;
  window.dispatchEvent(new Event("auth-expired"));
  const app = document.getElementById("app");
  const link = el("a", { class: "btn", href: loginUrl(), text: "Sign in again" });
  app?.replaceChildren(el("div", { class: "empty auth-expired", role: "alert" },
    el("p", { text: "Your session ended. Sign in to continue." }), link));
  link.focus();
}
async function checkAuthentication(): Promise<void> {
  if (!BOOT.authEnabled || authExpired) return;
  const response = await nativeFetch(`${BOOT.basePath}/auth/me`, { credentials: "same-origin" });
  if (response.status === 401 || response.status === 403) { expireAuthentication(); return; }
  if (!response.ok) throw new Error("Could not verify your session");
  const identity = await response.json() as { user: AccountIdentity; csrfToken: string };
  account = identity.user;
  csrfToken = identity.csrfToken;
  if (account.mustChangePassword) {
    authExpired = true;
    window.dispatchEvent(new Event("auth-expired"));
    location.assign(`${BOOT.basePath}/account?returnTo=${encodeURIComponent(location.pathname + location.search)}`);
  }
}
// Cover workspace actions, inspector requests and video fetches with one boundary.
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  const protectedRequest = BOOT.authEnabled && url.origin === location.origin &&
    url.pathname.startsWith(`${BOOT.basePath}/`);
  if (protectedRequest && authExpired) throw new Error("Session ended");
  let options = init;
  if (protectedRequest) {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("X-CSRF-Token", csrfToken);
    options = { ...init, headers, credentials: "same-origin" };
  }
  const response = await nativeFetch(input, options);
  if (protectedRequest && response.status === 401) expireAuthentication();
  return response;
};

const ORIENTATIONS = ["portrait", "landscape_left", "portrait_upside_down", "landscape_right"];
/** Floor between "send me a fresh keyframe" pokes at the server. */
const KEYFRAME_REQUEST_MIN_MS = 3_000;
/**
 * Decoder backlog that counts as "behind". Deltas can't be skipped, so a
 * decoder slower than the stream falls further behind with every frame. The
 * queue is dropped immediately and the server is asked for a fresh keyframe.
 */
const DECODE_BACKLOG_MAX = 4;
/** Pointer-move send interval — the device takes a motion event in ~15 ms. */
const MOVE_INTERVAL_MS = 16;
const DEBUG_FLAGS = ["overdraw", "gpu-profile", "layout-bounds", "show-taps", "pointer-location", "slow-animations"];

// ── Tiny DOM helpers ───────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

function button(label: string, title: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = el("button", { class: `btn ${cls}`.trim(), title, type: "button" });
  b.innerHTML = label;
  b.addEventListener("click", onClick);
  return b;
}

function iconButton(name: IconName, title: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", { class: "btn icon-btn", title, "aria-label": title, type: "button" });
  b.innerHTML = icons[name];
  b.addEventListener("click", onClick);
  return b;
}

function workspaceButton(name: keyof typeof workspaceIcons, label: string, action: () => void): HTMLButtonElement {
  const b = button(workspaceIcons[name], label, action, "icon-btn workspace-button");
  b.setAttribute("aria-label", label);
  return b;
}

function wsUrl(path: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${path}`;
}

// ── Touch cursor ───────────────────────────────────────────────────────────

/** Diameter of the fingertip cursor in CSS px. */
const TOUCH_CURSOR_SIZE = 28;

/**
 * Paint the fingertip circle at `scale`× and hand back a PNG data URL — a
 * translucent disc with a light rim and a faint dark halo so it reads on both
 * white and black screens. Rendered at runtime rather than shipped as an SVG
 * cursor: every engine takes PNG cursors, and drawing at the device pixel
 * ratio keeps the rim crisp on HiDPI displays.
 */
function paintTouchCursor(scale: number, pressed: boolean): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = Math.round(TOUCH_CURSOR_SIZE * scale);
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.scale(scale, scale);
  const c = TOUCH_CURSOR_SIZE / 2;
  const r = pressed ? c - 4 : c - 2.5;
  g.beginPath();
  g.arc(c, c, r + 1, 0, Math.PI * 2);
  g.strokeStyle = "rgba(0, 0, 0, 0.35)";
  g.lineWidth = 1.5;
  g.stroke();
  g.beginPath();
  g.arc(c, c, r, 0, Math.PI * 2);
  g.fillStyle = pressed ? "rgba(255, 255, 255, 0.55)" : "rgba(255, 255, 255, 0.25)";
  g.fill();
  g.strokeStyle = "rgba(255, 255, 255, 0.95)";
  g.lineWidth = 1.5;
  g.stroke();
  try {
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

const touchCursorCache = new Map<string, string>();

/**
 * CSS `cursor` value for the fingertip: a 1× / 2× image-set where the engine
 * supports it, a plain 1× PNG otherwise, `crosshair` as the last resort. The
 * hotspot is the disc centre, so the touch lands where the circle sits.
 */
function touchCursorCss(pressed: boolean): string {
  const key = pressed ? "pressed" : "idle";
  const cached = touchCursorCache.get(key);
  if (cached) return cached;
  const hot = TOUCH_CURSOR_SIZE / 2;
  const one = paintTouchCursor(1, pressed);
  const two = paintTouchCursor(2, pressed);
  const probe = document.createElement("span");
  const candidates: string[] = [];
  if (one && two) {
    candidates.push(`image-set(url("${one}") 1x, url("${two}") 2x) ${hot} ${hot}, crosshair`);
    candidates.push(`-webkit-image-set(url("${one}") 1x, url("${two}") 2x) ${hot} ${hot}, crosshair`);
  }
  if (one) candidates.push(`url("${one}") ${hot} ${hot}, crosshair`);
  let value = "crosshair";
  for (const candidate of candidates) {
    probe.style.cursor = candidate;
    if (probe.style.cursor) {
      value = candidate;
      break;
    }
  }
  touchCursorCache.set(key, value);
  return value;
}

// ── Device view ────────────────────────────────────────────────────────────

class DeviceView {
  readonly root: HTMLElement;
  private readonly surfaceWrap: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver;
  private renderWidth = 0;
  private renderHeight = 0;
  private displayScale = 1;
  private img: HTMLImageElement | null = null;
  private readonly statusChip: HTMLElement;
  private readonly fpsChip: HTMLElement;
  private readonly orientationChip: HTMLElement;
  private readonly notice: HTMLElement;
  private pendingOrientation: string | null = null;
  private pendingTimer: number | null = null;
  private noticeTimer: number | null = null;

  private ws: WebSocket | null = null;
  private suspended = false;
  private mjpegRetry: number | null = null;
  private cancelInput: (flushText?: boolean) => void = () => {};
  private closed = false;

  private config: ScreenConfig;
  private decoder: VideoDecoder | null = null;
  private decoderGeneration = 0;
  private lastDescription: Uint8Array | null = null;
  private awaitingKeyframe = true;
  private awaitingSince = 0;
  private streamAbort: AbortController | null = null;
  private framesAtLastAbort = -1;
  private stalledAborts = 0;
  private lastKeyframeRequest = -Infinity;
  private timestamp = 0;
  private framesDecoded = 0;
  private framesPresented = 0;
  private pendingFrame: VideoFrame | null = null;
  private retainedFrame: { source: VideoFrame | ImageBitmap; width: number; height: number } | null = null;
  private paintRaf: number | null = null;
  private presentationDrops = 0;
  /** Wall-clock submit time per frame timestamp, for the decode-latency readout. */
  private readonly submittedAt = new Map<number, number>();
  private decodeLatencyMs = 0;
  private backlogDrops = 0;
  private firstFrameSeen = false;
  private mode: "h264" | "mjpeg" = "mjpeg";
  private frameSize: { width: number; height: number } | null = null;

  private lastMoveSent = 0;
  private pinch: { anchorX: number; anchorY: number } | null = null;
  private textBuffer = "";
  private textFlushTimer: number | null = null;
  private wheelAccumX = 0;
  private wheelAccumY = 0;
  private wheelTimer: number | null = null;
  private darkTheme = true;

  constructor(
    readonly entry: DeviceEntry,
    private readonly preferMjpeg: boolean,
  ) {
    this.config = entry.config ?? { width: 1080, height: 2400, orientation: "portrait", rotation: 0 };

    this.canvas = el("canvas", { class: "screen-canvas" });
    // This canvas is a pure video sink; alpha blending and synchronized
    // compositor hand-off only add work and latency.
    const ctx = this.canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx;

    this.statusChip = el("span", { class: "chip chip-status", text: "connecting" });
    this.fpsChip = el("span", { class: "chip chip-dim chip-fps", text: "– fps" });
    this.orientationChip = el("span", { class: "chip chip-dim", text: this.config.orientation });

    this.notice = el("div", { class: "device-notice hidden" });
    this.surfaceWrap = el("div", { class: "screen-wrap", tabindex: "0" }, this.canvas, this.notice);
    this.setTouchCursor(false);

    this.root = el(
      "section",
      { class: "device", "data-device": entry.device, "aria-label": entry.name },
      el(
        "header",
        { class: "device-head" },
        el("div", { class: "device-title" }, el("strong", { text: entry.name }), el("span", { class: "serial", text: entry.device })),
        el("span", { class: "remote-badge", text: "REMOTE" }),
        el("div", { class: "device-chips" }, this.statusChip, this.fpsChip, this.orientationChip),
      ),
      el("div", { class: "device-frame" }, this.surfaceWrap),
      this.buildControls(),
    );

    this.root.querySelector(".device-frame")!.append(this.root.querySelector(".device-control-sidebar")!);

    const actions = el("div", { class: "device-head-actions" },
      iconButton("camera", "Screenshot", () => window.open(this.entry.screenshotEndpoint, "_blank")),
      iconButton("rotateCcw", "Rotate", () => this.rotateStep(1)),
      workspaceButton("expand", "Fill screen with this device", () => this.root.dispatchEvent(new Event("devicefill"))),
      workspaceButton("close", "Hide from workspace", () => this.root.dispatchEvent(new Event("devicehide"))));
    this.root.querySelector(".device-head")!.append(actions);

    // The encoded frame is much larger than the on-page phone in the common
    // case. Keep the canvas backing store at the pixels the display can
    // actually show instead of repainting millions of invisible pixels.
    this.resizeObserver = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.renderWidth = Math.max(1, Math.round(entry.contentRect.width * dpr));
      this.renderHeight = Math.max(1, Math.round(entry.contentRect.height * dpr));
      // Static screens may never emit another frame after a layout change.
      // Repaint the full-resolution source instead of stretching the old raster.
      if (!this.closed && !this.suspended && this.retainedFrame) this.paintRetainedFrame();
    });
    this.resizeObserver.observe(this.surfaceWrap);

    this.applyAspect();
    this.connectWs();
    this.startStream();
    this.bindInput();
    this.startFpsLoop();
  }

  // ── Layout ───────────────────────────────────────────────────────────────

  /**
   * Shape the stage from the frames actually on screen, falling back to the
   * reported config before the first frame lands. Rotating restarts capture,
   * so the new geometry trails the config push by a beat — reshaping on the
   * push alone would letterbox the old frames inside the new aspect until the
   * stream caught up.
   */
  private applyAspect(): void {
    const { width, height } = this.frameSize ?? this.config;
    if (!(width > 0 && height > 0)) return;
    this.surfaceWrap.style.aspectRatio = `${width} / ${height}`;
    this.surfaceWrap.style.setProperty("--screen-aspect", String(width / height));
    this.root.classList.toggle("landscape", width > height);
  }

  private noteFrameSize(width: number, height: number): void {
    if (!(width > 0 && height > 0)) return;
    if (this.frameSize && this.frameSize.width === width && this.frameSize.height === height) return;
    this.frameSize = { width, height };
    this.applyAspect();
  }

  // ── Controls ─────────────────────────────────────────────────────────────

  private buildControls(): HTMLElement {
    const nav = el("div", { class: "nav-row" });
    nav.append(
      iconButton("back", "Back", () => this.sendButton("back")),
      iconButton("home", "Home", () => this.sendButton("home")),
      iconButton("recents", "Recent apps", () => this.sendButton("app-switch")),
    );

    // The software-keyboard toggle is hidden for now — still available via the
    // WS protocol (0x0c); re-add its iconButton here to restore it.
    const tools = el("div", { class: "tool-row" });
    tools.append(
      // Rotate *the device*, as the orientation names read: turning it left
      // (counter-clockwise) is ROTATION_90 = landscape_left, i.e. +1 here.
      iconButton("rotateCcw", "Rotate left", () => this.rotateStep(1)),
      iconButton("rotateCw", "Rotate right", () => this.rotateStep(-1)),
      iconButton("volumeDown", "Volume down", () => this.sendButton("volume-down")),
      iconButton("volumeUp", "Volume up", () => this.sendButton("volume-up")),
      iconButton("power", "Power", () => this.sendButton("power")),
      iconButton("moon", "Toggle light/dark theme", () => this.toggleTheme()),
      iconButton("camera", "Save screenshot", () => window.open(this.entry.screenshotEndpoint, "_blank")),
    );

    const textPanel = el("details", { class: "text-entry" });
    const input = el("textarea", { class: "input", rows: "2", "aria-label": `Text for ${this.entry.name}`, placeholder: "Type text to send…" });
    const sendText = () => {
      if (!input.value || this.ws?.readyState !== WebSocket.OPEN) {
        if (input.value) this.showNotice("Device disconnected. Text kept for retry.", false);
        return;
      }
      if (/[^\x00-\x7f]/.test(input.value)) {
        this.showNotice("Android text input supports ASCII characters only.", false);
        return;
      }
      this.send(0x0d, { text: input.value });
      input.value = "";
    };
    textPanel.append(el("summary", { text: "Text input" }), input,
      el("p", { class: "muted", text: "ASCII text only. Send inserts text into the focused device field." }),
      el("div", { class: "text-actions" },
        button("Send", "Send text to device", sendText),
        button("Enter", "Press Enter on device", () => this.sendKey("Enter")),
        button("Backspace", "Press Backspace on device", () => this.sendKey("Backspace"))));
    return el("div", { class: "device-controls" }, textPanel,
      el("div", { class: "device-control-sidebar", role: "group", "aria-label": `Device controls for ${this.entry.name}` }, nav, tools));
  }

  /**
   * Step the orientation by `delta` quarter-turns. Steps from the request in
   * flight rather than from `config`, which only advances once the device has
   * actually rotated — otherwise a second click before the device catches up
   * re-sends the orientation already requested.
   */
  private rotateStep(delta: number): void {
    const base = this.pendingOrientation ?? this.config.orientation;
    const idx = Math.max(0, ORIENTATIONS.indexOf(base));
    const next = ORIENTATIONS[(idx + delta + ORIENTATIONS.length) % ORIENTATIONS.length]!;
    this.pendingOrientation = next;
    this.orientationChip.textContent = `${next}…`;
    // Safety net for a dropped socket. Longer than the server's confirmation
    // budget, so the chip doesn't snap back just before the answer arrives.
    if (this.pendingTimer !== null) clearTimeout(this.pendingTimer);
    this.pendingTimer = window.setTimeout(() => this.settleOrientation(), 10_000);
    this.send(0x07, { orientation: next });
  }

  /** Drop any in-flight rotation and show what the device is actually doing. */
  private settleOrientation(): void {
    if (this.pendingTimer !== null) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pendingOrientation = null;
    this.orientationChip.textContent = this.config.orientation;
  }

  /** Transient message over the device frame (rotation refused, etc.). */
  private showNotice(message: string, ok: boolean): void {
    this.notice.textContent = message;
    this.notice.className = `device-notice ${ok ? "" : "error"}`.trim();
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => {
      this.notice.className = "device-notice hidden";
      this.noticeTimer = null;
    }, 4_000);
  }

  private toggleTheme(): void {
    this.darkTheme = !this.darkTheme;
    this.send(0x0e, { theme: this.darkTheme ? "dark" : "light" });
  }

  private sendKey(code: string): void {
    this.send(0x06, { type: "down", code });
    this.send(0x06, { type: "up", code });
  }

  get connected(): boolean {
    return !this.closed && !this.suspended && this.ws?.readyState === WebSocket.OPEN;
  }

  get telemetry(): string {
    return `${this.statusChip.textContent} · ${this.fpsChip.textContent}`;
  }

  sendButton(name: string): void {
    this.send(0x04, { button: name });
  }

  /** The mouse pointer stands in for a fingertip over the screen — show one. */
  private setTouchCursor(pressed: boolean): void {
    this.surfaceWrap.style.cursor = touchCursorCss(pressed);
  }

  /** Stream state readout — `live` colours the dot green. */
  private setStatus(text: string, live: boolean): void {
    this.statusChip.textContent = text;
    this.statusChip.classList.toggle("live", live);
    this.root.dispatchEvent(new Event("devicechange"));
  }

  // ── WebSocket ────────────────────────────────────────────────────────────

  private connectWs(): void {
    if (this.closed || authExpired) return;
    const ws = new WebSocket(wsUrl(this.entry.wsEndpoint));
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.root.dispatchEvent(new Event("devicechange"));
      if (this.suspended) return;
      this.setStatus(this.mode === "h264" ? "H.264" : "MJPEG", true);
    };
    ws.onmessage = (event) => {
      const data = new Uint8Array(event.data as ArrayBuffer);
      if (data.length === 0) return;
      const text = () => new TextDecoder().decode(data.subarray(1));
      if (data[0] === 0x82) {
        try {
          this.config = JSON.parse(text()) as ScreenConfig;
          this.settleOrientation();
          this.applyAspect();
        } catch {}
      } else if (data[0] === 0x83) {
        try {
          const notice = JSON.parse(text()) as { kind: string; ok: boolean; message: string };
          this.showNotice(notice.message, notice.ok);
        } catch {}
      }
    };
    ws.onclose = (event) => {
      if (BOOT.authEnabled) {
        if (event.code === 4001 || event.code === 4401 || event.code === 1008) expireAuthentication();
        else void checkAuthentication().catch(() => {});
      }
      this.root.dispatchEvent(new Event("devicechange"));
      this.cancelInput(false);
      this.ws = null;
      if (!this.closed) {
        this.setStatus("reconnecting", false);
        setTimeout(() => this.connectWs(), 1_000);
      }
    };
    ws.onerror = () => ws.close();
  }

  send(tag: number, body?: unknown): void {
    const json = body === undefined ? new Uint8Array(0) : new TextEncoder().encode(JSON.stringify(body));
    const frame = new Uint8Array(1 + json.length);
    frame[0] = tag;
    frame.set(json, 1);
    if (this.closed || this.suspended || authExpired) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(frame);
    } else {
      this.showNotice("Device disconnected. Try again when connected.", false);
    }
  }

  // ── Streaming ────────────────────────────────────────────────────────────

  private startStream(): void {
    const useH264 = !this.preferMjpeg && this.entry.videoAvailable && isAvccSupported();
    this.mode = useH264 ? "h264" : "mjpeg";
    if (useH264) void this.runAvccStream();
    else this.runMjpegStream();
  }

  private runMjpegStream(): void {
    if (this.closed || this.suspended || authExpired) return;
    if (this.mjpegRetry !== null) clearTimeout(this.mjpegRetry);
    this.mjpegRetry = null;
    this.setStatus("MJPEG", true);
    this.fpsChip.textContent = "stills";
    const img = this.img ?? el("img", { class: "screen-canvas", alt: this.entry.name });
    if (!this.img) {
      this.img = img;
      this.canvas.replaceWith(img);
      img.addEventListener("error", () => {
        if (!this.closed && !this.suspended && this.mjpegRetry === null) {
          this.mjpegRetry = window.setTimeout(() => this.runMjpegStream(), 1_500);
        }
      });
    }
    const connect = () => {
      if (this.closed || this.suspended || authExpired) return;
      img.src = `${this.entry.streamMjpegEndpoint}?t=${Date.now()}`;
    };
    connect();
  }

  private async runAvccStream(): Promise<void> {
    const demuxer = new AvccDemuxer();
    let backoff = 500;
    while (!this.closed && this.mode === "h264") {
      if (this.suspended) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      try {
        this.streamAbort = new AbortController();
        const response = await fetch(this.entry.streamAvccEndpoint, { signal: this.streamAbort.signal });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        this.setStatus("H.264", true);
        backoff = 500;
        demuxer.reset();
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          for (const chunk of demuxer.push(value)) this.onAvccChunk(chunk.type, chunk.payload);
        }
      } catch {
        // fall through to reconnect
      }
      this.teardownDecoder();
      if (this.closed || this.mode !== "h264") return;
      if (this.suspended) continue;
      this.setStatus("reconnecting", false);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 4_000);
    }
  }

  private onAvccChunk(type: "description" | "keyframe" | "delta" | "seed", payload: Uint8Array): void {
    if (this.closed || this.suspended || this.mode !== "h264") return;
    if (type === "seed") {
      // Seeds arrive before the first decoded frame *and* after a rotation, to
      // repaint a stream that has nothing new to encode. paintSeed yields to
      // any real frame that lands while it decodes.
      void this.paintSeed(payload);
      return;
    }
    if (type === "description") {
      if (this.lastDescription && bytesEqual(this.lastDescription, payload) && this.decoder) return;
      this.lastDescription = payload.slice();
      this.configureDecoder(this.lastDescription);
      return;
    }
    let decoder = this.decoder;
    if (!decoder || decoder.state === "closed") return;
    if (this.awaitingKeyframe && type !== "keyframe") return;
    // Once this queue grows, submitting more deltas guarantees that the view
    // stays behind. Reset immediately and ask screenrecord for a fresh IDR;
    // if this chunk already is an IDR, use it as the clean restart point.
    if (decoder.decodeQueueSize > DECODE_BACKLOG_MAX && this.lastDescription) {
      this.backlogDrops++;
      this.configureDecoder(this.lastDescription);
      decoder = this.decoder;
      if (!decoder) return;
      if (type !== "keyframe") {
        this.requestFreshKeyframe();
        return;
      }
    }
    this.awaitingKeyframe = false;
    this.awaitingSince = 0;
    this.timestamp += 33_333;
    this.submittedAt.set(this.timestamp, performance.now());
    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: type === "keyframe" ? "key" : "delta",
          timestamp: this.timestamp,
          data: payload as BufferSource,
        }),
      );
    } catch {
      this.recoverDecoder();
    }
  }

  private configureDecoder(description: Uint8Array): void {
    this.teardownDecoder();
    try {
      const generation = this.decoderGeneration;
      const decoder = new VideoDecoder({
        output: (frame) => {
          if (generation === this.decoderGeneration) this.queueFrame(frame);
          else frame.close();
        },
        error: () => {
          if (generation === this.decoderGeneration) this.recoverDecoder();
        },
      });
      decoder.configure({
        codec: avcCodecString(description),
        description: description as BufferSource,
        optimizeForLatency: true,
      });
      this.decoder = decoder;
      this.awaitingKeyframe = true;
      this.awaitingSince = performance.now();
    } catch {
      this.decoder = null;
      // Give up on WebCodecs for this session — fall back to MJPEG.
      if (!this.firstFrameSeen) {
        this.mode = "mjpeg";
        this.closedStreamFallback();
      }
    }
  }

  private closedStreamFallback(): void {
    if (this.img) return;
    this.streamAbort?.abort();
    this.runMjpegStream();
  }

  private recoverDecoder(): void {
    // Reconfigure from the last description and wait for the next keyframe.
    if (this.lastDescription) this.configureDecoder(this.lastDescription);
    // The keyframe we just choked on is the one the server has cached, so
    // reconnecting would replay it. Ask for a new capture session instead.
    this.requestFreshKeyframe();
  }

  /** Tell the server our stream is undecodable and we need fresh SPS/IDR. */
  private requestFreshKeyframe(): void {
    const now = performance.now();
    if (now - this.lastKeyframeRequest < KEYFRAME_REQUEST_MIN_MS) return;
    this.lastKeyframeRequest = now;
    this.send(0x0f);
  }

  private teardownDecoder(): void {
    this.decoderGeneration++;
    if (this.decoder && this.decoder.state !== "closed") {
      try {
        this.decoder.close();
      } catch {}
    }
    this.decoder = null;
    this.submittedAt.clear();
    if (this.paintRaf !== null) cancelAnimationFrame(this.paintRaf);
    this.paintRaf = null;
    this.pendingFrame?.close();
    this.pendingFrame = null;
  }

  /**
   * WebCodecs can deliver a burst after network or decoder delay. Painting
   * every stale output makes the main thread replay history, so retain only
   * the newest output and present at most once per browser frame.
   */
  private queueFrame(frame: VideoFrame): void {
    const submitted = this.submittedAt.get(frame.timestamp);
    if (submitted !== undefined) {
      this.submittedAt.delete(frame.timestamp);
      this.decodeLatencyMs = performance.now() - submitted;
    }
    this.firstFrameSeen = true;
    this.framesDecoded++;
    this.stalledAborts = 0;
    if (this.pendingFrame) {
      this.pendingFrame.close();
      this.presentationDrops++;
    }
    this.pendingFrame = frame;
    if (this.paintRaf !== null) return;
    this.paintRaf = requestAnimationFrame(() => {
      this.paintRaf = null;
      const latest = this.pendingFrame;
      this.pendingFrame = null;
      if (latest) this.paintFrame(latest);
    });
  }

  private paintFrame(frame: VideoFrame): void {
    const width = frame.displayWidth || frame.codedWidth;
    const height = frame.displayHeight || frame.codedHeight;
    this.noteFrameSize(width, height);
    this.retainFrame(frame, width, height);
    this.framesPresented++;
  }

  private retainFrame(source: VideoFrame | ImageBitmap, width: number, height: number): void {
    this.retainedFrame?.source.close();
    this.retainedFrame = { source, width, height };
    this.paintRetainedFrame();
  }

  private paintRetainedFrame(): void {
    const frame = this.retainedFrame;
    if (!frame) return;
    const raster = this.rasterSize(frame.width, frame.height);
    if (this.canvas.width !== raster.width || this.canvas.height !== raster.height) {
      this.canvas.width = raster.width;
      this.canvas.height = raster.height;
    }
    this.ctx.drawImage(frame.source, 0, 0, raster.width, raster.height);
  }

  /** CSS transforms do not trigger ResizeObserver; zoom still needs a fresh raster. */
  setDisplayScale(scale: number): void {
    if (this.displayScale === scale) return;
    this.displayScale = scale;
    if (!this.closed && !this.suspended && this.retainedFrame) this.paintRetainedFrame();
  }

  private rasterSize(sourceWidth: number, sourceHeight: number): { width: number; height: number } {
    if (!(this.renderWidth > 0 && this.renderHeight > 0)) {
      return { width: sourceWidth, height: sourceHeight };
    }
    const scale = Math.min(1, this.renderWidth * this.displayScale / sourceWidth, this.renderHeight * this.displayScale / sourceHeight);
    return {
      width: Math.max(1, Math.round(sourceWidth * scale)),
      height: Math.max(1, Math.round(sourceHeight * scale)),
    };
  }

  private async paintSeed(payload: Uint8Array): Promise<void> {
    const framesAtStart = this.framesDecoded;
    const generation = this.decoderGeneration;
    try {
      const bitmap = await createImageBitmap(new Blob([payload as BlobPart]));
      if (this.closed || this.suspended || generation !== this.decoderGeneration || this.framesDecoded !== framesAtStart) {
        bitmap.close();
        return;
      }
      this.noteFrameSize(bitmap.width, bitmap.height);
      this.retainFrame(bitmap, bitmap.width, bitmap.height);
    } catch {}
  }

  /** How long to wait on a keyframe before reconnecting — grows while fruitless. */
  private awaitingBudgetMs(): number {
    return Math.min(2_500 * 2 ** this.stalledAborts, 20_000);
  }

  private startFpsLoop(): void {
    let lastCount = 0;
    const tick = () => {
      if (this.closed) return;
      if (this.img) this.noteFrameSize(this.img.naturalWidth, this.img.naturalHeight);
      if (this.mode === "h264" && !this.suspended) {
        const fps = this.framesPresented - lastCount;
        lastCount = this.framesPresented;
        this.fpsChip.textContent = `${fps} fps`;
        // Pipeline health on hover: decode latency, queue depth, catch-ups.
        const queued = this.decoder?.decodeQueueSize ?? 0;
        this.fpsChip.title =
          `decode ${this.decodeLatencyMs.toFixed(0)} ms · ${queued} queued` +
          (this.backlogDrops ? ` · caught up ${this.backlogDrops}×` : "") +
          (this.presentationDrops ? ` · skipped ${this.presentationDrops} stale paints` : "");
        // Watchdog: stuck waiting for a keyframe (we joined mid-restart on a
        // static screen, or a keyframe failed to decode) → reconnect; the fresh
        // GOP replay paints instantly. Retries back off instead of stopping
        // after one fruitless attempt: screenrecord may not emit another IDR
        // for minutes, so a viewer that gives up stays frozen that whole time.
        // The backoff is what keeps a genuinely idle stream from flapping.
        if (this.awaitingSince && performance.now() - this.awaitingSince > this.awaitingBudgetMs()) {
          this.stalledAborts = this.framesDecoded === this.framesAtLastAbort ? this.stalledAborts + 1 : 0;
          this.awaitingSince = 0;
          this.framesAtLastAbort = this.framesDecoded;
          // Reconnecting replays the cached GOP; if that already failed us
          // once, the cache itself is the problem — ask for a new one.
          if (this.stalledAborts > 0) this.requestFreshKeyframe();
          this.streamAbort?.abort();
        }
      }
      setTimeout(tick, 1_000);
    };
    setTimeout(tick, 1_000);
  }

  // ── Input ────────────────────────────────────────────────────────────────

  private surfacePoint(event: PointerEvent | WheelEvent): { x: number; y: number } {
    const surface = this.img ?? this.canvas;
    const rect = surface.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  }

  private bindInput(): void {
    const surface = this.surfaceWrap;
    let pointer: number | null = null;
    let lastPoint = { x: 0, y: 0 };
    const finish = () => {
      if (pointer === null) return;
      const id = pointer;
      pointer = null;
      this.setTouchCursor(false);
      const p = lastPoint;
      if (this.pinch) {
        this.send(0x05, { type: "end", x1: p.x, y1: p.y,
          x2: Math.min(1, Math.max(0, 2 * this.pinch.anchorX - p.x)),
          y2: Math.min(1, Math.max(0, 2 * this.pinch.anchorY - p.y)) });
        this.pinch = null;
      } else this.send(0x03, { type: "end", x: p.x, y: p.y });
      if (surface.hasPointerCapture(id)) surface.releasePointerCapture(id);
    };
    const heldKeys = new Set<string>();
    this.cancelInput = (flushText = true) => {
      if (flushText) this.flushText();
      finish();
      for (const code of heldKeys) this.send(0x06, { type: "up", code });
      heldKeys.clear();
      if (this.textFlushTimer !== null) clearTimeout(this.textFlushTimer);
      if (this.wheelTimer !== null) clearTimeout(this.wheelTimer);
      this.textFlushTimer = this.wheelTimer = null;
      this.textBuffer = "";
      this.wheelAccumX = this.wheelAccumY = 0;
    };
    surface.addEventListener("blur", () => this.cancelInput());
    surface.addEventListener("contextmenu", (e) => e.preventDefault());

    surface.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || pointer !== null || this.suspended || this.ws?.readyState !== WebSocket.OPEN) return;
      pointer = e.pointerId;
      e.preventDefault();
      surface.focus();
      surface.setPointerCapture(e.pointerId);
      this.setTouchCursor(true);
      const p = this.surfacePoint(e);
      lastPoint = p;
      if (e.altKey) {
        this.pinch = { anchorX: p.x, anchorY: p.y };
        this.send(0x05, { type: "begin", x1: p.x, y1: p.y, x2: p.x, y2: p.y });
      } else {
        this.send(0x03, { type: "begin", x: p.x, y: p.y });
      }
    });

    surface.addEventListener("pointermove", (e) => {
      if (pointer !== e.pointerId) return;
      const now = performance.now();
      if (now - this.lastMoveSent < MOVE_INTERVAL_MS) return;
      this.lastMoveSent = now;
      const p = this.surfacePoint(e);
      lastPoint = p;
      if (this.pinch) {
        const mirrored = {
          x: Math.min(1, Math.max(0, 2 * this.pinch.anchorX - p.x)),
          y: Math.min(1, Math.max(0, 2 * this.pinch.anchorY - p.y)),
        };
        this.send(0x05, { type: "move", x1: p.x, y1: p.y, x2: mirrored.x, y2: mirrored.y });
      } else {
        this.send(0x03, { type: "move", x: p.x, y: p.y });
      }
    });

    const endPointer = (e: PointerEvent) => {
      if (pointer !== e.pointerId) return;
      if (e.type === "pointerup") lastPoint = this.surfacePoint(e);
      finish();
    };
    surface.addEventListener("pointerup", endPointer);
    surface.addEventListener("pointercancel", endPointer);
    surface.addEventListener("lostpointercapture", endPointer);

    surface.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        if (this.suspended || this.ws?.readyState !== WebSocket.OPEN) return;
        const surfaceEl = this.img ?? this.canvas;
        const rect = surfaceEl.getBoundingClientRect();
        this.wheelAccumX += e.deltaX / rect.width;
        this.wheelAccumY += e.deltaY / rect.height;
        if (this.wheelTimer != null) return;
        this.wheelTimer = window.setTimeout(() => {
          this.wheelTimer = null;
          const p = this.surfacePoint(e);
          const dx = this.wheelAccumX;
          const dy = this.wheelAccumY;
          this.wheelAccumX = 0;
          this.wheelAccumY = 0;
          if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
            this.send(0x0b, { dx, dy, x: p.x, y: p.y });
          }
        }, 80);
      },
      { passive: false },
    );

    surface.addEventListener("keydown", (e) => {
      if (this.suspended || this.ws?.readyState !== WebSocket.OPEN) return;
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === "KeyH") {
        e.preventDefault();
        this.sendButton("home");
        return;
      }
      if (e.metaKey || e.ctrlKey) return; // let browser shortcuts through
      if (e.key.length === 1 && !e.altKey) {
        e.preventDefault();
        this.textBuffer += e.key;
        this.scheduleTextFlush();
        return;
      }
      const SPECIAL = [
        "Enter",
        "Backspace",
        "Tab",
        "Escape",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Delete",
        "Home",
        "End",
        "PageUp",
        "PageDown",
      ];
      if (SPECIAL.includes(e.code) || /^F\d{1,2}$/.test(e.code)) {
        e.preventDefault();
        this.flushText();
        heldKeys.add(e.code);
        this.send(0x06, { type: "down", code: e.code });
      }
    });
    surface.addEventListener("keyup", (e) => {
      if (heldKeys.delete(e.code)) this.send(0x06, { type: "up", code: e.code });
    });
  }

  private scheduleTextFlush(): void {
    if (this.textFlushTimer != null) return;
    this.textFlushTimer = window.setTimeout(() => {
      this.textFlushTimer = null;
      this.flushText();
    }, 120);
  }

  private flushText(): void {
    if (this.textFlushTimer != null) {
      clearTimeout(this.textFlushTimer);
      this.textFlushTimer = null;
    }
    if (!this.textBuffer) return;
    const text = this.textBuffer;
    this.textBuffer = "";
    this.send(0x0d, { text });
  }

  cancelInteraction(): void {
    this.cancelInput();
  }

  setSuspended(suspended: boolean): void {
    if (this.suspended === suspended) return;
    this.cancelInput();
    this.suspended = suspended;
    this.root.dispatchEvent(new Event("devicechange"));
    if (suspended) {
      this.streamAbort?.abort();
      this.awaitingSince = 0;
      if (this.mjpegRetry !== null) clearTimeout(this.mjpegRetry);
      this.mjpegRetry = null;
      this.teardownDecoder();
      if (this.img) this.img.removeAttribute("src");
      this.setStatus("paused", false);
    } else if (this.mode === "mjpeg") this.runMjpegStream();
  }

  destroy(): void {
    this.cancelInput(false);
    this.closed = true;

    this.streamAbort?.abort();
    if (this.mjpegRetry !== null) clearTimeout(this.mjpegRetry);
    this.resizeObserver.disconnect();
    this.teardownDecoder();
    this.retainedFrame?.source.close();
    this.retainedFrame = null;
    this.ws?.close();
    if (this.img) this.img.src = "";
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ── Panes ──────────────────────────────────────────────────────────────────

class Panes {
  readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly identity: HTMLElement;
  private readonly groupState = new Map<string, boolean>();
  private controlsFilter = "";
  private readonly controlState = new Map<string, Record<string, unknown>>();
  private readonly controlQueues = new Map<string, Promise<unknown>>();
  private renderGeneration = 0;
  private readonly tabs = new Map<string, HTMLButtonElement>();
  private active: string | null = null;
  private logsSource: EventSource | null = null;
  private eventsSource: EventSource | null = null;
  private logsPaused = false;
  private logsFilter = "";

  constructor(
    private readonly api: ApiState,
    private readonly deviceViews: () => DeviceView[],
    private readonly attachDevice: (name: string) => Promise<void>,
    private readonly selectedDevice: () => string | null,
  ) {
    this.body = el("div", { class: "pane-body" });
    this.identity = el("div", { class: "inspector-identity" });
    const tabBar = el("div", { class: "pane-tabs", "aria-label": "Inspector sections" });
    for (const name of ["devices", "tools", "logs"]) {
      const tab = el("button", { class: "pane-tab", type: "button", text: name === "tools" ? "Controls" : name === "logs" ? "Logcat" : "Devices", "data-pane": name, "aria-pressed": "false" });
      tab.addEventListener("click", () => this.open(name));
      this.tabs.set(name, tab);
      tabBar.append(tab);
    }
    this.root = el("aside", { class: "panes inspector hidden", "aria-label": "Inspector" }, this.identity, tabBar, this.body);
  }

  get visible(): boolean { return this.active !== null; }
  get activePane(): string | null { return this.active; }

  close(): void {
    this.active = null;
    this.renderGeneration++;
    this.root.classList.add("hidden");
    this.tabs.forEach((tab) => { tab.classList.remove("active"); tab.setAttribute("aria-pressed", "false"); });
    this.stopStreams();
    this.root.dispatchEvent(new CustomEvent("inspectorchange", { bubbles: true }));
  }

  toggle(name: string): void {
    if (this.active === name) this.close();
    else this.open(name);
  }

  open(name: string): void {
    this.active = name;
    this.renderGeneration++;
    const target = this.targetView();
    this.identity.replaceChildren(el("span", { class: "inspector-eyebrow", text: "Inspecting" }),
      el("strong", { text: target?.entry.name ?? "No device selected" }),
      el("span", { class: "serial", text: target?.entry.device ?? "Attach a device to begin" }));
    this.root.classList.remove("hidden");
    this.tabs.forEach((tab, key) => {
      tab.classList.toggle("active", key === name);
      tab.setAttribute("aria-pressed", String(key === name));
      tab.hidden = key === "devices" && name !== "devices";
    });
    this.stopStreams();
    this.body.replaceChildren();
    if (name === "devices") void this.renderDevices();
    if (name === "tools") this.renderTools();
    if (name === "logs") this.renderLogs();
    this.root.dispatchEvent(new CustomEvent("inspectorchange", { bubbles: true }));
  }

  refreshTarget(): void {
    if (this.active) this.open(this.active);
  }

  private stopStreams(): void {
    this.logsSource?.close();
    this.logsSource = null;
    this.eventsSource?.close();
    this.eventsSource = null;
  }

  private async renderDevices(): Promise<void> {
    const generation = this.renderGeneration;
    this.body.replaceChildren(el("p", { class: "muted", text: "Loading devices…" }));
    try {
      const res = await fetch(this.api.gridApiEndpoint);
      const grid = (await res.json()) as {
        devices: Array<{ serial: string; state: string; model?: string; attached: boolean }>;
        avds: Array<{ name: string; running: boolean }>;
      };
      const list = el("div", { class: "grid-list" });
      list.append(el("h3", { text: "Connected" }));
      if (grid.devices.length === 0) list.append(el("p", { class: "muted", text: "No devices connected." }));
      for (const device of grid.devices) {
        const row = el(
          "div",
          { class: "grid-row" },
          el("div", {}, el("strong", { text: device.model ?? device.serial }), el("span", { class: "serial", text: ` ${device.serial}` })),
        );
        if (device.attached) row.append(el("span", { class: "chip", text: "streaming" }));
        else if (device.state === "device") {
          if (account?.role !== "operator") row.append(button("Attach", `Attach ${device.serial}`, () => void this.startAndReload(device.serial)));
          else row.append(el("span", { class: "chip chip-dim", text: "Admin required" }));
        }
        else row.append(el("span", { class: "chip chip-dim", text: device.state }));
        list.append(row);
      }
      list.append(el("h3", { text: "AVDs" }));
      if (grid.avds.length === 0) list.append(el("p", { class: "muted", text: "No AVDs configured." }));
      for (const avd of grid.avds) {
        const row = el("div", { class: "grid-row" }, el("div", {}, el("strong", { text: avd.name.replace(/_/g, " ") })));
        row.append(
          avd.running
            ? el("span", { class: "chip", text: "running" })
            : account?.role === "operator" ? el("span", { class: "chip chip-dim", text: "Admin required" }) : button("Boot", `Boot ${avd.name}`, () => void this.startAndReload(avd.name)),
        );
        list.append(row);
      }
      if (generation === this.renderGeneration) this.body.replaceChildren(list);
    } catch {
      if (generation === this.renderGeneration) this.body.replaceChildren(el("p", { class: "muted", text: "Failed to load device list." }));
    }
  }

  private async startAndReload(device: string): Promise<void> {
    const generation = this.renderGeneration;
    this.body.replaceChildren(el("p", { class: "muted", text: `Starting ${device}… (booting can take a minute)` }));
    try {
      await this.attachDevice(device);
      if (this.active === "devices") void this.renderDevices();
    } catch (error) {
      if (generation !== this.renderGeneration) return;
      this.body.replaceChildren(el("p", { class: "tool-status error", role: "alert", text: error instanceof Error ? error.message : String(error) }),
        button("Retry", `Retry attaching ${device}`, () => void this.startAndReload(device)),
        button("Back to devices", "Reload available devices", () => void this.renderDevices()));
    }
  }

  private targetView(): DeviceView | null {
    return this.deviceViews().find((view) => view.entry.device === this.selectedDevice()) ?? null;
  }

  private renderTools(): void {
    const generation = this.renderGeneration;
    const target = this.targetView();
    const wrap = el("div", { class: "tools" });
    if (!target) {
      wrap.append(el("p", { class: "muted", text: "Attach or select a device to use its controls." }));
      this.body.replaceChildren(wrap);
      return;
    }

    this.renderEmulatorControls(wrap, () => target);

    const log = el("div", { class: "event-log" });
    wrap.append(el("h3", { text: "Recent actions" }), log);
    const push = (entry: EventLogEntry) => {
      if (entry.device && entry.device !== target.entry.device) return;
      const line = el("div", { class: `event ${entry.status === "error" ? "error" : ""}` });
      line.textContent = `${new Date(entry.timestamp).toLocaleTimeString()}  ${entry.summary}`;
      log.append(line);
      while (log.childElementCount > 200) log.firstElementChild?.remove();
      log.scrollTop = log.scrollHeight;
    };
    this.eventsSource = new EventSource(this.api.eventLogEventsEndpoint);
    this.eventsSource.onmessage = (event) => {
      if (generation !== this.renderGeneration) return;
      try {
        const data = JSON.parse(event.data) as { events?: EventLogEntry[]; event?: EventLogEntry };
        if (data.events) data.events.forEach(push);
        if (data.event) push(data.event);
      } catch {}
    };

    this.organizeControls(wrap);
  }

  private organizeControls(wrap: HTMLElement): void {
    const search = el("input", { class: "input inspector-search", type: "search", placeholder: "Find a control — battery, gps, wifi…", "aria-label": "Find a control" });
    search.value = this.controlsFilter;
    const groups = el("div", { class: "inspector-groups" });
    const aliases: Record<string, string> = { Location: "gps latitude longitude", Network: "wifi airplane connectivity mobile data latency speed delay", Apps: "app package deep link launch stop clear", Battery: "battery power charging ac", Accessibility: "accessibility font contrast talkback", "Render debugging": "overdraw gpu layout bounds taps pointer animations debug" };
    let current: HTMLDetailsElement | null = null;
    for (const child of Array.from(wrap.children)) {
      if (child.tagName === "H3") {
        const title = child.textContent ?? "Controls";
        current = el("details", { class: "inspector-group", "data-group": title });
        current.open = this.groupState.get(title) ?? (title === "Quick actions" || title === "Network" || title === "Apps");
        current.append(el("summary", {}, el("span", { text: title }), el("span", { class: "inspector-group-summary" })));
        const group = current;
        group.addEventListener("toggle", () => { if (!search.value) this.groupState.set(title, group.open); });
        groups.append(group);
      } else if (current && !child.classList.contains("tool-status")) {
        let content = current.querySelector<HTMLElement>(".inspector-group-body");
        if (!content) { content = el("div", { class: "inspector-group-body" }); current.append(content); }
        content.append(child);
      }
    }
    const updateSummaries = () => {
      for (const group of Array.from(groups.children) as HTMLDetailsElement[]) {
        const value = group.querySelector<HTMLElement>("[data-summary]")?.dataset.summary ?? "";
        const label = group.querySelector<HTMLElement>(".inspector-group-summary");
        if (label) { label.textContent = value; label.title = value; }
      }
    };
    groups.addEventListener("inspector-summary", updateSummaries);
    updateSummaries();
    const order = ["Quick actions", "Network", "Battery", "Location", "Apps", "Render debugging", "Telephony & sensors", "Accessibility", "Snapshots", "Recent actions"];
    for (const title of order) {
      const group = Array.from(groups.children).find((element) => (element as HTMLElement).dataset.group === title);
      if (group) groups.append(group);
    }
    const empty = el("p", { class: "muted inspector-empty", text: "No matching controls." });
    const applyFilter = () => {
      this.controlsFilter = search.value;
      const query = search.value.trim().toLowerCase();
      let shown = 0;
      for (const group of Array.from(groups.children) as HTMLDetailsElement[]) {
        const title = group.dataset.group ?? "";
        const searchable = `${group.textContent} ${aliases[title] ?? ""} ${Array.from(group.querySelectorAll("input,select,button")).map((element) => `${element.getAttribute("placeholder") ?? ""} ${element.getAttribute("title") ?? ""}`).join(" ")}`.toLowerCase();
        group.hidden = !!query && !searchable.includes(query);
        if (!group.hidden) shown++;
        group.open = query ? !group.hidden : (this.groupState.get(title) ?? (title === "Quick actions" || title === "Network" || title === "Apps"));
      }
      empty.hidden = shown > 0;
    };
    search.addEventListener("input", applyFilter);
    const status = wrap.querySelector(".tool-status");
    this.body.replaceChildren(el("div", { class: "inspector-search-wrap" }, search), groups, empty);
    if (status) this.body.append(status);
    applyFilter();
  }

  /**
   * Emulator controls: every row posts to the device's `/action` endpoint —
   * the same RPC the CLI, MCP tools and SDK use — so the Recent-actions log
   * below reflects it and scripts can reproduce it.
   */
  private renderEmulatorControls(wrap: HTMLElement, target: () => DeviceView | null): void {
    const view = target();
    if (!view) return;
    const generation = this.renderGeneration;
    const device = view.entry.device;
    const state = this.controlState.get(device) ?? {};
    this.controlState.set(device, state);
    const current = () => generation === this.renderGeneration;
    const status = el("div", { class: "tool-status", role: "status", "aria-live": "polite" });
    let statusTimer: number | null = null;
    const flash = (message: string, error = false) => {
      if (!current()) return;
      status.textContent = message;
      status.classList.toggle("error", error);
      if (statusTimer) window.clearTimeout(statusTimer);
      statusTimer = window.setTimeout(() => { status.textContent = ""; }, 4_000);
    };
    // Queue commands for each device so a late initial read cannot undo a setting.
    const run = (action: string, params: Record<string, unknown>, okMessage?: string): Promise<unknown> => {
      const request = async () => {
        try {
          const res = await fetch(view.entry.actionEndpoint, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, params }),
          });
          const body = (await res.json()) as { ok: boolean; result?: unknown; message?: string; error?: string };
          if (!res.ok || !body.ok) { flash(body.message ?? body.error ?? `${action} failed`, true); return null; }
          if (okMessage) flash(okMessage);
          return body.result ?? {};
        } catch (err) { flash(err instanceof Error ? err.message : String(err), true); return null; }
      };
      const result = (this.controlQueues.get(device) ?? Promise.resolve()).then(request);
      this.controlQueues.set(device, result);
      return result;
    };
    const field = (placeholder: string, opts: { type?: string; value?: string; width?: number; min?: string; max?: string; step?: string } = {}) =>
      el("input", { class: "input tool-input", placeholder, "aria-label": placeholder, type: opts.type ?? "text", value: opts.value,
        min: opts.min, max: opts.max, step: opts.step, style: opts.width ? `width:${opts.width}px` : undefined }) as HTMLInputElement;
    const row = (...children: Array<Node | string | null | undefined>) => el("div", { class: "tool-form-row" }, ...children);
    const small = (label: string, title: string, fn: () => void) => button(label, title, fn, "small");
    const select = (options: Array<[string, string]>, value?: string, label = "Control setting") => {
      const input = el("select", { class: "select tool-input", "aria-label": label }) as HTMLSelectElement;
      for (const [value, text] of options) input.append(el("option", { value, text }));
      if (value != null) input.value = value;
      return input;
    };
    const forms = new Map<string, HTMLElement>();
    const section = (title: string, ...rows: HTMLElement[]) => {
      const form = el("div", { class: "tool-form", "data-summary": "" }, ...rows);
      forms.set(title, form);
      wrap.append(el("h3", { text: title }), form);
    };
    const summary = (title: string, value: string) => {
      const form = forms.get(title);
      if (!form) return;
      form.dataset.summary = value;
      form.dispatchEvent(new Event("inspector-summary", { bubbles: true }));
    };
    const onEnter = (input: HTMLInputElement, fn: () => void) => input.addEventListener("keydown", (e) => { if (e.key === "Enter") fn(); });
    const segmented = (label: string, options: Array<[string, string]>, value: string | undefined, apply: (value: string) => Promise<boolean>) => {
      const group = el("div", { class: "inspector-segmented", role: "group", "aria-label": label });
      const buttons = new Map<string, HTMLButtonElement>();
      const set = (next?: string) => { for (const [value, button] of buttons) button.setAttribute("aria-pressed", String(value === next)); };
      for (const [value, text] of options) {
        const control = small(text, `${label}: ${text}`, () => {
          for (const button of buttons.values()) button.disabled = true;
          void apply(value).then((ok) => { if (ok) set(value); }).finally(() => { for (const button of buttons.values()) button.disabled = false; });
        });
        buttons.set(value, control); group.append(control);
      }
      set(value);
      return { group, set };
    };
    const setting = (label: string, content: HTMLElement) => el("div", { class: "control-field" }, el("span", { text: label }), content);
    const toggle = (label: string, key: string, apply: (value: boolean) => Promise<boolean>) => {
      const box = el("input", { type: "checkbox", role: "switch", "aria-label": label }) as HTMLInputElement;
      const set = (value: unknown) => {
        box.indeterminate = typeof value !== "boolean";
        box.checked = value === true;
        box.title = box.indeterminate ? "Current state unavailable. Click to set." : "";
      };
      set(state[key]);
      box.addEventListener("change", () => {
        const next = box.checked;
        set(state[key]); box.disabled = true;
        void apply(next).then((ok) => { if (ok) state[key] = next; set(state[key]); }).finally(() => { box.disabled = false; });
      });
      return { box, set, label: el("label", { class: "flag" }, box, ` ${label}`) };
    };

    const quick = el("div", { class: "tool-grid" });
    const actionIcon = (paths: string) => `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
    const quickAction = (label: string, icon: string, action: string, params: Record<string, unknown>) => {
      const control = button(`${icon}<span>${label}</span>`, label, () => void run(action, params, label));
      control.classList.add("inspector-quick-action"); quick.append(control);
    };
    quickAction("Wake", icons.power, "button", { button: "wake" });
    quickAction("Lock", actionIcon('<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>'), "button", { button: "lock" });
    quickAction("Notifications", actionIcon('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>'), "button", { button: "notifications" });
    quickAction("Quick settings", actionIcon('<path d="M4 7h16M4 17h16"/><circle cx="8" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>'), "button", { button: "quick-settings" });
    const screenshot = button(`${icons.camera}<span>Screenshot</span>`, "Screenshot", () => window.open(view.entry.screenshotEndpoint, "_blank"));
    screenshot.classList.add("inspector-quick-action"); quick.append(screenshot);
    quickAction("Low memory", actionIcon('<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/>'), "memory-warning", {});
    section("Quick actions", quick);

    const networkSummary = () => summary("Network", `${state.speedLabel ?? "Unknown speed"} · ${state.delayLabel ?? "Unknown latency"}`);
    const speed = segmented("Network speed", [["full", "Full"], ["lte", "LTE"], ["umts", "3G"], ["edge", "Edge"], ["off", "Off"]], state.speed as string | undefined, async (value) => {
      // Off switches mobile data off; emulator speed 0 can mean unlimited.
      const result = await run("network", value === "off" ? { data: false } : { speed: value, data: true }, value === "off" ? "Mobile data off (Wi-Fi unchanged)" : `Network speed ${value}`);
      if (result == null) return false;
      state.speed = value; state.speedLabel = value === "umts" ? "3G" : value === "off" ? "Mobile off" : value === "full" ? "Full" : value === "lte" ? "LTE" : "Edge";
      state.data = value !== "off"; data.set(state.data); networkSummary(); return true;
    });
    speed.group.querySelector<HTMLButtonElement>('button:last-child')!.title = "Disable mobile data; Wi-Fi is controlled separately";
    const delay = segmented("Network latency", [["none", "None"], ["50", "50 ms"], ["200", "200 ms"], ["1000", "1 s"]], state.delay as string | undefined, async (value) => {
      const result = await run("network", { delay: value }, `Latency ${value === "none" ? "0" : value} ms`);
      if (result == null) return false;
      state.delay = value; state.delayLabel = value === "none" ? "0 ms" : value === "1000" ? "1 s" : `${value} ms`; networkSummary(); return true;
    });
    const networkToggle = (label: string, key: string) => toggle(label, key, async (on) => {
      const result = await run("network", { [key]: on }, `${label} ${on ? "on" : "off"}`);
      if (result == null) return false;
      if (key === "data") { state.speed = undefined; state.speedLabel = on ? "Unknown speed" : "Mobile off"; speed.set(); networkSummary(); }
      return true;
    });
    const wifi = networkToggle("Wi-Fi", "wifi"), data = networkToggle("Mobile data", "data"), airplane = networkToggle("Airplane mode", "airplane");
    section("Network", setting("Speed profile", speed.group), setting("Added latency", delay.group), row(wifi.label, data.label, airplane.label));
    networkSummary();
    void run("network", {}).then((result) => {
      const network = result as { airplane?: boolean; wifi?: boolean; data?: boolean } | null;
      if (!network) return;
      for (const [control, key] of [[airplane, "airplane"], [wifi, "wifi"], [data, "data"]] as const) {
        if (typeof network[key] === "boolean") { state[key] = network[key]; control.set(network[key]); }
      }
      if (network.data === false) { state.speed = state.speed === "off" ? "off" : undefined; state.speedLabel = "Mobile off"; speed.set(state.speed as string | undefined); }
      else if (network.data === true && state.speed === "off") { state.speed = undefined; state.speedLabel = "Unknown speed"; speed.set(); }
      networkSummary();
    });

    const level = field("Battery level", { type: "range", min: "0", max: "100", step: "1", value: String(state.batteryLevel ?? 50) });
    const levelText = el("output", { class: "inspector-battery-value", text: typeof state.batteryLevel === "number" ? `${state.batteryLevel}%` : "Unknown" });
    level.disabled = typeof state.batteryLevel !== "number";
    const power = segmented("Power source", [["ac", "AC"], ["none", "Battery"]], state.batteryPlugged as string | undefined, async (plugged) => {
      const result = await run("battery", { plugged }, plugged === "ac" ? "Charging (AC)" : "Unplugged");
      if (result == null) return false; setBattery(result); return true;
    });
    const setBattery = (result: unknown) => {
      const battery = result as { level?: number | null; plugged?: string; status?: string | null };
      if (typeof battery.level === "number") { state.batteryLevel = battery.level; level.value = String(battery.level); levelText.textContent = `${battery.level}%`; level.disabled = false; }
      else { delete state.batteryLevel; levelText.textContent = "Unknown"; level.disabled = false; }
      state.batteryPlugged = battery.plugged; power.set(battery.plugged);
      const source = battery.plugged === "none" ? "Battery" : battery.plugged?.toUpperCase() ?? "Unknown source";
      summary("Battery", `${typeof battery.level === "number" ? `${battery.level}%` : "Unknown"} · ${source}`);
    };
    level.addEventListener("input", () => { levelText.textContent = `${level.value}%`; });
    level.addEventListener("change", () => {
      const value = Number(level.value); level.disabled = true;
      void run("battery", { level: value }, `Battery ${value}%`).then((result) => {
        if (result != null) setBattery(result);
        else { level.value = String(state.batteryLevel ?? 50); levelText.textContent = typeof state.batteryLevel === "number" ? `${state.batteryLevel}%` : "Unknown"; }
      }).finally(() => { level.disabled = false; });
    });
    section("Battery", row(el("span", { class: "inspector-control-caption", text: "Level" }), levelText), row(level),
      setting("Power source", power.group), row(small("Reset", "Restore real battery reporting", () => void run("battery", { reset: true }, "Battery reset").then((result) => { if (result != null) setBattery(result); }))));
    summary("Battery", typeof state.batteryLevel === "number" ? `${state.batteryLevel}% · ${state.batteryPlugged === "none" ? "Battery" : String(state.batteryPlugged ?? "Unknown").toUpperCase()}` : "Unknown");
    void run("battery", {}).then((result) => { if (result != null) setBattery(result); else level.disabled = false; });

    const lat = field("Latitude", { type: "number", step: "any", min: "-90", max: "90", value: state.latitude as string | undefined });
    const lon = field("Longitude", { type: "number", step: "any", min: "-180", max: "180", value: state.longitude as string | undefined });
    const presets = el("div", { class: "inspector-location-presets", role: "group", "aria-label": "Location presets" });
    for (const [label, latitude, longitude] of [["Googleplex", "37.4220", "-122.0841"], ["London", "51.5074", "-0.1278"], ["Tokyo", "35.6762", "139.6503"]] as const) {
      presets.append(small(label, `Choose ${label} coordinates`, () => { lat.value = latitude!; lon.value = longitude!; rememberLocation(); }));
    }
    const rememberLocation = () => { state.latitude = lat.value; state.longitude = lon.value; };
    lat.addEventListener("input", rememberLocation); lon.addEventListener("input", rememberLocation);
    const setGeo = () => {
      const latitude = Number(lat.value), longitude = Number(lon.value);
      if (!lat.value || !lon.value || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
        flash("Enter a latitude from −90 to 90 and longitude from −180 to 180.", true); return;
      }
      void run("geo", { lat: latitude, lon: longitude }, `Location ${lat.value}, ${lon.value}`).then((result) => {
        if (result == null) return; state.locationSummary = `${latitude}, ${longitude}`; summary("Location", String(state.locationSummary));
      });
    };
    onEnter(lat, setGeo); onEnter(lon, setGeo);
    section("Location", presets, row(lat, lon), row(small("Send location", "Send a GPS fix (adb emu geo fix)", setGeo)));
    summary("Location", String(state.locationSummary ?? "No location sent"));

    const url = field("https://… or myapp://…", { value: state.url as string | undefined });
    const pkg = field("App package", { value: state.package as string | undefined });
    url.addEventListener("input", () => { state.url = url.value; });
    pkg.addEventListener("input", () => { state.package = pkg.value; summary("Apps", pkg.value); });
    const openUrl = () => { if (url.value) void run("open", { url: url.value }, `Opened ${url.value}`); };
    onEnter(url, openUrl);
    section("Apps", setting("Package", pkg), row(
      small("Launch", "Launch the app", () => { if (pkg.value) void run("launch", { package: pkg.value }, `Launched ${pkg.value}`); }),
      small("Stop", "Force-stop the app", () => { if (pkg.value) void run("stop", { package: pkg.value }, `Stopped ${pkg.value}`); }),
      small("Clear", "Clear the app's data", () => { if (pkg.value) void run("clear-data", { package: pkg.value }, `Cleared ${pkg.value}`); })),
      setting("Deep link / URL", row(url, small("Open", "Open a URL / deep link", openUrl))));
    summary("Apps", pkg.value);
    void fetch(view.entry.foregroundEndpoint).then(async (res) => {
      if (!res.ok) return;
      const foreground = await res.json() as { packageName?: string };
      if (!pkg.value && foreground.packageName) { pkg.value = foreground.packageName; state.package = pkg.value; summary("Apps", pkg.value); }
    }).catch(() => {});

    const debugFlags: Record<string, string> = { overdraw: "Show overdraw", "gpu-profile": "GPU profile bars", "layout-bounds": "Layout bounds", "show-taps": "Show taps", "pointer-location": "Pointer location", "slow-animations": "Slow animations (×5)" };
    const debug = new Map<string, ReturnType<typeof toggle>>();
    const debugSummary = () => {
      const known = Object.keys(debugFlags).filter((key) => typeof state[`debug:${key}`] === "boolean");
      summary("Render debugging", `${known.filter((key) => state[`debug:${key}`] === true).length} on${known.length < Object.keys(debugFlags).length ? " · Unknown state" : ""}`);
    };
    for (const [option, label] of Object.entries(debugFlags)) debug.set(option, toggle(label, `debug:${option}`, async (enabled) => {
      const result = await run("debug", { option, enabled }, `${label} ${enabled ? "on" : "off"}`);
      if (result == null) return false; state[`debug:${option}`] = enabled; debugSummary(); return true;
    }));
    section("Render debugging", row(...Array.from(debug.values()).map((control) => control.label))); debugSummary();
    void run("debug", {}).then((result) => {
      const flags = (result as { flags?: Record<string, boolean> } | null)?.flags;
      if (!flags) return;
      for (const [key, control] of debug) { state[`debug:${key}`] = flags[key]; control.set(flags[key]); }
      debugSummary();
    });

    const number = field("Phone number", { value: String(state.phoneNumber ?? "5551234567") });
    const smsText = field("SMS text", { value: state.sms as string | undefined });
    number.addEventListener("input", () => { state.phoneNumber = number.value; }); smsText.addEventListener("input", () => { state.sms = smsText.value; });
    section("Telephony & sensors", row(number,
      small("Call", "Incoming call", () => void run("call", { number: number.value, op: "call" }, `Calling from ${number.value}`)),
      small("End", "End the call", () => void run("call", { number: number.value, op: "end" }, "Call ended"))),
      row(smsText, small("Send SMS", "Deliver an incoming SMS", () => void run("sms", { number: number.value, text: smsText.value }, "SMS delivered"))),
      row(small("Touch fingerprint sensor", "Touch the fingerprint sensor (finger 1)", () => void run("fingerprint", { id: 1 }, "Fingerprint touched"))));

    const fontScale = select([["", "Current scale unknown"], ["0.85", "0.85×"], ["1", "1.0×"], ["1.15", "1.15×"], ["1.3", "1.3×"], ["1.5", "1.5×"], ["2", "2.0×"]], typeof state.fontScale === "number" ? String(state.fontScale) : "", "Font scale");
    const syncFont = (scale: unknown) => {
      if (typeof scale !== "number" || !Number.isFinite(scale)) return;
      state.fontScale = scale; state.largeText = scale >= 1.3; fontScale.value = String(scale); largeText.set(state.largeText);
    };
    fontScale.addEventListener("change", () => {
      const previous = state.fontScale; const scale = Number(fontScale.value);
      if (!fontScale.value) return; fontScale.value = previous == null ? "" : String(previous); fontScale.disabled = true;
      void run("font-scale", { scale }, `Font scale ${scale}×`).then((result) => { if (result != null) syncFont((result as { scale: number }).scale); }).finally(() => { fontScale.disabled = false; });
    });
    const largeText = toggle("Large text (1.3×)", "largeText", async (on) => {
      const result = await run("font-scale", { scale: on ? 1.3 : 1 }, `Large text ${on ? "on" : "off"}`);
      if (result == null) return false; syncFont((result as { scale: number }).scale); return true;
    });
    const talkback = toggle("TalkBack", "talkback", async (enabled) => (await run("talkback", { enabled }, `TalkBack ${enabled ? "on" : "off"}`)) != null);
    const contrast = toggle("High-contrast text", "contrast", async (enabled) => (await run("high-contrast", { enabled }, `High-contrast text ${enabled ? "on" : "off"}`)) != null);
    const dpi = field("dpi", { type: "number", min: "72", max: "1200" });
    const setDpi = () => { if (dpi.value) void run("density", { dpi: dpi.value }, `Density ${dpi.value}`); };
    onEnter(dpi, setDpi);
    section("Accessibility", row(talkback.label, largeText.label, contrast.label), setting("Font scale", fontScale),
      row(dpi, small("Set", "Override display density", setDpi), small("Reset", "Reset density", () => void run("density", { dpi: "reset" }, "Density reset"))));
    void run("font-scale", {}).then((result) => { if (result != null) { syncFont((result as { scale: number }).scale); state.largeText = typeof state.fontScale === "number" ? state.fontScale >= 1.3 : undefined; } });
    for (const [action, key, control] of [["talkback", "talkback", talkback], ["high-contrast", "contrast", contrast]] as const) {
      void run(action, {}).then((result) => { if (result != null) { state[key] = (result as { enabled?: boolean }).enabled; control.set(state[key]); } });
    }

    const snapName = field("snapshot name", { value: "clean" });
    const snapList = el("div", { class: "snap-list" });
    const refreshSnapshots = async () => {
      const result = (await run("snapshot", { op: "list" })) as { snapshots?: Array<{ tag: string; size?: string; date?: string }> } | null;
      snapList.replaceChildren();
      if (!result?.snapshots) return;
      if (result.snapshots.length === 0) { snapList.append(el("span", { class: "muted", text: "No snapshots yet." })); return; }
      for (const snapshot of result.snapshots) snapList.append(el("div", { class: "snap-row" },
        el("span", {}, el("strong", { text: snapshot.tag }), snapshot.size ? el("span", { class: "muted", text: `  ${snapshot.size}` }) : null),
        el("span", { class: "snap-actions" },
          small("Load", `Restore ${snapshot.tag}`, () => void run("snapshot", { op: "load", name: snapshot.tag }, `Loaded ${snapshot.tag}`)),
          small("Delete", `Delete ${snapshot.tag}`, () => void run("snapshot", { op: "delete", name: snapshot.tag }, `Deleted ${snapshot.tag}`).then((result) => { if (result != null) void refreshSnapshots(); })))));
    };
    section("Snapshots", row(snapName,
      small("Save", "Save the emulator state", () => { if (snapName.value) void run("snapshot", { op: "save", name: snapName.value }, `Saved ${snapName.value}`).then((result) => { if (result != null) void refreshSnapshots(); }); }),
      small("Load", "Restore this snapshot", () => { if (snapName.value) void run("snapshot", { op: "load", name: snapName.value }, `Loaded ${snapName.value}`); })), snapList);
    void refreshSnapshots();
    wrap.append(status);
  }

  private renderLogs(): void {
    const generation = this.renderGeneration;
    const target = this.targetView();
    const wrap = el("div", { class: "logs" });
    if (!target) {
      wrap.append(el("p", { class: "muted", text: "Select a device to view Logcat." }));
      this.body.replaceChildren(wrap);
      return;
    }
    const filter = el("input", { class: "input", placeholder: "Filter logcat…", type: "search", "aria-label": "Filter Logcat" });
    filter.value = this.logsFilter;
    const minimum = el("select", { class: "select log-minimum", "aria-label": "Minimum log level" });
    for (const [value, text] of [["0", "All levels"], ["2", "Debug+"], ["3", "Info+"], ["4", "Warning+"], ["5", "Error+"]]) minimum.append(el("option", { value, text }));
    const list = el("div", { class: "log-lines", role: "log", "aria-label": `Logcat for ${target.entry.name}` });
    const count = el("span", { class: "log-count", text: "Waiting for logs…" });
    const levels: Record<string, number> = { V: 1, D: 2, I: 3, W: 4, E: 5, F: 6, A: 6 };
    const records: Array<{ line: string; level: string; time: string; tag: string; message: string }> = [];
    const render = () => {
      const fragment = document.createDocumentFragment();
      let shown = 0;
      for (const record of records) {
        if (this.logsFilter && !record.line.toLowerCase().includes(this.logsFilter)) continue;
        if (record.level && (levels[record.level] ?? 0) < Number(minimum.value)) continue;
        const row = el("div", { class: `log-line log-level-${record.level.toLowerCase() || "unknown"}` });
        if (record.level) row.append(el("span", { class: "log-time", text: record.time }), el("span", { class: "log-level", text: record.level }), el("span", { class: "log-tag", text: record.tag }), el("span", { class: "log-message", text: record.message }));
        else row.textContent = record.line;
        fragment.append(row);
        shown++;
      }
      list.replaceChildren(fragment);
      list.scrollTop = list.scrollHeight;
      count.textContent = `${shown} of ${records.length} lines`;
    };
    filter.addEventListener("input", () => { this.logsFilter = filter.value.toLowerCase(); render(); });
    minimum.addEventListener("change", render);
    const pause = button(this.logsPaused ? "Resume" : "Pause", "Pause/resume the log stream", () => {
      this.logsPaused = !this.logsPaused;
      pause.textContent = this.logsPaused ? "Resume" : "Pause";
      pause.setAttribute("aria-pressed", String(this.logsPaused));
    });
    pause.setAttribute("aria-pressed", String(this.logsPaused));
    const clear = button("Clear", "Clear displayed logs", () => { records.length = 0; render(); });
    wrap.append(el("div", { class: "logs-head" }, filter), el("div", { class: "logs-toolbar" }, minimum, pause, clear), list, count);
    this.body.replaceChildren(wrap);
    this.logsSource = new EventSource(target.entry.logsEndpoint);
    this.logsSource.onmessage = (event) => {
      if (this.logsPaused || generation !== this.renderGeneration) return;
      try {
        const { line } = JSON.parse(event.data) as { line: string };
        if (typeof line !== "string") return;
        console.log(`[logcat] ${line}`);
        const thread = line.match(/^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)\s+\d+\s+\d+\s+([VDIWEFA])\s+([^:]+):\s?(.*)$/);
        const brief = line.match(/^([VDIWEFA])\/([^(:]+)(?:\(\s*\d+\))?:\s?(.*)$/);
        records.push({ line, level: thread?.[2] ?? brief?.[1] ?? "", time: thread?.[1]?.split(/\s+/)[1] ?? "", tag: (thread?.[3] ?? brief?.[2] ?? "").trim(), message: thread?.[4] ?? brief?.[3] ?? line });
        if (records.length > 1_000) records.shift();
        render();
      } catch {}
    };
  }

}


// ── App ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const app = document.getElementById("app")!;
  let api: ApiState;
  try {
    await checkAuthentication();
    if (authExpired) return;
    const res = await fetch(`${BOOT.basePath}/api` || "/api");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    api = await res.json() as ApiState;
  } catch {
    if (authExpired) return;
    app.replaceChildren(el("p", { class: "empty", text: "Failed to reach the serve-avd server. Reload to retry." }));
    return;
  }

  type Layout = CanvasLayout;
  const mobile = matchMedia("(max-width: 700px), (pointer: coarse) and (max-height: 500px)");
  const views: DeviceView[] = [];
  const hidden = new Set<string>();
  window.addEventListener("auth-expired", () => { for (const view of views) view.destroy(); panes?.close(); });
  let activeDeviceId: string | null = api.devices[0]?.device ?? null;
  let layout: Layout | null = null;
  let mirror = false;
  let showRail = !mobile.matches;
  let showRemote = true;
  let panes: Panes | null = null;
  const stage = el("div", { class: "stage", "data-layout": "custom" });
  const stageHost = el("main", { class: "workspace-stage", "aria-label": "Device workspace" }, stage);
  const selector = el("select", { class: "select device-selector", "aria-label": "Selected device" });
  const count = el("span", { class: "rail-count" });
  const railList = el("div", { class: "rail-list" });
  const available = el("div", { class: "rail-available" });
  const rail = el("aside", { class: "device-rail", "aria-label": "Devices" },
    el("div", { class: "rail-heading" }, el("span", { text: "Connected" }), count), railList,
    el("div", { class: "rail-heading" }, el("span", { text: "Virtual devices" })), available,
    el("p", { class: "rail-help", text: "Select a device to target it. Hide previews without disconnecting. Drag the handle to reorder, or focus it and use ↑ / ↓." }));
  const visibleViews = () => views.filter(v => !hidden.has(v.entry.device) && (!mobile.matches || v.entry.device === activeDeviceId));
  const remote = new WorkspaceRemote((command) => {
    const targets = mirror ? visibleViews() : visibleViews().filter(v => v.entry.device === activeDeviceId);
    for (const view of targets) if (view.connected) view.sendButton(command);
  }, () => {
    const shown = views.filter(v => !hidden.has(v.entry.device));
    const index = shown.findIndex(v => v.entry.device === activeDeviceId);
    if (shown.length) selectDevice(shown[(index + 1) % shown.length]!.entry.device);
  });
  stageHost.append(remote.root);
  const railToggle = workspaceButton("rail", "Toggle device list", () => {
    showRail = !showRail;
    if (showRail && mobile.matches) panes?.close();
    update();
  });
  const remoteToggle = workspaceButton("remote", "Toggle remote", () => { showRemote = !showRemote; update(); });
  const inspectorToggle = workspaceButton("inspector", "Toggle inspector", () => {
    if (panes?.visible) panes.close();
    else panes?.open("tools");
  });
  const mirrorButton = button('<span class="switch-track"><span></span></span><span>Mirror input</span>',
    "Send remote buttons to all visible devices", () => { mirror = !mirror; update(); }, "mirror-toggle");
  mirrorButton.setAttribute("role", "switch");
  const layouts = el("div", { class: "layout-picker", role: "group", "aria-label": "Device layout" });
  const layoutButtons = new Map<Layout, HTMLButtonElement>();
  for (const name of ["grid", "split", "stack"] as const) {
    const label = name[0]!.toUpperCase() + name.slice(1);
    const b = button(`${workspaceIcons[name === "grid" ? "split" : name]}<span>${label}</span>`, `${label} arrangement on the canvas`, () => { layout = name; update(); canvas.arrange(name); });
    b.setAttribute("aria-label", label);
    layoutButtons.set(name, b);
    layouts.append(b);
  }
  const layoutBar = el("div", { class: "layout-toolbar" }, el("span", { class: "muted layout-label", text: "Layout" }), layouts);
  const header = el("header", { class: "topbar" },
    el("div", { class: "brand" }, el("span", { class: "logo", text: "▶" }), el("strong", { text: "serve-avd" }), el("span", { class: "version", text: `v${api.version}` })),
    layoutBar, selector,
    el("div", { class: "topbar-actions" }, mirrorButton, el("span", { class: "toolbar-divider" }), railToggle, remoteToggle, inspectorToggle));
  if (account) {
    const menu = el("details", { class: "account-menu" });
    const summary = el("summary", { text: `${account.username} · ${account.role}`, "aria-label": "Account menu" });
    const settings = el("a", { href: `${BOOT.basePath}/account`, text: "Account and password" });
    const logout = button("Sign out", "Sign out", () => {
      logout.disabled = true;
      void fetch(`${BOOT.basePath}/auth/logout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
        .then(response => { if (!response.ok) throw new Error("Sign out failed"); expireAuthentication(); location.assign(`${BOOT.basePath}/login`); })
        .catch(() => { logout.disabled = false; });
    });
    menu.append(summary, el("div", { class: "account-menu-items" }, settings, logout));
    header.querySelector(".topbar-actions")!.append(menu);
  }
  const railNodes = new Map<string, { row: HTMLElement; select: HTMLButtonElement; eye: HTMLButtonElement; meta: HTMLElement }>();
  const empty = el("div", { class: "empty workspace-empty" });
  stageHost.append(empty);
  const canvas = new WorkspaceCanvas(stageHost, stage, `serve-avd:canvas:${BOOT.basePath}:${account?.id ?? "local"}`,
    () => { layout = null; layoutButtons.forEach(b => b.setAttribute("aria-pressed", "false")); },
    () => { for (const view of views) view.cancelInteraction(); },
    zoom => { for (const view of views) view.setDisplayScale(zoom); });
  window.addEventListener("auth-expired", () => canvas.destroy());

  const updateRemote = () => {
    const selected = views.find(v => v.entry.device === activeDeviceId);
    const targets = mirror ? visibleViews() : visibleViews().filter(v => v === selected);
    remote.setTarget(mirror ? "All visible devices" : selected?.entry.name ?? "No device selected", targets.some(v => v.connected));
    for (const view of views) {
      const nodes = railNodes.get(view.entry.device);
      if (nodes) {
        nodes.meta.textContent = `${view.entry.device} · ${view.telemetry}`;
        nodes.row.classList.toggle("connected", view.connected);
      }
    }
  };
  function update(): void {
    selector.value = activeDeviceId ?? "";
    selector.hidden = views.length < 2;
    rail.hidden = !showRail;
    railToggle.setAttribute("aria-pressed", String(showRail));
    remoteToggle.setAttribute("aria-pressed", String(showRemote));
    inspectorToggle.setAttribute("aria-pressed", String(panes?.visible ?? false));
    mirrorButton.setAttribute("aria-checked", String(mirror));
    stage.dataset.layout = layout ?? "custom";
    stage.classList.toggle("mirroring", mirror);
    layoutButtons.forEach((b, name) => b.setAttribute("aria-pressed", String(name === layout)));
    const shown = visibleViews();
    stage.dataset.count = String(shown.length);
    count.textContent = `${shown.length} of ${views.length} shown`;
    empty.hidden = shown.length !== 0;
    if (!shown.length) {
      empty.replaceChildren(el("h2", { text: views.length ? "All devices are hidden" : "No emulators attached" }),
        el("p", { class: "muted", text: views.length ? "Use the eye toggle in the device list to bring one back." : "Attach a connected device or start an AVD from the device list." }),
        button(views.length ? "Show all devices" : "Open device list", "Show devices", () => {
          if (views.length) { hidden.clear(); activeDeviceId ??= views[0]!.entry.device; update(); panes?.refreshTarget(); }
          else { showRail = true; update(); }
        }));
    }
    for (const view of views) {
      const id = view.entry.device;
      const active = id === activeDeviceId;
      view.root.classList.toggle("selected-device", active);
      view.root.hidden = !shown.includes(view);
      view.setSuspended(document.hidden || !shown.includes(view));
      const nodes = railNodes.get(id)!;
      nodes.row.classList.toggle("selected", active);
      nodes.row.classList.toggle("device-hidden", hidden.has(id));
      nodes.select.setAttribute("aria-pressed", String(active));
      nodes.eye.setAttribute("aria-label", `${hidden.has(id) ? "Show" : "Hide"} ${view.entry.name}`);
      nodes.eye.title = nodes.eye.getAttribute("aria-label")!;
      nodes.eye.setAttribute("aria-pressed", String(!hidden.has(id)));
      nodes.eye.innerHTML = hidden.has(id) ? workspaceIcons.eyeOff : workspaceIcons.eye;
    }
    canvas.sync(views.map(v => ({ id: v.entry.device, root: v.root })), !mobile.matches);
    remote.setVisible(showRemote);
    updateRemote();
  }
  function selectDevice(id: string, focusInput = true): void {
    if (!views.some(v => v.entry.device === id)) return;
    const changed = activeDeviceId !== id;
    if (changed) views.find(v => v.entry.device === activeDeviceId)?.cancelInteraction();
    hidden.delete(id);
    activeDeviceId = id;
    update();
    if (changed) panes?.refreshTarget();
    if (focusInput) canvas.reveal(id);
    if (focusInput) views.find(v => v.entry.device === id)?.root.querySelector<HTMLElement>(".screen-wrap")?.focus({ preventScroll: true });
  }
  const toggleDevice = (id: string) => {
    if (hidden.has(id)) { hidden.delete(id); activeDeviceId ??= id; }
    else {
      hidden.add(id);
      if (activeDeviceId === id) activeDeviceId = views.find(v => !hidden.has(v.entry.device))?.entry.device ?? null;
    }
    update();
    panes?.refreshTarget();
  };
  const reorder = (id: string, targetIndex: number) => {
    const from = views.findIndex(v => v.entry.device === id);
    if (from < 0 || targetIndex < 0 || targetIndex >= views.length || from === targetIndex) return;
    const [view] = views.splice(from, 1);
    views.splice(targetIndex, 0, view!);
    for (const v of views) railList.append(railNodes.get(v.entry.device)!.row);
    update();
  };
  let dragged: string | null = null;
  const addView = (entry: DeviceEntry) => {
    const view = new DeviceView(entry, api.codec === "mjpeg");
    views.push(view);
    stage.append(view.root);
    selector.append(el("option", { value: entry.device, text: entry.name }));
    const select = el("button", { class: "rail-select", type: "button", "aria-label": `Select ${entry.name}` },
      el("span", { class: "rail-name" }, el("span", { class: "status-dot" }), el("strong", { text: entry.name })));
    const meta = el("span", { class: "rail-meta" });
    select.append(meta);
    select.addEventListener("click", () => { selectDevice(entry.device); canvas.fit([{ id: entry.device, root: view.root }]); if (mobile.matches) { showRail = false; update(); } });
    const eye = workspaceButton("eye", `Hide ${entry.name}`, () => toggleDevice(entry.device));
    eye.classList.add("rail-eye");
    eye.setAttribute("aria-pressed", "true");
    const grip = workspaceButton("grip", `Reorder ${entry.name}; use up and down arrows`, () => {});
    grip.classList.add("rail-grip");
    grip.draggable = true;
    grip.addEventListener("dragstart", e => { dragged = entry.device; e.dataTransfer?.setData("text/plain", entry.device); });
    grip.addEventListener("dragend", () => { dragged = null; });
    grip.addEventListener("keydown", e => {
      if (!["ArrowUp", "ArrowDown"].includes(e.key)) return;
      e.preventDefault();
      reorder(entry.device, views.indexOf(view) + (e.key === "ArrowUp" ? -1 : 1));
      grip.focus();
    });
    const row = el("div", { class: "rail-row", "data-device": entry.device }, grip, select, eye);
    row.addEventListener("dragover", e => { if (dragged) e.preventDefault(); });
    row.addEventListener("drop", e => { e.preventDefault(); if (dragged) reorder(dragged, views.indexOf(view)); dragged = null; });
    railNodes.set(entry.device, { row, select, eye, meta });
    railList.append(row);
    if (!hidden.has(entry.device)) activeDeviceId ??= entry.device;
    view.root.addEventListener("pointerdown", () => selectDevice(entry.device, false), true);
    view.root.addEventListener("click", event => {
      const target = event.target as Element;
      if (!target.closest("button, input, textarea, select, summary, a, [contenteditable], [role=button]")) selectDevice(entry.device);
    });
    view.root.addEventListener("focusin", () => selectDevice(entry.device, false));
    view.root.addEventListener("devicechange", updateRemote);
    view.root.addEventListener("canvasselect", event => selectDevice(entry.device, (event as CustomEvent<boolean>).detail));
    view.root.addEventListener("devicefill", () => { selectDevice(entry.device); canvas.fill(entry.device); });
    view.root.addEventListener("devicehide", () => toggleDevice(entry.device));
  };
  api.devices.forEach(addView);
  const attachDevice = async (name: string) => {
    const res = await fetch(api.gridStartEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device: name }) });
    if (!res.ok) throw new Error(`Could not attach device (HTTP ${res.status})`);
    const { device } = await res.json() as { device: DeviceEntry };
    if (!views.some(v => v.entry.device === device.device)) addView(device);
    selectDevice(device.device);
    void refreshAvailable();
  };
  let refreshingDevices = false;
  async function refreshAvailable(): Promise<void> {
    if (refreshingDevices || authExpired) return;
    refreshingDevices = true;
    try {
      const res = await fetch(api.gridApiEndpoint);
      if (!res.ok) throw new Error("Device discovery unavailable");
      const data = await res.json() as { devices: Array<Partial<DeviceEntry> & {serial: string; state: string; model?: string; attached?: boolean}>; avds: Array<{name: string; running: boolean}> };
      if (authExpired) return;
      const previousTarget = activeDeviceId;
      // Discovery updates the device inventory, never the browser's hidden set.
      for (let i = views.length - 1; i >= 0; i--) {
        const view = views[i]!;
        if (data.devices.some(d => d.serial === view.entry.device && d.state === "device")) continue;
        view.destroy();
        view.root.remove();
        railNodes.get(view.entry.device)?.row.remove();
        railNodes.delete(view.entry.device);
        [...selector.options].find(o => o.value === view.entry.device)?.remove();
        views.splice(i, 1);
        if (activeDeviceId === view.entry.device) activeDeviceId = null;
      }
      for (const device of data.devices) {
        if (device.state === "device" && device.attached && device.device && device.wsEndpoint &&
            !views.some(v => v.entry.device === device.device)) addView(device as DeviceEntry);
      }
      activeDeviceId ??= views.find(v => !hidden.has(v.entry.device))?.entry.device ?? null;
      update();
      if (previousTarget !== activeDeviceId) panes?.refreshTarget();
      available.replaceChildren();
      const candidates = [
        ...data.devices.filter(d => d.state === "device" && !views.some(v => v.entry.device === d.serial)).map(d => ({id: d.serial, name: d.model ?? d.serial, label: "Attach"})),
        ...data.avds.filter(d => !d.running).map(d => ({id: d.name, name: d.name, label: "Boot"})),
      ];
      for (const item of account?.role === "operator" ? [] : candidates) {
        const start = button(item.label, `${item.label} ${item.name}`, () => {
          start.disabled = true;
          start.textContent = "Starting…";
          void attachDevice(item.id).catch(error => { start.disabled = false; start.textContent = "Retry"; message.textContent = String(error); });
        });
        const message = el("span", { class: "muted rail-attach-name", text: item.name });
        available.append(el("div", { class: "rail-attach" }, message, start));
      }
      if (!candidates.length) available.append(el("p", { class: "rail-empty", text: "Connected devices appear automatically. Use the eye to show or hide a preview." }));
    } catch {
      if (!authExpired) available.replaceChildren(el("p", { class: "rail-empty", text: "Could not load available devices." }));
    } finally {
      refreshingDevices = false;
    }
    available.append(button("Refresh devices", "Refresh devices", () => void refreshAvailable(), "ghost refresh-devices"));
  }
  panes = new Panes(api, () => views, attachDevice, () => activeDeviceId);
  panes.root.addEventListener("inspectorchange", () => {
    if (mobile.matches && panes?.visible) showRail = false;
    update();
  });
  selector.addEventListener("change", () => selectDevice(selector.value));
  mobile.addEventListener("change", () => { showRail = !mobile.matches; if (mobile.matches) panes?.close(); update(); });
  document.addEventListener("visibilitychange", update);
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !remote.root.contains(e.target as Node)) {
      if (mobile.matches) showRail = false;
      panes?.close(); update();
    }
  });
  app.replaceChildren(header, el("div", { class: "layout" }, rail, stageHost, panes.root));
  const initial = BOOT.initialState.panes;
  if (initial?.length) { if (initial[0] !== "none") panes.open(initial[0]!); }
  else if (!mobile.matches) panes.open("tools");
  update();
  void refreshAvailable();
  window.setInterval(updateRemote, 1000);
  window.setInterval(() => { if (!document.hidden) void refreshAvailable(); }, 5000);
  if (BOOT.authEnabled) window.setInterval(() => void checkAuthentication().catch(() => {}), 15_000);
}

void main();
