/**
 * Android key mapping: browser `KeyboardEvent.code` values → Android keycodes
 * (android.view.KeyEvent constants), hardware button names for the `button`
 * command / 0x04 messages, and text preparation for `input text`.
 */

/** Android keycodes by browser `KeyboardEvent.code`. */
const KEYCODE_BY_BROWSER_CODE: Record<string, number> = {
  Enter: 66,
  NumpadEnter: 160,
  Escape: 111,
  Backspace: 67,
  Delete: 112,
  Tab: 61,
  Space: 62,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Home: 122,
  End: 123,
  PageUp: 92,
  PageDown: 93,
  Insert: 124,
  CapsLock: 115,
  Minus: 69,
  Equal: 70,
  BracketLeft: 71,
  BracketRight: 72,
  Backslash: 73,
  Semicolon: 74,
  Quote: 75,
  Backquote: 68,
  Comma: 55,
  Period: 56,
  Slash: 76,
  AudioVolumeUp: 24,
  AudioVolumeDown: 25,
  AudioVolumeMute: 164,
  MediaPlayPause: 85,
  MediaTrackNext: 87,
  MediaTrackPrevious: 88,
};

for (let i = 0; i < 26; i++) {
  KEYCODE_BY_BROWSER_CODE[`Key${String.fromCharCode(65 + i)}`] = 29 + i; // KEYCODE_A..Z
}
for (let i = 0; i <= 9; i++) {
  KEYCODE_BY_BROWSER_CODE[`Digit${i}`] = 7 + i; // KEYCODE_0..9
  KEYCODE_BY_BROWSER_CODE[`Numpad${i}`] = 144 + i;
}
for (let i = 1; i <= 12; i++) {
  KEYCODE_BY_BROWSER_CODE[`F${i}`] = 130 + i; // KEYCODE_F1..F12
}

export function androidKeycodeForBrowserCode(code: string): number | null {
  return KEYCODE_BY_BROWSER_CODE[code] ?? null;
}

/**
 * Hardware/system buttons for `serve-emu button <name>` and browser toolbar
 * presses. Each maps to a keyevent, or a shell command for the few that have
 * no keycode (`cmd statusbar …`).
 */
export const BUTTONS: Record<string, { keycode?: number; shell?: string; label: string }> = {
  home: { keycode: 3, label: "Home" },
  back: { keycode: 4, label: "Back" },
  "app-switch": { keycode: 187, label: "App Switch" },
  recents: { keycode: 187, label: "App Switch" },
  overview: { keycode: 187, label: "App Switch" },
  power: { keycode: 26, label: "Power" },
  lock: { keycode: 223, label: "Sleep" },
  sleep: { keycode: 223, label: "Sleep" },
  wake: { keycode: 224, label: "Wake" },
  "volume-up": { keycode: 24, label: "Volume Up" },
  "volume-down": { keycode: 25, label: "Volume Down" },
  mute: { keycode: 164, label: "Mute" },
  menu: { keycode: 82, label: "Menu" },
  search: { keycode: 84, label: "Search" },
  camera: { keycode: 27, label: "Camera" },
  call: { keycode: 5, label: "Call" },
  "end-call": { keycode: 6, label: "End Call" },
  assistant: { keycode: 219, label: "Assistant" },
  "play-pause": { keycode: 85, label: "Play/Pause" },
  "dpad-up": { keycode: 19, label: "DPad Up" },
  "dpad-down": { keycode: 20, label: "DPad Down" },
  "dpad-left": { keycode: 21, label: "DPad Left" },
  "dpad-right": { keycode: 22, label: "DPad Right" },
  "dpad-center": { keycode: 23, label: "DPad Center" },
  notifications: { shell: "cmd statusbar expand-notifications", label: "Notifications" },
  "quick-settings": { shell: "cmd statusbar expand-settings", label: "Quick Settings" },
  "collapse-statusbar": { shell: "cmd statusbar collapse", label: "Collapse Status Bar" },
};

export function buttonNames(): string[] {
  return Object.keys(BUTTONS);
}

// ── Text input ─────────────────────────────────────────────────────────────

export class UnsupportedCharacterError extends Error {
  constructor(public readonly char: string) {
    super(`Unsupported character for 'input text': ${JSON.stringify(char)} (ASCII only)`);
  }
}

export type TextStep =
  | { kind: "text"; text: string }
  | { kind: "key"; keycode: number };

/**
 * Split arbitrary text into `input text` chunks plus keyevents for newline and
 * tab (which `input text` cannot express). Throws `UnsupportedCharacterError`
 * for anything outside printable ASCII — Android's `input text` only reliably
 * supports the ASCII range (matching serve-sim's "US keyboard only" behavior).
 */
export function textToSteps(text: string, chunkSize = 120): TextStep[] {
  const steps: TextStep[] = [];
  let current = "";
  const flush = () => {
    while (current.length > 0) {
      steps.push({ kind: "text", text: current.slice(0, chunkSize) });
      current = current.slice(chunkSize);
    }
  };
  for (const char of text.replace(/\r\n/g, "\n")) {
    if (char === "\n") {
      flush();
      steps.push({ kind: "key", keycode: 66 }); // KEYCODE_ENTER
    } else if (char === "\t") {
      flush();
      steps.push({ kind: "key", keycode: 61 }); // KEYCODE_TAB
    } else {
      const point = char.codePointAt(0)!;
      if (point < 0x20 || point > 0x7e) throw new UnsupportedCharacterError(char);
      current += char;
    }
  }
  flush();
  return steps;
}

/** Single-quote a string for the device-side mksh shell. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}
