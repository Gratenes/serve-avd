/**
 * Input injection for one device, multiplexed over a persistent `adb shell`.
 *
 * Single-finger touch uses `input motionevent DOWN/MOVE/UP` when the device
 * supports it (Android 11+), giving live drags; older devices fall back to
 * replaying the gesture as `input tap`/`input swipe` on release. Two-finger
 * pinch has no `input` verb at all, so it's synthesized as raw evdev
 * multi-touch (protocol B) via `sendevent` chains against the emulator's
 * virtual touchscreen — probed, and skipped gracefully when unavailable.
 */
import { AdbShell, screenRotation } from "./adb";
import { BUTTONS } from "./keymap";
import { textToSteps, shellQuote, type TextStep } from "./keymap";
import { createDebug } from "./debug";

const debug = createDebug("input");

export const ORIENTATIONS: Record<string, number> = {
  portrait: 0,
  landscape_left: 1,
  portrait_upside_down: 2,
  landscape_right: 3,
};

export function orientationNameForRotation(rotation: number): string {
  return Object.keys(ORIENTATIONS).find((k) => ORIENTATIONS[k] === rotation) ?? "portrait";
}

/** Outcome of a rotation request — `applied` is false when the device refused. */
export interface RotateResult {
  requested: number;
  /** The rotation the display actually settled on. */
  rotation: number;
  applied: boolean;
}

// A honoured rotation lands in ~1s on an idle emulator but was measured as slow
// as 4.4s under load; a refused one never lands. Budget past the slow case —
// reporting "refused" for a rotation that was merely late is the worse error,
// and the session's own rotation poll surfaces a late one within a second
// regardless, so a generous budget costs the viewer nothing.
const ROTATION_SETTLE_MS = 6_000;
const ROTATION_POLL_MS = 150;

/** Android render/debug toggles (the ca-debug analog). */
export const DEBUG_FLAGS: Record<string, { on: string; off: string; refresh?: boolean }> = {
  overdraw: { on: "setprop debug.hwui.overdraw show", off: "setprop debug.hwui.overdraw false", refresh: true },
  "gpu-profile": {
    on: "setprop debug.hwui.profile visual_bars",
    off: "setprop debug.hwui.profile false",
    refresh: true,
  },
  "layout-bounds": { on: "setprop debug.layout true", off: "setprop debug.layout false", refresh: true },
  "show-taps": { on: "settings put system show_touches 1", off: "settings put system show_touches 0" },
  "pointer-location": {
    on: "settings put system pointer_location 1",
    off: "settings put system pointer_location 0",
  },
  "slow-animations": {
    on: "settings put global window_animation_scale 5; settings put global transition_animation_scale 5; settings put global animator_duration_scale 5",
    off: "settings put global window_animation_scale 1; settings put global transition_animation_scale 1; settings put global animator_duration_scale 1",
  },
};

// Poke the system server to re-read debug.* sysprops (SYSPROPS_TRANSACTION).
const SYSPROPS_REFRESH = "service call activity 1599295570 >/dev/null";

export interface ForegroundApp {
  packageName: string;
  activity?: string;
  pid?: number;
}

interface MultiTouchDevice {
  path: string;
  maxX: number;
  maxY: number;
  hasBtnTouch: boolean;
}

interface ActiveTouch {
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  startedAt: number;
  moved: boolean;
}

export class InputInjector {
  private motioneventSupported: Promise<boolean> | null = null;
  private mtDevice: Promise<MultiTouchDevice | null> | null = null;
  private touch: ActiveTouch | null = null;
  private moveInFlight = false;
  private queuedMove: { x: number; y: number } | null = null;
  private pinchActive = false;

  constructor(
    public readonly serial: string,
    private readonly shell: AdbShell,
    /** Current rotation supplier — pinch coords must be mapped into the natural panel space. */
    private readonly rotation: () => number,
  ) {}

  // ── Capability probes ────────────────────────────────────────────────────

  private supportsMotionevent(): Promise<boolean> {
    if (!this.motioneventSupported) {
      this.motioneventSupported = this.shell
        .run("input 2>&1 | grep -c motionevent")
        .then((out) => parseInt(out, 10) > 0)
        .catch(() => false);
      void this.motioneventSupported.then((ok) => debug(`motionevent supported: ${ok}`));
    }
    return this.motioneventSupported;
  }

  private multiTouchDevice(): Promise<MultiTouchDevice | null> {
    if (!this.mtDevice) {
      this.mtDevice = this.shell
        .run("getevent -p 2>&1")
        .then(async (out) => {
          const device = parseMultiTouchDevice(out);
          if (!device) return null;
          // Confirm we may *write* — on Play-store images /dev/input is
          // SELinux-protected and pinch cannot be synthesized without root.
          const probe = await this.shell.runWithCode(`sendevent ${device.path} 0 0 0`);
          return probe.code === 0 ? device : null;
        })
        .catch(() => null);
      void this.mtDevice.then((d) => debug("multi-touch device:", d));
    }
    return this.mtDevice;
  }

  // ── Single-finger touch ──────────────────────────────────────────────────

  /**
   * Handle a normalized (0..1, display-space) touch phase. `width`/`height`
   * are the current rotated display dimensions.
   */
  async touchEvent(type: "begin" | "move" | "end", x: number, y: number, width: number, height: number): Promise<void> {
    const px = Math.round(clamp01(x) * (width - 1));
    const py = Math.round(clamp01(y) * (height - 1));

    if (type === "begin") {
      this.touch = { startX: px, startY: py, lastX: px, lastY: py, startedAt: Date.now(), moved: false };
      if (await this.supportsMotionevent()) {
        await this.shell.run(`input motionevent DOWN ${px} ${py}`);
      }
      return;
    }

    const touch = this.touch;
    if (!touch) return;

    if (type === "move") {
      touch.lastX = px;
      touch.lastY = py;
      if (Math.hypot(px - touch.startX, py - touch.startY) > 10) touch.moved = true;
      if (!(await this.supportsMotionevent())) return; // gesture replays on end
      // Coalesce: never queue more than the latest move behind the in-flight one.
      if (this.moveInFlight) {
        this.queuedMove = { x: px, y: py };
        return;
      }
      this.moveInFlight = true;
      try {
        let next: { x: number; y: number } | null = { x: px, y: py };
        while (next) {
          await this.shell.run(`input motionevent MOVE ${next.x} ${next.y}`);
          next = this.queuedMove;
          this.queuedMove = null;
        }
      } finally {
        this.moveInFlight = false;
      }
      return;
    }

    // end
    this.touch = null;
    this.queuedMove = null;
    if (await this.supportsMotionevent()) {
      await this.shell.run(`input motionevent UP ${px} ${py}`);
      return;
    }
    // Fallback: replay the whole gesture now.
    const duration = Date.now() - touch.startedAt;
    if (!touch.moved && duration < 400) {
      await this.shell.run(`input tap ${touch.startX} ${touch.startY}`);
    } else {
      const dur = Math.max(60, Math.min(duration, 1_500));
      await this.shell.run(`input swipe ${touch.startX} ${touch.startY} ${px} ${py} ${dur}`);
    }
  }

  /** Atomic tap at display pixels (`input tap`). */
  async tap(px: number, py: number): Promise<void> {
    await this.shell.run(`input tap ${Math.round(px)} ${Math.round(py)}`);
  }

  /** Long-press: a zero-distance swipe held for `durationMs`. */
  async longPress(px: number, py: number, durationMs: number): Promise<void> {
    const x = Math.round(px);
    const y = Math.round(py);
    await this.shell.run(`input swipe ${x} ${y} ${x} ${y} ${Math.max(1, Math.round(durationMs))}`);
  }

  /** Swipe between display pixels over `durationMs`. */
  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 300): Promise<void> {
    await this.shell.run(
      `input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${Math.max(1, Math.round(durationMs))}`,
    );
  }

  /** Mouse-wheel scroll: a short inverted swipe around the pointer. */
  async scroll(dx: number, dy: number, width: number, height: number, atX = 0.5, atY = 0.5): Promise<void> {
    const cx = Math.round(clamp01(atX) * width);
    const cy = Math.round(clamp01(atY) * height);
    // Wheel-down (positive dy) scrolls content up: finger moves up.
    const tx = Math.round(clamp(cx - dx * width, 0, width - 1));
    const ty = Math.round(clamp(cy - dy * height, 0, height - 1));
    if (tx === cx && ty === cy) return;
    await this.shell.run(`input swipe ${cx} ${cy} ${tx} ${ty} 100`);
  }

  // ── Two-finger pinch (raw evdev) ─────────────────────────────────────────

  /**
   * Pinch with fingers at normalized display points (x1,y1)/(x2,y2). Uses the
   * virtual multi-touch panel; silently no-ops (returning false) when the
   * device can't be driven this way.
   */
  async multiTouch(
    type: "begin" | "move" | "end",
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): Promise<boolean> {
    const device = await this.multiTouchDevice();
    if (!device) return false;

    const a = this.toPanel(x1, y1, device);
    const b = this.toPanel(x2, y2, device);
    const events: string[] = [];
    const ev = (etype: number, code: number, value: number) =>
      events.push(`sendevent ${device.path} ${etype} ${code} ${value}`);

    const ABS = 3, KEY = 1, SYN = 0;
    const MT_SLOT = 47, MT_TRACKING_ID = 57, MT_X = 53, MT_Y = 54, BTN_TOUCH = 330;

    if (type === "begin") {
      if (this.pinchActive) return true;
      this.pinchActive = true;
      ev(ABS, MT_SLOT, 0);
      ev(ABS, MT_TRACKING_ID, 9001);
      ev(ABS, MT_X, a.x);
      ev(ABS, MT_Y, a.y);
      ev(ABS, MT_SLOT, 1);
      ev(ABS, MT_TRACKING_ID, 9002);
      ev(ABS, MT_X, b.x);
      ev(ABS, MT_Y, b.y);
      if (device.hasBtnTouch) ev(KEY, BTN_TOUCH, 1);
    } else if (type === "move") {
      if (!this.pinchActive) return true;
      ev(ABS, MT_SLOT, 0);
      ev(ABS, MT_X, a.x);
      ev(ABS, MT_Y, a.y);
      ev(ABS, MT_SLOT, 1);
      ev(ABS, MT_X, b.x);
      ev(ABS, MT_Y, b.y);
    } else {
      if (!this.pinchActive) return true;
      this.pinchActive = false;
      ev(ABS, MT_SLOT, 0);
      ev(ABS, MT_TRACKING_ID, -1);
      ev(ABS, MT_SLOT, 1);
      ev(ABS, MT_TRACKING_ID, -1);
      if (device.hasBtnTouch) ev(KEY, BTN_TOUCH, 0);
    }
    ev(SYN, 0, 0);

    const result = await this.shell.runWithCode(events.join("; "));
    if (result.code !== 0) {
      debug(`pinch sendevent failed: ${result.out}`);
      this.pinchActive = false;
      return false;
    }
    return true;
  }

  /** Map a normalized display-space point into raw panel coordinates (natural orientation). */
  private toPanel(x: number, y: number, device: MultiTouchDevice): { x: number; y: number } {
    const [nx, ny] = displayToNatural(clamp01(x), clamp01(y), this.rotation());
    return { x: Math.round(nx * device.maxX), y: Math.round(ny * device.maxY) };
  }

  // ── Keys / buttons / text ────────────────────────────────────────────────

  async keyevent(keycode: number, longPress = false): Promise<void> {
    await this.shell.run(`input keyevent ${longPress ? "--longpress " : ""}${keycode}`);
  }

  /** Press a named button. Throws on unknown names (caller reports valid ones). */
  async button(name: string): Promise<void> {
    const button = BUTTONS[name];
    if (!button) throw new Error(`Unknown button '${name}'`);
    if (button.keycode != null) await this.keyevent(button.keycode);
    else if (button.shell) await this.shell.run(button.shell);
  }

  async text(text: string): Promise<void> {
    const steps = textToSteps(text);
    await this.runTextSteps(steps);
  }

  private async runTextSteps(steps: TextStep[]): Promise<void> {
    for (const step of steps) {
      if (step.kind === "text") {
        await this.shell.run(`input text ${shellQuote(step.text)}`);
      } else {
        await this.keyevent(step.keycode);
      }
    }
  }

  // ── Device state ─────────────────────────────────────────────────────────

  /**
   * Request a display rotation and report what the device actually did.
   *
   * `wm user-rotation lock` exits 0 whether or not the window manager honours
   * the request — an orientation-locked foreground app (the launcher, most
   * games) pins the display, exactly like hardware rotation. And when it *is*
   * honoured the new rotation lands a beat later, not synchronously. So the
   * request is confirmed by reading the rotation back: assuming it took mis-
   * sizes the capture and the touch mapping until the next poll corrects it.
   */
  async rotate(orientation: string): Promise<RotateResult> {
    const requested = ORIENTATIONS[orientation];
    if (requested == null) {
      throw new Error(
        `Unknown orientation '${orientation}' (expected ${Object.keys(ORIENTATIONS).join(" | ")})`,
      );
    }
    // `wm user-rotation lock` reliably re-evaluates the window manager on
    // modern Android; raw settings writes don't always.
    const result = await this.shell.runWithCode(`wm user-rotation lock ${requested}`);
    if (result.code !== 0) {
      await this.shell.run(
        `settings put system accelerometer_rotation 0; settings put system user_rotation ${requested}`,
      );
    }
    const rotation = await this.awaitRotation(requested);
    const applied = rotation === requested;
    if (!applied) debug(`rotation ${requested} refused for ${this.serial} (still ${rotation})`);
    return { requested, rotation, applied };
  }

  /** Poll the real rotation until it reaches `target` or the budget runs out. */
  private async awaitRotation(target: number): Promise<number> {
    const deadline = Date.now() + ROTATION_SETTLE_MS;
    for (;;) {
      const rotation = await screenRotation(this.serial, this.shell);
      if (rotation === target || Date.now() >= deadline) return rotation;
      await new Promise((resolve) => setTimeout(resolve, ROTATION_POLL_MS));
    }
  }

  async setDebugFlag(option: string, enabled: boolean): Promise<void> {
    const flag = DEBUG_FLAGS[option];
    if (!flag) {
      throw new Error(`Unknown debug option '${option}' (expected ${Object.keys(DEBUG_FLAGS).join(" | ")})`);
    }
    const cmd = enabled ? flag.on : flag.off;
    await this.shell.run(flag.refresh ? `${cmd}; ${SYSPROPS_REFRESH}` : cmd);
  }

  async foregroundApp(): Promise<ForegroundApp | null> {
    const out = await this.shell.run(
      "dumpsys activity activities 2>/dev/null | grep -E 'topResumedActivity|mResumedActivity' | head -1",
    );
    const match = /([A-Za-z][A-Za-z0-9_.]*)\/(\.?[A-Za-z0-9_.$]*)/.exec(out);
    if (!match) return null;
    const app: ForegroundApp = { packageName: match[1]!, activity: match[2] };
    try {
      const pid = parseInt(await this.shell.run(`pidof -s ${app.packageName}`), 10);
      if (Number.isFinite(pid)) app.pid = pid;
    } catch {}
    return app;
  }

  /** Ask the foreground app to trim memory as if the system were critical. */
  async memoryWarning(): Promise<string> {
    const app = await this.foregroundApp();
    if (!app) throw new Error("Could not determine the foreground app");
    const result = await this.shell.runWithCode(`am send-trim-memory ${app.packageName} RUNNING_CRITICAL`);
    if (result.code !== 0) throw new Error(result.out || "am send-trim-memory failed");
    return app.packageName;
  }

  /** Toggle the soft keyboard's show-with-hardware-keyboard setting. */
  async toggleSoftwareKeyboard(): Promise<boolean> {
    const current = await this.shell.run("settings get secure show_ime_with_hard_keyboard");
    const next = current.trim() === "1" ? 0 : 1;
    await this.shell.run(`settings put secure show_ime_with_hard_keyboard ${next}`);
    return next === 1;
  }

  async setTheme(theme: "light" | "dark"): Promise<void> {
    await this.shell.run(`cmd uimode night ${theme === "dark" ? "yes" : "no"}`);
  }

  async wake(): Promise<void> {
    await this.keyevent(224); // KEYCODE_WAKEUP
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/**
 * Map a normalized display-space point to normalized natural-panel space for
 * the given rotation (Surface.ROTATION_0..3).
 */
export function displayToNatural(x: number, y: number, rotation: number): [number, number] {
  switch (rotation & 3) {
    case 1:
      return [1 - y, x];
    case 2:
      return [1 - x, 1 - y];
    case 3:
      return [y, 1 - x];
    default:
      return [x, y];
  }
}

/**
 * Parse `getevent -p` output and pick the multi-touch panel: the device with
 * ABS_MT_POSITION_X/Y (0035/0036), preferring names that look like the
 * emulator's virtual touchscreen.
 */
export function parseMultiTouchDevice(output: string): MultiTouchDevice | null {
  interface Candidate extends MultiTouchDevice {
    name: string;
  }
  const candidates: Candidate[] = [];
  let path: string | null = null;
  let name = "";
  let maxX = -1;
  let maxY = -1;
  let hasBtnTouch = false;
  const flush = () => {
    if (path && maxX > 0 && maxY > 0) candidates.push({ path, name, maxX, maxY, hasBtnTouch });
    name = "";
    maxX = -1;
    maxY = -1;
    hasBtnTouch = false;
  };
  for (const line of output.split("\n")) {
    const deviceMatch = /^add device \d+:\s*(\S+)/.exec(line.trim());
    if (deviceMatch) {
      flush();
      path = deviceMatch[1]!;
      continue;
    }
    const nameMatch = /name:\s*"(.*)"/.exec(line);
    if (nameMatch) name = nameMatch[1]!;
    const absMatch = /^\s*(0035|0036)\s*:\s*value \S+, min \S+, max (\d+)/.exec(line);
    if (absMatch) {
      const max = parseInt(absMatch[2]!, 10);
      if (absMatch[1] === "0035") maxX = max;
      else maxY = max;
    }
    if (/\b014a\b/.test(line)) hasBtnTouch = true;
  }
  flush();
  if (candidates.length === 0) return null;
  const preferred =
    candidates.find((c) => /multi[-_ ]?touch/i.test(c.name)) ??
    candidates.find((c) => /touch/i.test(c.name)) ??
    candidates[0]!;
  return { path: preferred.path, maxX: preferred.maxX, maxY: preferred.maxY, hasBtnTouch: preferred.hasBtnTouch };
}
