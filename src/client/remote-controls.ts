/** TV controls use the existing named-button protocol. The workspace owns routing. */
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
  ["app-switch", "Recent apps", "Recents"],
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

const GLYPHS: Partial<Record<RemoteButton, string>> = {
  "dpad-up": '<path d="m6 15 6-6 6 6"/>',
  "dpad-down": '<path d="m6 9 6 6 6-6"/>',
  "dpad-left": '<path d="m15 6-6 6 6 6"/>',
  "dpad-right": '<path d="m9 6 6 6-6 6"/>',
  back: '<path d="m9 14-5-5 5-5M4 9h10a6 6 0 0 1 0 12h-3"/>',
  home: '<path d="m3 11 9-7 9 7v9H3z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  "play-pause": '<path d="m4 5 9 7-9 7zM16 5v14M20 5v14"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
  "app-switch": '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  mute: '<path d="M4 9h4l5-4v14l-5-4H4zM17 9l4 6M21 9l-4 6"/>',
  power: '<path d="M12 3v9M18.4 6.6a9 9 0 1 1-12.8 0"/>',
  "volume-down": '<path d="M5 12h14"/>',
  "volume-up": '<path d="M5 12h14M12 5v14"/>',
};

function symbol(markup: string): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = markup; // Only static, local icon markup reaches this helper.
  return svg;
}

let nextRemoteId = 0;

/** One floating controller; command routing always follows the workspace target. */
export class WorkspaceRemote {
  readonly root = document.createElement("div");
  private readonly input: RemoteInput;
  private readonly buttons: HTMLButtonElement[] = [];
  private readonly target = document.createElement("button");
  private readonly targetName = document.createElement("span");
  private readonly status = document.createElement("span");
  private readonly panel = document.createElement("div");
  private readonly grip = document.createElement("button");
  private readonly collapse = document.createElement("button");
  private readonly macroRecord = document.createElement("button");
  private readonly macroRun = document.createElement("button");
  private readonly resizeObserver: ResizeObserver;
  private observedHost: HTMLElement | null = null;
  private readonly mobile = window.matchMedia("(max-width: 700px), (pointer: coarse) and (max-height: 500px)");
  private visible = true;
  private expanded = true;
  private destroyed = false;
  private position: { x: number; y: number } | null = null;
  private drag: { id: number; x: number; y: number; left: number; top: number } | null = null;

  constructor(send: (button: RemoteButton) => void, cycleTarget: () => void) {
    this.input = new RemoteInput(send);
    this.input.visible = true;
    this.root.className = "workspace-remote";
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", "TV remote");
    const header = document.createElement("div");
    header.className = "workspace-remote-header";
    this.grip.type = this.target.type = this.collapse.type = "button";
    this.grip.className = "workspace-remote-grip";
    this.grip.setAttribute("aria-label", "Move remote. Drag or use arrow keys; Home resets position");
    this.grip.title = "Drag to move · arrows to move · double-click to re-dock";
    this.grip.append(symbol('<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>'));
    this.target.className = "workspace-remote-target";
    this.targetName.className = "workspace-remote-target-name";
    this.status.className = "workspace-remote-status";
    this.status.setAttribute("aria-hidden", "true");
    this.target.append(this.status, this.targetName, symbol('<path d="m7 9 5-5 5 5m-10 6 5 5 5-5"/>'));
    this.target.addEventListener("click", () => { if (!this.destroyed) cycleTarget(); });
    this.collapse.className = "workspace-remote-collapse";
    this.collapse.append(symbol('<path d="m6 9 6 6 6-6"/>'));
    this.collapse.addEventListener("click", () => {
      this.expanded = !this.expanded;
      this.updateExpanded();
      this.clampPosition();
    });
    header.append(this.grip, this.target, this.collapse);

    this.panel.id = `workspace-remote-panel-${++nextRemoteId}`;
    this.panel.className = "workspace-remote-panel";
    this.panel.tabIndex = 0;
    this.panel.setAttribute("role", "group");
    this.collapse.setAttribute("aria-controls", this.panel.id);
    const dpad = document.createElement("div");
    dpad.className = "workspace-remote-dpad";
    const navigation = document.createElement("div");
    navigation.className = "workspace-remote-navigation";
    const volume = document.createElement("div");
    volume.className = "workspace-remote-volume";
    const bottom = document.createElement("div");
    bottom.className = "workspace-remote-bottom";
    const makeButton = (name: RemoteButton) => {
      const [, label, text] = REMOTE_BUTTONS.find(([button]) => button === name)!;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `workspace-remote-key workspace-remote-${name}`;
      button.title = label;
      button.setAttribute("aria-label", label);
      const glyph = GLYPHS[name];
      if (glyph) button.append(symbol(glyph));
      else button.textContent = text;
      button.addEventListener("click", () => this.input.press(name));
      this.buttons.push(button);
      return button;
    };
    for (const name of ["dpad-up", "dpad-left", "dpad-center", "dpad-right", "dpad-down"] as const) dpad.append(makeButton(name));
    for (const name of ["back", "home", "menu", "play-pause", "search", "app-switch"] as const) navigation.append(makeButton(name));
    for (const name of ["volume-down", "mute", "volume-up"] as const) volume.append(makeButton(name));
    bottom.append(volume, makeButton("power"));
    const hint = document.createElement("p");
    hint.className = "workspace-remote-hint";
    hint.textContent = "Arrows · Enter · Esc work while the remote has focus";
    const macros = document.createElement("div");
    macros.className = "workspace-remote-macros";
    this.macroRecord.type = this.macroRun.type = "button";
    this.macroRecord.className = this.macroRun.className = "btn small";
    this.macroRecord.textContent = "● Record macro";
    this.macroRecord.setAttribute("aria-label", "Record macro");
    this.macroRecord.setAttribute("aria-pressed", "false");
    this.macroRun.textContent = "Run macro…";
    this.macroRun.setAttribute("aria-label", "Run macro");
    macros.append(this.macroRecord, this.macroRun);
    this.panel.append(dpad, navigation, bottom, macros, hint);
    this.root.append(header, this.panel);
    this.panel.addEventListener("keydown", (event) => {
      const onButton = event.target instanceof HTMLButtonElement;
      const button = remoteShortcut(event, onButton);
      if (button) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) this.input.press(button);
      } else if (event.repeat && onButton && ["Enter", "NumpadEnter", "Space"].includes(event.code)) {
        event.preventDefault();
      }
    });
    this.bindMovement();
    this.resizeObserver = new ResizeObserver(() => {
      // Rail/inspector toggles resize the stage without resizing the window.
      const host = this.root.parentElement;
      if (host !== this.observedHost) {
        if (this.observedHost) this.resizeObserver.unobserve(this.observedHost);
        this.observedHost = host;
        if (host) this.resizeObserver.observe(host);
      }
      this.clampPosition();
    });
    this.resizeObserver.observe(this.root);
    this.mobile.addEventListener("change", this.onLayoutChange);
    window.addEventListener("resize", this.onLayoutChange);
    this.updateExpanded();
    this.setTarget("No device selected", false);
  }

  setMacroActions(record: () => void, run: () => void): void {
    this.macroRecord.addEventListener("click", () => { if (!this.destroyed) record(); });
    this.macroRun.addEventListener("click", () => { if (!this.destroyed) run(); });
  }

  setMacroRecording(active: boolean, steps: number): void {
    this.macroRecord.textContent = active ? `Stop · ${steps} steps` : "● Record macro";
    this.macroRecord.setAttribute("aria-label", active ? "Stop and save macro" : "Record macro");
    this.macroRecord.setAttribute("aria-pressed", String(active));
    this.macroRecord.classList.toggle("is-recording", active);
  }

  setTarget(name: string, connected: boolean): void {
    this.input.connected = connected && !this.destroyed;
    this.targetName.textContent = name;
    this.target.title = `${name} · ${connected ? "Connected" : "Disconnected"} · Switch target device`;
    this.target.setAttribute("aria-label", `Switch target device. Current target: ${name}. ${connected ? "Connected" : "Disconnected"}`);
    this.panel.setAttribute("aria-label", `TV remote for ${name}`);
    this.root.classList.toggle("is-connected", this.input.connected);
    for (const button of this.buttons) button.disabled = !this.input.connected;
  }

  setVisible(visible: boolean): void {
    this.visible = visible && !this.destroyed;
    this.root.hidden = !this.visible;
    this.input.visible = this.visible && this.expanded;
    if (!this.visible) this.endDrag();
    else this.clampPosition();
  }

  private updateExpanded(): void {
    this.panel.hidden = !this.expanded;
    this.input.visible = this.visible && this.expanded && !this.destroyed;
    this.collapse.setAttribute("aria-expanded", String(this.expanded));
    this.collapse.setAttribute("aria-label", this.expanded ? "Collapse remote" : "Expand remote");
    this.root.classList.toggle("is-collapsed", !this.expanded);
  }

  private origin(): { x: number; y: number } {
    const host = this.root.offsetParent as HTMLElement | null;
    const rect = this.root.getBoundingClientRect();
    const parent = host?.getBoundingClientRect();
    return {
      x: rect.left - (parent?.left ?? 0) - (host?.clientLeft ?? 0) + (host?.scrollLeft ?? 0),
      y: rect.top - (parent?.top ?? 0) - (host?.clientTop ?? 0) + (host?.scrollTop ?? 0),
    };
  }

  private move(x: number, y: number): void {
    if (this.mobile.matches || this.destroyed) return;
    const host = this.root.offsetParent as HTMLElement | null;
    if (!host) return;
    // Positions are in the host's scrollable content coordinates. Clamp against
    // its visible scrollport, not the unscrolled origin, to avoid drag jumps.
    const minX = host.scrollLeft + 8;
    const minY = host.scrollTop + 8;
    const maxX = Math.max(minX, host.scrollLeft + host.clientWidth - this.root.offsetWidth - 8);
    const maxY = Math.max(minY, host.scrollTop + host.clientHeight - this.root.offsetHeight - 8);
    this.position = { x: Math.min(maxX, Math.max(minX, x)), y: Math.min(maxY, Math.max(minY, y)) };
    this.root.style.left = `${this.position.x}px`;
    this.root.style.top = `${this.position.y}px`;
    this.root.style.right = "auto";
    this.root.style.bottom = "auto";
  }

  private clampPosition(): void {
    if (this.position && this.visible) this.move(this.position.x, this.position.y);
  }

  private resetPosition(): void {
    this.position = null;
    this.root.style.removeProperty("left");
    this.root.style.removeProperty("top");
    this.root.style.removeProperty("right");
    this.root.style.removeProperty("bottom");
  }

  private readonly onLayoutChange = () => {
    this.endDrag();
    if (this.mobile.matches) this.resetPosition();
    else this.clampPosition();
  };

  private bindMovement(): void {
    this.grip.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || this.drag || this.mobile.matches) return;
      event.preventDefault();
      this.grip.focus();
      const origin = this.origin();
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: origin.x, top: origin.y };
      this.grip.setPointerCapture(event.pointerId);
      this.root.classList.add("is-dragging");
    });
    this.grip.addEventListener("pointermove", (event) => {
      if (this.drag?.id !== event.pointerId) return;
      this.move(this.drag.left + event.clientX - this.drag.x, this.drag.top + event.clientY - this.drag.y);
    });
    for (const event of ["pointerup", "pointercancel", "lostpointercapture", "blur"]) this.grip.addEventListener(event, () => this.endDrag());
    this.grip.addEventListener("dblclick", () => this.resetPosition());
    this.grip.addEventListener("keydown", (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const step = event.shiftKey ? 48 : 16;
      const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const change = delta[event.code];
      if (!change && event.code !== "Home") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.code === "Home") this.resetPosition();
      else if (change) {
        const origin = this.origin();
        this.move(origin.x + change[0], origin.y + change[1]);
      }
    });
  }

  private endDrag(): void {
    const id = this.drag?.id;
    this.drag = null;
    if (id !== undefined && this.grip.hasPointerCapture(id)) this.grip.releasePointerCapture(id);
    this.root.classList.remove("is-dragging");
  }

  destroy(): void {
    this.destroyed = true;
    this.setVisible(false);
    this.input.connected = false;
    this.resizeObserver.disconnect();
    this.mobile.removeEventListener("change", this.onLayoutChange);
    window.removeEventListener("resize", this.onLayoutChange);
  }
}
