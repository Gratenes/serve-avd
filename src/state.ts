import { tmpdir } from "os";
import { join } from "path";
import { readdirSync, mkdirSync, writeFileSync, renameSync, readFileSync, rmSync } from "fs";

/** Directory where serve-avd stores runtime state. */
export const STATE_DIR = join(tmpdir(), "serve-avd");

/** Per-device state file: `$TMPDIR/serve-avd/server-{serial}.json` */
export function stateFileForDevice(serial: string): string {
  return join(STATE_DIR, `server-${sanitize(serial)}.json`);
}

/** Serials contain `:` for tcp devices (`192.168.1.2:5555`); keep filenames tame. */
function sanitize(serial: string): string {
  return serial.replace(/[^A-Za-z0-9._-]+/g, "_");
}

/** Runtime record for a device streamed in-process by a preview server. */
export interface ServeAvdDeviceState {
  pid: number;
  port: number;
  /** adb serial, e.g. `emulator-5554`. */
  device: string;
  /** Human name, e.g. `Pixel 9 Pro XL`. */
  name?: string;
  url: string;
  streamUrl: string;
  wsUrl: string;
}

/**
 * Build the state for a device served in-process. There's no separate helper
 * process — the URLs point at the preview server's own same-origin
 * `{base}/helper/<device>/…` routes, which emuMiddleware serves from an
 * adb-backed EmulatorSession.
 */
export function inProcessServeAvdState(
  serial: string,
  port: number,
  base = "/",
  host = "127.0.0.1",
  name?: string,
): ServeAvdDeviceState {
  const h = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  // Normalize to a leading-slash, no-trailing-slash prefix so a base without a
  // leading slash (e.g. "foo") still yields well-formed `…:port/foo/helper/…`.
  const trimmed = base.replace(/^\/+/, "").replace(/\/+$/, "");
  const prefix = trimmed === "" ? "" : `/${trimmed}`;
  return {
    pid: process.pid,
    port,
    device: serial,
    ...(name ? { name } : {}),
    url: `http://${h}:${port}`,
    streamUrl: `http://${h}:${port}${prefix}/helper/${encodeURIComponent(serial)}/stream.mjpeg`,
    wsUrl: `ws://${h}:${port}${prefix}/helper/${encodeURIComponent(serial)}/ws`,
  };
}

/** Persist a device's state so other processes / the CLI can enumerate it.
 *  Writes atomically (temp file + rename) so a concurrent reader never observes
 *  a truncated or partially-written file. */
export function writeServeAvdState(state: ServeAvdDeviceState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const file = stateFileForDevice(state.device);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}

/** List all per-device state files in the state directory. */
export function listStateFiles(): string[] {
  try {
    return readdirSync(STATE_DIR)
      .filter((f) => f.startsWith("server-") && f.endsWith(".json"))
      .map((f) => join(STATE_DIR, f));
  } catch {
    return [];
  }
}

/** Read every parseable device state, newest first. */
export function readAllStates(): ServeAvdDeviceState[] {
  const states: ServeAvdDeviceState[] = [];
  for (const file of listStateFiles()) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as ServeAvdDeviceState;
      if (parsed && typeof parsed.pid === "number" && typeof parsed.device === "string") {
        states.push(parsed);
      }
    } catch {
      // Partially-written or stale file — skip.
    }
  }
  return states;
}

/** True when the recorded pid is still alive. */
export function statePidAlive(state: ServeAvdDeviceState): boolean {
  try {
    process.kill(state.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function removeStateForDevice(serial: string): void {
  try {
    rmSync(stateFileForDevice(serial), { force: true });
  } catch {}
}
