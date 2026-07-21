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

/** Dump the current UI hierarchy as JSON. Throws when uiautomator fails (e.g. secure screens). */
export async function dumpUiHierarchy(shell: AdbShell): Promise<AxDump> {
  const result = await shell.runWithCode(
    `uiautomator dump ${DUMP_PATH} >/dev/null 2>&1 && cat ${DUMP_PATH} && rm -f ${DUMP_PATH}`,
  );
  const xmlStart = result.out.indexOf("<?xml");
  if (result.code !== 0 || xmlStart === -1) {
    throw new Error(result.out.trim() || "uiautomator dump produced no XML");
  }
  return parseUiAutomatorXml(result.out.slice(xmlStart));
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
