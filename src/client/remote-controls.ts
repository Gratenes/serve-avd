/** TV controls use the existing named-button protocol, scoped to one device. */
export const REMOTE_BUTTONS = [
  ["dpad-up", "Up", "↑"],
  ["dpad-left", "Left", "←"],
  ["dpad-center", "Select", "OK"],
  ["dpad-right", "Right", "→"],
  ["dpad-down", "Down", "↓"],
  ["back", "Back", "Back"],
  ["home", "Home", "Home"],
  ["play-pause", "Play or pause", "Play / pause"],
  ["volume-down", "Volume down", "Vol −"],
  ["mute", "Mute", "Mute"],
  ["volume-up", "Volume up", "Vol +"],
  ["menu", "Menu", "Menu"],
  ["search", "Search", "Search"],
  ["power", "Power", "Power"],
] as const;

export type RemoteButton = (typeof REMOTE_BUTTONS)[number][0];

interface RemoteKey {
  code: string;
  repeat: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** Keep native button activation (Enter/Space) separate from TV shortcuts. */
export function remoteShortcut(event: RemoteKey, onButton: boolean): RemoteButton | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  switch (event.code) {
    case "ArrowUp": return "dpad-up";
    case "ArrowDown": return "dpad-down";
    case "ArrowLeft": return "dpad-left";
    case "ArrowRight": return "dpad-right";
    case "Escape": return "back";
    case "Enter":
    case "NumpadEnter": return onButton ? null : "dpad-center";
    default: return null;
  }
}

/** A disconnected/hidden remote drops commands; it never queues a replay. */
export class RemoteInput {
  connected = false;
  visible = false;

  constructor(private readonly send: (button: RemoteButton) => void) {}

  press(button: RemoteButton): void {
    if (this.connected && this.visible) this.send(button);
  }
}

let nextRemoteId = 0;

export class RemoteControls {
  readonly root = document.createElement("div");
  private readonly input: RemoteInput;
  private readonly buttons: HTMLButtonElement[] = [];
  private readonly status = document.createElement("p");

  constructor(deviceName: string, send: (button: RemoteButton) => void) {
    this.input = new RemoteInput(send);
    this.root.className = "tv-remote";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "btn tv-remote-toggle";
    toggle.textContent = "TV remote";
    toggle.setAttribute("aria-expanded", "false");

    const panel = document.createElement("div");
    panel.id = `tv-remote-${++nextRemoteId}`;
    panel.className = "tv-remote-panel";
    panel.hidden = true;
    panel.tabIndex = 0;
    panel.setAttribute("role", "group");
    panel.setAttribute("aria-label", `TV remote for ${deviceName}`);
    toggle.setAttribute("aria-controls", panel.id);
    toggle.setAttribute("aria-label", `TV remote for ${deviceName}`);

    const title = document.createElement("strong");
    title.textContent = deviceName;
    this.status.className = "tv-remote-status";
    this.status.setAttribute("role", "status");
    const hint = document.createElement("p");
    hint.className = "tv-remote-hint";
    hint.textContent = "Focus here to use arrow keys, Enter to select, and Esc to go back. Tab moves between controls.";
    const dpad = document.createElement("div");
    dpad.className = "tv-remote-dpad";
    const actions = document.createElement("div");
    actions.className = "tv-remote-actions";
    for (const [name, label, text] of REMOTE_BUTTONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `btn tv-remote-key tv-remote-${name}`;
      button.textContent = text;
      button.setAttribute("aria-label", label);
      button.addEventListener("click", () => this.input.press(name));
      this.buttons.push(button);
      (name.startsWith("dpad-") ? dpad : actions).append(button);
    }
    panel.append(title, this.status, dpad, actions, hint);
    this.root.append(toggle, panel);

    toggle.addEventListener("click", () => {
      this.input.visible = !this.input.visible;
      panel.hidden = !this.input.visible;
      toggle.setAttribute("aria-expanded", String(this.input.visible));
      if (this.input.visible) panel.focus();
    });
    panel.addEventListener("keydown", (event) => {
      const onButton = event.target instanceof HTMLButtonElement;
      const button = remoteShortcut(event, onButton);
      if (button) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) this.input.press(button);
      } else if (event.repeat && onButton && ["Enter", "NumpadEnter", "Space"].includes(event.code)) {
        // Hold/repeat is deliberately unsupported, especially for Power.
        event.preventDefault();
      }
    });
    this.setConnected(false);
  }

  setConnected(connected: boolean): void {
    this.input.connected = connected;
    for (const button of this.buttons) button.disabled = !connected;
    this.status.textContent = connected ? "Connected" : "Waiting for control connection…";
  }

  destroy(): void {
    this.input.visible = false;
    this.setConnected(false);
  }
}
