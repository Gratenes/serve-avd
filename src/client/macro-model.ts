import { androidKeycodeForBrowserCode, BUTTONS } from '../keymap';
import type { FeatureDevice } from './feature-dom';
import { deviceAction, helperBase, request } from './feature-dom';
export type MacroKind = 'KEY' | 'TEXT' | 'WAIT' | 'LINK' | 'CHECK' | 'INPUT';
export interface MacroStep { kind: MacroKind; value: string; waitMs: number; tag?: number; body?: Record<string, unknown> }
export interface Macro { id: string; name: string; steps: MacroStep[]; uses: number }
export function resolveDeepLink(url: string, id?: string | null): string | null {
  if (!url.trim()) throw new Error('Enter a deep link.');
  if (url.includes('{id}')) { if (id == null || !id.trim()) return null; return url.replaceAll('{id}', encodeURIComponent(id.trim())); }
  return url.trim();
}
export function recordedStep(tag: number, body: Record<string, unknown>, waitMs: number): MacroStep | null {
  if (tag === 4 && typeof body.button === 'string') return { kind: 'KEY', value: body.button, waitMs };
  if (tag === 13 && typeof body.text === 'string') return { kind: 'TEXT', value: body.text, waitMs };
  if (tag === 6) { if (body.type !== 'down') return null; return { kind: 'KEY', value: String(body.code), waitMs }; }
  if ([3,5,11].includes(tag)) return { kind: 'INPUT', value: JSON.stringify(body), tag, body, waitMs };
  return null;
}
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('Macro stopped'));
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(new Error('Macro stopped')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });
}
export function validateMacroSteps(steps: MacroStep[]): void {
  if (!Array.isArray(steps) || !steps.length || steps.length > 10000) throw new Error('Add at least one step (maximum 10000).');
  for (const step of steps) {
    if (!step || !['KEY','TEXT','WAIT','LINK','CHECK','INPUT'].includes(step.kind) || typeof step.value !== 'string') throw new Error('Invalid macro step.');
    if (!Number.isFinite(step.waitMs) || step.waitMs < 0 || step.waitMs > 60000) throw new Error('Step delay must be 0–60000 ms.');
    if (step.kind === 'KEY' && !(step.value in BUTTONS) && androidKeycodeForBrowserCode(step.value) == null) throw new Error(`Unknown key ${step.value}.`);
    if (step.kind === 'WAIT' && (!step.value.trim() || !Number.isFinite(Number(step.value)) || Number(step.value) < 0 || Number(step.value) > 60000)) throw new Error('Wait must be 0–60000 ms.');
    if (step.kind === 'CHECK' && !step.value.trim()) throw new Error('Enter screen text to wait for.');
    if (step.kind === 'LINK' && (!step.value.trim() || step.value.includes('{id}'))) throw new Error('Replace {id} in the macro deep link before running.');
    if (step.kind === 'INPUT' && (step.tag == null || ![3,5,11].includes(step.tag) || !step.body || typeof step.body !== 'object')) throw new Error('Invalid recorded input payload.');
  }
}
export class MacroRunner {
  private abort: AbortController | null = null;
  get running(): boolean { return this.abort !== null; }
  stop(): void { this.abort?.abort(new Error('Macro stopped')); }
  async run(steps: MacroStep[], targets: FeatureDevice[], repeat: number, stopOnCrash: boolean, progress: (index: number, total: number) => void): Promise<void> {
    if (this.running) throw new Error('A macro is already running.');
    validateMacroSteps(steps);
    if (!targets.length || targets.some(target => !target.connected)) throw new Error('Select connected devices before running.');
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) throw new Error('Repeat must be between 1 and 100.');
    const abort = this.abort = new AbortController();
    const baseline = new Map<string, Set<string>>();
    let monitor: ReturnType<typeof setTimeout> | undefined;
    let monitorRequest: Promise<void> | null = null;
    const checkCrashes = async (initial = false) => {
      for (const target of targets) {
        const data = await request<{ crashes: Array<{id:string}> }>(`${helperBase(target)}/crashes`, { signal: abort.signal });
        if (!Array.isArray(data.crashes)) throw new Error('Crash monitoring unavailable.');
        if (initial) baseline.set(target.entry.device, new Set(data.crashes.map(item => item.id)));
        else if (data.crashes.some(item => !baseline.get(target.entry.device)?.has(item.id))) throw new Error(`Macro stopped: app crashed on ${target.entry.name}.`);
      }
    };
    const watch = () => { monitor = setTimeout(() => {
      monitorRequest = checkCrashes().catch(error => { abort.abort(error); }).finally(() => { monitorRequest = null; if (!abort.signal.aborted) watch(); });
    }, 400); };
    try {
      if (stopOnCrash) { await checkCrashes(true); watch(); }
      let index = 0;
      for (let turn = 0; turn < repeat; turn++) for (const step of steps) {
        progress(index++, steps.length * repeat);
        await pause(step.waitMs, abort.signal);
        if (targets.some(target => !target.connected)) throw new Error('Macro stopped: a target disconnected or was hidden.');
        await Promise.all(targets.map(async target => {
          try {
            if (abort.signal.aborted) throw abort.signal.reason;
            switch (step.kind) {
              case 'KEY': await deviceAction(target, step.value in BUTTONS ? 'button' : 'key', step.value in BUTTONS ? { button: step.value } : { code: step.value }, abort.signal); break;
              case 'TEXT': await deviceAction(target, 'text', { text: step.value }, abort.signal); break;
              case 'WAIT': await pause(Number(step.value), abort.signal); break;
              case 'LINK': await deviceAction(target, 'open', { url: step.value }, abort.signal); break;
              case 'CHECK': {
                const deadline = Date.now()+10000;
                for (;;) {
                  const result = await deviceAction<{total:number}>(target,'find',{text:step.value},abort.signal);
                  if (result.total > 0) break;
                  if (Date.now() >= deadline) throw new Error(`Screen text ${step.value} did not appear.`);
                  await pause(400,abort.signal);
                }
                break;
              }
              case 'INPUT': if (!target.sendInput(step.tag!,step.body!)) throw new Error('Macro input target disconnected.'); break;
            }
          } catch (error) { abort.abort(error); throw error; }
        }));
      }
      if (stopOnCrash) { if (monitorRequest) await monitorRequest; if (!abort.signal.aborted) await checkCrashes(); }
      if (abort.signal.aborted) throw abort.signal.reason;
      progress(index, steps.length * repeat);
    } catch (error) { throw abort.signal.aborted ? abort.signal.reason ?? error : error; }
    finally { if (monitor) clearTimeout(monitor); abort.abort(); if (this.abort === abort) this.abort = null; }
  }
}
