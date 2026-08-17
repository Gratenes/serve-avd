/**
 * serve-avd preview client. Vanilla DOM app: per-device stage (H.264 via
 * WebCodecs onto canvas, or MJPEG <img> fallback), full input forwarding over
 * the binary [tag][JSON] WebSocket, and side panes (devices / tools / logs).
 */
import { AvccDemuxer, avcCodecString, isAvccSupported } from "./avcc-codec";
import { icons, type IconName } from "./icons";

declare const __SERVE_AVD_VERSION__: string | undefined;

interface BootConfig {
  basePath: string;
  codec: "auto" | "mjpeg";
  initialState: { panes?: string[]; fit?: boolean };
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
  initialState: { panes?: string[]; fit?: boolean };
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

const ORIENTATIONS = ["portrait", "landscape_left", "portrait_upside_down", "landscape_right"];
/** Floor between "send me a fresh keyframe" pokes at the server. */
const KEYFRAME_REQUEST_MIN_MS = 3_000;
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

function wsUrl(path: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${path}`;
}

// ── Device view ────────────────────────────────────────────────────────────

class DeviceView {
  readonly root: HTMLElement;
  private readonly surfaceWrap: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private img: HTMLImageElement | null = null;
  private readonly statusChip: HTMLElement;
  private readonly fpsChip: HTMLElement;
  private readonly orientationChip: HTMLElement;
  private readonly notice: HTMLElement;
  private pendingOrientation: string | null = null;
  private pendingTimer: number | null = null;
  private noticeTimer: number | null = null;

  private ws: WebSocket | null = null;
  private wsQueue: Uint8Array[] = [];
  private closed = false;

  private config: ScreenConfig;
  private decoder: VideoDecoder | null = null;
  private lastDescription: Uint8Array | null = null;
  private awaitingKeyframe = true;
  private awaitingSince = 0;
  private streamAbort: AbortController | null = null;
  private framesAtLastAbort = -1;
  private stalledAborts = 0;
  private lastKeyframeRequest = -Infinity;
  private timestamp = 0;
  private framesDecoded = 0;
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
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx;

    this.statusChip = el("span", { class: "chip chip-status", text: "connecting" });
    this.fpsChip = el("span", { class: "chip chip-dim chip-fps", text: "– fps" });
    this.orientationChip = el("span", { class: "chip chip-dim", text: this.config.orientation });

    this.notice = el("div", { class: "device-notice hidden" });
    this.surfaceWrap = el("div", { class: "screen-wrap", tabindex: "0" }, this.canvas, this.notice);

    this.root = el(
      "section",
      { class: "device" },
      el(
        "header",
        { class: "device-head" },
        el("div", { class: "device-title" }, el("strong", { text: entry.name }), el("span", { class: "serial", text: entry.device })),
        el("div", { class: "device-chips" }, this.statusChip, this.fpsChip, this.orientationChip),
      ),
      el("div", { class: "device-frame" }, this.surfaceWrap),
      this.buildControls(),
    );

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

    return el("div", { class: "device-controls" }, nav, tools);
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

  sendButton(name: string): void {
    this.send(0x04, { button: name });
  }

  /** Stream state readout — `live` colours the dot green. */
  private setStatus(text: string, live: boolean): void {
    this.statusChip.textContent = text;
    this.statusChip.classList.toggle("live", live);
  }

  // ── WebSocket ────────────────────────────────────────────────────────────

  private connectWs(): void {
    if (this.closed) return;
    const ws = new WebSocket(wsUrl(this.entry.wsEndpoint));
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.setStatus(this.mode === "h264" ? "H.264" : "MJPEG", true);
      for (const frame of this.wsQueue) ws.send(frame);
      this.wsQueue = [];
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
    ws.onclose = () => {
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
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(frame);
    } else if (tag !== 0x03 && tag !== 0x05 && tag !== 0x0b) {
      // Queue everything except high-rate touch/scroll traffic.
      this.wsQueue.push(frame);
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
    this.setStatus("MJPEG", true);
    this.fpsChip.textContent = "stills";
    const img = el("img", { class: "screen-canvas", alt: this.entry.name });
    this.img = img;
    this.canvas.replaceWith(img);
    const connect = () => {
      if (this.closed) return;
      img.src = `${this.entry.streamMjpegEndpoint}?t=${Date.now()}`;
    };
    img.addEventListener("error", () => {
      if (!this.closed) setTimeout(connect, 1_500);
    });
    connect();
  }

  private async runAvccStream(): Promise<void> {
    const demuxer = new AvccDemuxer();
    let backoff = 500;
    while (!this.closed) {
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
      if (this.closed) return;
      this.setStatus("reconnecting", false);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 4_000);
    }
  }

  private onAvccChunk(type: "description" | "keyframe" | "delta" | "seed", payload: Uint8Array): void {
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
    const decoder = this.decoder;
    if (!decoder || decoder.state === "closed") return;
    if (this.awaitingKeyframe && type !== "keyframe") return;
    this.awaitingKeyframe = false;
    this.awaitingSince = 0;
    this.timestamp += 33_333;
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
      const decoder = new VideoDecoder({
        output: (frame) => this.paintFrame(frame),
        error: () => this.recoverDecoder(),
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
    if (this.decoder && this.decoder.state !== "closed") {
      try {
        this.decoder.close();
      } catch {}
    }
    this.decoder = null;
  }

  private paintFrame(frame: VideoFrame): void {
    const width = frame.displayWidth || frame.codedWidth;
    const height = frame.displayHeight || frame.codedHeight;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.noteFrameSize(width, height);
    }
    this.ctx.drawImage(frame, 0, 0, width, height);
    frame.close();
    this.firstFrameSeen = true;
    this.framesDecoded++;
    this.stalledAborts = 0;
  }

  private async paintSeed(payload: Uint8Array): Promise<void> {
    const framesAtStart = this.framesDecoded;
    try {
      const bitmap = await createImageBitmap(new Blob([payload as BlobPart]));
      if (this.framesDecoded !== framesAtStart) return; // a real frame beat us
      if (this.canvas.width !== bitmap.width || this.canvas.height !== bitmap.height) {
        this.canvas.width = bitmap.width;
        this.canvas.height = bitmap.height;
        this.noteFrameSize(bitmap.width, bitmap.height);
      }
      this.ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
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
      if (this.mode === "h264") {
        const fps = this.framesDecoded - lastCount;
        lastCount = this.framesDecoded;
        this.fpsChip.textContent = `${fps} fps`;
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
    surface.addEventListener("contextmenu", (e) => e.preventDefault());

    surface.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      surface.focus();
      surface.setPointerCapture(e.pointerId);
      const p = this.surfacePoint(e);
      if (e.altKey) {
        this.pinch = { anchorX: p.x, anchorY: p.y };
        this.send(0x05, { type: "begin", x1: p.x, y1: p.y, x2: p.x, y2: p.y });
      } else {
        this.send(0x03, { type: "begin", x: p.x, y: p.y });
      }
    });

    surface.addEventListener("pointermove", (e) => {
      if (!surface.hasPointerCapture(e.pointerId)) return;
      const now = performance.now();
      if (now - this.lastMoveSent < 30) return;
      this.lastMoveSent = now;
      const p = this.surfacePoint(e);
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
      if (!surface.hasPointerCapture(e.pointerId)) return;
      surface.releasePointerCapture(e.pointerId);
      const p = this.surfacePoint(e);
      if (this.pinch) {
        const mirrored = {
          x: Math.min(1, Math.max(0, 2 * this.pinch.anchorX - p.x)),
          y: Math.min(1, Math.max(0, 2 * this.pinch.anchorY - p.y)),
        };
        this.send(0x05, { type: "end", x1: p.x, y1: p.y, x2: mirrored.x, y2: mirrored.y });
        this.pinch = null;
      } else {
        this.send(0x03, { type: "end", x: p.x, y: p.y });
      }
    };
    surface.addEventListener("pointerup", endPointer);
    surface.addEventListener("pointercancel", endPointer);

    surface.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
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
        this.send(0x06, { type: "down", code: e.code });
      }
    });
    surface.addEventListener("keyup", (e) => {
      if (androidSpecial(e.code)) this.send(0x06, { type: "up", code: e.code });
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

  destroy(): void {
    this.closed = true;
    this.teardownDecoder();
    this.ws?.close();
    if (this.img) this.img.src = "";
  }
}

function androidSpecial(code: string): boolean {
  return ["Enter", "Backspace", "Tab", "Escape"].includes(code);
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
  ) {
    this.body = el("div", { class: "pane-body" });
    const tabBar = el("div", { class: "pane-tabs" });
    for (const name of ["devices", "tools", "logs"]) {
      const tab = el("button", { class: "pane-tab", type: "button", text: name });
      tab.addEventListener("click", () => this.toggle(name));
      this.tabs.set(name, tab);
      tabBar.append(tab);
    }
    this.root = el("aside", { class: "panes hidden" }, tabBar, this.body);
  }

  toggle(name: string): void {
    if (this.active === name) {
      this.active = null;
      this.root.classList.add("hidden");
      this.tabs.forEach((t) => t.classList.remove("active"));
      this.stopStreams();
      return;
    }
    this.open(name);
  }

  open(name: string): void {
    this.active = name;
    this.root.classList.remove("hidden");
    this.tabs.forEach((t, key) => t.classList.toggle("active", key === name));
    this.stopStreams();
    this.body.replaceChildren();
    if (name === "devices") void this.renderDevices();
    if (name === "tools") this.renderTools();
    if (name === "logs") this.renderLogs();
  }

  private stopStreams(): void {
    this.logsSource?.close();
    this.logsSource = null;
    this.eventsSource?.close();
    this.eventsSource = null;
  }

  private async renderDevices(): Promise<void> {
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
        else if (device.state === "device")
          row.append(button("Attach", `Attach ${device.serial}`, () => void this.startAndReload(device.serial)));
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
            : button("Boot", `Boot ${avd.name}`, () => void this.startAndReload(avd.name)),
        );
        list.append(row);
      }
      this.body.replaceChildren(list);
    } catch {
      this.body.replaceChildren(el("p", { class: "muted", text: "Failed to load device list." }));
    }
  }

  private async startAndReload(device: string): Promise<void> {
    this.body.replaceChildren(el("p", { class: "muted", text: `Starting ${device}… (booting can take a minute)` }));
    try {
      await this.attachDevice(device);
    } finally {
      if (this.active === "devices") void this.renderDevices();
    }
  }

  private targetView(): DeviceView | null {
    return this.deviceViews()[0] ?? null;
  }

  private renderTools(): void {
    const views = this.deviceViews();
    let target = views[0] ?? null;

    const wrap = el("div", { class: "tools" });
    if (views.length > 1) {
      const select = el("select", { class: "select" });
      for (const view of views) select.append(el("option", { value: view.entry.device, text: view.entry.name }));
      select.addEventListener("change", () => {
        target = views.find((v) => v.entry.device === select.value) ?? target;
      });
      wrap.append(select);
    }

    const actions = el("div", { class: "tool-grid" });
    const act = (label: string, fn: (view: DeviceView) => void) =>
      actions.append(button(label, label, () => target && fn(target)));
    act("Memory warning", (v) => v.send(0x09));
    act("Notifications", (v) => v.sendButton("notifications"));
    act("Quick settings", (v) => v.sendButton("quick-settings"));
    act("Lock", (v) => v.sendButton("lock"));
    act("Wake", (v) => v.sendButton("wake"));
    wrap.append(el("h3", { text: "Actions" }), actions);

    const flags = el("div", { class: "flag-list" });
    for (const flag of DEBUG_FLAGS) {
      const checkbox = el("input", { type: "checkbox" }) as HTMLInputElement;
      checkbox.addEventListener("change", () => {
        target?.send(0x08, { option: flag, enabled: checkbox.checked });
      });
      flags.append(el("label", { class: "flag" }, checkbox, ` ${flag}`));
    }
    wrap.append(el("h3", { text: "Render debugging" }), flags);

    this.renderEmulatorControls(wrap, () => target);

    const log = el("div", { class: "event-log" });
    wrap.append(el("h3", { text: "Recent actions" }), log);
    const push = (entry: EventLogEntry) => {
      const line = el("div", { class: `event ${entry.status === "error" ? "error" : ""}` });
      line.textContent = `${new Date(entry.timestamp).toLocaleTimeString()}  ${entry.summary}`;
      log.append(line);
      while (log.childElementCount > 200) log.firstElementChild?.remove();
      log.scrollTop = log.scrollHeight;
    };
    this.eventsSource = new EventSource(this.api.eventLogEventsEndpoint);
    this.eventsSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { events?: EventLogEntry[]; event?: EventLogEntry };
        if (data.events) data.events.forEach(push);
        if (data.event) push(data.event);
      } catch {}
    };

    this.body.replaceChildren(wrap);
  }

  /**
   * Emulator controls: every row posts to the device's `/action` endpoint —
   * the same RPC the CLI, MCP tools and SDK use — so the Recent-actions log
   * below reflects it and scripts can reproduce it.
   */
  private renderEmulatorControls(wrap: HTMLElement, target: () => DeviceView | null): void {
    const status = el("div", { class: "tool-status" });
    let statusTimer: number | null = null;
    const flash = (message: string, error = false) => {
      status.textContent = message;
      status.classList.toggle("error", error);
      if (statusTimer) window.clearTimeout(statusTimer);
      statusTimer = window.setTimeout(() => {
        status.textContent = "";
      }, 4_000);
    };
    const run = async (action: string, params: Record<string, unknown>, okMessage?: string): Promise<unknown> => {
      const view = target();
      if (!view) {
        flash("No device attached", true);
        return null;
      }
      try {
        const res = await fetch(view.entry.actionEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, params }),
        });
        const body = (await res.json()) as { ok: boolean; result?: unknown; message?: string };
        if (!res.ok || !body.ok) {
          flash(body.message ?? `${action} failed`, true);
          return null;
        }
        if (okMessage) flash(okMessage);
        return body.result;
      } catch (err) {
        flash(err instanceof Error ? err.message : String(err), true);
        return null;
      }
    };

    const field = (placeholder: string, opts: { type?: string; value?: string; width?: number; min?: string; max?: string; step?: string } = {}) => {
      const input = el("input", {
        class: "input tool-input",
        placeholder,
        type: opts.type ?? "text",
        value: opts.value,
        min: opts.min,
        max: opts.max,
        step: opts.step,
        style: opts.width ? `width:${opts.width}px` : undefined,
      }) as HTMLInputElement;
      return input;
    };
    const row = (...children: Array<Node | string | null | undefined>) => el("div", { class: "tool-form-row" }, ...children);
    const small = (label: string, title: string, fn: () => void) => button(label, title, fn, "small");
    const select = (options: Array<[string, string]>, value?: string) => {
      const s = el("select", { class: "select tool-input" }) as HTMLSelectElement;
      for (const [v, label] of options) s.append(el("option", { value: v, text: label }));
      if (value != null) s.value = value;
      return s;
    };
    const toggle = (label: string, onChange: (checked: boolean) => void) => {
      const box = el("input", { type: "checkbox" }) as HTMLInputElement;
      box.addEventListener("change", () => onChange(box.checked));
      return { box, label: el("label", { class: "flag" }, box, ` ${label}`) };
    };
    const section = (title: string, ...rows: HTMLElement[]) => {
      wrap.append(el("h3", { text: title }), el("div", { class: "tool-form" }, ...rows));
    };
    const onEnter = (input: HTMLInputElement, fn: () => void) =>
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") fn();
      });

    // Location
    const lat = field("Latitude", { type: "number", step: "any", value: "37.4220" });
    const lon = field("Longitude", { type: "number", step: "any", value: "-122.0841" });
    const setGeo = () => void run("geo", { lat: Number(lat.value), lon: Number(lon.value) }, `Location ${lat.value}, ${lon.value}`);
    onEnter(lat, setGeo);
    onEnter(lon, setGeo);
    section("Location", row(lat, lon, small("Set", "Send a GPS fix (adb emu geo fix)", setGeo)));

    // Network
    const speed = select(
      [
        ["", "speed…"],
        ["full", "full"],
        ["lte", "lte"],
        ["hsdpa", "hsdpa"],
        ["umts", "umts"],
        ["edge", "edge"],
        ["gprs", "gprs"],
        ["gsm", "gsm"],
      ],
      "",
    );
    const delay = select(
      [
        ["", "delay…"],
        ["none", "none"],
        ["umts", "umts"],
        ["edge", "edge"],
        ["gprs", "gprs"],
      ],
      "",
    );
    speed.addEventListener("change", () => speed.value && void run("network", { speed: speed.value }, `Speed ${speed.value}`));
    delay.addEventListener("change", () => delay.value && void run("network", { delay: delay.value }, `Delay ${delay.value}`));
    const airplane = toggle("airplane", (on) => void run("network", { airplane: on }, `Airplane ${on ? "on" : "off"}`));
    const wifi = toggle("wifi", (on) => void run("network", { wifi: on }, `Wi-Fi ${on ? "on" : "off"}`));
    const data = toggle("mobile data", (on) => void run("network", { data: on }, `Mobile data ${on ? "on" : "off"}`));
    section("Network", row(speed, delay), row(airplane.label, wifi.label, data.label));
    void run("network", {}).then((r) => {
      const s = r as { airplane?: boolean; wifi?: boolean; data?: boolean } | null;
      if (!s) return;
      airplane.box.checked = !!s.airplane;
      wifi.box.checked = !!s.wifi;
      data.box.checked = !!s.data;
    });

    // Battery
    const level = field("Level %", { type: "number", min: "0", max: "100", width: 90 });
    const setLevel = () => level.value !== "" && void run("battery", { level: Number(level.value) }, `Battery ${level.value}%`);
    onEnter(level, setLevel);
    section(
      "Battery",
      row(
        level,
        small("Set", "Fake the battery level", setLevel),
        small("Unplug", "Unplug the charger", () => void run("battery", { plugged: "none" }, "Unplugged")),
        small("AC", "Plug into AC", () => void run("battery", { plugged: "ac" }, "Charging (AC)")),
        small("Reset", "Restore real battery reporting", () => void run("battery", { reset: true }, "Battery reset")),
      ),
    );

    // Telephony + sensors
    const number = field("Phone number", { value: "5551234567", width: 150 });
    const smsText = field("SMS text");
    section(
      "Telephony & sensors",
      row(
        number,
        small("Call", "Incoming call", () => void run("call", { number: number.value, op: "call" }, `Calling from ${number.value}`)),
        small("End", "End the call", () => void run("call", { number: number.value, op: "end" }, "Call ended")),
      ),
      row(smsText, small("Send SMS", "Deliver an incoming SMS", () => void run("sms", { number: number.value, text: smsText.value }, "SMS delivered"))),
      row(small("Fingerprint", "Touch the fingerprint sensor (finger 1)", () => void run("fingerprint", { id: 1 }, "Fingerprint touched"))),
    );

    // Apps
    const url = field("https://… or myapp://…");
    const openUrl = () => url.value && void run("open", { url: url.value }, `Opened ${url.value}`);
    onEnter(url, openUrl);
    const pkg = field("com.example.app");
    section(
      "Apps",
      row(url, small("Open", "Open a URL / deep link", openUrl)),
      row(
        pkg,
        small("Launch", "Launch the app", () => pkg.value && void run("launch", { package: pkg.value }, `Launched ${pkg.value}`)),
        small("Stop", "Force-stop the app", () => pkg.value && void run("stop", { package: pkg.value }, `Stopped ${pkg.value}`)),
        small("Clear", "Clear the app's data", () => pkg.value && void run("clear-data", { package: pkg.value }, `Cleared ${pkg.value}`)),
      ),
    );
    void (async () => {
      const view = target();
      if (!view) return;
      try {
        const res = await fetch(view.entry.foregroundEndpoint);
        if (res.ok) {
          const fg = (await res.json()) as { packageName?: string };
          if (fg.packageName && !pkg.value) pkg.value = fg.packageName;
        }
      } catch {}
    })();

    // Accessibility / display
    const fontScale = select(
      [
        ["", "font scale…"],
        ["0.85", "0.85×"],
        ["1", "1.0×"],
        ["1.15", "1.15×"],
        ["1.3", "1.3×"],
        ["1.5", "1.5×"],
        ["2", "2.0×"],
      ],
      "",
    );
    fontScale.addEventListener("change", () => fontScale.value && void run("font-scale", { scale: Number(fontScale.value) }, `Font scale ${fontScale.value}×`));
    const dpi = field("dpi", { type: "number", min: "72", max: "1200", width: 80 });
    const setDpi = () => dpi.value && void run("density", { dpi: dpi.value }, `Density ${dpi.value}`);
    onEnter(dpi, setDpi);
    const talkback = toggle("TalkBack", (on) => void run("talkback", { enabled: on }, `TalkBack ${on ? "on" : "off"}`));
    section(
      "Accessibility",
      row(fontScale, dpi, small("Set", "Override display density", setDpi), small("Reset", "Reset density", () => void run("density", { dpi: "reset" }, "Density reset"))),
      row(talkback.label),
    );

    // Snapshots
    const snapName = field("snapshot name", { value: "clean" });
    const snapList = el("div", { class: "snap-list" });
    const refreshSnapshots = async () => {
      const r = (await run("snapshot", { op: "list" })) as { snapshots: Array<{ tag: string; size?: string; date?: string }> } | null;
      snapList.replaceChildren();
      if (!r) return;
      if (r.snapshots.length === 0) {
        snapList.append(el("span", { class: "muted", text: "No snapshots yet." }));
        return;
      }
      for (const s of r.snapshots) {
        snapList.append(
          el(
            "div",
            { class: "snap-row" },
            el("span", {}, el("strong", { text: s.tag }), s.size ? el("span", { class: "muted", text: `  ${s.size}` }) : null),
            el(
              "span",
              { class: "snap-actions" },
              small("Load", `Restore ${s.tag}`, () => void run("snapshot", { op: "load", name: s.tag }, `Loaded ${s.tag}`)),
              small("Delete", `Delete ${s.tag}`, () => void run("snapshot", { op: "delete", name: s.tag }, `Deleted ${s.tag}`).then(refreshSnapshots)),
            ),
          ),
        );
      }
    };
    section(
      "Snapshots",
      row(
        snapName,
        small("Save", "Save the emulator state", () => snapName.value && void run("snapshot", { op: "save", name: snapName.value }, `Saved ${snapName.value}`).then(refreshSnapshots)),
        small("Load", "Restore this snapshot", () => snapName.value && void run("snapshot", { op: "load", name: snapName.value }, `Loaded ${snapName.value}`)),
      ),
      snapList,
    );
    void refreshSnapshots();

    wrap.append(status);
  }

  private renderLogs(): void {
    const target = this.targetView();
    const wrap = el("div", { class: "logs" });
    if (!target) {
      wrap.append(el("p", { class: "muted", text: "No device attached." }));
      this.body.replaceChildren(wrap);
      return;
    }
    const filter = el("input", { class: "input", placeholder: "Filter logcat…", type: "search" }) as HTMLInputElement;
    filter.addEventListener("input", () => {
      this.logsFilter = filter.value.toLowerCase();
    });
    const pause = button("Pause", "Pause/resume the log stream", () => {
      this.logsPaused = !this.logsPaused;
      pause.textContent = this.logsPaused ? "Resume" : "Pause";
    });
    const list = el("div", { class: "log-lines" });
    wrap.append(el("div", { class: "logs-head" }, filter, pause), list);
    this.body.replaceChildren(wrap);

    this.logsSource = new EventSource(target.entry.logsEndpoint);
    this.logsSource.onmessage = (event) => {
      if (this.logsPaused) return;
      try {
        const { line } = JSON.parse(event.data) as { line: string };
        // Mirror into the browser console so browser-driving agents can read device logs.
        console.log(`[logcat] ${line}`);
        if (this.logsFilter && !line.toLowerCase().includes(this.logsFilter)) return;
        const div = el("div", { class: "log-line" });
        div.textContent = line;
        list.append(div);
        while (list.childElementCount > 1_000) list.firstElementChild?.remove();
        list.scrollTop = list.scrollHeight;
      } catch {}
    };
  }
}

// ── App ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const app = document.getElementById("app")!;
  const apiPath = `${BOOT.basePath}/api` || "/api";
  let api: ApiState;
  try {
    const res = await fetch(apiPath);
    api = (await res.json()) as ApiState;
  } catch {
    app.replaceChildren(el("p", { class: "muted", text: "Failed to reach the serve-avd server." }));
    return;
  }

  const stage = el("main", { class: "stage" });
  const views: DeviceView[] = [];
  const preferMjpeg = api.codec === "mjpeg";

  const addView = (entry: DeviceEntry) => {
    const view = new DeviceView(entry, preferMjpeg);
    views.push(view);
    stage.append(view.root);
  };
  api.devices.forEach(addView);
  if (api.devices.length === 0) {
    stage.append(
      el(
        "div",
        { class: "empty" },
        el("h2", { text: "No emulators attached" }),
        el("p", { class: "muted", text: "Open the Devices pane to boot an AVD or attach a connected device." }),
      ),
    );
  }

  const attachDevice = async (name: string) => {
    const res = await fetch(api.gridStartEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device: name }),
    });
    if (res.ok) {
      const { device } = (await res.json()) as { device: DeviceEntry };
      if (!views.some((v) => v.entry.device === device.device)) {
        stage.querySelector(".empty")?.remove();
        addView(device);
      }
    }
  };

  const panes = new Panes(api, () => views, attachDevice);

  const header = el(
    "header",
    { class: "topbar" },
    el("div", { class: "brand" }, el("span", { class: "logo", text: "▶" }), el("strong", { text: "serve-avd" }), el("span", { class: "muted", text: ` v${api.version}` })),
    el(
      "div",
      { class: "topbar-actions" },
      button("Fit", "Fit emulator to viewport", () => document.body.classList.toggle("fit"), "ghost"),
      button("Devices", "Devices pane", () => panes.toggle("devices"), "ghost"),
      button("Tools", "Tools pane", () => panes.toggle("tools"), "ghost"),
      button("Logs", "Logcat pane", () => panes.toggle("logs"), "ghost"),
    ),
  );

  app.replaceChildren(header, el("div", { class: "layout" }, stage, panes.root));

  if (BOOT.initialState.fit) document.body.classList.add("fit");
  const initialPanes = BOOT.initialState.panes ?? [];
  if (initialPanes.length > 0 && initialPanes[0] !== "none") panes.open(initialPanes[0]!);
}

void main();
