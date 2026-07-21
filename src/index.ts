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
  adbExecOut,
  AdbShell,
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
import { dumpUiHierarchy } from "./ax";
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

/** Send `[tag][JSON]` frames over the server's input WebSocket. */
function sendHid(
  state: ServeAvdDeviceState,
  frames: Array<{ tag: number; body?: unknown; delayAfterMs?: number }>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(state.wsUrl);
    ws.binaryType = "arraybuffer";
    ws.on("open", async () => {
      for (const frame of frames) {
        const json = frame.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(frame.body));
        const msg = Buffer.concat([Buffer.from([frame.tag]), json]);
        ws.send(msg);
        if (frame.delayAfterMs) await new Promise((r) => setTimeout(r, frame.delayAfterMs));
      }
      setTimeout(() => {
        ws.close();
        resolve();
      }, 80);
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

async function tap(xArg: string, yArg: string, deviceArg?: string): Promise<void> {
  const x = Number(xArg);
  const y = Number(yArg);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    console.error("Usage: serve-avd tap <x> <y> [-d serial]");
    console.error("  x, y are normalized 0..1 of the emulator screen");
    console.error("  Example: serve-avd tap 0.5 0.9   # near bottom-center");
    process.exit(1);
  }
  const state = requireState(deviceArg);
  await sendHid(state, [
    { tag: 0x03, body: { type: "begin", x, y }, delayAfterMs: 40 },
    { tag: 0x03, body: { type: "end", x, y } },
  ]);
}

async function button(name: string, deviceArg?: string): Promise<void> {
  if (!BUTTONS[name]) {
    console.error(`Unknown button '${name}'. Available: ${Object.keys(BUTTONS).join(", ")}`);
    process.exit(1);
  }
  const state = requireState(deviceArg);
  await sendHid(state, [{ tag: 0x04, body: { button: name } }]);
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

  const state = requireState(opts.device);
  await sendHid(state, [{ tag: 0x0d, body: { text }, delayAfterMs: Math.min(2_000, 50 + text.length * 15) }]);
}

async function rotate(orientation: string, deviceArg?: string): Promise<void> {
  if (ORIENTATIONS[orientation] == null) {
    console.error(`Unknown orientation '${orientation}'. Expected: ${Object.keys(ORIENTATIONS).join(" | ")}`);
    process.exit(1);
  }
  const state = requireState(deviceArg);
  await sendHid(state, [{ tag: 0x07, body: { orientation }, delayAfterMs: 300 }]);
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
  const state = requireState(deviceArg);
  await sendHid(state, [{ tag: 0x08, body: { option, enabled: stateArg === "on" }, delayAfterMs: 200 }]);
}

async function memoryWarning(deviceArg?: string): Promise<void> {
  const state = requireState(deviceArg);
  await sendHid(state, [{ tag: 0x09, delayAfterMs: 200 }]);
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

/** Screenshot via the running server when present, else straight through adb. */
async function screenshot(path: string | undefined, deviceArg?: string): Promise<void> {
  const state = readState(deviceArg);
  let data: Buffer;
  if (state) {
    const res = await fetch(new URL(state.streamUrl.replace(/stream\.mjpeg$/, "screenshot.png")));
    if (!res.ok) {
      console.error(`Screenshot failed: HTTP ${res.status}`);
      process.exit(1);
    }
    data = Buffer.from(await res.arrayBuffer());
  } else {
    const serial = await resolveSingleSerial(deviceArg);
    data = await adbExecOut(serial, ["screencap", "-p"]);
  }
  const isPng = data[0] === 0x89;
  const out = path ?? `emu-screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.${isPng ? "png" : "jpg"}`;
  writeFileSync(out, data);
  console.log(out);
}

async function resolveSingleSerial(deviceArg?: string): Promise<string> {
  const online = (await listDevices()).filter((d) => d.state === "device");
  if (deviceArg) {
    const match = online.find((d) => d.serial === deviceArg);
    if (match) return match.serial;
    console.error(`No connected device '${deviceArg}'.`);
    process.exit(1);
  }
  if (online.length === 0) {
    console.error("No devices connected.");
    process.exit(1);
  }
  return online[0]!.serial;
}

async function axDump(deviceArg: string | undefined): Promise<void> {
  const state = readState(deviceArg);
  if (state) {
    const res = await fetch(new URL(state.streamUrl.replace(/stream\.mjpeg$/, "ax")));
    console.log(JSON.stringify(await res.json(), null, 2));
    return;
  }
  const serial = await resolveSingleSerial(deviceArg);
  const shell = new AdbShell(serial);
  try {
    console.log(JSON.stringify(await dumpUiHierarchy(shell), null, 2));
  } finally {
    shell.close();
  }
}

async function foreground(deviceArg: string | undefined): Promise<void> {
  const state = requireState(deviceArg);
  const res = await fetch(new URL(state.streamUrl.replace(/stream\.mjpeg$/, "foreground")));
  console.log(JSON.stringify(await res.json(), null, 2));
}

// ── Program ────────────────────────────────────────────────────────────────

function parsePanes(value: string): string[] {
  return value === "none" ? [] : value.split(",").map((p) => p.trim()).filter(Boolean);
}

const program = new Command();

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
  .option("--fit", "Initially size the emulator to fit the preview viewport")
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
  serve-avd --panes devices,tools --fit  Open panes and fit the emulator to the viewport
  serve-avd --theme dark                 Start the device in Dark Mode
  serve-avd --no-preview                 Stream in foreground without the web UI
  serve-avd --detach                     Start streaming in background (daemon)
  serve-avd --list                       Show all running streams
  serve-avd --kill                       Stop all streams`,
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
    const initialState =
      opts.panes !== undefined || opts.fit
        ? {
            ...(opts.panes !== undefined ? { panes: parsePanes(opts.panes) } : {}),
            ...(opts.fit ? { fit: true } : {}),
          }
        : undefined;
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

program
  .command("tap")
  .description("Tap at normalized 0..1 coords")
  .argument("<x>", "X coord, normalized 0..1")
  .argument("<y>", "Y coord, normalized 0..1")
  .option(...deviceOpt)
  .action((x: string, y: string, opts) => tap(x, y, opts.device));

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
  .description("Show recent emulator events")
  .option(...deviceOpt)
  .option("-j, --json", "Print JSON")
  .option("-n, --limit <count>", "Maximum number of events")
  .action((opts) => eventLog(opts.device, { json: opts.json, limit: opts.limit }));

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

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
