/**
 * Device actions — the one RPC surface behind `POST /helper/<serial>/action`,
 * the CLI subcommands, the MCP tools, the `serve-avd/client` SDK, replay,
 * and the preview's Tools pane. Each action is a small named function over an
 * `ActionContext` (persistent adb shell + input injector + emulator console),
 * validated params in, JSON result out, one event-log entry per call.
 *
 * Kept transport-agnostic so the same code runs inside a preview server
 * (session-backed) and headless from the CLI (fresh shell against adb).
 */
import type { AdbShell } from "./adb";
import type { InputInjector } from "./input";
import { ORIENTATIONS, DEBUG_FLAGS } from "./input";
import { BUTTONS, androidKeycodeForBrowserCode, shellQuote, textToSteps, UnsupportedCharacterError } from "./keymap";
import {
  findInAx,
  waitForAx,
  pickMatch,
  describeQuery,
  isEmptyQuery,
  type AxDump,
  type AxQuery,
  type AxMatch,
} from "./ax";
import { formatEventLogPoint } from "./event-log-format";
import type { EventLogEntry } from "./event-log";

// ── Context ────────────────────────────────────────────────────────────────

export interface ActionRecord {
  kind: string;
  summary: string;
  action?: string;
  details?: Record<string, unknown>;
  status?: "ok" | "error";
}

export interface ActionContext {
  serial: string;
  shell: AdbShell;
  injector: InputInjector;
  /** Current rotated display size in px. */
  displaySize(): Promise<{ width: number; height: number }>;
  /** UI hierarchy dump. */
  ax(): Promise<AxDump>;
  /** Emulator console (`adb emu …`). Throws for non-emulator serials. */
  emu(args: string[], opts?: { timeout?: number }): Promise<string>;
  /** Host-side adb (`adb -s <serial> …`) for install/push/pull. */
  adb(args: string[], opts?: { timeout?: number }): Promise<string>;
  /** Append to the event log. */
  record(entry: ActionRecord): EventLogEntry | void;
  /** The screen changed wholesale (snapshot load) — viewers should re-sync. */
  onDisplayReset?(): void;
  /** A rotate action settled on `rotation` (applied or not) — adopt it now rather than on the next poll. */
  onRotation?(rotation: number): void;
}

export type ActionParams = Record<string, unknown>;

export class ActionError extends Error {
  constructor(
    message: string,
    public readonly code: "bad_request" | "not_found" | "unsupported" | "failed" = "failed",
  ) {
    super(message);
  }
}

// ── Param helpers ──────────────────────────────────────────────────────────

function str(p: ActionParams, key: string, required = false): string | undefined {
  const v = p[key];
  if (v == null || v === "") {
    if (required) throw new ActionError(`'${key}' is required`, "bad_request");
    return undefined;
  }
  return String(v);
}

function num(p: ActionParams, key: string, required = false, range?: [number, number]): number | undefined {
  const v = p[key];
  if (v == null || v === "") {
    if (required) throw new ActionError(`'${key}' is required`, "bad_request");
    return undefined;
  }
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new ActionError(`'${key}' must be a number`, "bad_request");
  if (range && (n < range[0] || n > range[1])) {
    throw new ActionError(`'${key}' must be between ${range[0]} and ${range[1]}`, "bad_request");
  }
  return n;
}

function bool(p: ActionParams, key: string): boolean | undefined {
  const v = p[key];
  if (v == null || v === "") return undefined;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  if (["1", "true", "on", "yes", "enable", "enabled"].includes(s)) return true;
  if (["0", "false", "off", "no", "disable", "disabled"].includes(s)) return false;
  throw new ActionError(`'${key}' must be on|off`, "bad_request");
}

function oneOf<T extends string>(p: ActionParams, key: string, values: readonly T[], required = false, fallback?: T): T | undefined {
  const v = str(p, key, required) ?? fallback;
  if (v == null) return undefined;
  if (!(values as readonly string[]).includes(v)) {
    throw new ActionError(`'${key}' must be one of ${values.join(" | ")}`, "bad_request");
  }
  return v as T;
}

/** Pull an AxQuery out of params (text/id/desc/class/exact/index/clickable). */
export function axQueryFromParams(p: ActionParams): AxQuery {
  const q: AxQuery = {};
  const text = str(p, "text");
  const id = str(p, "id");
  const desc = str(p, "desc");
  const cls = str(p, "class");
  if (text != null) q.text = text;
  if (id != null) q.id = id;
  if (desc != null) q.desc = desc;
  if (cls != null) q.class = cls;
  if (bool(p, "exact")) q.exact = true;
  if (bool(p, "clickable")) q.clickable = true;
  const index = num(p, "index");
  if (index != null) q.index = Math.max(0, Math.floor(index));
  return q;
}

const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
function pkg(p: ActionParams, key = "package"): string {
  const v = str(p, key, true)!;
  if (!PACKAGE_RE.test(v)) throw new ActionError(`'${key}' is not a valid package name: ${v}`, "bad_request");
  return v;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

// ── Action specs ───────────────────────────────────────────────────────────

export interface ParamSpec {
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  required?: boolean;
  enum?: string[];
}

export interface ActionSpec {
  name: string;
  description: string;
  params: Record<string, ParamSpec>;
  /** Needs the emulator console (`adb emu`) — physical devices can't do it. */
  emulatorOnly?: boolean;
  run(ctx: ActionContext, params: ActionParams): Promise<unknown>;
}

const AX_QUERY_PARAMS: Record<string, ParamSpec> = {
  text: { type: "string", description: "Match visible text or content-description (case-insensitive substring)" },
  id: { type: "string", description: "Match resource id (full 'pkg:id/name' or just 'name')" },
  desc: { type: "string", description: "Match content-description only" },
  class: { type: "string", description: "Match widget class name substring, e.g. Button" },
  exact: { type: "boolean", description: "Require exact (case-sensitive) matches" },
  index: { type: "number", description: "Which match to use when several match (0-based, default 0)" },
};

const ORIENTATION_NAMES = Object.keys(ORIENTATIONS);
const NETWORK_SPEEDS = ["gsm", "hscsd", "gprs", "edge", "umts", "hsdpa", "lte", "evdo", "full"];
const NETWORK_DELAYS = ["gprs", "edge", "umts", "none"];

async function resolveTarget(
  ctx: ActionContext,
  params: ActionParams,
): Promise<{ x: number; y: number; px: number; py: number; screen: { width: number; height: number }; match?: AxMatch; query?: AxQuery }> {
  const query = axQueryFromParams(params);
  const x = num(params, "x", false, [0, 1]);
  const y = num(params, "y", false, [0, 1]);
  const screen = await ctx.displaySize();
  if (!isEmptyQuery(query)) {
    const result = findInAx(await ctx.ax(), query, screen);
    const match = pickMatch(result, query);
    if (!match) {
      throw new ActionError(
        `No UI element matching ${describeQuery(query)}${result.total ? ` (only ${result.total} match${result.total === 1 ? "" : "es"})` : ""}`,
        "not_found",
      );
    }
    const size = result.screen.width > 0 ? result.screen : screen;
    return {
      x: match.normalized.x,
      y: match.normalized.y,
      px: match.center.x,
      py: match.center.y,
      screen: size,
      match,
      query,
    };
  }
  if (x == null || y == null) {
    throw new ActionError("Provide x and y (normalized 0..1) or a target (text / id / desc / class)", "bad_request");
  }
  return {
    x,
    y,
    px: Math.round(clamp01(x) * (screen.width - 1)),
    py: Math.round(clamp01(y) * (screen.height - 1)),
    screen,
  };
}

function targetLabel(t: { x: number; y: number; query?: AxQuery }): string {
  return t.query ? describeQuery(t.query) : formatEventLogPoint(t.x, t.y);
}

export const ACTIONS: ActionSpec[] = [
  // ── Input ──────────────────────────────────────────────────────────────
  {
    name: "tap",
    description: "Tap a point (normalized x,y) or the first UI element matching text / id / desc / class",
    params: {
      x: { type: "number", description: "Normalized 0..1 x (when not targeting by text/id)" },
      y: { type: "number", description: "Normalized 0..1 y" },
      ...AX_QUERY_PARAMS,
      durationMs: { type: "number", description: "Hold duration for a long-press (default: plain tap)" },
    },
    async run(ctx, params) {
      const t = await resolveTarget(ctx, params);
      const durationMs = num(params, "durationMs", false, [0, 60_000]);
      const label = targetLabel(t);
      ctx.record({
        kind: "tap",
        action: "tap",
        summary: durationMs ? `Long-press ${label}` : `Tap ${label}`,
        details: {
          type: "tap",
          start: { x: t.x, y: t.y },
          current: { x: t.x, y: t.y },
          screen: t.screen,
          ...(t.query ? { target: t.query } : {}),
          ...(durationMs ? { durationMs } : {}),
        },
      });
      if (durationMs && durationMs > 0) await ctx.injector.longPress(t.px, t.py, durationMs);
      else await ctx.injector.tap(t.px, t.py);
      return {
        x: t.x,
        y: t.y,
        px: t.px,
        py: t.py,
        ...(t.match ? { matched: { text: t.match.node.text, resourceId: t.match.node.resourceId, contentDesc: t.match.node.contentDesc, bounds: t.match.bounds } } : {}),
      };
    },
  },
  {
    name: "swipe",
    description: "Swipe from (x1,y1) to (x2,y2) in normalized coords over durationMs (default 300)",
    params: {
      x1: { type: "number", description: "Start x 0..1", required: true },
      y1: { type: "number", description: "Start y 0..1", required: true },
      x2: { type: "number", description: "End x 0..1", required: true },
      y2: { type: "number", description: "End y 0..1", required: true },
      durationMs: { type: "number", description: "Duration in ms (default 300)" },
    },
    async run(ctx, params) {
      const x1 = num(params, "x1", true, [0, 1])!;
      const y1 = num(params, "y1", true, [0, 1])!;
      const x2 = num(params, "x2", true, [0, 1])!;
      const y2 = num(params, "y2", true, [0, 1])!;
      const durationMs = num(params, "durationMs", false, [1, 60_000]) ?? 300;
      const screen = await ctx.displaySize();
      const px = (v: number, max: number) => Math.round(clamp01(v) * (max - 1));
      ctx.record({
        kind: "drag",
        action: "drag",
        summary: `Drag ${formatEventLogPoint(x1, y1)} -> ${formatEventLogPoint(x2, y2)}`,
        details: { type: "drag", start: { x: x1, y: y1 }, current: { x: x2, y: y2 }, durationMs, screen },
      });
      await ctx.injector.swipe(px(x1, screen.width), px(y1, screen.height), px(x2, screen.width), px(y2, screen.height), durationMs);
      return { from: { x: x1, y: y1 }, to: { x: x2, y: y2 }, durationMs };
    },
  },
  {
    name: "text",
    description: "Type text into the focused field (ASCII; \\n = Enter, \\t = Tab)",
    params: { text: { type: "string", description: "Text to type", required: true } },
    async run(ctx, params) {
      const text = str(params, "text", true)!;
      try {
        textToSteps(text);
      } catch (err) {
        if (err instanceof UnsupportedCharacterError) throw new ActionError(err.message, "unsupported");
        throw err;
      }
      ctx.record({ kind: "text", action: "type", summary: "Type text", details: { text } });
      await ctx.injector.text(text);
      return { typed: text.length };
    },
  },
  {
    name: "key",
    description: "Press a key by browser KeyboardEvent.code (Enter, Backspace, Tab, ArrowDown, KeyA…) or an Android keycode number",
    params: {
      code: { type: "string", description: "Browser key code, e.g. Enter" },
      keycode: { type: "number", description: "Android keycode number (alternative to code)" },
      longPress: { type: "boolean", description: "Long-press the key" },
    },
    async run(ctx, params) {
      const code = str(params, "code");
      let keycode = num(params, "keycode");
      if (keycode == null && code != null) keycode = androidKeycodeForBrowserCode(code) ?? undefined;
      if (keycode == null) throw new ActionError(code ? `Unknown key code '${code}'` : "Provide 'code' or 'keycode'", "bad_request");
      const label = code ?? String(keycode);
      ctx.record({ kind: "key", action: "down", summary: `Key ${label}`, details: { code: label, key: label, keycode } });
      await ctx.injector.keyevent(keycode, bool(params, "longPress") === true);
      return { keycode };
    },
  },
  {
    name: "button",
    description: `Press a hardware/navigation button (${Object.keys(BUTTONS).join(" | ")})`,
    params: { button: { type: "string", description: "Button name", required: true, enum: Object.keys(BUTTONS) } },
    async run(ctx, params) {
      const button = str(params, "button", true)!;
      if (!BUTTONS[button]) throw new ActionError(`Unknown button '${button}'. Available: ${Object.keys(BUTTONS).join(", ")}`, "bad_request");
      ctx.record({ kind: "button", action: button, summary: `Button ${button}`, details: { button } });
      await ctx.injector.button(button);
      return { button };
    },
  },
  {
    name: "rotate",
    description: "Rotate the display (portrait | landscape_left | portrait_upside_down | landscape_right)",
    params: { orientation: { type: "string", description: "Orientation", required: true, enum: ORIENTATION_NAMES } },
    async run(ctx, params) {
      const orientation = oneOf(params, "orientation", ORIENTATION_NAMES, true)!;
      ctx.record({ kind: "rotate", action: orientation, summary: `Rotate ${orientation}` });
      const result = await ctx.injector.rotate(orientation);
      ctx.onRotation?.(result.rotation);
      if (!result.applied) {
        throw new ActionError(`Rotation ${orientation} refused — the foreground app is orientation-locked`, "failed");
      }
      return result;
    },
  },
  {
    name: "debug",
    description: `Toggle an Android render/debug flag (${Object.keys(DEBUG_FLAGS).join(" | ")}); no params reads all flags`,
    params: {
      option: { type: "string", description: "Flag (omit to read all flags)", enum: Object.keys(DEBUG_FLAGS) },
      enabled: { type: "boolean", description: "on/off (required when setting a flag)" },
    },
    async run(ctx, params) {
      const option = oneOf(params, "option", Object.keys(DEBUG_FLAGS));
      if (option == null && params.enabled == null) {
        const reads: Record<string, [string, string]> = {
          overdraw: ["getprop debug.hwui.overdraw", "show"],
          "gpu-profile": ["getprop debug.hwui.profile", "visual_bars"],
          "layout-bounds": ["getprop debug.layout", "true"],
          "show-taps": ["settings get system show_touches", "1"],
          "pointer-location": ["settings get system pointer_location", "1"],
        };
        const flags: Record<string, boolean | null> = {};
        for (const [flag, [command, on]] of Object.entries(reads)) {
          const raw = (await ctx.shell.run(command)).trim();
          flags[flag] = raw === on ? true : /^(0|false|1|)$/i.test(raw) ? false : null;
        }
        const scales = await Promise.all(["window_animation_scale", "transition_animation_scale", "animator_duration_scale"].map(async (key) => Number((await ctx.shell.run(`settings get global ${key}`)).trim())));
        flags["slow-animations"] = scales.every((scale) => scale === 5) ? true : scales.every((scale) => scale === 1) ? false : null;
        return { flags };
      }
      if (option == null) throw new ActionError("'option' is required", "bad_request");
      const enabled = bool(params, "enabled");
      if (enabled == null) throw new ActionError("'enabled' is required", "bad_request");
      ctx.record({ kind: "debug", action: option, summary: `Debug ${option} ${enabled ? "on" : "off"}`, details: { option, enabled } });
      await ctx.injector.setDebugFlag(option, enabled);
      return { option, enabled };
    },
  },
  {
    name: "theme",
    description: "Set device appearance: light or dark",
    params: { theme: { type: "string", description: "light | dark", required: true, enum: ["light", "dark"] } },
    async run(ctx, params) {
      const theme = oneOf(params, "theme", ["light", "dark"] as const, true)!;
      ctx.record({ kind: "theme", action: theme, summary: `Theme ${theme}` });
      await ctx.injector.setTheme(theme);
      return { theme };
    },
  },
  {
    name: "scroll",
    description: "Wheel-style scroll by a normalized delta around a point",
    params: {
      dx: { type: "number", description: "Horizontal delta (fraction of width)" },
      dy: { type: "number", description: "Vertical delta (fraction of height); positive scrolls content up" },
      x: { type: "number", description: "Pointer x 0..1 (default 0.5)" },
      y: { type: "number", description: "Pointer y 0..1 (default 0.5)" },
    },
    async run(ctx, params) {
      const dx = num(params, "dx") ?? 0;
      const dy = num(params, "dy") ?? 0;
      const x = num(params, "x", false, [0, 1]) ?? 0.5;
      const y = num(params, "y", false, [0, 1]) ?? 0.5;
      const screen = await ctx.displaySize();
      ctx.record({ kind: "scroll", action: "scroll", summary: "Scroll", details: { dx, dy, x, y } });
      await ctx.injector.scroll(dx, dy, screen.width, screen.height, x, y);
      return { dx, dy };
    },
  },
  {
    name: "memory-warning",
    description: "Ask the foreground app to trim memory (RUNNING_CRITICAL)",
    params: {},
    async run(ctx) {
      ctx.record({ kind: "memory", action: "memory-warning", summary: "Memory warning" });
      const packageName = await ctx.injector.memoryWarning();
      return { packageName };
    },
  },

  // ── Semantic targeting ─────────────────────────────────────────────────
  {
    name: "find",
    description: "Find UI elements by text / id / desc / class; returns bounds, centers, normalized coords",
    params: AX_QUERY_PARAMS,
    async run(ctx, params) {
      const query = axQueryFromParams(params);
      const screen = await ctx.displaySize();
      const result = findInAx(await ctx.ax(), query, screen);
      return { query, screen: result.screen, total: result.total, matches: result.matches };
    },
  },
  {
    name: "wait",
    description: "Wait until a UI element matching the query appears (or disappears with gone=true)",
    params: {
      ...AX_QUERY_PARAMS,
      timeoutMs: { type: "number", description: "Budget in ms (default 10000)" },
      intervalMs: { type: "number", description: "Poll interval in ms (default 500)" },
      gone: { type: "boolean", description: "Wait for the element to disappear instead" },
    },
    async run(ctx, params) {
      const query = axQueryFromParams(params);
      if (isEmptyQuery(query)) throw new ActionError("Provide a target (text / id / desc / class) to wait for", "bad_request");
      const timeoutMs = num(params, "timeoutMs", false, [0, 600_000]) ?? 10_000;
      const intervalMs = num(params, "intervalMs", false, [50, 60_000]) ?? 500;
      const gone = bool(params, "gone") === true;
      const screen = await ctx.displaySize();
      const result = await waitForAx(() => ctx.ax(), query, { timeoutMs, intervalMs, gone }, screen);
      ctx.record({
        kind: "wait",
        action: gone ? "gone" : "appear",
        summary: `Wait for ${describeQuery(query)}${gone ? " to disappear" : ""} — ${result.ok ? `ok in ${result.elapsedMs}ms` : `timed out after ${result.elapsedMs}ms`}`,
        details: { query, gone, timeoutMs, ok: result.ok, elapsedMs: result.elapsedMs },
        status: result.ok ? "ok" : "error",
      });
      return { query, gone, ...result };
    },
  },

  // ── Emulator: location / network / power / sensors ─────────────────────
  {
    name: "geo",
    description: "Set the emulator's GPS fix (latitude, longitude, optional altitude in metres)",
    emulatorOnly: true,
    params: {
      lat: { type: "number", description: "Latitude -90..90", required: true },
      lon: { type: "number", description: "Longitude -180..180", required: true },
      alt: { type: "number", description: "Altitude in metres" },
    },
    async run(ctx, params) {
      const lat = num(params, "lat", true, [-90, 90])!;
      const lon = num(params, "lon", true, [-180, 180])!;
      const alt = num(params, "alt");
      ctx.record({ kind: "geo", action: "fix", summary: `Location ${lat.toFixed(5)}, ${lon.toFixed(5)}`, details: { lat, lon, ...(alt != null ? { alt } : {}) } });
      // Console order is longitude, latitude.
      await ctx.emu(["geo", "fix", String(lon), String(lat), ...(alt != null ? [String(alt)] : [])]);
      return { lat, lon, ...(alt != null ? { alt } : {}) };
    },
  },
  {
    name: "network",
    description: "Set network conditions: speed / delay (emulator console), airplane / wifi / mobile data toggles. No params → current status.",
    params: {
      speed: { type: "string", description: `Link speed: ${NETWORK_SPEEDS.join(" | ")} or <up>:<down> kbps` },
      delay: { type: "string", description: `Latency: ${NETWORK_DELAYS.join(" | ")} or <min>:<max> ms` },
      airplane: { type: "boolean", description: "Airplane mode on/off" },
      wifi: { type: "boolean", description: "Wi-Fi on/off" },
      data: { type: "boolean", description: "Mobile data on/off" },
    },
    async run(ctx, params) {
      const speed = str(params, "speed");
      const delay = str(params, "delay");
      const airplane = bool(params, "airplane");
      const wifi = bool(params, "wifi");
      const data = bool(params, "data");
      const applied: Record<string, unknown> = {};
      if (speed != null) {
        if (!NETWORK_SPEEDS.includes(speed) && !/^\d+(:\d+)?$/.test(speed)) {
          throw new ActionError(`speed must be ${NETWORK_SPEEDS.join(" | ")} or <up>:<down>`, "bad_request");
        }
        await ctx.emu(["network", "speed", speed]);
        applied.speed = speed;
      }
      if (delay != null) {
        if (!NETWORK_DELAYS.includes(delay) && !/^\d+(:\d+)?$/.test(delay)) {
          throw new ActionError(`delay must be ${NETWORK_DELAYS.join(" | ")} or <min>:<max>`, "bad_request");
        }
        await ctx.emu(["network", "delay", delay]);
        applied.delay = delay;
      }
      if (airplane != null) {
        const r = await ctx.shell.runWithCode(`cmd connectivity airplane-mode ${airplane ? "enable" : "disable"}`);
        if (r.code !== 0) {
          await ctx.shell.run(
            `settings put global airplane_mode_on ${airplane ? 1 : 0}; am broadcast -a android.intent.action.AIRPLANE_MODE --ez state ${airplane}`,
          );
        }
        applied.airplane = airplane;
      }
      if (wifi != null) {
        await ctx.shell.run(`svc wifi ${wifi ? "enable" : "disable"}`);
        applied.wifi = wifi;
      }
      if (data != null) {
        await ctx.shell.run(`svc data ${data ? "enable" : "disable"}`);
        applied.data = data;
      }
      if (Object.keys(applied).length === 0) {
        const status = ctx.serial.startsWith("emulator-") ? await ctx.emu(["network", "status"]).catch(() => "") : "";
        const airplaneOn = (await ctx.shell.run("settings get global airplane_mode_on").catch(() => "0")).trim() === "1";
        const wifiOn = (await ctx.shell.run("settings get global wifi_on").catch(() => "0")).trim() === "1";
        const dataOn = (await ctx.shell.run("settings get global mobile_data").catch(() => "1")).trim() !== "0";
        return { airplane: airplaneOn, wifi: wifiOn, data: dataOn, ...(status ? { console: status } : {}) };
      }
      const summary = Object.entries(applied)
        .map(([k, v]) => `${k} ${typeof v === "boolean" ? (v ? "on" : "off") : v}`)
        .join(", ");
      ctx.record({ kind: "network", action: "set", summary: `Network ${summary}`, details: applied });
      return applied;
    },
  },
  {
    name: "battery",
    description: "Fake battery state: level 0..100, plugged (ac | usb | wireless | none), or reset to real values",
    params: {
      level: { type: "number", description: "Battery level 0..100" },
      plugged: { type: "string", description: "ac | usb | wireless | none", enum: ["ac", "usb", "wireless", "none"] },
      reset: { type: "boolean", description: "Restore real battery reporting" },
    },
    async run(ctx, params) {
      const level = num(params, "level", false, [0, 100]);
      const plugged = oneOf(params, "plugged", ["ac", "usb", "wireless", "none"] as const);
      const reset = bool(params, "reset") === true;
      const applied: Record<string, unknown> = {};
      if (reset) {
        await ctx.shell.run("dumpsys battery reset");
        applied.reset = true;
      }
      if (level != null) {
        await ctx.shell.run(`dumpsys battery set level ${Math.round(level)}`);
        applied.level = Math.round(level);
      }
      if (plugged != null) {
        if (plugged === "none") await ctx.shell.run("dumpsys battery unplug");
        else await ctx.shell.run(`dumpsys battery unplug; dumpsys battery set ${plugged} 1`);
        applied.plugged = plugged;
      }
      const state = parseBatteryDump(await ctx.shell.run("dumpsys battery"));
      if (Object.keys(applied).length > 0) {
        const bits = [
          applied.reset ? "reset" : null,
          applied.level != null ? `${applied.level}%` : null,
          applied.plugged != null ? (applied.plugged === "none" ? "unplugged" : `on ${applied.plugged}`) : null,
        ].filter(Boolean);
        ctx.record({ kind: "battery", action: "set", summary: `Battery ${bits.join(", ")}`, details: applied });
      }
      return { ...state, applied };
    },
  },
  {
    name: "fingerprint",
    description: "Touch (or remove) a fingerprint on the emulator's sensor — unblocks biometric prompts",
    emulatorOnly: true,
    params: {
      id: { type: "number", description: "Finger id (default 1)" },
      remove: { type: "boolean", description: "Lift/remove instead of touch" },
    },
    async run(ctx, params) {
      const id = Math.round(num(params, "id", false, [1, 10]) ?? 1);
      const remove = bool(params, "remove") === true;
      ctx.record({ kind: "fingerprint", action: remove ? "remove" : "touch", summary: `Fingerprint ${remove ? "remove" : "touch"} ${id}`, details: { id, remove } });
      await ctx.emu(["finger", remove ? "remove" : "touch", String(id)]);
      return { id, remove };
    },
  },
  {
    name: "call",
    description: "Simulate an incoming call (op: call | accept | end | hold) from a phone number",
    emulatorOnly: true,
    params: {
      number: { type: "string", description: "Phone number", required: true },
      op: { type: "string", description: "call | accept | end | hold (default call)", enum: ["call", "accept", "end", "hold"] },
    },
    async run(ctx, params) {
      const number = str(params, "number", true)!;
      if (!/^\+?[0-9*#]{1,32}$/.test(number)) throw new ActionError("number must be digits (optionally with leading +)", "bad_request");
      const op = oneOf(params, "op", ["call", "accept", "end", "hold"] as const, false, "call")!;
      const verb = op === "end" ? "cancel" : op;
      ctx.record({ kind: "call", action: op, summary: `Call ${op} ${number}`, details: { number, op } });
      await ctx.emu(["gsm", verb, number]);
      return { number, op };
    },
  },
  {
    name: "sms",
    description: "Deliver an incoming SMS from a phone number",
    emulatorOnly: true,
    params: {
      number: { type: "string", description: "Sender phone number", required: true },
      text: { type: "string", description: "Message body", required: true },
    },
    async run(ctx, params) {
      const number = str(params, "number", true)!;
      if (!/^\+?[0-9*#]{1,32}$/.test(number)) throw new ActionError("number must be digits (optionally with leading +)", "bad_request");
      const text = str(params, "text", true)!.replace(/\r?\n/g, " ");
      ctx.record({ kind: "sms", action: "send", summary: `SMS from ${number}: ${JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}…` : text)}`, details: { number, text } });
      await ctx.emu(["sms", "send", number, text]);
      return { number, text };
    },
  },

  // ── Accessibility / display knobs ──────────────────────────────────────
  {
    name: "font-scale",
    description: "Set the system font scale (1.0 = default; Android's Settings offers 0.85–2.0)",
    params: { scale: { type: "number", description: "Font scale, e.g. 1.3; omit to read current scale" } },
    async run(ctx, params) {
      const scale = num(params, "scale", false, [0.5, 3]);
      if (scale == null) {
        const raw = (await ctx.shell.run("settings get system font_scale")).trim();
        const current = raw === "null" || raw === "" ? 1 : Number(raw);
        if (!Number.isFinite(current) || current < 0.5 || current > 3) throw new ActionError("Could not read font scale");
        return { scale: current };
      }
      ctx.record({ kind: "a11y", action: "font-scale", summary: `Font scale ${scale}`, details: { scale } });
      await ctx.shell.run(`settings put system font_scale ${scale}`);
      return { scale };
    },
  },
  {
    name: "density",
    description: "Override the display density in dpi (or 'reset' to the device default)",
    params: { dpi: { type: "string", description: "Density in dpi, or 'reset'", required: true } },
    async run(ctx, params) {
      const raw = str(params, "dpi", true)!;
      if (raw !== "reset" && !(Number.isFinite(Number(raw)) && Number(raw) >= 72 && Number(raw) <= 1200)) {
        throw new ActionError("dpi must be a number (72–1200) or 'reset'", "bad_request");
      }
      ctx.record({ kind: "a11y", action: "density", summary: `Density ${raw}`, details: { dpi: raw } });
      const r = await ctx.shell.runWithCode(raw === "reset" ? "wm density reset" : `wm density ${Math.round(Number(raw))}`);
      if (r.code !== 0) throw new ActionError(r.out || "wm density failed");
      const out = await ctx.shell.run("wm density");
      return { dpi: raw, current: out };
    },
  },
  {
    name: "locale",
    description: "Set the locale. Default: per-app for the foreground app (Android 13+, no root). system=true sets the system locale (needs a rooted/non-Play image; otherwise saved for the next reboot).",
    params: {
      locale: { type: "string", description: "BCP-47 tag, e.g. fr-FR or ja-JP", required: true },
      package: { type: "string", description: "App to set the locale for (default: foreground app)" },
      system: { type: "boolean", description: "Set the system-wide locale instead" },
    },
    async run(ctx, params) {
      const locale = str(params, "locale", true)!;
      if (!/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(locale)) throw new ActionError(`'${locale}' is not a BCP-47 locale tag`, "bad_request");
      const tag = locale.replace(/_/g, "-");
      if (bool(params, "system")) {
        ctx.record({ kind: "a11y", action: "locale", summary: `System locale ${tag}`, details: { locale: tag, system: true } });
        const r = await ctx.shell.runWithCode(`setprop persist.sys.locale ${tag} && setprop ctl.restart zygote`);
        if (r.code === 0) return { locale: tag, scope: "system", applied: "now (zygote restarted)" };
        await ctx.shell.run(`settings put system system_locales ${tag}`);
        return {
          locale: tag,
          scope: "system",
          applied: "on next reboot",
          note: "Setting the live system locale needs root (`adb root` on a non-Play image). Saved for the next boot; or omit system=true to set a per-app locale on Android 13+.",
        };
      }
      const target = str(params, "package") ?? (await ctx.injector.foregroundApp())?.packageName;
      if (!target) throw new ActionError("No foreground app to set a locale for — pass 'package'", "not_found");
      ctx.record({ kind: "a11y", action: "locale", summary: `Locale ${tag} for ${target}`, details: { locale: tag, package: target } });
      const r = await ctx.shell.runWithCode(`cmd locale set-app-locales ${target} --locales ${tag}`);
      if (r.code !== 0 || /Unknown command|not found|Exception/i.test(r.out)) {
        throw new ActionError(`Per-app locales need Android 13+ (${r.out.trim() || "cmd locale unavailable"}); try system=true`, "unsupported");
      }
      return { locale: tag, scope: "app", package: target };
    },
  },
  {
    name: "talkback",
    description: "Turn the TalkBack screen reader on/off (needs a Google/Play image with TalkBack installed)",
    params: { enabled: { type: "boolean", description: "on/off; omit to read current state" } },
    async run(ctx, params) {
      const enabled = bool(params, "enabled");
      if (enabled == null) {
        const services = await ctx.shell.run("settings get secure enabled_accessibility_services");
        const active = (await ctx.shell.run("settings get secure accessibility_enabled")).trim() === "1";
        return { enabled: active && /talkback/i.test(services) };
      }
      ctx.record({ kind: "a11y", action: "talkback", summary: `TalkBack ${enabled ? "on" : "off"}`, details: { enabled } });
      if (!enabled) {
        const services=await ctx.shell.run("settings get secure enabled_accessibility_services");
        const remaining=services.trim().split(":").map(service=>service.trim()).filter(service=>service!=="null" && service && !/talkback/i.test(service));
        await ctx.shell.run(`settings put secure enabled_accessibility_services ${shellQuote(remaining.join(":"))}; settings put secure accessibility_enabled ${remaining.length?1:0}`);
        return { enabled: false };
      }
      const services = await ctx.shell.run("dumpsys accessibility 2>/dev/null | grep -io '[a-z0-9_.]*talkback[a-z0-9_.]*/[a-z0-9_.]*TalkBackService' | head -1");
      let component = services.trim().split("\n")[0]?.trim() ?? "";
      if (!component) {
        const pkgs = await ctx.shell.run("pm list packages | grep -i talkback | head -1");
        const p = pkgs.replace(/^package:/, "").trim();
        if (!p) throw new ActionError("TalkBack is not installed on this image (use a Google APIs / Play image)", "unsupported");
        component = `${p}/com.google.android.marvin.talkback.TalkBackService`;
      }
      const current=await ctx.shell.run("settings get secure enabled_accessibility_services");
      const merged=[...new Set([...current.trim().split(":").map(service=>service.trim()).filter(service=>service!=="null"&&service),component])];
      await ctx.shell.run(`settings put secure enabled_accessibility_services ${shellQuote(merged.join(":"))}; settings put secure accessibility_enabled 1`);
      return { enabled: true, service: component };
    },
  },

  {
    name: "high-contrast",
    description: "Enable Android high-contrast text; no params reads the current state",
    params: { enabled: { type: "boolean", description: "Enable high-contrast text" } },
    async run(ctx, params) {
      const enabled = bool(params, "enabled");
      if (enabled == null) {
        return { enabled: (await ctx.shell.run("settings get secure high_text_contrast_enabled")).trim() === "1" };
      }
      const result = await ctx.shell.runWithCode(`settings put secure high_text_contrast_enabled ${enabled ? 1 : 0}`);
      if (result.code !== 0) throw new ActionError(result.out.trim() || "Could not set high-contrast text");
      ctx.record({ kind: "a11y", action: "high-contrast", summary: `High-contrast text ${enabled ? "on" : "off"}`, details: { enabled } });
      return { enabled };
    },
  },

  // ── App lifecycle ──────────────────────────────────────────────────────
  {
    name: "install",
    description: "Install an APK from a path on the serve-avd host (adb install -r -g)",
    params: {
      path: { type: "string", description: "Path to the .apk on the host", required: true },
      launch: { type: "boolean", description: "Launch the app after installing (parses the package from the apk output when possible)" },
    },
    async run(ctx, params) {
      const path = str(params, "path", true)!;
      ctx.record({ kind: "app", action: "install", summary: `Install ${path}`, details: { path } });
      const out = await ctx.adb(["install", "-r", "-g", path], { timeout: 300_000 });
      if (/Failure/i.test(out)) throw new ActionError(out.trim());
      return { path, output: out.trim() };
    },
  },
  {
    name: "launch",
    description: "Launch an app by package name (its LAUNCHER activity) or an explicit package/Activity component",
    params: {
      package: { type: "string", description: "Package name, or package/.Activity component", required: true },
      wait: { type: "boolean", description: "Wait for the activity to be displayed (default true)" },
    },
    async run(ctx, params) {
      const raw = str(params, "package", true)!;
      const wait = bool(params, "wait") !== false;
      const w = wait ? "-W " : "";
      ctx.record({ kind: "app", action: "launch", summary: `Launch ${raw}`, details: { package: raw } });
      if (raw.includes("/")) {
        const r = await ctx.shell.runWithCode(`am start ${w}-n ${shellQuote(raw)}`);
        if (r.code !== 0 || /Error/i.test(r.out)) throw new ActionError(r.out.trim() || "am start failed");
        return { component: raw, output: r.out.trim() };
      }
      const name = pkg({ package: raw });
      const r = await ctx.shell.runWithCode(
        `comp=$(cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${name} 2>/dev/null | tail -n 1); ` +
          `case "$comp" in */*) am start ${w}-n "$comp" ;; *) monkey -p ${name} -c android.intent.category.LAUNCHER 1 ;; esac`,
      );
      if (r.code !== 0 || /Error|No activities found|monkey aborted/i.test(r.out)) {
        throw new ActionError(r.out.trim() || `Could not launch ${name} (is it installed?)`, "not_found");
      }
      const comp = /cmp=([^\s}]+)/.exec(r.out)?.[1] ?? null;
      return { package: name, ...(comp ? { component: comp } : {}), output: r.out.trim() };
    },
  },
  {
    name: "stop",
    description: "Force-stop an app",
    params: { package: { type: "string", description: "Package name", required: true } },
    async run(ctx, params) {
      const name = pkg(params);
      ctx.record({ kind: "app", action: "stop", summary: `Stop ${name}`, details: { package: name } });
      await ctx.shell.run(`am force-stop ${name}`);
      return { package: name };
    },
  },
  {
    name: "clear-data",
    description: "Clear an app's data (pm clear) — a fresh-install state without reinstalling",
    params: { package: { type: "string", description: "Package name", required: true } },
    async run(ctx, params) {
      const name = pkg(params);
      ctx.record({ kind: "app", action: "clear-data", summary: `Clear data ${name}`, details: { package: name } });
      const r = await ctx.shell.runWithCode(`pm clear ${name}`);
      if (!/Success/i.test(r.out)) throw new ActionError(r.out.trim() || `pm clear ${name} failed`, "not_found");
      return { package: name };
    },
  },
  {
    name: "uninstall",
    description: "Uninstall an app",
    params: { package: { type: "string", description: "Package name", required: true } },
    async run(ctx, params) {
      const name = pkg(params);
      ctx.record({ kind: "app", action: "uninstall", summary: `Uninstall ${name}`, details: { package: name } });
      const r = await ctx.shell.runWithCode(`pm uninstall ${name}`);
      if (!/Success/i.test(r.out)) throw new ActionError(r.out.trim() || `pm uninstall ${name} failed`, "not_found");
      return { package: name };
    },
  },
  {
    name: "open",
    description: "Open a URL or deep link (android.intent.action.VIEW)",
    params: {
      url: { type: "string", description: "http(s)://, myapp://… or any intent-resolvable URI", required: true },
      package: { type: "string", description: "Restrict to this package" },
    },
    async run(ctx, params) {
      const url = str(params, "url", true)!;
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) throw new ActionError("url must include a scheme, e.g. https://… or myapp://…", "bad_request");
      const target = str(params, "package");
      ctx.record({ kind: "app", action: "open", summary: `Open ${url}`, details: { url, ...(target ? { package: target } : {}) } });
      const r = await ctx.shell.runWithCode(
        `am start -W -a android.intent.action.VIEW -d ${shellQuote(url)}${target ? ` ${pkg({ package: target })}` : ""}`,
      );
      if (r.code !== 0 || /Error|No Activity found/i.test(r.out)) throw new ActionError(r.out.trim() || "No app can open that URL", "not_found");
      const comp = /cmp=([^\s}]+)/.exec(r.out)?.[1] ?? null;
      return { url, ...(comp ? { component: comp } : {}), output: r.out.trim() };
    },
  },
  {
    name: "apps",
    description: "List installed packages (third-party by default; all=true includes system apps)",
    params: { all: { type: "boolean", description: "Include system packages" } },
    async run(ctx, params) {
      const all = bool(params, "all") === true;
      const out = await ctx.shell.run(`pm list packages${all ? "" : " -3"}`);
      const packages = out
        .split("\n")
        .map((l) => l.trim().replace(/^package:/, ""))
        .filter(Boolean)
        .sort();
      return { packages, count: packages.length };
    },
  },

  // ── Snapshots ──────────────────────────────────────────────────────────
  {
    name: "snapshot",
    description: "Emulator snapshots: save | load | delete <name>, or list",
    emulatorOnly: true,
    params: {
      op: { type: "string", description: "save | load | delete | list", required: true, enum: ["save", "load", "delete", "list"] },
      name: { type: "string", description: "Snapshot name (required except for list)" },
    },
    async run(ctx, params) {
      const op = oneOf(params, "op", ["save", "load", "delete", "list"] as const, true)!;
      if (op === "list") {
        const out = await ctx.emu(["avd", "snapshot", "list"], { timeout: 30_000 });
        return { snapshots: parseSnapshotList(out), raw: out };
      }
      const name = str(params, "name", true)!;
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new ActionError("snapshot name: letters, digits, . _ - only", "bad_request");
      ctx.record({ kind: "snapshot", action: op, summary: `Snapshot ${op} ${name}`, details: { op, name } });
      await ctx.emu(["avd", "snapshot", op, name], { timeout: 180_000 });
      if (op === "load") {
        // Restoring VM state restarts adbd's connection; the device is briefly
        // unreachable. Wait until a fresh shell answers so the next command
        // (screenshot, tap…) doesn't land in that gap.
        const deadline = Date.now() + 30_000;
        let reachable = false;
        while (Date.now() < deadline) {
          try {
            const out = await ctx.adb(["shell", "getprop", "sys.boot_completed"], { timeout: 5_000 });
            if (out.trim().startsWith("1")) {
              reachable = true;
              break;
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 500));
        }
        ctx.onDisplayReset?.();
        return { op, name, reachable };
      }
      return { op, name };
    },
  },

  // ── Escape hatch ───────────────────────────────────────────────────────
  {
    name: "shell",
    description: "Run a shell command on the device and return its output",
    params: { cmd: { type: "string", description: "Command line (runs in the device's sh)", required: true } },
    async run(ctx, params) {
      const cmd = str(params, "cmd", true)!;
      ctx.record({ kind: "shell", action: "run", summary: `Shell ${cmd.length > 60 ? `${cmd.slice(0, 60)}…` : cmd}`, details: { cmd } });
      const r = await ctx.shell.runWithCode(cmd);
      return { code: r.code, output: r.out };
    },
  },
];

export const ACTIONS_BY_NAME: Record<string, ActionSpec> = Object.fromEntries(ACTIONS.map((a) => [a.name, a]));

export function actionNames(): string[] {
  return ACTIONS.map((a) => a.name);
}

/**
 * Run a named action. Throws `ActionError` for unknown names / bad params;
 * device failures propagate as plain errors. Failures are appended to the
 * event log with status "error".
 */
export async function runAction(ctx: ActionContext, name: string, params: ActionParams = {}): Promise<unknown> {
  const spec = ACTIONS_BY_NAME[name];
  if (!spec) throw new ActionError(`Unknown action '${name}'. Available: ${actionNames().join(", ")}`, "not_found");
  if (spec.emulatorOnly && !ctx.serial.startsWith("emulator-")) {
    throw new ActionError(`'${name}' needs an emulator (adb emu console) — ${ctx.serial} is a physical device`, "unsupported");
  }
  try {
    return await spec.run({ ...ctx, record(entry) { return ctx.record({ ...entry, details: { ...entry.details, replay: { action: name, params } } }); } }, params ?? {});
  } catch (err) {
    if (!(err instanceof ActionError && err.code === "bad_request")) {
      ctx.record({
        kind: spec.name,
        action: spec.name,
        summary: `${spec.name} failed: ${err instanceof Error ? err.message : String(err)}`,
        status: "error",
      });
    }
    throw err;
  }
}

// ── Output parsers (exported for tests) ────────────────────────────────────

export function parseBatteryDump(out: string): { level: number | null; plugged: string; status: string | null } {
  const level = /\blevel:\s*(\d+)/.exec(out);
  const ac = /AC powered:\s*true/i.test(out);
  const usb = /USB powered:\s*true/i.test(out);
  const wireless = /Wireless powered:\s*true/i.test(out);
  const status = /\bstatus:\s*(\d+)/.exec(out);
  const STATUS: Record<string, string> = { "1": "unknown", "2": "charging", "3": "discharging", "4": "not-charging", "5": "full" };
  return {
    level: level ? parseInt(level[1]!, 10) : null,
    plugged: ac ? "ac" : usb ? "usb" : wireless ? "wireless" : "none",
    status: status ? (STATUS[status[1]!] ?? status[1]!) : null,
  };
}

export function parseSnapshotList(out: string): Array<{ id: string; tag: string; size?: string; date?: string }> {
  const rows: Array<{ id: string; tag: string; size?: string; date?: string }> = [];
  let inTable = false;
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^ID\s+TAG\b/i.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (/^(OK|KO)\b/.test(line)) break;
    // `--  default_boot   79M 2026-07-31 14:08:08   01:01:36.414`
    const m = /^(\S+)\s+(\S+)(?:\s+(\S+))?(?:\s+(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}:\d{2})?))?/.exec(line);
    if (!m) continue;
    rows.push({ id: m[1]!, tag: m[2]!, ...(m[3] ? { size: m[3] } : {}), ...(m[4] ? { date: m[4] } : {}) });
  }
  return rows;
}
