/**
 * Event log → replayable script → device actions.
 *
 * `eventsToScript` distils the event log (whatever a human in the preview or an
 * agent over the API did) into a plain JSON list of timed steps that map 1:1
 * onto actions (see actions.ts). `runScript` plays a script back through any
 * DeviceDriver — the same code path the CLI, MCP tools and SDK use — so a
 * recorded session is a reproducible test.
 *
 * Taps carry both coordinates and, when the tap was targeted at a UI element,
 * the query that found it; replay prefers the query (survives layout shifts)
 * unless told to use coordinates.
 */
import type { EventLogEntry } from "./event-log";
import type { ActionParams } from "./actions";
import type { AxQuery } from "./ax";

export const REPLAY_SCRIPT_VERSION = 1;

export interface ReplayStep extends Record<string, unknown> {
  /** Milliseconds since the first step. */
  t: number;
  /** Action name (see actions.ts). */
  action: string;
}

export interface ReplayScript {
  version: number;
  /** Serial the recording came from (informational; replay targets whatever -d says). */
  device?: string;
  name?: string;
  recordedAt?: string;
  steps: ReplayStep[];
}

type Point = { x: number; y: number };

function point(v: unknown): Point | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  return typeof p.x === "number" && typeof p.y === "number" ? { x: p.x, y: p.y } : null;
}

/** Map one event-log entry to a step (sans timing), or null when it isn't replayable. */
export function eventToStep(entry: EventLogEntry): Omit<ReplayStep, "t"> | null {
  if (entry.status === "error") return null;
  const d = entry.details ?? {};
  switch (entry.kind) {
    case "tap": {
      const p = point(d.current) ?? point(d.start);
      if (!p) return null;
      const step: Record<string, unknown> = { action: "tap", x: round(p.x), y: round(p.y) };
      const target = d.target as AxQuery | undefined;
      if (target && typeof target === "object") step.target = target;
      if (typeof d.durationMs === "number" && d.durationMs > 0) step.durationMs = d.durationMs;
      return step as Omit<ReplayStep, "t">;
    }
    case "drag": {
      const from = point(d.start);
      const to = point(d.current);
      if (!from || !to) return null;
      const durationMs = typeof d.durationMs === "number" && d.durationMs > 0 ? Math.min(5_000, Math.max(50, Math.round(d.durationMs))) : 300;
      return { action: "swipe", x1: round(from.x), y1: round(from.y), x2: round(to.x), y2: round(to.y), durationMs };
    }
    case "text":
      return typeof d.text === "string" && d.text.length > 0 ? { action: "text", text: d.text } : null;
    case "key": {
      const code = (typeof d.code === "string" && d.code) || (typeof d.key === "string" && d.key) || null;
      if (code) return { action: "key", code };
      return typeof d.keycode === "number" ? { action: "key", keycode: d.keycode } : null;
    }
    case "button": {
      const button = (typeof d.button === "string" && d.button) || entry.action;
      return button ? { action: "button", button } : null;
    }
    case "rotate":
      return entry.action ? { action: "rotate", orientation: entry.action } : null;
    case "debug":
      return typeof d.option === "string" && typeof d.enabled === "boolean" ? { action: "debug", option: d.option, enabled: d.enabled } : null;
    case "theme":
      return entry.action === "light" || entry.action === "dark" ? { action: "theme", theme: entry.action } : null;
    case "scroll":
      return typeof d.dx === "number" && typeof d.dy === "number"
        ? { action: "scroll", dx: d.dx, dy: d.dy, ...(typeof d.x === "number" ? { x: d.x } : {}), ...(typeof d.y === "number" ? { y: d.y } : {}) }
        : null;
    case "memory":
      return { action: "memory-warning" };
    case "geo":
      return typeof d.lat === "number" && typeof d.lon === "number" ? { action: "geo", lat: d.lat, lon: d.lon, ...(typeof d.alt === "number" ? { alt: d.alt } : {}) } : null;
    case "network":
      return Object.keys(d).length ? { action: "network", ...d } : null;
    case "battery":
      return Object.keys(d).length ? { action: "battery", ...d } : null;
    case "fingerprint":
      return { action: "fingerprint", ...(typeof d.id === "number" ? { id: d.id } : {}), ...(d.remove ? { remove: true } : {}) };
    case "call":
      return typeof d.number === "string" ? { action: "call", number: d.number, op: typeof d.op === "string" ? d.op : "call" } : null;
    case "sms":
      return typeof d.number === "string" && typeof d.text === "string" ? { action: "sms", number: d.number, text: d.text } : null;
    case "a11y": {
      if (entry.action === "font-scale" && typeof d.scale === "number") return { action: "font-scale", scale: d.scale };
      if (entry.action === "density" && d.dpi != null) return { action: "density", dpi: String(d.dpi) };
      if (entry.action === "locale" && typeof d.locale === "string") {
        return { action: "locale", locale: d.locale, ...(typeof d.package === "string" ? { package: d.package } : {}), ...(d.system ? { system: true } : {}) };
      }
      if (entry.action === "talkback" && typeof d.enabled === "boolean") return { action: "talkback", enabled: d.enabled };
      return null;
    }
    case "app": {
      if (entry.action === "launch" && typeof d.package === "string") return { action: "launch", package: d.package };
      if (entry.action === "open" && typeof d.url === "string") return { action: "open", url: d.url, ...(typeof d.package === "string" ? { package: d.package } : {}) };
      if (entry.action === "stop" && typeof d.package === "string") return { action: "stop", package: d.package };
      if (entry.action === "clear-data" && typeof d.package === "string") return { action: "clear-data", package: d.package };
      if (entry.action === "install" && typeof d.path === "string") return { action: "install", path: d.path };
      return null;
    }
    case "snapshot":
      return typeof d.name === "string" && (d.op === "save" || d.op === "load") ? { action: "snapshot", op: d.op, name: d.name } : null;
    case "wait": {
      const query = d.query as AxQuery | undefined;
      if (!query || typeof query !== "object") return null;
      return { action: "wait", ...query, ...(d.gone ? { gone: true } : {}), ...(typeof d.timeoutMs === "number" ? { timeoutMs: d.timeoutMs } : {}) };
    }
    case "shell":
      return typeof d.cmd === "string" ? { action: "shell", cmd: d.cmd } : null;
    default:
      return null;
  }
}

/** Convert an event log (oldest first) into a script with relative timing. */
export function eventsToScript(events: EventLogEntry[], meta: { device?: string; name?: string } = {}): ReplayScript {
  const sorted = [...events].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id - b.id);
  const steps: ReplayStep[] = [];
  let origin: number | null = null;
  for (const entry of sorted) {
    const step = eventToStep(entry);
    if (!step) continue;
    const ts = Date.parse(entry.timestamp);
    if (origin == null) origin = Number.isFinite(ts) ? ts : 0;
    const t = Number.isFinite(ts) ? Math.max(0, ts - origin) : (steps[steps.length - 1]?.t ?? 0);
    steps.push({ t, ...step } as ReplayStep);
  }
  return {
    version: REPLAY_SCRIPT_VERSION,
    ...(meta.device ? { device: meta.device } : {}),
    ...(meta.name ? { name: meta.name } : {}),
    recordedAt: new Date().toISOString(),
    steps,
  };
}

/** Parse + validate a script file. Accepts a bare steps array too. */
export function parseScript(text: string): ReplayScript {
  const parsed = JSON.parse(text) as unknown;
  const script: ReplayScript = Array.isArray(parsed)
    ? { version: REPLAY_SCRIPT_VERSION, steps: parsed as ReplayStep[] }
    : (parsed as ReplayScript);
  if (!script || !Array.isArray(script.steps)) throw new Error("expected { steps: [...] } or an array of steps");
  let last = 0;
  script.steps = script.steps.map((raw, i) => {
    if (!raw || typeof raw !== "object" || typeof (raw as ReplayStep).action !== "string") {
      throw new Error(`step ${i} has no "action"`);
    }
    const t = typeof raw.t === "number" && Number.isFinite(raw.t) ? raw.t : last;
    last = t;
    return { ...raw, t } as ReplayStep;
  });
  return script;
}

// ── Playback ───────────────────────────────────────────────────────────────

export interface ReplayTarget {
  action(name: string, params?: ActionParams): Promise<unknown>;
}

export interface StepOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
  elapsedMs: number;
}

export interface RunScriptOptions {
  /** Time scale (2 = twice as fast). Default 1. */
  speed?: number;
  /** Honour recorded gaps between steps. Default true. */
  wait?: boolean;
  /** Replay taps by coordinates even when a target query was recorded. */
  preferCoords?: boolean;
  /** Stop at the first failed step. Default true. */
  stopOnError?: boolean;
  /** Cap on any single wait between steps (ms). Default 30s. */
  maxGapMs?: number;
  onStep?(index: number, step: ReplayStep, outcome: StepOutcome): void;
}

export interface RunScriptSummary {
  ok: number;
  failed: number;
  skipped: number;
}

/** Turn a step into action params (strips timing, resolves the tap target policy). */
export function stepToAction(step: ReplayStep, preferCoords = false): { name: string; params: ActionParams } {
  const { t: _t, action, ...rest } = step;
  if (action === "tap") {
    const { target, x, y, ...others } = rest as { target?: AxQuery; x?: number; y?: number } & Record<string, unknown>;
    if (target && !preferCoords) return { name: "tap", params: { ...others, ...target } };
    return { name: "tap", params: { ...others, x, y } };
  }
  return { name: action, params: rest };
}

export async function runScript(script: ReplayScript, target: ReplayTarget, options: RunScriptOptions = {}): Promise<RunScriptSummary> {
  const speed = options.speed && options.speed > 0 ? options.speed : 1;
  const wait = options.wait !== false;
  const stopOnError = options.stopOnError !== false;
  const maxGapMs = options.maxGapMs ?? 30_000;
  const summary: RunScriptSummary = { ok: 0, failed: 0, skipped: 0 };
  let prevT = script.steps[0]?.t ?? 0;
  let stopped = false;
  for (let i = 0; i < script.steps.length; i++) {
    const step = script.steps[i]!;
    if (stopped) {
      summary.skipped++;
      continue;
    }
    if (wait && i > 0) {
      const gap = Math.min(maxGapMs, Math.max(0, (step.t - prevT) / speed));
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    }
    prevT = step.t;
    const { name, params } = stepToAction(step, options.preferCoords);
    const started = Date.now();
    try {
      const result = await target.action(name, params);
      summary.ok++;
      options.onStep?.(i, step, { ok: true, result, elapsedMs: Date.now() - started });
    } catch (err) {
      summary.failed++;
      options.onStep?.(i, step, { ok: false, error: err instanceof Error ? err.message : String(err), elapsedMs: Date.now() - started });
      if (stopOnError) stopped = true;
    }
  }
  return summary;
}

function round(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}
