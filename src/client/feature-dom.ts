/** Shared browser boundary for workspace additions. All server text stays text. */
export interface FeatureDevice {
  entry: { device: string; name: string; actionEndpoint: string; foregroundEndpoint: string; axEndpoint: string; screenshotEndpoint: string };
  root: HTMLElement;
  readonly connected: boolean;
  sendInput(tag: number, body: Record<string, unknown>): boolean;
}
export function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const item = document.createElement(tag); item.textContent = text; item.className = className; return item;
}
export function control(text: string, action: () => void, label = text): HTMLButtonElement {
  const item = node('button', text, 'btn small'); item.type = 'button'; item.setAttribute('aria-label', label); item.addEventListener('click', action); return item;
}
export function field(label: string, value = '', type = 'text'): HTMLInputElement {
  const item = node('input', '', 'input'); item.type = type; item.value = value; item.placeholder = label; item.setAttribute('aria-label', label); return item;
}
export function row(...children: Node[]): HTMLDivElement { const item = node('div', '', 'feature-row'); item.append(...children); return item; }
export function section(title: string, ...children: Node[]): HTMLElement { const item = node('section', '', 'feature-section'); item.setAttribute('aria-label', title); item.append(node('h3', title), ...children); return item; }
export function helperBase(device: FeatureDevice): string { return device.entry.actionEndpoint.replace(/\/action\/?$/, ''); }
export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json() as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(data.message ?? data.error ?? `HTTP ${response.status}`);
  return data;
}
export async function deviceAction<T = Record<string, unknown>>(device: FeatureDevice, action: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const data = await request<{ ok: boolean; result: T; message?: string; error?: string }>(device.entry.actionEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, params }), signal });
  if (!data.ok) throw new Error(data.message ?? data.error ?? `${action} failed`);
  return data.result;
}
export function readSaved<T>(key: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(key) ?? 'null') as T ?? fallback; } catch { return fallback; } }
export function saveItems(key: string, value: unknown): void { localStorage.setItem(key, JSON.stringify(value)); }
export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
