/**
 * serve-avd CLI — the `npx serve` of Android Emulators.
 *
 * Mirrors serve-sim's interface: the bare command starts a preview server,
 * subcommands drive a running server over its state file + input WebSocket.
 */
import { Command } from "commander";
import { spawn } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import WebSocket from "ws";
import {
  listDevices,
  listAvds,
  launchAvd,
  waitForBoot,
  waitForNewEmulatorSerial,
  avdNameForSerial,
  adbPath,
} from "./adb";
import { startServer } from "./server";
import { peekDeviceSession } from "./device-session";
import {
  readAllStates,
  removeStateForDevice,
  statePidAlive,
  type ServeAvdDeviceState,
} from "./state";
import { subscribeEventLog, type EventLogEntry } from "./event-log";
import { formatEventLogLine } from "./event-log-format";
import { BUTTONS, UnsupportedCharacterError, textToSteps } from "./keymap";
import { ORIENTATIONS, DEBUG_FLAGS } from "./input";
import { describeQuery, type AxMatch, type AxQuery, type FindResult, type WaitResult } from "./ax";
import { ActionError, type ActionParams } from "./actions";
import { resolveDriver, type DeviceDriver } from "./driver";
import { eventsToScript, runScript, parseScript, type ReplayScript } from "./replay";
import { runMcpServer } from "./mcp";
import type { PreviewInitialState } from "./middleware";

declare const __SERVE_AVD_VERSION__: string | undefined;
const VERSION = typeof __SERVE_AVD_VERSION__ === "string" ? __SERVE_AVD_VERSION__ : "dev";

const DIM = "\x1b[90m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

// ── Device resolution ──────────────────────────────────────────────────────

/**
 * Resolve CLI device args to serials. Accepts adb serials and AVD names
 * (booting the AVD when it isn't running). With no args: every online device,
 * or — when nothing is running — boot the first configured AVD.
 */
async function resolveTargets(args: string[], quiet: boolean): Promise<string[]> {
  const online = (await listDevices()).filter((d) => d.state === "device");

  if (args.length === 0) {
    if (online.length > 0) return online.map((d) => d.serial);
    const avds = await listAvds();
    if (avds.length === 0) {
      throw new Error(
        "No devices connected and no AVDs configured. Create one in Android Studio's Device Manager or with avdmanager.",
      );
    }
    if (!quiet) console.log(`No running emulator — booting ${BOLD}${avds[0]}${RESET}…`);
    return [await bootAvd(avds[0]!, online.map((d) => d.serial))];
  }

  const serials: string[] = [];
  const avds = await listAvds();
  const runningAvdNames = new Map<string, string>(); // avd name → serial
  for (const device of online) {
    if (!device.isEmulator) continue;
    const name = await avdNameForSerial(device.serial);
    if (name) runningAvdNames.set(name.toLowerCase(), device.serial);
  }

  for (const arg of args) {
    const bySerial = online.find((d) => d.serial === arg);
    if (bySerial) {
      serials.push(bySerial.serial);
      continue;
    }
    const normalized = arg.replace(/ /g, "_").toLowerCase();
    const runningSerial = runningAvdNames.get(normalized);
    if (runningSerial) {
      serials.push(runningSerial);
      continue;
    }
    const avd = avds.find((name) => name.toLowerCase() === normalized);
    if (avd) {
      if (!quiet) console.log(`Booting ${BOLD}${avd}${RESET}…`);
      serials.push(await bootAvd(avd, online.map((d) => d.serial)));
      continue;
    }
    const known = [...online.map((d) => d.serial), ...avds];
    throw new Error(
      `No device or AVD matching '${arg}'.${known.length ? ` Available: ${known.join(", ")}` : ""}`,
    );
  }
  return [...new Set(serials)];
}

async function bootAvd(name: string, knownSerials: string[]): Promise<string> {
  launchAvd(name);
  const serial = await waitForNewEmulatorSerial(new Set(knownSerials), 120_000);
  if (!serial) throw new Error(`AVD ${name} did not come online within 2 minutes`);
  await waitForBoot(serial, 180_000);
  return serial;
}

// ── serve / follow / detach ────────────────────────────────────────────────

interface ServeOpts {
  port?: number;
  host?: string;
  quiet: boolean;
  codec?: "auto" | "mjpeg";
  theme?: "light" | "dark";
  initialState?: PreviewInitialState;
  bitRate?: number;
  size?: string;
  preview: boolean;
}

async function serve(devices: string[], opts: ServeOpts): Promise<void> {
  const defaultPort = opts.preview ? 3200 : 3100;
  const serials = await resolveTargets(devices, opts.quiet);
  const running = await startServer({
    port: opts.port ?? defaultPort,
    strictPort: opts.port !== undefined,
    host: opts.host,
    codec: opts.codec,
    initialState: opts.initialState,
    sessionOptions: {
      ...(opts.bitRate ? { bitRateMbps: opts.bitRate } : {}),
      ...(opts.size ? { size: opts.size } : {}),
    },
  });

  const states: ServeAvdDeviceState[] = [];
  for (const serial of serials) {
    const state = await running.attach(serial);
    if (opts.theme) await peekDeviceSession(serial)?.injector.setTheme(opts.theme);
    states.push(state);
  }

  const shutdown = () => {
    running.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (opts.quiet) {
    printStatesJSON(states);
  } else {
    console.log(`\n  ${BOLD}serve-avd${RESET} ${DIM}v${VERSION}${RESET}\n`);
    for (const state of states) {
      const session = peekDeviceSession(state.device);
      console.log(`  ${GREEN}▸${RESET} ${BOLD}${session?.name ?? state.device}${RESET} ${DIM}(${state.device})${RESET}`);
      if (opts.preview) console.log(`    Preview  ${state.url}`);
      console.log(`    Stream   ${state.streamUrl}`);
      console.log(`    WS       ${state.wsUrl}${DIM}  (binary [tag][JSON] input protocol)${RESET}`);
    }
    console.log(`\n  ${DIM}Ctrl+C to stop${RESET}\n`);
    // Tail the event log so foreground use shows what agents/browsers do.
    subscribeEventLog((entry: EventLogEntry) => {
      const session = entry.device ? peekDeviceSession(entry.device) : undefined;
      console.log(`  ${DIM}${formatEventLogLine(entry, { deviceLabel: session?.name ?? null })}${RESET}`);
    });
  }
}

async function detach(devices: string[], port: number | undefined, quiet: boolean): Promise<void> {
  // Re-exec ourselves headless in the background; wait for state files.
  const serials = await resolveTargets(devices, quiet);
  const before = new Map(readAllStates().map((s) => [s.device, s.pid]));
  const args = [process.argv[1]!, ...serials, "--no-preview", "-q"];
  if (port !== undefined) args.push("-p", String(port));
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore" });
  child.unref();

  const deadline = Date.now() + 30_000;
  const states: ServeAvdDeviceState[] = [];
  while (Date.now() < deadline && states.length < serials.length) {
    await new Promise((r) => setTimeout(r, 250));
    states.length = 0;
    for (const state of readAllStates()) {
      if (serials.includes(state.device) && state.pid !== before.get(state.device) && statePidAlive(state)) {
        states.push(state);
      }
    }
  }
  if (states.length === 0) {
    console.error("Failed to start background server (try running without --detach to see errors).");
    process.exit(1);
  }
  printStatesJSON(states);
}

function printStatesJSON(states: ServeAvdDeviceState[]): void {
  console.log(JSON.stringify(states.length === 1 ? states[0] : states, null, 2));
}

// ── list / kill ────────────────────────────────────────────────────────────

function aliveStates(device?: string): ServeAvdDeviceState[] {
  const states = readAllStates().filter((s) => {
    if (device && s.device !== device && s.name !== device) return false;
    if (!statePidAlive(s)) {
      removeStateForDevice(s.device);
      return false;
    }
    return true;
  });
  return states;
}

function listStreams(device?: string): void {
  const states = aliveStates(device);
  if (states.length === 0) {
    console.log("No running streams.");
    return;
  }
  for (const s of states) {
    console.log(`${BOLD}${s.name ?? s.device}${RESET} ${DIM}(${s.device})${RESET}  pid ${s.pid}  ${s.url}`);
  }
}

function killStreams(device?: string): void {
  const states = aliveStates(device);
  if (states.length === 0) {
    console.log("No running streams.");
    return;
  }
  for (const s of states) {
    try {
      process.kill(s.pid, "SIGTERM");
      console.log(`Stopped ${s.device} (pid ${s.pid})`);
    } catch {}
    removeStateForDevice(s.device);
  }
}

// ── Talking to a running server ────────────────────────────────────────────

function readState(device?: string): ServeAvdDeviceState | null {
  const states = aliveStates(device);
  return states[0] ?? null;
}

function requireState(device?: string): ServeAvdDeviceState {
  const state = readState(device);
  if (!state) {
    console.error("No serve-avd server running. Run `serve-avd` first.");
    process.exit(1);
  }
  return state;
}

/**
 * Send `[tag][JSON]` frames over the server's input WebSocket.
 *
 * `awaitReply` holds the socket open until the server pushes a frame it
 * accepts (or `awaitTimeoutMs` elapses) — for commands whose effect lands
 * asynchronously on the device, so a scripted `rotate && screenshot` sees the
 * result rather than racing it.
 */
function sendHid(
  state: ServeAvdDeviceState,
  frames: Array<{ tag: number; body?: unknown; delayAfterMs?: number }>,
  options: { awaitReply?: (tag: number, body: unknown) => boolean; awaitTimeoutMs?: number } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(state.wsUrl);
    ws.binaryType = "arraybuffer";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer); // else the pending timer holds the CLI open
      ws.close();
      resolve();
    };
    if (options.awaitReply) {
      ws.on("message", (data: Buffer) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        if (buf.length < 1) return;
        let body: unknown = null;
        try {
          body = JSON.parse(buf.subarray(1).toString("utf8"));
        } catch {
          return;
        }
        if (options.awaitReply!(buf[0]!, body)) finish();
      });
    }
    ws.on("open", async () => {
      for (const frame of frames) {
        const json = frame.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(frame.body));
        const msg = Buffer.concat([Buffer.from([frame.tag]), json]);
        ws.send(msg);
        if (frame.delayAfterMs) await new Promise((r) => setTimeout(r, frame.delayAfterMs));
      }
      timer = setTimeout(finish, options.awaitReply ? (options.awaitTimeoutMs ?? 8_000) : 80);
    });
    ws.on("error", () => {
      console.error("Failed to connect to serve-avd server at", state.wsUrl);
      reject(new Error("WebSocket connection failed"));
    });
  });
}

// ── Subcommand implementations ─────────────────────────────────────────────

async function gesture(jsonStr: string, deviceArg?: string): Promise<void> {
  const state = requireState(deviceArg);
  let touch: { type: string; x: number; y: number };
  try {
    touch = JSON.parse(jsonStr);
  } catch {
    console.error("Invalid JSON:", jsonStr);
    process.exit(1);
  }
  await sendHid(state, [{ tag: 0x03, body: touch }]);
}

async function button(name: string, deviceArg?: string): Promise<void> {
  if (!BUTTONS[name]) {
    console.error(`Unknown button '${name}'. Available: ${Object.keys(BUTTONS).join(", ")}`);
    process.exit(1);
  }
  await runActionCommand(deviceArg, "button", { button: name }, { line: () => "" });
}

async function typeText(
  positional: string[],
  opts: { device?: string; stdin?: boolean; file?: string },
): Promise<void> {
  const sourceCount = [positional.length > 0, opts.stdin ?? false, opts.file != null].filter(Boolean).length;
  if (sourceCount !== 1) {
    console.error("Usage: serve-avd type <text> [-d serial]");
    console.error("       serve-avd type --stdin [-d serial]");
    console.error("       serve-avd type --file <path> [-d serial]");
    console.error("");
    console.error("Only ASCII characters are supported (A-Z, a-z, 0-9, space,");
    console.error("newline, tab, and standard punctuation).");
    process.exit(1);
  }

  let text: string;
  if (opts.stdin) {
    text = readFileSync(0, "utf8");
  } else if (opts.file) {
    try {
      text = readFileSync(opts.file, "utf8");
    } catch (err) {
      console.error(`Failed to read file '${opts.file}': ${(err as Error).message}`);
      process.exit(1);
    }
  } else {
    text = positional.join(" ");
  }

  try {
    textToSteps(text); // validate before sending
  } catch (err) {
    if (err instanceof UnsupportedCharacterError) {
      console.error(err.message);
      console.error("Supported: A-Z, a-z, 0-9, space, newline, tab, and standard punctuation.");
      process.exit(1);
    }
    throw err;
  }

  await runActionCommand(opts.device, "text", { text }, { line: () => "" });
}

async function rotate(orientation: string, deviceArg?: string): Promise<void> {
  if (ORIENTATIONS[orientation] == null) {
    console.error(`Unknown orientation '${orientation}'. Expected: ${Object.keys(ORIENTATIONS).join(" | ")}`);
    process.exit(1);
  }
  // The action returns once the device has actually rotated (or throws when
  // it refused) — not on a fixed delay, so a scripted `rotate && screenshot`
  // captures the new orientation.
  await runActionCommand(deviceArg, "rotate", { orientation }, { line: () => "" });
}

async function debugFlag(option: string, stateArg: string, deviceArg?: string): Promise<void> {
  if (!DEBUG_FLAGS[option]) {
    console.error(`Unknown debug option '${option}'. Available: ${Object.keys(DEBUG_FLAGS).join(", ")}`);
    process.exit(1);
  }
  if (stateArg !== "on" && stateArg !== "off") {
    console.error("State must be 'on' or 'off'.");
    process.exit(1);
  }
  await runActionCommand(deviceArg, "debug", { option, enabled: stateArg === "on" }, { line: () => "" });
}

async function memoryWarning(deviceArg?: string): Promise<void> {
  await runActionCommand(deviceArg, "memory-warning", {}, { line: () => "" });
}

async function eventLog(deviceArg: string | undefined, opts: { json?: boolean; limit?: string }): Promise<void> {
  const state = requireState(deviceArg);
  const url = new URL("/api/event-log", state.url);
  if (deviceArg) url.searchParams.set("device", state.device);
  if (opts.limit != null) {
    const limit = Number(opts.limit);
    if (!Number.isFinite(limit) || limit <= 0) {
      console.error("event-log --limit must be a positive number");
      process.exit(1);
    }
    url.searchParams.set("limit", String(Math.floor(limit)));
  }

  let payload: { events: EventLogEntry[] };
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = (await res.json()) as { events: EventLogEntry[] };
  } catch (err) {
    console.error(`Failed to read event log: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (payload.events.length === 0) {
    console.log("No events.");
    return;
  }
  const labels = new Map<string, string>();
  for (const s of readAllStates()) if (s.name) labels.set(s.device, s.name);
  for (const entry of payload.events) {
    console.log(formatEventLogLine(entry, { deviceLabel: entry.device ? (labels.get(entry.device) ?? entry.device) : null }));
  }
}

// ── Driver-backed commands (server when running, else direct adb) ──────────

/**
 * Resolve a driver for `-d`, run `fn`, and always release the adb shell.
 * Errors print one line and exit 1 — the CLI's contract for scripts/agents.
 */
async function withDriver<T>(deviceArg: string | undefined, fn: (driver: DeviceDriver) => Promise<T>): Promise<T> {
  let driver: DeviceDriver;
  try {
    driver = await resolveDriver(deviceArg);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  try {
    return await fn(driver);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(err instanceof ActionError && err.code === "not_found" ? 3 : 1);
  } finally {
    driver.close();
  }
}

/** Run one action and print its result (JSON, or a caller-provided line). */
async function runActionCommand(
  deviceArg: string | undefined,
  name: string,
  params: ActionParams,
  opts: { json?: boolean; line?: (result: unknown) => string },
): Promise<void> {
  await withDriver(deviceArg, async (driver) => {
    const result = await driver.action(name, params);
    if (opts.json || !opts.line) console.log(JSON.stringify(result, null, 2));
    else {
      const line = opts.line(result);
      if (line) console.log(line);
    }
  });
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** "10s" | "500ms" | "2m" | "1500" → ms. */
function parseDuration(value: string | undefined, fallbackMs: number): number {
  if (value == null || value === "") return fallbackMs;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/i.exec(value.trim());
  if (!m) {
    console.error(`Invalid duration '${value}' — use e.g. 500ms, 10s, 2m, or a number of ms`);
    process.exit(1);
  }
  const n = parseFloat(m[1]!);
  const unit = (m[2] ?? "ms").toLowerCase();
  return Math.round(unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : n);
}

/** Query params shared by find / tap / wait. */
function queryParams(text: string | undefined, opts: Record<string, unknown>): ActionParams {
  const params: ActionParams = {};
  if (text != null && text !== "") params.text = text;
  if (opts.text != null) params.text = opts.text;
  if (opts.id != null) params.id = opts.id;
  if (opts.desc != null) params.desc = opts.desc;
  if (opts.class != null) params.class = opts.class;
  if (opts.exact) params.exact = true;
  if (opts.clickable) params.clickable = true;
  if (opts.index != null) params.index = Number(opts.index);
  return params;
}

function hasQuery(params: ActionParams): boolean {
  return params.text != null || params.id != null || params.desc != null || params.class != null;
}

const queryOpts = (cmd: Command) =>
  cmd
    .option("--text <text>", "Match visible text / content-description (substring, case-insensitive)")
    .option("--id <resourceId>", "Match resource id (pkg:id/name or just name)")
    .option("--desc <text>", "Match content-description only")
    .option("--class <name>", "Match widget class (substring)")
    .option("--exact", "Exact, case-sensitive matches")
    .option("--clickable", "Only clickable nodes")
    .option("-i, --index <n>", "Pick the nth match (0-based)");

function screenshot(path: string | undefined, deviceArg?: string): Promise<void> {
  return withDriver(deviceArg, async (driver) => {
    const shot = await driver.screenshot();
    const ext = shot.contentType === "image/png" ? "png" : "jpg";
    const out = path ?? `emu-screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
    writeFileSync(out, shot.data);
    console.log(out);
  });
}

function axDump(deviceArg: string | undefined): Promise<void> {
  return withDriver(deviceArg, async (driver) => printJson(await driver.ax()));
}

function foreground(deviceArg: string | undefined): Promise<void> {
  return withDriver(deviceArg, async (driver) => {
    const app = await driver.foreground();
    if (!app) {
      console.error("No resumed activity found");
      process.exit(1);
    }
    printJson(app);
  });
}

function formatMatch(m: AxMatch, i: number): string {
  const label = m.node.text ?? m.node.contentDesc ?? "";
  const id = m.node.resourceId ? ` ${DIM}${m.node.resourceId}${RESET}` : "";
  const cls = m.node.class ? m.node.class.split(".").pop() : "";
  const flags = [m.node.clickable ? "clickable" : null, m.node.focused ? "focused" : null, m.node.checked ? "checked" : null, m.node.enabled === undefined ? null : null]
    .filter(Boolean)
    .join(",");
  return `${DIM}[${i}]${RESET} ${BOLD}${JSON.stringify(label)}${RESET} ${cls}${id}  @ (${m.normalized.x.toFixed(3)}, ${m.normalized.y.toFixed(3)})  px ${m.center.x},${m.center.y}  bounds [${m.bounds.left},${m.bounds.top}][${m.bounds.right},${m.bounds.bottom}]${flags ? `  ${DIM}${flags}${RESET}` : ""}`;
}

async function find(text: string | undefined, opts: Record<string, unknown>): Promise<void> {
  const params = queryParams(text, opts);
  if (!hasQuery(params)) {
    console.error('Usage: serve-avd find "<text>" | --id <id> | --desc <text> | --class <name>');
    process.exit(1);
  }
  await withDriver(opts.device as string | undefined, async (driver) => {
    const result = (await driver.action("find", params)) as FindResult & { query: AxQuery };
    if (opts.json) {
      printJson(result);
      return;
    }
    if (result.total === 0) {
      console.error(`No UI element matching ${describeQuery(result.query)}`);
      process.exit(3);
    }
    result.matches.forEach((m, i) => console.log(formatMatch(m, i)));
  });
}

async function tapCmd(xArg: string | undefined, yArg: string | undefined, opts: Record<string, unknown>): Promise<void> {
  const params = queryParams(undefined, opts);
  if (xArg != null && !hasQuery(params)) {
    // `serve-avd tap 0.5 0.9` — or `serve-avd tap "Sign in"` as a text shortcut.
    const x = Number(xArg);
    const y = Number(yArg);
    if (yArg == null && !Number.isFinite(x)) {
      params.text = xArg;
    } else {
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
        console.error("Usage: serve-avd tap <x> <y> [-d serial]           x, y normalized 0..1");
        console.error('       serve-avd tap --text "Sign in" | --id submit | --desc "Search"');
        console.error("  Example: serve-avd tap 0.5 0.9   # near bottom-center");
        process.exit(1);
      }
      params.x = x;
      params.y = y;
    }
  } else if (xArg != null && hasQuery(params)) {
    console.error("Give either coordinates or a target (--text/--id/--desc), not both.");
    process.exit(1);
  }
  if (params.x == null && !hasQuery(params)) {
    console.error('Usage: serve-avd tap <x> <y> | serve-avd tap --text "Sign in" [-d serial]');
    process.exit(1);
  }
  if (opts.long) params.durationMs = opts.long === true ? 600 : parseDuration(String(opts.long), 600);
  await runActionCommand(opts.device as string | undefined, "tap", params, {
    json: !!opts.json,
    line: (r) => {
      const res = r as { x: number; y: number; matched?: { text?: string; resourceId?: string; contentDesc?: string } };
      const label = res.matched ? ` ${JSON.stringify(res.matched.text ?? res.matched.contentDesc ?? res.matched.resourceId ?? "")}` : "";
      return `${params.durationMs ? "Long-pressed" : "Tapped"} (${res.x.toFixed(3)}, ${res.y.toFixed(3)})${label}`;
    },
  });
}

async function waitCmd(text: string | undefined, opts: Record<string, unknown>): Promise<void> {
  const params = queryParams(text, opts);
  if (!hasQuery(params)) {
    console.error('Usage: serve-avd wait "<text>" | --id <id> | --desc <text> [--timeout 10s] [--gone]');
    process.exit(1);
  }
  params.timeoutMs = parseDuration(opts.timeout as string | undefined, 10_000);
  params.intervalMs = parseDuration(opts.interval as string | undefined, 500);
  if (opts.gone) params.gone = true;
  await withDriver(opts.device as string | undefined, async (driver) => {
    const result = (await driver.action("wait", params)) as WaitResult & { query: AxQuery; gone: boolean };
    if (opts.json) printJson(result);
    else if (result.ok) {
      const where = result.match ? ` at (${result.match.normalized.x.toFixed(3)}, ${result.match.normalized.y.toFixed(3)})` : "";
      console.log(`${describeQuery(result.query)} ${result.gone ? "gone" : "found"}${where} after ${result.elapsedMs}ms`);
    } else {
      console.error(`Timed out after ${result.elapsedMs}ms waiting for ${describeQuery(result.query)}${result.gone ? " to disappear" : ""}`);
    }
    if (!result.ok) process.exit(2);
  });
}

async function swipeCmd(args: string[], opts: Record<string, unknown>): Promise<void> {
  const nums = args.map(Number);
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) {
    console.error("Usage: serve-avd swipe <x1> <y1> <x2> <y2> [--duration 300ms]   (normalized 0..1)");
    process.exit(1);
  }
  const [x1, y1, x2, y2] = nums as [number, number, number, number];
  await runActionCommand(opts.device as string | undefined, "swipe", { x1, y1, x2, y2, durationMs: parseDuration(opts.duration as string | undefined, 300) }, {
    json: !!opts.json,
    line: () => `Swiped (${x1}, ${y1}) → (${x2}, ${y2})`,
  });
}

// ── Emulator controls ──────────────────────────────────────────────────────

type GeoPoint = { lat: number; lon: number; alt?: number };

/** Parse a route: a JSON file ([[lat,lon],…] or [{lat,lon,alt?},…]) or an inline "lat,lon lat,lon …" string. */
function parseRoute(spec: string): GeoPoint[] {
  let text = spec;
  try {
    text = readFileSync(spec, "utf8");
  } catch {
    // not a file — treat as inline
  }
  const points: GeoPoint[] = [];
  const push = (lat: unknown, lon: unknown, alt?: unknown) => {
    const la = Number(lat);
    const lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) throw new Error(`Invalid route point: ${JSON.stringify([lat, lon])}`);
    const p: GeoPoint = { lat: la, lon: lo };
    if (alt != null && Number.isFinite(Number(alt))) p.alt = Number(alt);
    points.push(p);
  };
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as { points?: unknown; route?: unknown };
      parsed = obj.points ?? obj.route ?? [];
    }
    if (!Array.isArray(parsed)) throw new Error("Route JSON must be an array of [lat, lon] pairs or {lat, lon} objects");
    for (const item of parsed) {
      if (Array.isArray(item)) push(item[0], item[1], item[2]);
      else if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        push(o.lat ?? o.latitude, o.lon ?? o.lng ?? o.longitude, o.alt ?? o.altitude);
      }
    }
  } else {
    for (const token of trimmed.split(/[\s;]+/).filter(Boolean)) {
      const parts = token.split(",");
      if (parts.length < 2) throw new Error(`Invalid route point '${token}' — expected lat,lon`);
      push(parts[0], parts[1], parts[2]);
    }
  }
  if (points.length === 0) throw new Error("Route has no points");
  return points;
}

/** Insert `steps` linearly interpolated fixes between consecutive points. */
function interpolateRoute(points: GeoPoint[], steps: number): GeoPoint[] {
  if (steps <= 0 || points.length < 2) return points;
  const out: GeoPoint[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    out.push(a);
    for (let s = 1; s <= steps; s++) {
      const t = s / (steps + 1);
      const p: GeoPoint = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
      if (a.alt != null && b.alt != null) p.alt = a.alt + (b.alt - a.alt) * t;
      out.push(p);
    }
  }
  out.push(points[points.length - 1]!);
  return out;
}

async function geoCmd(latArg: string | undefined, lonArg: string | undefined, altArg: string | undefined, opts: Record<string, unknown>): Promise<void> {
  const routeSpec = (opts.route ?? opts.follow) as string | undefined;
  if (routeSpec) {
    let points: GeoPoint[];
    try {
      points = interpolateRoute(parseRoute(routeSpec), Math.max(0, parseInt(String(opts.steps ?? "0"), 10) || 0));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    const intervalMs = parseDuration(opts.interval as string | undefined, 1_000);
    await withDriver(opts.device as string | undefined, async (driver) => {
      let stopped = false;
      const stop = () => {
        stopped = true;
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      if (!opts.json) console.log(`Following ${points.length} fixes every ${intervalMs}ms${opts.loop ? " (looping)" : ""} — Ctrl+C to stop`);
      do {
        for (let i = 0; i < points.length && !stopped; i++) {
          const p = points[i]!;
          await driver.action("geo", p);
          if (opts.json) console.log(JSON.stringify({ index: i, ...p }));
          else console.log(`  ${DIM}${String(i + 1).padStart(String(points.length).length)}/${points.length}${RESET}  ${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}${p.alt != null ? `  ${p.alt}m` : ""}`);
          if (i < points.length - 1 || opts.loop) await new Promise((r) => setTimeout(r, intervalMs));
        }
      } while (opts.loop && !stopped);
    });
    return;
  }
  const lat = Number(latArg);
  const lon = Number(lonArg);
  if (latArg == null || lonArg == null || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.error("Usage: serve-avd geo <lat> <lon> [alt]");
    console.error('       serve-avd geo --route <file.json | "lat,lon lat,lon …"> [--interval 1s] [--steps 10] [--loop]');
    process.exit(1);
  }
  const params: ActionParams = { lat, lon };
  if (altArg != null) params.alt = Number(altArg);
  await runActionCommand(opts.device as string | undefined, "geo", params, {
    json: !!opts.json,
    line: () => `Location set to ${lat}, ${lon}${altArg != null ? ` (${altArg}m)` : ""}`,
  });
}

const NETWORK_KEYS = ["speed", "delay", "airplane", "wifi", "data"];

async function networkCmd(args: string[], opts: Record<string, unknown>): Promise<void> {
  const params: ActionParams = {};
  for (const key of NETWORK_KEYS) if (opts[key] != null) params[key] = opts[key];
  // Positional pairs: `network speed lte delay edge airplane on`
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    const value = args[i + 1];
    if (!NETWORK_KEYS.includes(key) || value == null) {
      console.error("Usage: serve-avd network [speed <gsm|edge|lte|full|up:down>] [delay <gprs|edge|umts|none|min:max>]");
      console.error("                         [airplane on|off] [wifi on|off] [data on|off]        (no args: status)");
      process.exit(1);
    }
    params[key] = value;
  }
  await runActionCommand(opts.device as string | undefined, "network", params, {
    json: !!opts.json,
    line: (r) => {
      const res = r as Record<string, unknown>;
      const parts = Object.entries(res)
        .filter(([k]) => k !== "console")
        .map(([k, v]) => `${k} ${typeof v === "boolean" ? (v ? "on" : "off") : String(v)}`);
      return `${Object.keys(params).length ? "Network set:" : "Network:"} ${parts.join(", ")}${res.console ? `\n${DIM}${String(res.console)}${RESET}` : ""}`;
    },
  });
}

async function batteryCmd(arg: string | undefined, opts: Record<string, unknown>): Promise<void> {
  const params: ActionParams = {};
  if (arg != null) {
    if (/^\d+$/.test(arg)) params.level = Number(arg);
    else if (arg === "unplug") params.plugged = "none";
    else if (arg === "reset") params.reset = true;
    else if (["ac", "usb", "wireless", "plug"].includes(arg)) params.plugged = arg === "plug" ? "ac" : arg;
    else {
      console.error("Usage: serve-avd battery [<level 0-100> | unplug | ac | usb | wireless | reset] [--plugged ac|usb|wireless|none] [--reset]");
      process.exit(1);
    }
  }
  if (opts.level != null) params.level = Number(opts.level);
  if (opts.plugged != null) params.plugged = opts.plugged;
  if (opts.unplug) params.plugged = "none";
  if (opts.reset) params.reset = true;
  await runActionCommand(opts.device as string | undefined, "battery", params, {
    json: !!opts.json,
    line: (r) => {
      const res = r as { level: number | null; plugged: string; status: string | null };
      return `Battery ${res.level ?? "?"}%  ${res.plugged === "none" ? "unplugged" : `on ${res.plugged}`}${res.status ? `  (${res.status})` : ""}`;
    },
  });
}

async function fingerprintCmd(idArg: string | undefined, opts: Record<string, unknown>): Promise<void> {
  const params: ActionParams = {};
  if (idArg != null) params.id = Number(idArg);
  if (opts.remove) params.remove = true;
  await runActionCommand(opts.device as string | undefined, "fingerprint", params, {
    json: !!opts.json,
    line: (r) => `Fingerprint ${(r as { remove: boolean }).remove ? "removed" : "touched"} (id ${(r as { id: number }).id})`,
  });
}

async function callCmd(a: string, b: string | undefined, opts: Record<string, unknown>): Promise<void> {
  const ops = ["call", "accept", "end", "hold"];
  let op = "call";
  let number = a;
  if (ops.includes(a) && b != null) {
    op = a;
    number = b;
  } else if (b != null) {
    console.error("Usage: serve-avd call <number> | serve-avd call accept|end|hold <number>");
    process.exit(1);
  }
  if (opts.accept) op = "accept";
  if (opts.end) op = "end";
  if (opts.hold) op = "hold";
  await runActionCommand(opts.device as string | undefined, "call", { number, op }, {
    json: !!opts.json,
    line: () => (op === "call" ? `Incoming call from ${number}` : `Call ${op}: ${number}`),
  });
}

async function smsCmd(number: string, text: string[], opts: Record<string, unknown>): Promise<void> {
  const body = text.join(" ");
  if (!body) {
    console.error("Usage: serve-avd sms <number> <text…>");
    process.exit(1);
  }
  await runActionCommand(opts.device as string | undefined, "sms", { number, text: body }, {
    json: !!opts.json,
    line: () => `SMS delivered from ${number}`,
  });
}

// ── App lifecycle ──────────────────────────────────────────────────────────

async function installCmd(apk: string, opts: Record<string, unknown>): Promise<void> {
  await withDriver(opts.device as string | undefined, async (driver) => {
    if (driver.mode === "server" && !opts.json) console.log(`${DIM}Installing via ${driver.url}…${RESET}`);
    const result = (await driver.action("install", { path: apk })) as { output: string };
    if (opts.json) printJson(result);
    else console.log(result.output || "Installed");
    if (opts.launch) {
      const pkg = await packageFromApk(apk);
      if (!pkg) {
        console.error("Installed, but could not read the package name from the APK to launch it (is `aapt`/`aapt2` on PATH?)");
        return;
      }
      const launched = (await driver.action("launch", { package: pkg })) as { component?: string };
      if (!opts.json) console.log(`Launched ${launched.component ?? pkg}`);
    }
  });
}

/** Best-effort package name via aapt/aapt2 (Android SDK build-tools) — null when unavailable. */
async function packageFromApk(apk: string): Promise<string | null> {
  const { execFile } = await import("child_process");
  const { existsSync, readdirSync } = await import("fs");
  const { join, dirname } = await import("path");
  const candidates = ["aapt2", "aapt"];
  const sdk = dirname(dirname(adbPath())); // <sdk>/platform-tools/adb → <sdk>
  try {
    const bt = join(sdk, "build-tools");
    for (const v of readdirSync(bt).sort().reverse()) {
      for (const tool of ["aapt2", "aapt"]) {
        const p = join(bt, v, tool);
        if (existsSync(p)) candidates.unshift(p);
      }
    }
  } catch {}
  for (const tool of candidates) {
    const out = await new Promise<string | null>((resolve) => {
      execFile(tool, ["dump", "badging", apk], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
    });
    const m = out && /package: name='([^']+)'/.exec(out);
    if (m) return m[1]!;
  }
  return null;
}

async function launchCmd(pkg: string, opts: Record<string, unknown>): Promise<void> {
  await runActionCommand(opts.device as string | undefined, "launch", { package: pkg, wait: !opts.noWait }, {
    json: !!opts.json,
    line: (r) => `Launched ${(r as { component?: string }).component ?? pkg}`,
  });
}

async function openCmd(url: string, opts: Record<string, unknown>): Promise<void> {
  const params: ActionParams = { url };
  if (opts.package) params.package = opts.package;
  await runActionCommand(opts.device as string | undefined, "open", params, {
    json: !!opts.json,
    line: (r) => `Opened ${url}${(r as { component?: string }).component ? ` in ${(r as { component: string }).component}` : ""}`,
  });
}

async function appsCmd(opts: Record<string, unknown>): Promise<void> {
  await runActionCommand(opts.device as string | undefined, "apps", { all: !!opts.all }, {
    json: !!opts.json,
    line: (r) => {
      const { packages } = r as { packages: string[] };
      return packages.length ? packages.join("\n") : `${DIM}No ${opts.all ? "" : "third-party "}packages installed${opts.all ? "" : " (use --all to include system apps)"}.${RESET}`;
    },
  });
}

async function snapshotCmd(op: string, name: string | undefined, opts: Record<string, unknown>): Promise<void> {
  if (!["save", "load", "delete", "list"].includes(op)) {
    console.error("Usage: serve-avd snapshot save|load|delete <name> | serve-avd snapshot list");
    process.exit(1);
  }
  if (op !== "list" && !name) {
    console.error(`Usage: serve-avd snapshot ${op} <name>`);
    process.exit(1);
  }
  await runActionCommand(opts.device as string | undefined, "snapshot", { op, name }, {
    json: !!opts.json,
    line: (r) => {
      if (op === "list") {
        const rows = (r as { snapshots: Array<{ id: string; tag: string; size?: string; date?: string }> }).snapshots;
        if (rows.length === 0) return "No snapshots.";
        return rows.map((s) => `${BOLD}${s.tag}${RESET}${s.size ? `  ${DIM}${s.size}${RESET}` : ""}${s.date ? `  ${DIM}${s.date}${RESET}` : ""}`).join("\n");
      }
      return `Snapshot ${op === "save" ? "saved" : op === "load" ? "loaded" : "deleted"}: ${name}`;
    },
  });
}

async function a11yCmd(sub: string, value: string | undefined, opts: Record<string, unknown>): Promise<void> {
  const device = opts.device as string | undefined;
  switch (sub) {
    case "font-scale":
      if (value == null) break;
      await runActionCommand(device, "font-scale", { scale: Number(value) }, { json: !!opts.json, line: () => `Font scale ${value}` });
      return;
    case "density":
      if (value == null) break;
      await runActionCommand(device, "density", { dpi: value }, { json: !!opts.json, line: (r) => `Density ${value}  (${(r as { current: string }).current.replace(/\n/g, "; ")})` });
      return;
    case "locale": {
      if (value == null) break;
      const params: ActionParams = { locale: value };
      if (opts.app) params.package = opts.app;
      if (opts.system) params.system = true;
      await runActionCommand(device, "locale", params, {
        json: !!opts.json,
        line: (r) => {
          const res = r as { locale: string; scope: string; package?: string; applied?: string; note?: string };
          return res.scope === "app"
            ? `Locale ${res.locale} set for ${res.package}`
            : `System locale ${res.locale} — applied ${res.applied}${res.note ? `\n${DIM}${res.note}${RESET}` : ""}`;
        },
      });
      return;
    }
    case "talkback":
      if (value == null) break;
      await runActionCommand(device, "talkback", { enabled: value }, { json: !!opts.json, line: (r) => `TalkBack ${(r as { enabled: boolean }).enabled ? "on" : "off"}` });
      return;
  }
  console.error("Usage: serve-avd a11y font-scale <scale> | density <dpi|reset> | locale <tag> [--app pkg] [--system] | talkback on|off");
  process.exit(1);
}

// ── adb passthrough ────────────────────────────────────────────────────────

/** Spawn adb against the resolved serial with inherited stdio; exit with its code. */
async function adbPassthrough(deviceArg: string | undefined, args: string[]): Promise<void> {
  const serial = await withDriver(deviceArg, async (driver) => driver.serial);
  await new Promise<void>((resolve) => {
    const child = spawn(adbPath(), ["-s", serial, ...args], { stdio: "inherit" });
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
      resolve();
    });
    child.on("error", (err) => {
      console.error(err.message);
      process.exitCode = 1;
      resolve();
    });
  });
}

// ── Replay ─────────────────────────────────────────────────────────────────

async function exportEventLog(deviceArg: string | undefined, file: string, opts: { limit?: string }): Promise<void> {
  await withDriver(deviceArg, async (driver) => {
    const events = await driver.eventLog(opts.limit != null ? Number(opts.limit) : undefined);
    const script = eventsToScript(events, { device: driver.serial, name: driver.name });
    const json = JSON.stringify(script, null, 2);
    if (file === "-") console.log(json);
    else {
      writeFileSync(file, `${json}\n`);
      console.log(`Wrote ${script.steps.length} step${script.steps.length === 1 ? "" : "s"} to ${file}`);
    }
  });
}

async function replayCmd(file: string, opts: Record<string, unknown>): Promise<void> {
  let script: ReplayScript;
  try {
    script = parseScript(readFileSync(file === "-" ? 0 : file, "utf8"));
  } catch (err) {
    console.error(`Could not read replay script: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const speed = opts.speed != null ? Number(opts.speed) : 1;
  if (!Number.isFinite(speed) || speed <= 0) {
    console.error("--speed must be a positive number (2 = twice as fast)");
    process.exit(1);
  }
  await withDriver(opts.device as string | undefined, async (driver) => {
    const total = script.steps.length;
    if (!opts.json) console.log(`Replaying ${total} step${total === 1 ? "" : "s"} on ${BOLD}${driver.name}${RESET}${speed !== 1 ? ` at ${speed}x` : ""}${opts.noWait ? " (no waits)" : ""}`);
    const summary = await runScript(script, driver, {
      speed,
      wait: !opts.noWait,
      preferCoords: !!opts.coords,
      stopOnError: !opts.continue,
      onStep: (i, step, outcome) => {
        const label = `${DIM}${String(i + 1).padStart(String(total).length)}/${total}${RESET}  ${step.action}${describeStep(step)}`;
        if (opts.json) console.log(JSON.stringify({ index: i, step, ...outcome }));
        else if (outcome.ok) console.log(`  ${GREEN}✓${RESET} ${label}`);
        else console.log(`  \x1b[31m✗${RESET} ${label}  ${DIM}${outcome.error}${RESET}`);
      },
    });
    if (!opts.json) console.log(`${summary.failed === 0 ? GREEN : "\x1b[31m"}${summary.ok}/${total} ok${RESET}${summary.failed ? `, ${summary.failed} failed` : ""}${summary.skipped ? `, ${summary.skipped} skipped` : ""}`);
    if (summary.failed > 0) process.exitCode = 1;
  });
}

function describeStep(step: Record<string, unknown>): string {
  const { action: _a, t: _t, ...rest } = step;
  const bits = Object.entries(rest)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  return bits.length ? ` ${DIM}${bits.join(" ").slice(0, 100)}${RESET}` : "";
}

// ── Program ────────────────────────────────────────────────────────────────

function parsePanes(value: string): string[] {
  return value === "none" ? [] : value.split(",").map((p) => p.trim()).filter(Boolean);
}

const program = new Command();

// Program options must precede a subcommand, so subcommands like `shell` can
// pass their own arguments through untouched (`serve-avd shell ls -la`).
program.enablePositionalOptions();

program
  .name("serve-avd")
  .description("The `npx serve` of Android Emulators — stream, control, and share emulators from the browser.")
  .version(VERSION)
  .argument("[device...]", "adb serial(s) or AVD name(s) — default: every online device, booting an AVD when none are")
  .option("-p, --port <port>", "Starting port (preview default: 3200; --no-preview default: 3100)", (v) => parseInt(v, 10))
  .option("--host <host>", "Host to bind (default: 127.0.0.1; use 0.0.0.0 for LAN)")
  .option("-d, --detach", "Spawn a background server and exit (daemon mode)")
  .option("-q, --quiet", "JSON-only output")
  .option("--no-preview", "Skip the web UI; stream in foreground only")
  .option("--codec <codec>", "Stream codec for the preview UI: auto (H.264 via WebCodecs) or mjpeg")
  .option("--theme <theme>", "Set device appearance before opening the preview: light or dark")
  .option("--panes <panes>", "Initially open preview panes: devices, tools, logs, or none")
  .option("--fit", "Deprecated: preview now fits the viewport automatically")
  .option("--bit-rate <mbps>", "H.264 bitrate in Mbps (default: 8)", (v) => parseFloat(v))
  .option("--size <WxH>", "Capture at a fixed size, e.g. 720x1560 (default: native)")
  .option("-l, --list [device]", "List running streams")
  .option("-k, --kill [device]", "Kill running stream(s)")
  .addHelpText(
    "after",
    `
Examples:
  serve-avd                              Open emulator preview at localhost:3200
  serve-avd Pixel_9_Pro_XL               Target an AVD by name (boots it if needed)
  serve-avd emulator-5554 -p 8080        Preview a specific serial on a custom port
  serve-avd --codec mjpeg                Force MJPEG (e.g. no WebCodecs in the browser)
  serve-avd --panes devices,tools        Open the devices and tools panes
  serve-avd --theme dark                 Start the device in Dark Mode
  serve-avd --no-preview                 Stream in foreground without the web UI
  serve-avd --detach                     Start streaming in background (daemon)
  serve-avd --list                       Show all running streams
  serve-avd --kill                       Stop all streams
  serve-avd mcp --serve                  MCP server for Claude/Cursor/Codex (+ preview UI)
  serve-avd tap --text "Sign in"         Tap a UI element by its text (also: find, wait)
  serve-avd snapshot save clean          Save emulator state; \`snapshot load clean\` to reset
  serve-avd event-log --export flow.json Record a session; \`replay flow.json\` to reproduce`,
  )
  .action(async (devices: string[], opts) => {
    if (opts.list !== undefined) {
      listStreams(typeof opts.list === "string" ? opts.list : undefined);
      return;
    }
    if (opts.kill !== undefined) {
      killStreams(typeof opts.kill === "string" ? opts.kill : undefined);
      return;
    }
    if (opts.codec && opts.codec !== "auto" && opts.codec !== "mjpeg") {
      console.error("--codec must be 'auto' or 'mjpeg'");
      process.exit(1);
    }
    if (opts.theme && opts.theme !== "light" && opts.theme !== "dark") {
      console.error("--theme must be 'light' or 'dark'");
      process.exit(1);
    }
    if (opts.detach) {
      await detach(devices, opts.port, !!opts.quiet);
      return;
    }
    const initialState = opts.panes !== undefined ? { panes: parsePanes(opts.panes) } : undefined;
    await serve(devices, {
      port: opts.port,
      host: opts.host,
      quiet: !!opts.quiet,
      codec: opts.codec,
      theme: opts.theme,
      initialState,
      bitRate: opts.bitRate,
      size: opts.size,
      preview: opts.preview !== false,
    });
  });

const deviceOpt = ["-d, --device <serial>", "Target a specific device (adb serial or name)"] as const;

program
  .command("gesture")
  .description("Send a touch gesture")
  .argument("<json>", 'Gesture JSON, e.g. \'{"type":"begin","x":0.5,"y":0.5}\'')
  .option(...deviceOpt)
  .action((json: string, opts) => gesture(json, opts.device));

const jsonOpt = ["-j, --json", "Print the JSON result"] as const;

queryOpts(
  program
    .command("tap")
    .description("Tap at normalized 0..1 coords, or the UI element matching --text / --id / --desc")
    .argument("[x]", 'X coord 0..1 (or a text label: serve-avd tap "Sign in")')
    .argument("[y]", "Y coord 0..1")
    .option("--long [duration]", "Long-press (default 600ms)")
    .option(...deviceOpt)
    .option(...jsonOpt),
).action((x: string | undefined, y: string | undefined, opts) => tapCmd(x, y, opts));

queryOpts(
  program
    .command("find")
    .description("Find UI elements by text / id / desc / class — prints bounds, centers and normalized coords")
    .argument("[text]", "Text or content-description to match")
    .option(...deviceOpt)
    .option(...jsonOpt),
).action((text: string | undefined, opts) => find(text, opts));

queryOpts(
  program
    .command("wait")
    .description("Wait until a UI element appears (or disappears with --gone); exit 2 on timeout")
    .argument("[text]", "Text or content-description to wait for")
    .option("-t, --timeout <duration>", "Budget, e.g. 10s / 500ms (default 10s)")
    .option("--interval <duration>", "Poll interval (default 500ms)")
    .option("--gone", "Wait for the element to disappear instead")
    .option(...deviceOpt)
    .option(...jsonOpt),
).action((text: string | undefined, opts) => waitCmd(text, opts));

program
  .command("swipe")
  .description("Swipe between two normalized points")
  .argument("<coords...>", "x1 y1 x2 y2 (0..1)")
  .option("--duration <duration>", "Swipe duration (default 300ms)")
  .option(...deviceOpt)
  .option(...jsonOpt)
  .action((coords: string[], opts) => swipeCmd(coords, opts));

program
  .command("button")
  .description(`Send a hardware/navigation button press (${Object.keys(BUTTONS).slice(0, 6).join("|")}|…)`)
  .argument("[name]", "Button name", "home")
  .option(...deviceOpt)
  .action((name: string, opts) => button(name, opts.device));

program
  .command("type")
  .description("Type text via the emulator keyboard (ASCII only)")
  .argument("[text...]", "Text to type")
  .option(...deviceOpt)
  .option("--stdin", "Read text from stdin")
  .option("--file <path>", "Read text from a file")
  .action((text: string[], opts) => typeText(text, { device: opts.device, stdin: opts.stdin, file: opts.file }));

program
  .command("rotate")
  .description("Set device orientation (portrait|portrait_upside_down|landscape_left|landscape_right)")
  .argument("<orientation>")
  .option(...deviceOpt)
  .action((orientation: string, opts) => rotate(orientation, opts.device));

program
  .command("debug")
  .description(`Toggle an Android render/debug flag (${Object.keys(DEBUG_FLAGS).join("|")})`)
  .argument("<option>")
  .argument("<state>", "on|off")
  .option(...deviceOpt)
  .action((option: string, state: string, opts) => debugFlag(option, state, opts.device));

program
  .command("memory-warning")
  .description("Ask the foreground app to trim memory (am send-trim-memory RUNNING_CRITICAL)")
  .option(...deviceOpt)
  .action((opts) => memoryWarning(opts.device));

program
  .command("event-log")
  .description("Show recent emulator events (or --export them as a replayable script)")
  .option(...deviceOpt)
  .option("-j, --json", "Print JSON")
  .option("-n, --limit <count>", "Maximum number of events")
  .option("--export <file>", "Write the replayable actions to a JSON script ('-' for stdout)")
  .action((opts) =>
    opts.export ? exportEventLog(opts.device, opts.export, { limit: opts.limit }) : eventLog(opts.device, { json: opts.json, limit: opts.limit }),
  );

program
  .command("replay")
  .description("Replay a script exported with `event-log --export` (or hand-written)")
  .argument("<file>", "Script JSON ('-' for stdin)")
  .option("--speed <factor>", "Time scale: 2 = twice as fast (default 1)")
  .option("--no-wait", "Ignore recorded timing; run steps back to back")
  .option("--coords", "Replay taps by coordinates even when a text/id target was recorded")
  .option("--continue", "Keep going after a failed step")
  .option(...deviceOpt)
  .option(...jsonOpt)
  .action((file: string, opts) => replayCmd(file, opts));

program
  .command("screenshot")
  .description("Save a screenshot (via the running server, or adb directly)")
  .argument("[path]", "Output file (default: ./emu-screenshot-<timestamp>.png)")
  .option(...deviceOpt)
  .action((path: string | undefined, opts) => screenshot(path, opts.device));

program
  .command("ax")
  .description("Dump the UI hierarchy as JSON (uiautomator)")
  .option(...deviceOpt)
  .action((opts) => axDump(opts.device));

program
  .command("foreground")
  .description("Print the foreground app ({ packageName, activity, pid })")
  .option(...deviceOpt)
  .action((opts) => foreground(opts.device));

// ── Emulator controls ──────────────────────────────────────────────────────

program
  .command("geo")
  .description("Set the GPS fix, or follow a route of fixes (--route)")
  .argument("[lat]", "Latitude")
  .argument("[lon]", "Longitude")
  .argument("[alt]", "Altitude in metres")
  .option("--route <spec>", 'Route: JSON file ([[lat,lon],…] / [{lat,lon}]) or inline "lat,lon lat,lon …"')
  .option("--follow <spec>", "Alias for --route")
  .option("--interval <duration>", "Delay between route fixes (default 1s)")
  .option("--steps <n>", "Interpolate n extra fixes between route points")
  .option("--loop", "Repeat the route until Ctrl+C")
  .option(...deviceOpt)
  .option(...jsonOpt)
  .action((lat: string | undefined, lon: string | undefined, alt: string | undefined, opts) => geoCmd(lat, lon, alt, opts));

program
  .command("network")
  .description("Network conditions: speed / delay (emulator), airplane / wifi / data toggles; no args prints status")
  .argument("[settings...]", "Pairs: speed lte | delay edge | airplane on | wifi off | data off")
  .option("--speed <speed>", "gsm | hscsd | gprs | edge | umts | hsdpa | lte | evdo | full | up:down")
  .option("--delay <delay>", "gprs | edge | umts | none | min:max")
  .option("--airplane <on|off>", "Airplane mode")
  .option("--wifi <on|off>", "Wi-Fi")
  .option("--data <on|off>", "Mobile data")
  .option(...deviceOpt)
  .option(...jsonOpt)
  .action((settings: string[], opts) => networkCmd(settings, opts));

program
  .command("battery")
  .description("Fake battery: level 0-100, unplug | ac | usb | wireless, or reset; no args prints status")
  .argument("[state]", "<level> | unplug | ac | usb | wireless | reset")
  .option("--level <n>", "Battery level 0-100")
  .option("--plugged <src>", "ac | usb | wireless | none")
  .option("--unplug", "Unplug")
  .option("--reset", "Restore real battery reporting")
  .option(...deviceOpt)
  .option(...jsonOpt)
  .action((state: string | undefined, opts) => batteryCmd(state, opts));

program
  .command("fingerprint")
  .description("Touch the emulator's fingerprint sensor (unblocks biometric prompts)")
  .argument("[id]", "Finger id (default 1)")
  .option("--remove", "Remove/lift instead of touch")
  .option(...deviceOpt)
  .option(...jsonOpt)
  .action((id: string | undefined, opts) => fingerprintCmd(id, opts));

program
  .command("call")
  .description("Simulate an incoming call: call <number>, or accept|end|hold <number>")
  .argument("<numberOrOp>", "Phone number, or accept | end | hold")
  .argument("[number]", "Phone number when the first argument is an op")
  .option("--accept", "Accept the call")
  .option("--end", "End the call")
  .option("--hold", "Hold the call")
  .option(...deviceOpt)
  .option(...jsonOpt)
  .action((a: string, b: string | undefined, opts) => callCmd(a, b, opts));

program
  .command("sms")
  .description("Deliver an incoming SMS")
  .argument("<number>", "Sender phone number")
  .argument("<text...>", "Message text")
  .option(...deviceOpt)
  .option(...jsonOpt)
  .action((number: string, text: string[], opts) => smsCmd(number, text, opts));

program
  .command("a11y")
  .description("Accessibility/display knobs: font-scale <n> | density <dpi|reset> | locale <tag> | talkback on|off")
  .argument("<setting>", "font-scale | density | locale | talkback")
  .argument("[value]", "Setting value")
  .option("--app <package>", "locale: app to set a per-app locale for (default: foreground app)")
  .option("--system", "locale: set the system locale (needs root; else applies on reboot)")
  .option(...deviceOpt)
  .option(...jsonOpt)
  .action((setting: string, value: string | undefined, opts) => a11yCmd(setting, value, opts));

program
  .command("snapshot")
  .description("Emulator snapshots: save | load | delete <name>, or list")
  .argument("<op>", "save | load | delete | list")
  .argument("[name]", "Snapshot name")
  .option(...deviceOpt)
  .option(...jsonOpt)
  .action((op: string, name: string | undefined, opts) => snapshotCmd(op, name, opts));

// ── App lifecycle ──────────────────────────────────────────────────────────

program
  .command("install")
  .description("Install an APK (adb install -r -g)")
  .argument("<apk>", "Path to the .apk")
  .option("--launch", "Launch the app after installing")
  .option(...deviceOpt)
  .option(...jsonOpt)
  .action((apk: string, opts) => installCmd(apk, opts));

program
  .command("launch")
  .description("Launch an app by package name (or package/.Activity)")
  .argument("<package>", "Package name or component")
  .option("--no-wait", "Don't wait for the activity to be displayed")
  .option(...deviceOpt)
  .option(...jsonOpt)
  .action((pkg: string, opts) => launchCmd(pkg, opts));

program
  .command("stop")
  .description("Force-stop an app")
  .argument("<package>")
  .option(...deviceOpt)
  .option(...jsonOpt)
  .action((pkg: string, opts) => runActionCommand(opts.device, "stop", { package: pkg }, { json: !!opts.json, line: () => `Stopped ${pkg}` }));

program
  .command("clear-data")
  .description("Clear an app's data (pm clear)")
  .argument("<package>")
  .option(...deviceOpt)
  .option(...jsonOpt)
  .action((pkg: string, opts) => runActionCommand(opts.device, "clear-data", { package: pkg }, { json: !!opts.json, line: () => `Cleared data for ${pkg}` }));

program
  .command("uninstall")
  .description("Uninstall an app")
  .argument("<package>")
  .option(...deviceOpt)
  .option(...jsonOpt)
  .action((pkg: string, opts) => runActionCommand(opts.device, "uninstall", { package: pkg }, { json: !!opts.json, line: () => `Uninstalled ${pkg}` }));

program
  .command("open")
  .description("Open a URL or deep link (VIEW intent)")
  .argument("<url>", "https://… or myapp://…")
  .option("--package <package>", "Restrict to this app")
  .option(...deviceOpt)
  .option(...jsonOpt)
  .action((url: string, opts) => openCmd(url, opts));

program
  .command("apps")
  .description("List installed packages (third-party; --all for system apps too)")
  .option("-a, --all", "Include system packages")
  .option(...deviceOpt)
  .option(...jsonOpt)
  .action((opts) => appsCmd(opts));

// ── adb passthrough ────────────────────────────────────────────────────────

program
  .command("shell")
  .description("Run a shell command on the device (no args: interactive shell)")
  .argument("[cmd...]", "Command and arguments")
  .option(...deviceOpt)
  .passThroughOptions()
  .action((cmd: string[], opts) => adbPassthrough(opts.device, ["shell", ...cmd]));

program
  .command("push")
  .description("Copy a local file/dir to the device (adb push)")
  .argument("<local>")
  .argument("<remote>")
  .option(...deviceOpt)
  .action((local: string, remote: string, opts) => adbPassthrough(opts.device, ["push", local, remote]));

program
  .command("pull")
  .description("Copy a file/dir from the device (adb pull)")
  .argument("<remote>")
  .argument("[local]")
  .option(...deviceOpt)
  .action((remote: string, local: string | undefined, opts) => adbPassthrough(opts.device, ["pull", remote, ...(local ? [local] : [])]));

// ── MCP ────────────────────────────────────────────────────────────────────

program
  .command("mcp")
  .description("Run an MCP server over stdio exposing the emulator as tools (for Claude Desktop / Cursor / Codex)")
  .option(...deviceOpt)
  .option("--serve", "Also host the preview server in-process (so humans can watch at localhost:3200)")
  .option("-p, --port <port>", "Preview port for --serve (default 3200)", (v) => parseInt(v, 10))
  .action((opts) =>
    runMcpServer({
      device: opts.device,
      serve: !!opts.serve,
      port: opts.port,
      version: VERSION,
      resolveDevices: (args) => resolveTargets(args, true),
    }),
  );

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
