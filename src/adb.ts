/**
 * adb + emulator toolchain access: binary discovery, one-shot commands, binary
 * `exec-out` capture, and a persistent interactive shell for low-latency input
 * injection (one `adb shell` handshake per device instead of one per command).
 */
import { spawn, execFile, type ChildProcessByStdio } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Readable, Writable } from "stream";
import { createDebug } from "./debug";

const debug = createDebug("adb");

// ── Toolchain discovery ────────────────────────────────────────────────────

function sdkRoots(): string[] {
  const roots: string[] = [];
  for (const env of ["ANDROID_HOME", "ANDROID_SDK_ROOT"]) {
    const value = process.env[env];
    if (value) roots.push(value);
  }
  // Default SDK locations for macOS and Linux.
  roots.push(join(homedir(), "Library", "Android", "sdk"));
  roots.push(join(homedir(), "Android", "Sdk"));
  roots.push(join(homedir(), "android-sdk"));
  return roots;
}

let cachedAdb: string | null = null;

/** Resolve the adb binary: $ANDROID_HOME/platform-tools, then PATH, then default SDK dirs. */
export function adbPath(): string {
  if (cachedAdb) return cachedAdb;
  for (const root of sdkRoots()) {
    const candidate = join(root, "platform-tools", "adb");
    if (existsSync(candidate)) return (cachedAdb = candidate);
  }
  return (cachedAdb = "adb"); // hope it's on PATH; execs will error clearly if not
}

let cachedEmulator: string | null = null;

/** Resolve the emulator binary the same way. */
export function emulatorPath(): string {
  if (cachedEmulator) return cachedEmulator;
  for (const root of sdkRoots()) {
    const candidate = join(root, "emulator", "emulator");
    if (existsSync(candidate)) return (cachedEmulator = candidate);
  }
  return (cachedEmulator = "emulator");
}

// ── One-shot commands ──────────────────────────────────────────────────────

export function adb(args: string[], opts: { timeout?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      adbPath(),
      args,
      { timeout: opts.timeout ?? 20_000, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || stdout || err.message).trim();
          reject(new Error(`adb ${args.join(" ")} failed: ${detail}`));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

/** `adb -s <serial> shell <cmd>` (stderr folded in, output trimmed). */
export function adbShell(serial: string, cmd: string, opts: { timeout?: number } = {}): Promise<string> {
  return adb(["-s", serial, "shell", `${cmd} 2>&1`], opts).then((out) => out.replace(/\r\n/g, "\n").trim());
}

/** `adb -s <serial> exec-out <cmd>` capturing raw binary stdout (no pty mangling). */
export function adbExecOut(serial: string, args: string[], opts: { timeout?: number } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      adbPath(),
      ["-s", serial, "exec-out", ...args],
      { timeout: opts.timeout ?? 30_000, maxBuffer: 256 * 1024 * 1024, encoding: "buffer" },
      (err, stdout) => {
        if (err) reject(new Error(`adb exec-out ${args.join(" ")} failed: ${err.message}`));
        else resolve(stdout);
      },
    );
  });
}

/**
 * `adb -s <serial> emu <cmd…>` — the emulator console (geo, network, gsm, sms,
 * finger, avd snapshot, power…). adb authenticates with the console token for
 * us. The console answers `OK` or `KO: <reason>`; this resolves with the
 * response body (sans OK) and throws on KO / non-emulator serials.
 */
export async function adbEmu(serial: string, args: string[], opts: { timeout?: number } = {}): Promise<string> {
  if (!serial.startsWith("emulator-")) {
    throw new Error(`'${args[0]}' needs an emulator (adb emu console) — ${serial} is not one`);
  }
  const out = await adb(["-s", serial, "emu", ...args], { timeout: opts.timeout ?? 20_000 });
  return parseEmuConsoleReply(out, args);
}

/** Exported for tests. */
export function parseEmuConsoleReply(out: string, args: string[]): string {
  const lines = out
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const ko = lines.find((l) => /^KO\b/.test(l));
  if (ko) throw new Error(`emulator console rejected '${args.join(" ")}': ${ko.replace(/^KO:?\s*/, "") || "unknown error"}`);
  return lines.filter((l) => l !== "OK").join("\n");
}

/** `adb -s <serial> install -r [-g] <apk>` — resolves with adb's output. */
export async function adbInstall(serial: string, apk: string, opts: { grant?: boolean; reinstall?: boolean } = {}): Promise<string> {
  const args = ["-s", serial, "install"];
  if (opts.reinstall !== false) args.push("-r");
  if (opts.grant !== false) args.push("-g");
  args.push(apk);
  const out = await adb(args, { timeout: 300_000 });
  if (/Failure/i.test(out)) throw new Error(out.trim());
  return out.trim();
}

export function adbPush(serial: string, local: string, remote: string): Promise<string> {
  return adb(["-s", serial, "push", local, remote], { timeout: 300_000 }).then((o) => o.trim());
}

export function adbPull(serial: string, remote: string, local: string): Promise<string> {
  return adb(["-s", serial, "pull", remote, local], { timeout: 300_000 }).then((o) => o.trim());
}

// ── Device discovery ───────────────────────────────────────────────────────

export interface AdbDevice {
  serial: string;
  state: string; // device | offline | unauthorized | …
  model?: string;
  product?: string;
  isEmulator: boolean;
}

/** Parse `adb devices -l`. Starts the adb server as a side effect. */
export async function listDevices(): Promise<AdbDevice[]> {
  const out = await adb(["devices", "-l"]);
  const devices: AdbDevice[] = [];
  for (const line of out.split("\n").slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [serial, state, ...rest] = trimmed.split(/\s+/);
    if (!serial || !state) continue;
    const fields: Record<string, string> = {};
    for (const kv of rest) {
      const idx = kv.indexOf(":");
      if (idx > 0) fields[kv.slice(0, idx)] = kv.slice(idx + 1);
    }
    devices.push({
      serial,
      state,
      model: fields.model?.replace(/_/g, " "),
      product: fields.product,
      isEmulator: serial.startsWith("emulator-"),
    });
  }
  return devices;
}

/** AVD name backing an emulator serial (via the emulator console), or null. */
export async function avdNameForSerial(serial: string): Promise<string | null> {
  if (!serial.startsWith("emulator-")) return null;
  try {
    const out = await adb(["-s", serial, "emu", "avd", "name"], { timeout: 5_000 });
    const name = out.split("\n").map((l) => l.trim()).filter(Boolean)[0];
    return name && name !== "OK" ? name : null;
  } catch {
    return null;
  }
}

/** Human display name for a device: AVD name, then model, then serial. */
export async function deviceDisplayName(serial: string): Promise<string> {
  const avd = await avdNameForSerial(serial);
  if (avd) return avd.replace(/_/g, " ");
  try {
    const model = await adbShell(serial, "getprop ro.product.model", { timeout: 5_000 });
    if (model) return model;
  } catch {}
  return serial;
}

/** AVDs configured on this machine (`emulator -list-avds`). */
export function listAvds(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(emulatorPath(), ["-list-avds"], { timeout: 15_000, encoding: "utf8" }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(
        stdout
          .split("\n")
          .map((l) => l.trim())
          // Newer emulators print an INFO banner line; AVD names never contain spaces.
          .filter((l) => l && !l.includes(" ") && !l.startsWith("INFO")),
      );
    });
  });
}

/** Launch an AVD headfully, detached from this process. */
export function launchAvd(name: string): void {
  const child = spawn(emulatorPath(), ["-avd", name], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

/** Wait until `sys.boot_completed` is 1 (device fully booted). */
export async function waitForBoot(serial: string, timeoutMs = 180_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const out = await adbShell(serial, "getprop sys.boot_completed", { timeout: 5_000 });
      if (out.startsWith("1")) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
}

/**
 * Wait for a *new* emulator serial to appear after `launchAvd`, i.e. one not
 * present in `known`. Returns the serial or null on timeout.
 */
export async function waitForNewEmulatorSerial(known: Set<string>, timeoutMs = 60_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const devices = await listDevices();
      const fresh = devices.find((d) => d.isEmulator && !known.has(d.serial) && d.state === "device");
      if (fresh) return fresh.serial;
    } catch {}
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return null;
}

// ── Screen geometry ────────────────────────────────────────────────────────

export interface ScreenGeometry {
  /** Unrotated (natural) panel size in px. */
  width: number;
  height: number;
  density: number;
}

export async function screenGeometry(serial: string): Promise<ScreenGeometry> {
  const sizeOut = await adbShell(serial, "wm size");
  // Prefer an override size when present — that's what the display is running at.
  const override = /Override size:\s*(\d+)x(\d+)/.exec(sizeOut);
  const physical = /Physical size:\s*(\d+)x(\d+)/.exec(sizeOut);
  const match = override ?? physical;
  if (!match) throw new Error(`Could not parse 'wm size' output: ${sizeOut}`);
  let density = 0;
  try {
    const densityOut = await adbShell(serial, "wm density");
    const dm = /density:\s*(\d+)/.exec(densityOut);
    if (dm) density = parseInt(dm[1]!, 10);
  } catch {}
  return { width: parseInt(match[1]!, 10), height: parseInt(match[2]!, 10), density };
}

/** Current display rotation 0..3 (multiples of 90° counter-clockwise from natural). */
export async function screenRotation(serial: string, shell?: AdbShell): Promise<number> {
  const run = (cmd: string) => (shell ? shell.run(cmd) : adbShell(serial, cmd));
  try {
    const out = await run("dumpsys window displays | grep -E 'rotation|mCurrentRotation' | head -5");
    const rot = parseRotation(out);
    if (rot != null) return rot;
  } catch {}
  try {
    // Fallback: the sticky user_rotation setting (accurate when auto-rotate is off).
    const out = await run("settings get system user_rotation");
    const value = parseInt(out.trim(), 10);
    if (value >= 0 && value <= 3) return value;
  } catch {}
  return 0;
}

/** Extract a 0..3 rotation from assorted dumpsys formats across API levels. */
export function parseRotation(text: string): number | null {
  const patterns = [
    /mCurrentRotation=(?:ROTATION_)?(\d+)/,
    /\brotation=ROTATION_(\d+)/,
    /\brotation[:=]\s*(\d+)/i,
    /SurfaceOrientation:\s*(\d)/,
  ];
  for (const pattern of patterns) {
    const m = pattern.exec(text);
    if (!m) continue;
    let value = parseInt(m[1]!, 10);
    if (value >= 90) value = value / 90; // ROTATION_90 → 1, ROTATION_270 → 3
    if (value >= 0 && value <= 3) return value;
  }
  return null;
}

// ── Persistent shell ───────────────────────────────────────────────────────

type ShellChild = ChildProcessByStdio<Writable, Readable, Readable>;

interface PendingCommand {
  sentinel: string;
  resolve: (result: { out: string; code: number }) => void;
}

/**
 * A single long-lived `adb -s <serial> shell` with commands multiplexed over
 * stdin. Skips the per-command adb handshake + fork (~100ms), which matters for
 * interactive input where we send many small `cmd input …` calls.
 *
 * Commands are serialized: each is written as `(<cmd>) 2>&1; echo <sentinel>$?`
 * and its output collected until the sentinel line arrives.
 */
export class AdbShell {
  private child: ShellChild | null = null;
  private buffer = "";
  private queue: Array<{ cmd: string; pending: PendingCommand }> = [];
  private active: PendingCommand | null = null;
  private nextId = 1;
  private closed = false;

  constructor(public readonly serial: string) {}

  private ensureChild(): ShellChild {
    if (this.child && this.child.exitCode === null) return this.child;
    const child = spawn(adbPath(), ["-s", this.serial, "shell"], {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ShellChild;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.resume(); // don't let the pipe fill
    child.on("exit", () => {
      debug(`shell for ${this.serial} exited`);
      // Fail the in-flight command so callers don't hang; later calls respawn.
      const active = this.active;
      this.active = null;
      this.buffer = "";
      active?.resolve({ out: "", code: 255 });
      this.pump();
    });
    this.child = child;
    return child;
  }

  private onData(chunk: string): void {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    this.drain();
  }

  private drain(): void {
    const active = this.active;
    if (!active) return;
    const idx = this.buffer.indexOf(active.sentinel);
    if (idx === -1) return;
    const lineEnd = this.buffer.indexOf("\n", idx);
    if (lineEnd === -1) return; // exit code digits not fully arrived yet
    const out = this.buffer.slice(0, idx);
    const code = parseInt(this.buffer.slice(idx + active.sentinel.length, lineEnd), 10);
    this.buffer = this.buffer.slice(lineEnd + 1);
    this.active = null;
    active.resolve({ out: out.replace(/\n$/, ""), code: Number.isFinite(code) ? code : 255 });
    this.pump();
  }

  private pump(): void {
    if (this.active || this.closed) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = next.pending;
    try {
      const child = this.ensureChild();
      child.stdin.write(`(${next.cmd}) 2>&1; echo ${next.pending.sentinel}$?\n`);
    } catch (err) {
      debug("shell write failed", err);
      const active = this.active;
      this.active = null;
      active?.resolve({ out: "", code: 255 });
    }
  }

  /** Run a command, resolving with its combined output (sans sentinel). */
  run(cmd: string): Promise<string> {
    return this.runWithCode(cmd).then((r) => r.out.trim());
  }

  runWithCode(cmd: string): Promise<{ out: string; code: number }> {
    if (this.closed) return Promise.resolve({ out: "", code: 255 });
    return new Promise((resolve) => {
      const sentinel = `__SEMU_${process.pid}_${this.nextId++}__:`;
      this.queue.push({ cmd, pending: { sentinel, resolve } });
      this.pump();
    });
  }

  close(): void {
    this.closed = true;
    this.queue = [];
    if (this.child) {
      try {
        this.child.stdin.end("exit\n");
      } catch {}
      const child = this.child;
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
      }, 500).unref();
      this.child = null;
    }
  }
}
