/**
 * `serve-avd/client` — a typed client for a running serve-avd server.
 *
 *   import { connect } from "serve-avd/client";
 *   const emu = await connect("http://localhost:3200");
 *   const dev = emu.device();                 // first attached device
 *   await dev.tap({ text: "Sign in" });
 *   await dev.type("hello");
 *   await dev.waitFor({ text: "Welcome" }, { timeoutMs: 10_000 });
 *   const png = await dev.screenshot();
 *
 * Plain `fetch` over the same HTTP API the preview UI uses — no WebSocket, no
 * Node-only modules — so it works from Node 18+, Bun, Deno and browsers
 * (subject to CORS, which the server allows). Everything routes through
 * `POST /helper/<serial>/action`, so the server's event log, Tools pane and any
 * open viewers see what your script does.
 */
import type { AxDump, AxQuery, AxMatch, FindResult, WaitResult } from "./ax";

// ── Types ──────────────────────────────────────────────────────────────────

export type { AxDump, AxQuery, AxMatch, FindResult, WaitResult };

export interface ScreenConfig {
  width: number;
  height: number;
  orientation: "portrait" | "landscape_left" | "portrait_upside_down" | "landscape_right" | string;
  rotation: number;
}

export interface DeviceInfo {
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

export interface ServerInfo {
  version: string;
  codec: "auto" | "mjpeg";
  basePath: string;
  devices: DeviceInfo[];
  gridApiEndpoint: string;
  gridStartEndpoint: string;
  eventLogEndpoint: string;
  eventLogEventsEndpoint: string;
}

export interface EventLogEntry {
  id: number;
  timestamp: string;
  source: string;
  kind: string;
  msg: string;
  summary: string;
  device?: string;
  action?: string;
  status?: "ok" | "error";
  details?: Record<string, unknown>;
}

export interface ForegroundApp {
  packageName: string;
  activity?: string;
  pid?: number;
}

export type Point = { x: number; y: number };
export type TapTarget = Point | AxQuery;

export interface Screenshot {
  data: Uint8Array;
  contentType: "image/jpeg" | "image/png";
}

export type Orientation = "portrait" | "landscape_left" | "portrait_upside_down" | "landscape_right";

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  gone?: boolean;
}

export type ActionErrorCode = "bad_request" | "not_found" | "unsupported" | "failed";

/** Thrown when the server rejects or fails an action. */
export class ServeAvdError extends Error {
  constructor(
    message: string,
    public readonly code: ActionErrorCode | "http" | "network",
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ServeAvdError";
  }
}

export interface ConnectOptions {
  /** Custom fetch (defaults to the global one). */
  fetch?: typeof fetch;
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

type Fetch = typeof fetch;

async function getJson<T>(f: Fetch, url: string): Promise<T> {
  let res: Response;
  try {
    res = await f(url);
  } catch (err) {
    throw new ServeAvdError(`Cannot reach ${url}: ${err instanceof Error ? err.message : String(err)}`, "network");
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) throw new ServeAvdError(body.message ?? body.error ?? `HTTP ${res.status}`, "http", res.status);
  return body;
}

// ── Device handle ──────────────────────────────────────────────────────────

export class Device {
  constructor(
    readonly info: DeviceInfo,
    private readonly origin: string,
    private readonly f: Fetch,
    private readonly server: ServeAvd,
  ) {}

  /** adb serial. */
  get serial(): string {
    return this.info.device;
  }
  /** Human name (AVD name / model). */
  get name(): string {
    return this.info.name;
  }

  private url(endpoint: string): string {
    return new URL(endpoint, this.origin).toString();
  }

  // ── Generic action ───────────────────────────────────────────────────────

  /**
   * Run any device action by name (see the README's action table):
   * `tap`, `swipe`, `text`, `key`, `button`, `rotate`, `debug`, `theme`, `scroll`,
   * `memory-warning`, `find`, `wait`, `geo`, `network`, `battery`, `fingerprint`,
   * `call`, `sms`, `font-scale`, `density`, `locale`, `talkback`, `install`,
   * `launch`, `stop`, `clear-data`, `uninstall`, `open`, `apps`, `snapshot`, `shell`.
   */
  async action<T = unknown>(name: string, params: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}): Promise<T> {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeoutMs = options.timeoutMs ?? defaultTimeout(name, params);
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let res: Response;
    try {
      res = await this.f(this.url(this.info.actionEndpoint), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: name, params }),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (err) {
      throw new ServeAvdError(
        controller?.signal.aborted ? `'${name}' timed out after ${timeoutMs}ms` : `Cannot reach serve-avd: ${err instanceof Error ? err.message : String(err)}`,
        "network",
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; error?: string; message?: string };
    if (!res.ok || body.ok === false) {
      const code = (body.error ?? "failed") as ActionErrorCode;
      throw new ServeAvdError(body.message ?? `HTTP ${res.status}`, ["bad_request", "not_found", "unsupported", "failed"].includes(code) ? code : "failed", res.status);
    }
    return body.result as T;
  }

  // ── Input ────────────────────────────────────────────────────────────────

  /**
   * Tap. `tap(0.5, 0.9)` (normalized coords), `tap({ x, y })`, or
   * `tap({ text: "Sign in" })` / `{ id: "submit" }` / `{ desc: "Search" }`.
   */
  tap(target: TapTarget, options?: { durationMs?: number; index?: number }): Promise<TapResult>;
  tap(x: number, y: number, options?: { durationMs?: number }): Promise<TapResult>;
  tap(a: TapTarget | number, b?: number | { durationMs?: number; index?: number }, c?: { durationMs?: number }): Promise<TapResult> {
    if (typeof a === "number") return this.action<TapResult>("tap", { x: a, y: b as number, ...(c ?? {}) });
    return this.action<TapResult>("tap", { ...a, ...((b as object) ?? {}) });
  }

  /** Long-press for `durationMs` (default 600). */
  longPress(target: TapTarget, durationMs = 600): Promise<TapResult> {
    return this.action<TapResult>("tap", { ...target, durationMs });
  }

  /** Swipe between normalized points. */
  swipe(from: Point, to: Point, durationMs = 300): Promise<unknown> {
    return this.action("swipe", { x1: from.x, y1: from.y, x2: to.x, y2: to.y, durationMs });
  }

  /** Scroll content down (finger up) by a fraction of the screen around a point. */
  scroll(dy = 0.5, at: Point = { x: 0.5, y: 0.5 }): Promise<unknown> {
    return this.action("scroll", { dx: 0, dy, x: at.x, y: at.y });
  }

  /** Type ASCII text into the focused field (\n = Enter, \t = Tab). */
  type(text: string): Promise<unknown> {
    return this.action("text", { text });
  }

  /** Press a key by browser KeyboardEvent.code (Enter, Backspace, ArrowDown, KeyA…). */
  key(code: string, options: { longPress?: boolean } = {}): Promise<unknown> {
    return this.action("key", { code, ...options });
  }

  /** Press a hardware/navigation button: home, back, app-switch, power, volume-up… */
  button(name: string): Promise<unknown> {
    return this.action("button", { button: name });
  }
  back(): Promise<unknown> {
    return this.button("back");
  }
  home(): Promise<unknown> {
    return this.button("home");
  }

  rotate(orientation: Orientation): Promise<{ requested: number; rotation: number; applied: boolean }> {
    return this.action("rotate", { orientation });
  }

  theme(theme: "light" | "dark"): Promise<unknown> {
    return this.action("theme", { theme });
  }

  debugFlag(option: "overdraw" | "gpu-profile" | "layout-bounds" | "show-taps" | "pointer-location" | "slow-animations", enabled: boolean): Promise<unknown> {
    return this.action("debug", { option, enabled });
  }

  // ── Query ────────────────────────────────────────────────────────────────

  /** UI hierarchy (uiautomator) as a JSON tree. */
  ax(): Promise<AxDump> {
    return getJson<AxDump>(this.f, this.url(this.info.axEndpoint));
  }

  /** Find UI elements matching a query. */
  find(query: AxQuery): Promise<FindResult & { query: AxQuery }> {
    return this.action("find", { ...query });
  }

  /** First match or null. */
  async findFirst(query: AxQuery): Promise<AxMatch | null> {
    const result = await this.find(query);
    return result.matches[query.index ?? 0] ?? null;
  }

  /** True when at least one element matches right now. */
  async exists(query: AxQuery): Promise<boolean> {
    return (await this.find(query)).total > 0;
  }

  /**
   * Wait for an element to appear (or disappear with `gone`). Resolves with the
   * match; throws `ServeAvdError("failed")` on timeout.
   */
  async waitFor(query: AxQuery, options: WaitOptions = {}): Promise<AxMatch | null> {
    const result = await this.action<WaitResult & { query: AxQuery; gone: boolean }>("wait", { ...query, ...options });
    if (!result.ok) {
      throw new ServeAvdError(`Timed out after ${result.elapsedMs}ms waiting for ${JSON.stringify(query)}${options.gone ? " to disappear" : ""}`, "failed");
    }
    return result.match;
  }

  /** Foreground app, or null when none is resumed. */
  async foreground(): Promise<ForegroundApp | null> {
    const res = await this.f(this.url(this.info.foregroundEndpoint));
    if (res.status === 503) return null;
    const body = (await res.json()) as ForegroundApp & { message?: string };
    if (!res.ok) throw new ServeAvdError(body.message ?? `HTTP ${res.status}`, "http", res.status);
    return body;
  }

  /** Current rotated screen size / orientation. */
  config(): Promise<ScreenConfig> {
    return getJson<ScreenConfig>(this.f, this.url(this.info.configEndpoint));
  }

  /** One-shot screenshot (JPEG on modern Android, else PNG). */
  async screenshot(): Promise<Screenshot> {
    const res = await this.f(this.url(this.info.screenshotEndpoint));
    if (!res.ok) throw new ServeAvdError(`Screenshot failed: HTTP ${res.status}`, "http", res.status);
    const contentType = (res.headers.get("content-type") ?? "").includes("jpeg") ? "image/jpeg" : "image/png";
    return { data: new Uint8Array(await res.arrayBuffer()), contentType };
  }

  /** Recent event-log entries for this device. */
  eventLog(limit?: number): Promise<EventLogEntry[]> {
    return this.server.eventLog({ device: this.serial, limit });
  }

  // ── Emulator controls ────────────────────────────────────────────────────

  geo(lat: number, lon: number, alt?: number): Promise<unknown> {
    return this.action("geo", { lat, lon, ...(alt != null ? { alt } : {}) });
  }

  /** Follow a route of fixes, `intervalMs` apart. Resolves when done (or when `signal` aborts). */
  async followRoute(points: Array<{ lat: number; lon: number; alt?: number }>, intervalMs = 1_000, signal?: AbortSignal): Promise<void> {
    for (let i = 0; i < points.length; i++) {
      if (signal?.aborted) return;
      const p = points[i]!;
      await this.geo(p.lat, p.lon, p.alt);
      if (i < points.length - 1) await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  network(settings: { speed?: string; delay?: string; airplane?: boolean; wifi?: boolean; data?: boolean } = {}): Promise<Record<string, unknown>> {
    return this.action("network", settings);
  }

  battery(settings: { level?: number; plugged?: "ac" | "usb" | "wireless" | "none"; reset?: boolean } = {}): Promise<{ level: number | null; plugged: string; status: string | null }> {
    return this.action("battery", settings);
  }

  fingerprint(id = 1, remove = false): Promise<unknown> {
    return this.action("fingerprint", { id, remove });
  }

  call(number: string, op: "call" | "accept" | "end" | "hold" = "call"): Promise<unknown> {
    return this.action("call", { number, op });
  }

  sms(number: string, text: string): Promise<unknown> {
    return this.action("sms", { number, text });
  }

  fontScale(scale: number): Promise<unknown> {
    return this.action("font-scale", { scale });
  }

  density(dpi: number | "reset"): Promise<unknown> {
    return this.action("density", { dpi: String(dpi) });
  }

  locale(locale: string, options: { package?: string; system?: boolean } = {}): Promise<unknown> {
    return this.action("locale", { locale, ...options });
  }

  talkback(enabled: boolean): Promise<unknown> {
    return this.action("talkback", { enabled });
  }

  readonly snapshot = {
    save: (name: string) => this.action("snapshot", { op: "save", name }),
    load: (name: string) => this.action("snapshot", { op: "load", name }),
    delete: (name: string) => this.action("snapshot", { op: "delete", name }),
    list: () => this.action<{ snapshots: Array<{ id: string; tag: string; size?: string; date?: string }> }>("snapshot", { op: "list" }),
  };

  // ── Apps ─────────────────────────────────────────────────────────────────

  /** Install an APK by path on the serve-avd host. */
  install(path: string): Promise<{ output: string }> {
    return this.action("install", { path });
  }
  launch(pkg: string, wait = true): Promise<{ component?: string }> {
    return this.action("launch", { package: pkg, wait });
  }
  stop(pkg: string): Promise<unknown> {
    return this.action("stop", { package: pkg });
  }
  clearData(pkg: string): Promise<unknown> {
    return this.action("clear-data", { package: pkg });
  }
  uninstall(pkg: string): Promise<unknown> {
    return this.action("uninstall", { package: pkg });
  }
  open(url: string, pkg?: string): Promise<{ component?: string }> {
    return this.action("open", { url, ...(pkg ? { package: pkg } : {}) });
  }
  async apps(all = false): Promise<string[]> {
    return (await this.action<{ packages: string[] }>("apps", { all })).packages;
  }

  /** Run a shell command on the device. */
  shell(cmd: string): Promise<{ code: number; output: string }> {
    return this.action("shell", { cmd });
  }
}

export interface TapResult {
  x: number;
  y: number;
  px: number;
  py: number;
  matched?: { text?: string; resourceId?: string; contentDesc?: string; bounds: { left: number; top: number; right: number; bottom: number } };
}

function defaultTimeout(name: string, params: Record<string, unknown>): number {
  if (name === "wait") return (Number(params.timeoutMs) || 10_000) + 15_000;
  if (name === "install" || name === "snapshot") return 320_000;
  if (name === "shell" || name === "launch" || name === "open") return 90_000;
  return 30_000;
}

// ── Server handle ──────────────────────────────────────────────────────────

export class ServeAvd {
  private constructor(
    readonly origin: string,
    private info: ServerInfo,
    private readonly f: Fetch,
  ) {}

  /** @internal */
  static async open(url: string, options: ConnectOptions): Promise<ServeAvd> {
    const f = options.fetch ?? globalThis.fetch;
    if (!f) throw new ServeAvdError("No fetch available — pass one in ConnectOptions", "network");
    const origin = url.replace(/\/+$/, "");
    const info = await getJson<ServerInfo>(f, `${origin}/api`);
    return new ServeAvd(origin, info, f);
  }

  get version(): string {
    return this.info.version;
  }

  /** Endpoints from /api are absolute paths (base included) — resolve against the host. */
  private abs(path: string): string {
    return new URL(path, this.origin).toString();
  }

  /** Attached devices (snapshot from the last refresh). */
  get devices(): Device[] {
    return this.info.devices.map((d) => new Device(d, this.origin, this.f, this));
  }

  /** Re-read the device list from the server. */
  async refresh(): Promise<Device[]> {
    this.info = await getJson<ServerInfo>(this.f, `${this.origin}/api`);
    return this.devices;
  }

  /**
   * A device by serial or name, or the first attached one. Throws when none is
   * attached (or none matches).
   */
  device(serialOrName?: string): Device {
    const list = this.devices;
    if (!serialOrName) {
      if (list.length === 0) throw new ServeAvdError("No devices attached to the serve-avd server", "not_found");
      return list[0]!;
    }
    const wanted = serialOrName.replace(/ /g, "_").toLowerCase();
    const match = list.find((d) => d.serial === serialOrName || d.name.replace(/ /g, "_").toLowerCase() === wanted);
    if (!match) throw new ServeAvdError(`No attached device '${serialOrName}' (have: ${list.map((d) => d.serial).join(", ") || "none"})`, "not_found");
    return match;
  }

  /** Attach a connected serial or boot an AVD by name; resolves with its handle. */
  async attach(serialOrAvd: string): Promise<Device> {
    const res = await this.f(this.abs(this.info.gridStartEndpoint), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device: serialOrAvd }),
    });
    const body = (await res.json().catch(() => ({}))) as { device?: DeviceInfo; error?: string };
    if (!res.ok || !body.device) throw new ServeAvdError(body.error ?? `attach failed: HTTP ${res.status}`, "failed", res.status);
    await this.refresh();
    return new Device(body.device, this.origin, this.f, this);
  }

  /** Connected adb devices + configured AVDs, as the Devices pane sees them. */
  grid(): Promise<{ devices: Array<{ serial: string; state: string; model?: string; isEmulator: boolean; attached: boolean }>; avds: Array<{ name: string; running: boolean }> }> {
    return getJson(this.f, this.abs(this.info.gridApiEndpoint));
  }

  /** Recent event-log entries (all devices unless filtered). */
  async eventLog(options: { device?: string; limit?: number } = {}): Promise<EventLogEntry[]> {
    const url = new URL(this.abs(this.info.eventLogEndpoint));
    if (options.device) url.searchParams.set("device", options.device);
    if (options.limit != null) url.searchParams.set("limit", String(options.limit));
    return (await getJson<{ events: EventLogEntry[] }>(this.f, url.toString())).events;
  }
}

/**
 * Connect to a running serve-avd server (default `http://localhost:3200`).
 * Also accepts a mounted middleware base, e.g. `http://localhost:8081/.emu`.
 */
export function connect(url = "http://localhost:3200", options: ConnectOptions = {}): Promise<ServeAvd> {
  return ServeAvd.open(url, options);
}
