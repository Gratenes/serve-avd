/**
 * Recent-actions event log. In-memory ring buffer with subscriber fan-out —
 * served as JSON at `/api/event-log`, streamed as SSE at
 * `/api/event-log/events`, and rendered by `serve-emu event-log`.
 */

export type EventLogSource = "hid" | "cli" | "server" | "ui";
export type EventLogStatus = "ok" | "error";

export type EventLogEntry = {
  id: number;
  timestamp: string;
  source: EventLogSource;
  kind: string;
  msg: string;
  summary: string;
  device?: string;
  action?: string;
  status?: EventLogStatus;
  details?: Record<string, unknown>;
};

export type EventLogDraft = Omit<EventLogEntry, "id" | "timestamp" | "msg"> & {
  timestamp?: string;
  msg?: string;
};

export const EVENT_LOG_MAX_ENTRIES = 500;

type Listener = (entry: EventLogEntry) => void;

const entries: EventLogEntry[] = [];
const listeners = new Set<Listener>();
let nextId = 1;

export function recordEventLogEvent(draft: EventLogDraft): EventLogEntry {
  const entry: EventLogEntry = {
    id: nextId++,
    timestamp: draft.timestamp ?? new Date().toISOString(),
    source: draft.source,
    kind: draft.kind,
    summary: draft.summary,
    msg: draft.msg ?? draft.summary,
    ...(draft.device ? { device: draft.device } : {}),
    ...(draft.action ? { action: draft.action } : {}),
    ...(draft.status ? { status: draft.status } : {}),
    ...(draft.details ? { details: draft.details } : {}),
  };
  entries.push(entry);
  if (entries.length > EVENT_LOG_MAX_ENTRIES) entries.splice(0, entries.length - EVENT_LOG_MAX_ENTRIES);
  for (const listener of listeners) listener(entry);
  return entry;
}

/** Mutate a recorded entry in place (drag coalescing). Notifies unless told not to. */
export function updateEventLogEvent(
  id: number,
  patch: Partial<Omit<EventLogEntry, "id">>,
  options: { notify?: boolean } = {},
): EventLogEntry | null {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return null;
  Object.assign(entry, patch, patch.summary && !patch.msg ? { msg: patch.summary } : {});
  if (options.notify !== false) {
    for (const listener of listeners) listener(entry);
  }
  return entry;
}

export function listEventLogEvents(options: { device?: string; limit?: number } = {}): EventLogEntry[] {
  let out = entries;
  if (options.device) out = out.filter((e) => e.device === options.device);
  if (options.limit != null && options.limit >= 0) out = out.slice(-options.limit);
  return [...out];
}

export function subscribeEventLog(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
