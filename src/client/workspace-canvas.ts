/** Canvas coordinates are independent of DOM order, selection and device input. */
export type CanvasLayout = "focus" | "grid" | "split" | "stack";
type Point = { x: number; y: number };
type Item = { id: string; root: HTMLElement };
const GRID = 24;
const MIN_ZOOM = .1;
const MAX_ZOOM = 2;
const snap = (n: number) => Math.round(n / GRID) * GRID;
const finitePoint = (p: unknown): p is Point => !!p && typeof p === "object" &&
  "x" in p && "y" in p && typeof p.x === "number" && typeof p.y === "number" &&
  Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) < 1e7 && Math.abs(p.y) < 1e7;

export class WorkspaceCanvas {
  private positions = new Map<string, Point>();
  private items: Item[] = [];
  private camera = { x: 24, y: 24, zoom: 1 };
  private enabled = false;
  private initialized = false;
  private restored = false;
  private hand = false;
  private space = false;
  private gesture: { pointer: number; start: Point; origin: Point; moved: boolean; item?: Item } | null = null;
  private controls = document.createElement("div");
  private zoomLabel: HTMLButtonElement;
  private handButton: HTMLButtonElement;
  private saveTimer: number | undefined;
  private lifetime = new AbortController();
  private layout: CanvasLayout | null = null;
  private focusTarget: string | null = null;
  private focusPositions = new Map<string, Point>();
  private focusCamera: typeof this.camera | null = null;
  private focusSignature = "";
  private resize: ResizeObserver;
  private observedItems = new Set<HTMLElement>();

  constructor(private host: HTMLElement, private world: HTMLElement, private storageKey: string,
    private onMove: () => void, private cancelInput: () => void, private onZoom: (zoom: number) => void) {
    try {
      const state = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if (state?.version === 1 && finitePoint(state.camera) &&
          Number.isFinite(state.camera.zoom) && state.camera.zoom >= MIN_ZOOM && state.camera.zoom <= MAX_ZOOM &&
          Array.isArray(state.positions)) {
        this.camera = state.camera;
        for (const [id, point] of state.positions) {
          if (typeof id === "string" && finitePoint(point)) this.positions.set(id, point);
        }
        this.restored = true;
      }
    } catch { /* Storage is optional, including in private browser sessions. */ }
    this.controls.className = "canvas-controls";
    this.controls.setAttribute("role", "toolbar");
    this.controls.setAttribute("aria-label", "Canvas controls");
    const control = (text: string, label: string, action: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn";
      b.textContent = text;
      b.title = label;
      b.setAttribute("aria-label", label);
      b.addEventListener("click", action);
      this.controls.append(b);
      return b;
    };
    this.handButton = control("Pan", "Pan canvas (drag anywhere)", () => {
      this.hand = !this.hand;
      this.cancelInput();
      this.render();
    });
    control("−", "Zoom out", () => this.zoomAt(this.camera.zoom / 1.2));
    this.zoomLabel = control("100%", "Reset zoom to 100%", () => this.zoomAt(1));
    control("+", "Zoom in", () => this.zoomAt(this.camera.zoom * 1.2));
    control("Fit all", "Fit all devices", () => this.fit());
    const hint = document.createElement("span");
    hint.className = "canvas-hint";
    hint.textContent = "Drag headers · Space + drag to pan · Ctrl/⌘ + scroll to zoom";
    this.controls.append(hint);
    host.append(this.controls);
    host.tabIndex = 0;
    const signal = this.lifetime.signal;
    host.addEventListener("wheel", e => {
      if (!this.enabled || this.isOverlay(e.target)) return;
      const target = e.target as Element;
      if (!e.ctrlKey && !e.metaKey && !this.hand && target.closest(".device")) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) {
        const rect = host.getBoundingClientRect();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? host.clientHeight : 1;
        // Keep wheel notches gentle and cap bursts from accelerated mouse wheels.
        const delta = Math.max(-100, Math.min(100, e.deltaY * unit));
        this.zoomAt(this.camera.zoom * Math.exp(-delta * .001), { x: e.clientX - rect.left, y: e.clientY - rect.top });
      } else {
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? host.clientHeight : 1;
        this.camera.x -= (e.shiftKey ? e.deltaY : e.deltaX) * unit;
        this.camera.y -= (e.shiftKey ? e.deltaX : e.deltaY) * unit;
        this.render();
        this.save();
      }
    }, { capture: true, passive: false, signal });
    host.addEventListener("pointerdown", e => this.start(e), { capture: true, signal });
    host.addEventListener("pointermove", e => {
      const g = this.gesture;
      if (!g || g.pointer !== e.pointerId) return;
      e.preventDefault();
      e.stopPropagation();
      if (Math.hypot(e.clientX - g.start.x, e.clientY - g.start.y) < 3 && !g.moved) return;
      g.moved = true;
      const divisor = g.item ? this.camera.zoom : 1;
      const point = { x: g.origin.x + (e.clientX - g.start.x) / divisor, y: g.origin.y + (e.clientY - g.start.y) / divisor };
      if (g.item) {
        this.positions.set(g.item.id, { x: snap(point.x), y: snap(point.y) });
        this.place(g.item);
        this.onMove();
      } else Object.assign(this.camera, point);
      this.render();
    }, { capture: true, signal });
    const end = (e: PointerEvent) => {
      if (this.gesture?.pointer !== e.pointerId) return;
      e.stopPropagation();
      this.finish(e.type === "pointerup");
    };
    host.addEventListener("pointerup", end, { capture: true, signal });
    host.addEventListener("pointercancel", end, { capture: true, signal });
    host.addEventListener("lostpointercapture", end, { signal });
    document.addEventListener("keydown", e => {
      if (!this.enabled || this.isTyping(e.target) || this.isOverlay(e.target)) return;
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        this.space = true;
        this.render();
      }
    }, { signal });
    document.addEventListener("keyup", e => {
      if (e.code === "Space") { this.space = false; this.render(); }
    }, { signal });
    window.addEventListener("blur", () => { this.space = false; this.finish(); }, { signal });
    window.addEventListener("pagehide", () => this.persist(), { signal });
    this.resize = new ResizeObserver(() => {
      if (this.enabled && this.layout === "focus") this.arrangeFocus();
    });
    this.resize.observe(host);
  }

  private isTyping(target: EventTarget | null): boolean {
    return target instanceof Element && !!target.closest("input, textarea, select, [contenteditable], .screen-wrap, button, summary");
  }

  private isOverlay(target: EventTarget | null): boolean {
    return target instanceof Element && !!target.closest(".canvas-controls, .workspace-remote, .performance-body, .inspector-workspace .panes");
  }

  private start(e: PointerEvent): void {
    if (!this.enabled || this.gesture || !e.isPrimary || this.isOverlay(e.target) || (e.button !== 0 && e.button !== 1)) return;
    const target = e.target as Element;
    const root = target.closest<HTMLElement>(".device, .workspace-tool-card");
    const pan = this.hand || this.space || e.button === 1 || !root;
    if (target.closest(".workspace-empty")) return;
    if (!pan && (this.layout === "focus" || !target.closest(".device-head") || target.closest("button, input, select, textarea"))) return;
    const item = pan ? undefined : this.items.find(i => i.root === root);
    if (!pan && !item) return;
    e.preventDefault();
    e.stopPropagation();
    this.cancelInput();
    this.host.focus({ preventScroll: true });
    this.gesture = { pointer: e.pointerId, start: { x: e.clientX, y: e.clientY },
      origin: { ...(item ? this.positions.get(item.id)! : this.camera) }, moved: false, item };
    this.host.setPointerCapture(e.pointerId);
    this.render();
  }

  private finish(select = false): void {
    const g = this.gesture;
    this.gesture = null;
    if (g && this.host.hasPointerCapture(g.pointer)) this.host.releasePointerCapture(g.pointer);
    this.render();
    this.save();
    if (select && g?.item) g.item.root.dispatchEvent(new CustomEvent("canvasselect", { detail: !g.moved }));
  }

  /** Only new devices receive automatic coordinates; polling never resets a workspace. */
  sync(items: Item[], enabled: boolean, layout: CanvasLayout | null = null, target: string | null = null): void {
    if (this.enabled !== enabled) this.focusSignature = "";
    const roots = new Set(items.map(item => item.root));
    for (const root of this.observedItems) if (!roots.has(root)) { this.resize.unobserve(root); this.observedItems.delete(root); }
    for (const root of roots) if (!this.observedItems.has(root)) { this.resize.observe(root); this.observedItems.add(root); }
    const enteringFocus = layout === "focus" && this.layout !== "focus";
    if (enteringFocus) this.focusCamera = { ...this.camera };
    if (layout !== "focus" && this.layout === "focus") {
      if (this.focusCamera) this.camera = this.focusCamera;
      this.focusCamera = null;
      this.focusSignature = "";
    }
    this.layout = layout;
    this.focusTarget = target;
    this.enabled = enabled;
    this.host.classList.toggle("canvas-workspace", enabled);
    this.controls.hidden = !enabled;
    this.items = items.filter(i => !i.root.hidden);
    const primary = this.items.find(i => i.id === target) ?? this.items[0];
    for (const item of items) {
      const focus = layout === "focus" && !item.root.hidden && !item.root.classList.contains("workspace-tool-card");
      item.root.classList.toggle("focus-primary", focus && item === primary);
      item.root.classList.toggle("focus-thumbnail", focus && item !== primary);
      item.root.style.order = focus ? (item === primary ? "0" : "1") : "";
      if (layout !== "focus" || !enabled) item.root.style.removeProperty("--focus-width");
      if (enabled && !item.root.hidden && !this.positions.has(item.id)) {
        const right = Math.max(0, ...items.filter(i => i !== item && !i.root.hidden && this.positions.has(i.id)).map(i => this.positions.get(i.id)!.x + (i.root.offsetWidth || parseFloat(getComputedStyle(i.root).width) || 336)));
        this.positions.set(item.id, { x: right ? Math.ceil((right + GRID) / GRID) * GRID : 0, y: 0 });
      }
      if (enabled) { if (layout !== "focus") this.place(item); }
      else { item.root.style.removeProperty("left"); item.root.style.removeProperty("top"); }
      const head = item.root.querySelector<HTMLElement>(".device-head")!;
      head.tabIndex = enabled ? 0 : -1;
      head.title = enabled && layout !== "focus" ? "Drag to move on the grid; use arrow keys to move, Shift for larger steps" : "";
      if (!head.dataset.canvasBound) {
        head.dataset.canvasBound = "true";
        head.addEventListener("keydown", e => {
          if (!this.enabled || this.layout === "focus" || e.target !== head || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
          e.preventDefault();
          e.stopPropagation();
          const p = this.positions.get(item.id)!;
          const step = GRID * (e.shiftKey ? 5 : 1);
          p.x += e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
          p.y += e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
          this.place(item);
          this.onMove();
          this.save();
        });
      }
    }
    if (!enabled) this.finish();
    this.render();
    if (enabled && layout === "focus") this.arrangeFocus();
    if (enabled && !this.initialized && this.host.clientWidth && this.items.length) {
      this.initialized = true;
      if (!this.restored) this.fit();
    }
  }

  arrange(layout: CanvasLayout): void {
    if (!this.enabled || !this.items.length) return;
    if (layout === "focus") { this.arrangeFocus(true); return; }
    const items = this.items;
    const columns = layout === "stack" ? 1 : layout === "split" ? items.length : Math.ceil(Math.sqrt(items.length));
    const columnWidths = Array.from({ length: columns }, (_, column) =>
      Math.ceil(Math.max(...items.filter((_, index) => index % columns === column).map(item => item.root.offsetWidth)) / GRID) * GRID);
    let x = 0, y = 0, rowHeight = 0;
    items.forEach((item, index) => {
      if (index && index % columns === 0) { x = 0; y += rowHeight + GRID; rowHeight = 0; }
      this.positions.set(item.id, { x: snap(x), y: snap(y) });
      this.place(item);
      x += columnWidths[index % columns]! + GRID;
      rowHeight = Math.max(rowHeight, Math.ceil(item.root.offsetHeight / GRID) * GRID);
    });
    this.fit();
  }

  /** Focus is a presentation of the visible devices, leaving saved grid coordinates intact. */
  private arrangeFocus(force = false): void {
    if (!this.items.length || !this.host.clientWidth) { this.focusSignature = ""; return; }
    const tools = this.items.filter(i => i.root.classList.contains("workspace-tool-card"));
    const devices = this.items.filter(i => !i.root.classList.contains("workspace-tool-card"));
    const primary = devices.find(i => i.id === this.focusTarget) ?? devices[0];
    if (!primary) { this.fit(); return; }
    const ordered = [primary, ...devices.filter(i => i !== primary)];
    const width = Math.max(160, this.host.clientWidth - 48);
    const sideBySide = width >= 600 && ordered.length > 1;
    const thumbWidth = Math.min(220, width);
    const primaryWidth = sideBySide ? width - thumbWidth - GRID : width;
    const signature = JSON.stringify([ordered.map(i => [i.id, i.root.classList.contains("landscape"), i.root.querySelector<HTMLElement>(".screen-wrap")?.style.getPropertyValue("--screen-aspect"), i.root.offsetHeight]), width, this.host.clientHeight]);
    if (!force && signature === this.focusSignature) return;
    this.focusSignature = signature;
    this.cancelInput();
    this.host.style.setProperty("--focus-screen-height", `${Math.max(180, this.host.clientHeight - 220)}px`);
    ordered.forEach((item, index) => item.root.style.setProperty("--focus-width", `${index ? thumbWidth : primaryWidth}px`));
    this.focusPositions.set(primary.id, { x: 0, y: 0 });
    let y = sideBySide ? 0 : Math.ceil((primary.root.offsetHeight + GRID) / GRID) * GRID;
    for (const item of ordered.slice(1)) {
      this.focusPositions.set(item.id, { x: sideBySide ? primaryWidth + GRID : Math.round((width - thumbWidth) / 2), y });
      y += Math.ceil((item.root.offsetHeight + GRID) / GRID) * GRID;
    }
    let toolY = Math.max(primary.root.offsetHeight, y) + GRID;
    for (const tool of tools) {
      this.focusPositions.set(tool.id, { x: 0, y: toolY });
      toolY += tool.root.offsetHeight + GRID;
    }
    for (const item of [...ordered, ...tools]) this.place(item);
    this.fit();
  }

  /** Enlarge only the requested device to the available workspace. */
  fill(id: string): void {
    const item = this.items.find(item => item.id === id);
    if (item) this.fit([item], MAX_ZOOM);
  }

  fit(items = this.items, maximumZoom = 1): void {
    if (!this.enabled || !items.length || !this.host.clientWidth) return;
    const left = Math.min(...items.map(i => this.point(i).x));
    const top = Math.min(...items.map(i => this.point(i).y));
    const right = Math.max(...items.map(i => this.point(i).x + (i.root.offsetWidth || parseFloat(getComputedStyle(i.root).width) || 336)));
    const bottom = Math.max(...items.map(i => this.point(i).y + i.root.offsetHeight));
    const width = this.host.clientWidth, height = this.host.clientHeight;
    const zoom = Math.max(MIN_ZOOM, Math.min(maximumZoom, (width - 48) / Math.max(1, right - left), (height - 104) / Math.max(1, bottom - top)));
    this.camera = { zoom, x: (width - (right - left) * zoom) / 2 - left * zoom,
      y: Math.max(24, (height - 64 - (bottom - top) * zoom) / 2) - top * zoom };
    this.render();
    this.save();
  }

  reveal(id: string): void {
    const item = this.items.find(i => i.id === id);
    if (!this.enabled || !item) return;
    const rect = item.root.getBoundingClientRect(), host = this.host.getBoundingClientRect();
    if (rect.right < host.left || rect.left > host.right || rect.bottom < host.top || rect.top > host.bottom - 64) this.fit([item]);
  }

  private zoomAt(value: number, point = { x: this.host.clientWidth / 2, y: this.host.clientHeight / 2 }): void {
    this.cancelInput();
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
    const ratio = zoom / this.camera.zoom;
    this.camera = { x: point.x - (point.x - this.camera.x) * ratio, y: point.y - (point.y - this.camera.y) * ratio, zoom };
    this.render();
    this.save();
  }

  private place(item: Item): void {
    const p = this.point(item);
    item.root.style.left = `${p.x}px`;
    item.root.style.top = `${p.y}px`;
  }

  private point(item: Item): Point {
    return (this.layout === "focus" ? this.focusPositions.get(item.id) : undefined) ?? this.positions.get(item.id) ?? { x: 0, y: 0 };
  }

  private render(): void {
    const { x, y, zoom } = this.camera;
    this.world.style.transform = this.enabled ? `translate(${x}px, ${y}px) scale(${zoom})` : "";
    this.host.style.setProperty("--grid-size", `${GRID * zoom}px`);
    this.host.style.setProperty("--grid-x", `${x}px`);
    this.host.style.setProperty("--grid-y", `${y}px`);
    this.host.classList.toggle("canvas-pan", this.enabled && (this.hand || this.space));
    this.host.classList.toggle("canvas-dragging", !!this.gesture);
    this.onZoom(this.enabled ? zoom : 1);
    this.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    this.handButton.setAttribute("aria-pressed", String(this.hand));
  }

  private save(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.persist(), 200);
  }

  private persist(): void {
    if (!this.initialized && !this.restored) return;
    try { localStorage.setItem(this.storageKey, JSON.stringify({ version: 1, camera: this.focusCamera ?? this.camera, positions: [...this.positions] })); } catch {}
  }

  destroy(): void {
    this.finish();
    clearTimeout(this.saveTimer);
    this.persist();
    this.lifetime.abort();
    this.resize.disconnect();
  }
}
