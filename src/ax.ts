/**
 * UI hierarchy dump — the Android analog of serve-sim's accessibility bridge.
 * Runs `uiautomator dump`, parses its XML, and returns a JSON tree agents can
 * navigate (bounds, text, resource ids, clickability).
 */
import { AdbShell } from "./adb";

export interface AxBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface AxNode {
  class?: string;
  package?: string;
  resourceId?: string;
  text?: string;
  contentDesc?: string;
  bounds?: AxBounds;
  index?: number;
  clickable?: boolean;
  longClickable?: boolean;
  focusable?: boolean;
  focused?: boolean;
  enabled?: boolean;
  scrollable?: boolean;
  checkable?: boolean;
  checked?: boolean;
  selected?: boolean;
  password?: boolean;
  children?: AxNode[];
}

export interface AxDump {
  rotation?: number;
  root: AxNode | null;
}

const DUMP_PATH = "/sdcard/.serve-avd-ui.xml";
/**
 * uiautomator waits for the UI to go idle before dumping; a screen that never
 * settles (spinners, live animations) can hold it for a long time. Cap it
 * device-side (toybox `timeout`, present on modern images) so callers fail
 * fast rather than acting on a stale screen after the fact.
 */
const DUMP_TIMEOUT_S = 20;

/** Dump the current UI hierarchy as JSON. Throws when uiautomator fails (e.g. secure screens). */
export async function dumpUiHierarchy(shell: AdbShell): Promise<AxDump> {
  const result = await shell.runWithCode(
    `if command -v timeout >/dev/null 2>&1; then timeout ${DUMP_TIMEOUT_S} uiautomator dump ${DUMP_PATH}; else uiautomator dump ${DUMP_PATH}; fi >/dev/null 2>&1 && cat ${DUMP_PATH} && rm -f ${DUMP_PATH}`,
  );
  const xmlStart = result.out.indexOf("<?xml");
  if (result.code !== 0 || xmlStart === -1) {
    if (result.code === 124) throw new Error(`uiautomator dump timed out after ${DUMP_TIMEOUT_S}s (the UI never went idle)`);
    throw new Error(result.out.trim() || "uiautomator dump produced no XML");
  }
  return parseUiAutomatorXml(result.out.slice(xmlStart));
}

// ── Semantic targeting ─────────────────────────────────────────────────────

/**
 * A node query. Every given field must match; `text`, `desc` and `id` are
 * case-insensitive substring matches unless `exact` is set (`id` also matches
 * when the query is just the id's suffix after `:id/`). `text` additionally
 * matches against `contentDesc`, so "Sign in" finds an icon button whose only
 * label is its content description.
 */
export interface AxQuery {
  text?: string;
  id?: string;
  desc?: string;
  class?: string;
  exact?: boolean;
  /** Only nodes flagged clickable (walks up to the nearest clickable ancestor otherwise). */
  clickable?: boolean;
  /** Pick the nth match (0-based). Default 0. */
  index?: number;
}

/** A matched node with its center in display pixels and normalized 0..1 coords. */
export interface AxMatch {
  node: AxNode;
  /** Path of child indices from the root. */
  path: number[];
  depth: number;
  center: { x: number; y: number };
  normalized: { x: number; y: number };
  bounds: AxBounds;
}

export interface FindResult {
  matches: AxMatch[];
  screen: { width: number; height: number };
  total: number;
}

export function isEmptyQuery(query: AxQuery): boolean {
  return query.text == null && query.id == null && query.desc == null && query.class == null;
}

export function describeQuery(query: AxQuery): string {
  const parts: string[] = [];
  if (query.text != null) parts.push(`text ${JSON.stringify(query.text)}`);
  if (query.id != null) parts.push(`id ${query.id}`);
  if (query.desc != null) parts.push(`desc ${JSON.stringify(query.desc)}`);
  if (query.class != null) parts.push(`class ${query.class}`);
  const label = parts.join(", ") || "any node";
  return query.index ? `${label} [${query.index}]` : label;
}

/** Depth-first flatten with each node's path from the root. */
export function flattenAx(root: AxNode | null): Array<{ node: AxNode; path: number[] }> {
  const out: Array<{ node: AxNode; path: number[] }> = [];
  const walk = (node: AxNode, path: number[]) => {
    out.push({ node, path });
    node.children?.forEach((child, i) => walk(child, [...path, i]));
  };
  if (root) walk(root, []);
  return out;
}

function matchesString(actual: string | undefined, wanted: string, exact: boolean): boolean {
  if (actual == null) return false;
  if (exact) return actual === wanted;
  return actual.toLowerCase().includes(wanted.toLowerCase());
}

/** Does `node` satisfy `query` (ignoring `index`)? */
export function nodeMatches(node: AxNode, query: AxQuery): boolean {
  const exact = query.exact === true;
  if (query.text != null && !matchesString(node.text, query.text, exact) && !matchesString(node.contentDesc, query.text, exact)) {
    return false;
  }
  if (query.desc != null && !matchesString(node.contentDesc, query.desc, exact)) return false;
  if (query.id != null) {
    const id = node.resourceId;
    if (id == null) return false;
    const suffix = id.includes(":id/") ? id.slice(id.indexOf(":id/") + 4) : id;
    const ok = exact
      ? id === query.id || suffix === query.id
      : id.toLowerCase().includes(query.id.toLowerCase());
    if (!ok) return false;
  }
  if (query.class != null) {
    const cls = node.class;
    if (cls == null) return false;
    const ok = exact ? cls === query.class : cls.toLowerCase().includes(query.class.toLowerCase());
    if (!ok) return false;
  }
  if (query.clickable && !node.clickable) return false;
  return true;
}

/** Screen size for normalization: the root node's bounds, else the given fallback. */
export function axScreenSize(dump: AxDump, fallback?: { width: number; height: number }): { width: number; height: number } {
  const b = dump.root?.bounds;
  if (b && b.right - b.left > 0 && b.bottom - b.top > 0) return { width: b.right - b.left, height: b.bottom - b.top };
  return fallback ?? { width: 0, height: 0 };
}

/**
 * Find nodes matching `query`, ordered document-first (which is roughly
 * top-to-bottom, left-to-right on screen). Nodes without bounds are skipped.
 */
export function findInAx(dump: AxDump, query: AxQuery, screen?: { width: number; height: number }): FindResult {
  const size = axScreenSize(dump, screen);
  const matches: AxMatch[] = [];
  for (const { node, path } of flattenAx(dump.root)) {
    if (!nodeMatches(node, query)) continue;
    const bounds = node.bounds;
    if (!bounds) continue;
    const cx = (bounds.left + bounds.right) / 2;
    const cy = (bounds.top + bounds.bottom) / 2;
    matches.push({
      node: { ...node, children: undefined },
      path,
      depth: path.length,
      bounds,
      center: { x: Math.round(cx), y: Math.round(cy) },
      normalized: {
        x: size.width > 0 ? clamp01(cx / size.width) : 0,
        y: size.height > 0 ? clamp01(cy / size.height) : 0,
      },
    });
  }
  return { matches, screen: size, total: matches.length };
}

/** The single match `query.index` points at (default first), or null. */
export function pickMatch(result: FindResult, query: AxQuery): AxMatch | null {
  return result.matches[query.index ?? 0] ?? null;
}

export interface WaitOptions {
  /** Total budget in ms. Default 10s. */
  timeoutMs?: number;
  /** Poll interval in ms. Default 500. */
  intervalMs?: number;
  /** Wait for the node to *disappear* instead. */
  gone?: boolean;
}

export interface WaitResult {
  ok: boolean;
  /** The match when waiting for presence (null when timed out or waiting for gone). */
  match: AxMatch | null;
  elapsedMs: number;
  attempts: number;
}

/**
 * Poll `dump()` until `query` matches (or stops matching with `gone`), or the
 * budget runs out. Dump failures (secure screens, transient uiautomator
 * errors) count as "no match" and are retried.
 */
export async function waitForAx(
  dump: () => Promise<AxDump>,
  query: AxQuery,
  options: WaitOptions = {},
  screen?: { width: number; height: number },
): Promise<WaitResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 500;
  const started = Date.now();
  let attempts = 0;
  for (;;) {
    attempts++;
    let match: AxMatch | null = null;
    try {
      match = pickMatch(findInAx(await dump(), query, screen), query);
    } catch {
      match = null;
    }
    const satisfied = options.gone ? match == null : match != null;
    const elapsedMs = Date.now() - started;
    if (satisfied) return { ok: true, match: options.gone ? null : match, elapsedMs, attempts };
    if (elapsedMs >= timeoutMs) return { ok: false, match: null, elapsedMs, attempts };
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, Math.max(0, timeoutMs - elapsedMs))));
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// ── XML parsing (uiautomator's restricted dialect) ─────────────────────────

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#x?[0-9a-fA-F]+);/g, (entity) => {
    const known = ENTITIES[entity];
    if (known) return known;
    const hex = /^&#x([0-9a-fA-F]+);$/.exec(entity);
    if (hex) return String.fromCodePoint(parseInt(hex[1]!, 16));
    const dec = /^&#(\d+);$/.exec(entity);
    if (dec) return String.fromCodePoint(parseInt(dec[1]!, 10));
    return entity;
  });
}

function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w-]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) attrs[m[1]!] = decodeEntities(m[2]!);
  return attrs;
}

function parseBounds(value: string | undefined): AxBounds | undefined {
  if (!value) return undefined;
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(value);
  if (!m) return undefined;
  return {
    left: parseInt(m[1]!, 10),
    top: parseInt(m[2]!, 10),
    right: parseInt(m[3]!, 10),
    bottom: parseInt(m[4]!, 10),
  };
}

function nodeFromAttributes(attrs: Record<string, string>): AxNode {
  const node: AxNode = {};
  if (attrs.class) node.class = attrs.class;
  if (attrs.package) node.package = attrs.package;
  if (attrs["resource-id"]) node.resourceId = attrs["resource-id"];
  if (attrs.text) node.text = attrs.text;
  if (attrs["content-desc"]) node.contentDesc = attrs["content-desc"];
  const bounds = parseBounds(attrs.bounds);
  if (bounds) node.bounds = bounds;
  if (attrs.index != null) node.index = parseInt(attrs.index, 10);
  const bools: Array<[keyof AxNode, string]> = [
    ["clickable", "clickable"],
    ["longClickable", "long-clickable"],
    ["focusable", "focusable"],
    ["focused", "focused"],
    ["enabled", "enabled"],
    ["scrollable", "scrollable"],
    ["checkable", "checkable"],
    ["checked", "checked"],
    ["selected", "selected"],
    ["password", "password"],
  ];
  for (const [key, attr] of bools) {
    if (attrs[attr] === "true") (node as Record<string, unknown>)[key] = true;
  }
  return node;
}

/** Parse uiautomator's XML into a JSON tree. Exported for tests. */
export function parseUiAutomatorXml(xml: string): AxDump {
  const dump: AxDump = { root: null };
  const hierarchyMatch = /<hierarchy\b([^>]*)>/.exec(xml);
  if (hierarchyMatch) {
    const rotation = parseAttributes(hierarchyMatch[1]!).rotation;
    if (rotation != null) dump.rotation = parseInt(rotation, 10);
  }

  const stack: AxNode[] = [];
  const tagRe = /<node\b([^>]*?)(\/?)>|<\/node>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml))) {
    if (m[0] === "</node>") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = nodeFromAttributes(parseAttributes(m[1]!));
    const parent = stack[stack.length - 1];
    if (parent) {
      (parent.children ??= []).push(node);
    } else if (!dump.root) {
      dump.root = node;
    }
    if (m[2] !== "/") stack.push(node);
  }
  return dump;
}
