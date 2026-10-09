import type { EventLogEntry } from "../event-log";
import { eventToStep } from "../replay";
import type { MacroStep } from "./macro-model";
export type TimelineKind =
  "input" | "install" | "settings" | "capture" | "crash";
export const EVENT_COLORS: Record<TimelineKind, string> = {
  input: "#7cb7ff",
  install: "#c9b2ff",
  settings: "#a3a9b0",
  capture: "#6ee7b7",
  crash: "#f2777a",
};
export function timelineKind(event: EventLogEntry): TimelineKind {
  if (event.kind === "capture") return "capture";
  if (event.kind === "crash") return "crash";
  if (event.kind === "install" || event.action === "install") return "install";
  return ["button", "key", "tap", "drag", "text", "scroll", "pinch"].includes(
    event.kind,
  ) || event.action === "open"
    ? "input"
    : "settings";
}
export function selectedEvents(
  events: EventLogEntry[],
  start: number,
  end: number,
  hidden: Set<TimelineKind>,
): EventLogEntry[] {
  return events
    .filter(
      (e) =>
        Date.parse(e.timestamp) >= start &&
        Date.parse(e.timestamp) <= end &&
        !hidden.has(timelineKind(e)),
    )
    .sort(
      (a, b) =>
        Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id - b.id,
    );
}
function input(body: Record<string, unknown>, waitMs: number): MacroStep {
  return { kind: "INPUT", value: JSON.stringify(body), tag: 3, body, waitMs };
}
/** One-device macros avoid duplicate keys from mirrored input. Gesture duration is consumed once. */
export function rangeToMacro(
  events: EventLogEntry[],
  device: string,
): { steps: MacroStep[]; excluded: number } {
  const chosen = events
    .filter((e) => e.device === device)
    .sort(
      (a, b) =>
        Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id - b.id,
    );
  const steps: MacroStep[] = [];
  let previous: number | null = null;
  let excluded = events.length - chosen.length;
  for (const event of chosen) {
    const action = eventToStep(event);
    const sequence: MacroStep[] = [];
    let duration = 0;
    if (action?.action === "button")
      sequence.push({ kind: "KEY", value: String(action.button), waitMs: 0 });
    else if (action?.action === "key" && typeof action.code === "string")
      sequence.push({ kind: "KEY", value: action.code, waitMs: 0 });
    else if (action?.action === "text")
      sequence.push({ kind: "TEXT", value: String(action.text), waitMs: 0 });
    else if (action?.action === "open")
      sequence.push({ kind: "LINK", value: String(action.url), waitMs: 0 });
    else if (action?.action === "tap") {
      duration = Math.min(5000, Math.max(0, Number(action.durationMs) || 0));
      sequence.push(
        input({ type: "begin", x: action.x, y: action.y }, 0),
        input({ type: "end", x: action.x, y: action.y }, duration),
      );
    } else if (action?.action === "swipe") {
      duration = Math.min(5000, Math.max(50, Number(action.durationMs) || 300));
      const count = Math.ceil(duration / 50);
      sequence.push(input({ type: "begin", x: action.x1, y: action.y1 }, 0));
      for (let i = 1; i <= count; i++)
        sequence.push(
          input(
            {
              type: "move",
              x:
                Number(action.x1) +
                ((Number(action.x2) - Number(action.x1)) * i) / count,
              y:
                Number(action.y1) +
                ((Number(action.y2) - Number(action.y1)) * i) / count,
            },
            duration / count,
          ),
        );
      sequence.push(input({ type: "end", x: action.x2, y: action.y2 }, 0));
    }
    if (!sequence.length) {
      excluded++;
      continue;
    }
    const at = Date.parse(event.timestamp);
    let delay = previous === null ? 0 : Math.max(0, at - previous);
    while (delay > 60000) {
      steps.push({ kind: "WAIT", value: "60000", waitMs: 0 });
      delay -= 60000;
    }
    sequence[0]!.waitMs = delay;
    steps.push(...sequence);
    previous = at + duration;
  }
  return { steps, excluded };
}
