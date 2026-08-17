/**
 * A device driver for the CLI, MCP server and replay: the same handful of
 * operations (actions, screenshot, ax, foreground, event log) whether a
 * serve-avd preview server is running for the device (talk to it over HTTP so
 * the event log, Tools pane and viewers all see what happened) or not (drive
 * adb directly with a private shell — every command works headless).
 */
import { AdbShell, adb, adbEmu, listDevices, screenGeometry, screenRotation, avdNameForSerial } from "./adb";
import { InputInjector, orientationNameForRotation, type ForegroundApp } from "./input";
import { StillCapture, type StillFrame } from "./capture";
import { dumpUiHierarchy, type AxDump } from "./ax";
import { runAction, ActionError, type ActionContext, type ActionParams } from "./actions";
import { recordEventLogEvent, listEventLogEvents, type EventLogEntry } from "./event-log";
import { readAllStates, removeStateForDevice, statePidAlive, type ServeAvdDeviceState } from "./state";

export interface DeviceDriver {
  readonly serial: string;
  /** Human name when known (AVD name / model). */
  readonly name: string;
  /** "server" = via a running serve-avd; "adb" = headless direct. */
  readonly mode: "server" | "adb";
  /** Preview URL when served. */
  readonly url?: string;
  action(name: string, params?: ActionParams): Promise<unknown>;
  screenshot(): Promise<StillFrame>;
  ax(): Promise<AxDump>;
  foreground(): Promise<ForegroundApp | null>;
  eventLog(limit?: number): Promise<EventLogEntry[]>;
  screenConfig(): Promise<{ width: number; height: number; orientation: string; rotation: number }>;
  close(): void;
}

// ── Remote (running server) ────────────────────────────────────────────────

/** Errors from the server's action endpoint keep their action error code. */
export class RemoteActionError extends ActionError {}

export class RemoteDriver implements DeviceDriver {
  readonly mode = "server" as const;
  readonly serial: string;
  readonly name: string;
  readonly url: string;
  private readonly helperBase: string;

  constructor(readonly state: ServeAvdDeviceState) {
    this.serial = state.device;
    this.name = state.name ?? state.device;
    this.url = state.url;
    this.helperBase = state.streamUrl.replace(/\/stream\.mjpeg$/, "");
  }

  private endpoint(path: string): string {
    return `${this.helperBase}/${path}`;
  }

  async action(name: string, params: ActionParams = {}): Promise<unknown> {
    const timeoutMs = actionTimeoutMs(name, params);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.endpoint("action"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: name, params }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(
        controller.signal.aborted
          ? `serve-avd server did not answer '${name}' within ${Math.round(timeoutMs / 1000)}s`
          : `Failed to reach serve-avd server at ${this.url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; error?: string; message?: string };
    if (!res.ok || body.ok === false) {
      const code = (body.error as ActionError["code"] | undefined) ?? "failed";
      throw new RemoteActionError(body.message ?? `HTTP ${res.status}`, ["bad_request", "not_found", "unsupported", "failed"].includes(code) ? code : "failed");
    }
    return body.result;
  }

  async screenshot(): Promise<StillFrame> {
    const res = await fetch(this.endpoint("screenshot.png"));
    if (!res.ok) throw new Error(`Screenshot failed: HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    const contentType = (res.headers.get("content-type") ?? "").includes("jpeg") ? "image/jpeg" : "image/png";
    return { data, contentType, capturedAt: Date.now() };
  }

  async ax(): Promise<AxDump> {
    const res = await fetch(this.endpoint("ax"));
    const body = (await res.json()) as AxDump & { error?: string; message?: string };
    if (!res.ok) throw new Error(body.message ?? `ax failed: HTTP ${res.status}`);
    return body;
  }

  async foreground(): Promise<ForegroundApp | null> {
    const res = await fetch(this.endpoint("foreground"));
    if (res.status === 503) return null;
    const body = (await res.json()) as ForegroundApp & { error?: string; message?: string };
    if (!res.ok) throw new Error(body.message ?? `foreground failed: HTTP ${res.status}`);
    return body;
  }

  async eventLog(limit?: number): Promise<EventLogEntry[]> {
    const url = new URL("/api/event-log", this.url);
    url.searchParams.set("device", this.serial);
    if (limit != null) url.searchParams.set("limit", String(limit));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`event log failed: HTTP ${res.status}`);
    return ((await res.json()) as { events: EventLogEntry[] }).events;
  }

  async screenConfig(): Promise<{ width: number; height: number; orientation: string; rotation: number }> {
    const res = await fetch(this.endpoint("config"));
    if (!res.ok) throw new Error(`config failed: HTTP ${res.status}`);
    return (await res.json()) as { width: number; height: number; orientation: string; rotation: number };
  }

  close(): void {}
}

/** Generous per-action HTTP timeouts — waits, installs and snapshots are slow by design. */
function actionTimeoutMs(name: string, params: ActionParams): number {
  if (name === "wait") return (Number(params.timeoutMs) || 10_000) + 15_000;
  if (name === "install" || name === "snapshot") return 320_000;
  if (name === "shell" || name === "launch" || name === "open") return 90_000;
  return 30_000;
}

// ── Local (direct adb) ─────────────────────────────────────────────────────

export class LocalDriver implements DeviceDriver {
  readonly mode = "adb" as const;
  readonly shell: AdbShell;
  readonly injector: InputInjector;
  private readonly still: StillCapture;
  private rotation = 0;
  private natural: { width: number; height: number } | null = null;

  constructor(
    readonly serial: string,
    readonly name: string = serial,
  ) {
    this.shell = new AdbShell(serial);
    this.injector = new InputInjector(serial, this.shell, () => this.rotation);
    this.still = new StillCapture(serial);
  }

  private async displaySize(): Promise<{ width: number; height: number }> {
    if (!this.natural) {
      const g = await screenGeometry(this.serial);
      this.natural = { width: g.width, height: g.height };
    }
    this.rotation = await screenRotation(this.serial, this.shell);
    const swap = this.rotation % 2 === 1;
    return swap
      ? { width: this.natural.height, height: this.natural.width }
      : { width: this.natural.width, height: this.natural.height };
  }

  private context(): ActionContext {
    return {
      serial: this.serial,
      shell: this.shell,
      injector: this.injector,
      displaySize: () => this.displaySize(),
      ax: () => dumpUiHierarchy(this.shell),
      emu: (args, opts) => adbEmu(this.serial, args, opts),
      adb: (args, opts) => adb(["-s", this.serial, ...args], opts),
      record: (entry) => recordEventLogEvent({ device: this.serial, source: "cli", ...entry }),
      onRotation: (rotation) => {
        this.rotation = rotation;
      },
    };
  }

  action(name: string, params: ActionParams = {}): Promise<unknown> {
    return runAction(this.context(), name, params);
  }

  async screenshot(): Promise<StillFrame> {
    const shot = await this.still.screenshot(0);
    if (!shot) throw new Error("screencap produced no image");
    return shot;
  }

  ax(): Promise<AxDump> {
    return dumpUiHierarchy(this.shell);
  }

  foreground(): Promise<ForegroundApp | null> {
    return this.injector.foregroundApp();
  }

  async eventLog(limit?: number): Promise<EventLogEntry[]> {
    // Headless: only what this process recorded.
    return listEventLogEvents({ device: this.serial, limit });
  }

  async screenConfig(): Promise<{ width: number; height: number; orientation: string; rotation: number }> {
    const { width, height } = await this.displaySize();
    return { width, height, orientation: orientationNameForRotation(this.rotation), rotation: this.rotation };
  }

  close(): void {
    this.shell.close();
  }
}

// ── Resolution ─────────────────────────────────────────────────────────────

/** Live serve-avd state files (dropping stale ones), optionally filtered by serial or name. */
export function liveServerStates(device?: string): ServeAvdDeviceState[] {
  return readAllStates().filter((s) => {
    if (device && s.device !== device && s.name !== device && s.name?.replace(/ /g, "_") !== device) return false;
    if (!statePidAlive(s)) {
      removeStateForDevice(s.device);
      return false;
    }
    return true;
  });
}

export interface ResolveDriverOptions {
  /** Force a mode; default: server when one is running for the device, else adb. */
  mode?: "auto" | "server" | "adb";
}

/**
 * Pick a driver for `device` (adb serial, AVD name, or undefined = the only /
 * first device). Prefers a running preview server so actions show up in its
 * event log and Tools pane; falls back to headless adb.
 */
export async function resolveDriver(device?: string, options: ResolveDriverOptions = {}): Promise<DeviceDriver> {
  const mode = options.mode ?? "auto";
  if (mode !== "adb") {
    const states = liveServerStates(device);
    if (states.length > 0) return new RemoteDriver(states[0]!);
    if (mode === "server") {
      throw new Error(device ? `No serve-avd server is streaming '${device}'. Run \`serve-avd ${device}\` first.` : "No serve-avd server running. Run `serve-avd` first.");
    }
  }
  const online = (await listDevices()).filter((d) => d.state === "device");
  if (device) {
    const bySerial = online.find((d) => d.serial === device);
    if (bySerial) return new LocalDriver(bySerial.serial, (await avdNameForSerial(bySerial.serial))?.replace(/_/g, " ") ?? bySerial.model ?? bySerial.serial);
    const wanted = device.replace(/ /g, "_").toLowerCase();
    for (const d of online) {
      if (!d.isEmulator) continue;
      const avd = await avdNameForSerial(d.serial);
      if (avd && avd.toLowerCase() === wanted) return new LocalDriver(d.serial, avd.replace(/_/g, " "));
    }
    throw new Error(
      `No connected device or running AVD matching '${device}'.${online.length ? ` Connected: ${online.map((d) => d.serial).join(", ")}` : " Nothing is connected."}`,
    );
  }
  if (online.length === 0) throw new Error("No devices connected and no serve-avd server running. Start an emulator or run `serve-avd`.");
  const first = online[0]!;
  return new LocalDriver(first.serial, (await avdNameForSerial(first.serial))?.replace(/_/g, " ") ?? first.model ?? first.serial);
}
