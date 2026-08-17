/**
 * Agent-facing layers: semantic targeting over the ax dump, action helpers,
 * event-log → replay conversion, and the MCP protocol handler (no device).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUiAutomatorXml, findInAx, nodeMatches, waitForAx, describeQuery, type AxDump } from "../src/ax";
import { parseBatteryDump, parseSnapshotList, axQueryFromParams, ACTIONS_BY_NAME, actionNames } from "../src/actions";
import { parseEmuConsoleReply } from "../src/adb";
import { eventToStep, eventsToScript, parseScript, stepToAction, runScript, type ReplayScript } from "../src/replay";
import { createMcpServer, compactUiTree } from "../src/mcp";
import type { EventLogEntry } from "../src/event-log";

const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.app" content-desc="" bounds="[0,0][1000,2000]">
  <node index="0" text="Welcome" resource-id="com.app:id/title" class="android.widget.TextView" package="com.app" content-desc="" bounds="[100,100][900,200]" />
  <node index="1" text="" resource-id="com.app:id/search" class="android.widget.ImageButton" package="com.app" content-desc="Search" clickable="true" bounds="[800,0][1000,100]" />
  <node index="2" text="Sign in" resource-id="com.app:id/submit" class="android.widget.Button" package="com.app" content-desc="" clickable="true" enabled="true" bounds="[100,1800][900,1900]" />
  <node index="3" text="Sign in with Google" resource-id="" class="android.widget.Button" package="com.app" content-desc="" clickable="true" bounds="[100,1600][900,1700]" />
  <node index="4" text="" resource-id="com.app:id/email" class="android.widget.EditText" package="com.app" content-desc="Email" focused="true" bounds="[100,500][900,600]" />
</node></hierarchy>`;

const dump = (): AxDump => parseUiAutomatorXml(XML);

test("findInAx: substring text match, document order, centers + normalized coords", () => {
  const r = findInAx(dump(), { text: "sign in" });
  assert.equal(r.total, 2);
  assert.equal(r.screen.width, 1000);
  assert.equal(r.matches[0]!.node.text, "Sign in");
  assert.deepEqual(r.matches[0]!.center, { x: 500, y: 1850 });
  assert.deepEqual(r.matches[0]!.normalized, { x: 0.5, y: 0.925 });
  assert.equal(r.matches[1]!.node.text, "Sign in with Google");
  // children are stripped from matches (no huge payloads)
  assert.equal(r.matches[0]!.node.children, undefined);
});

test("findInAx: exact, id suffix, desc, class, clickable, index", () => {
  assert.equal(findInAx(dump(), { text: "Sign in", exact: true }).total, 1);
  assert.equal(findInAx(dump(), { id: "submit" }).matches[0]!.node.resourceId, "com.app:id/submit");
  assert.equal(findInAx(dump(), { id: "com.app:id/submit", exact: true }).total, 1);
  assert.equal(findInAx(dump(), { id: "submit", exact: true }).total, 1); // suffix still allowed when exact
  // text also matches content-desc (icon buttons)
  assert.equal(findInAx(dump(), { text: "search" }).matches[0]!.node.resourceId, "com.app:id/search");
  assert.equal(findInAx(dump(), { desc: "Email" }).matches[0]!.node.class, "android.widget.EditText");
  assert.equal(findInAx(dump(), { class: "Button" }).total, 3); // ImageButton + 2 Buttons
  assert.equal(findInAx(dump(), { class: "Button", clickable: true }).total, 3);
  assert.equal(findInAx(dump(), { text: "Welcome", clickable: true }).total, 0);
  const second = findInAx(dump(), { text: "sign in", index: 1 });
  assert.equal(second.matches[1]!.node.text, "Sign in with Google");
  assert.ok(!nodeMatches({ text: "abc" }, { text: "abd" }));
});

test("describeQuery is human", () => {
  assert.equal(describeQuery({ text: "Sign in" }), 'text "Sign in"');
  assert.equal(describeQuery({ id: "submit", index: 2 }), "id submit [2]");
});

test("waitForAx: appears after N polls, gone, timeout, tolerates dump errors", async () => {
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls === 1) throw new Error("uiautomator busy");
    return calls < 3 ? parseUiAutomatorXml("<hierarchy><node bounds='[0,0][10,10]' /></hierarchy>") : dump();
  };
  const found = await waitForAx(flaky, { text: "Welcome" }, { timeoutMs: 5_000, intervalMs: 5 });
  assert.equal(found.ok, true);
  assert.equal(found.attempts, 3);
  assert.equal(found.match?.node.text, "Welcome");

  const gone = await waitForAx(async () => dump(), { text: "Welcome" }, { timeoutMs: 60, intervalMs: 5, gone: true });
  assert.equal(gone.ok, false);
  const goneNow = await waitForAx(async () => ({ root: null }), { text: "Welcome" }, { timeoutMs: 60, intervalMs: 5, gone: true });
  assert.equal(goneNow.ok, true);

  const timedOut = await waitForAx(async () => dump(), { text: "nope" }, { timeoutMs: 40, intervalMs: 5 });
  assert.equal(timedOut.ok, false);
  assert.ok(timedOut.attempts >= 2);
});

test("axQueryFromParams normalizes CLI/HTTP params", () => {
  assert.deepEqual(axQueryFromParams({ text: "Hi", exact: "true", index: "2" }), { text: "Hi", exact: true, index: 2 });
  assert.deepEqual(axQueryFromParams({ id: "submit", clickable: 1 }), { id: "submit", clickable: true });
  assert.deepEqual(axQueryFromParams({}), {});
});

test("parseBatteryDump / parseSnapshotList / parseEmuConsoleReply", () => {
  const b = parseBatteryDump("Current Battery Service state:\n  AC powered: true\n  USB powered: false\n  status: 2\n  level: 42\n");
  assert.deepEqual(b, { level: 42, plugged: "ac", status: "charging" });
  const s = parseSnapshotList(
    "List of snapshots present on all disks:\nID        TAG                 VM SIZE                DATE       VM CLOCK\n--        default_boot            79M 2026-07-31 14:08:08   01:01:36.414\n--        clean                  334M 2026-08-16 09:56:56   00:00:12.000\nOK\n",
  );
  assert.deepEqual(
    s.map((r) => [r.tag, r.size, r.date]),
    [
      ["default_boot", "79M", "2026-07-31 14:08:08"],
      ["clean", "334M", "2026-08-16 09:56:56"],
    ],
  );
  assert.equal(parseEmuConsoleReply("OK\n", ["geo", "fix"]), "");
  assert.equal(parseEmuConsoleReply("Current network status:\ndownload speed: 0\nOK\n", ["network", "status"]), "Current network status:\ndownload speed: 0");
  assert.throws(() => parseEmuConsoleReply("KO: unknown snapshot\n", ["avd", "snapshot", "load", "x"]), /unknown snapshot/);
});

test("action registry is complete and self-describing", () => {
  for (const name of ["tap", "swipe", "text", "button", "find", "wait", "geo", "network", "battery", "fingerprint", "call", "sms", "font-scale", "density", "locale", "talkback", "install", "launch", "stop", "clear-data", "open", "apps", "snapshot", "shell"]) {
    assert.ok(ACTIONS_BY_NAME[name], `missing action ${name}`);
    assert.ok(ACTIONS_BY_NAME[name]!.description.length > 10);
  }
  assert.equal(new Set(actionNames()).size, actionNames().length);
  for (const emuOnly of ["geo", "fingerprint", "call", "sms", "snapshot"]) assert.equal(ACTIONS_BY_NAME[emuOnly]!.emulatorOnly, true);
});

// ── Replay ─────────────────────────────────────────────────────────────────

let nextId = 1;
const ev = (kind: string, details: Record<string, unknown> = {}, extra: Partial<EventLogEntry> = {}, t = 0): EventLogEntry => ({
  id: nextId++,
  timestamp: new Date(1_700_000_000_000 + t).toISOString(),
  source: "hid",
  kind,
  msg: kind,
  summary: kind,
  device: "emulator-5554",
  details,
  ...extra,
});

test("eventToStep maps recorded events to actions (and skips the rest)", () => {
  assert.deepEqual(eventToStep(ev("tap", { start: { x: 0.5, y: 0.25 }, current: { x: 0.5, y: 0.25 } })), { action: "tap", x: 0.5, y: 0.25 });
  assert.deepEqual(eventToStep(ev("tap", { current: { x: 0.1, y: 0.2 }, target: { text: "Sign in" }, durationMs: 800 })), {
    action: "tap",
    x: 0.1,
    y: 0.2,
    target: { text: "Sign in" },
    durationMs: 800,
  });
  assert.deepEqual(eventToStep(ev("drag", { start: { x: 0.5, y: 0.8 }, current: { x: 0.5, y: 0.2 }, durationMs: 420 })), {
    action: "swipe",
    x1: 0.5,
    y1: 0.8,
    x2: 0.5,
    y2: 0.2,
    durationMs: 420,
  });
  assert.deepEqual(eventToStep(ev("text", { text: "hi" })), { action: "text", text: "hi" });
  assert.deepEqual(eventToStep(ev("key", { code: "Enter" })), { action: "key", code: "Enter" });
  assert.deepEqual(eventToStep(ev("button", { button: "home" })), { action: "button", button: "home" });
  assert.deepEqual(eventToStep(ev("rotate", {}, { action: "landscape_left" })), { action: "rotate", orientation: "landscape_left" });
  assert.deepEqual(eventToStep(ev("geo", { lat: 1, lon: 2 })), { action: "geo", lat: 1, lon: 2 });
  assert.deepEqual(eventToStep(ev("app", { url: "https://x" }, { action: "open" })), { action: "open", url: "https://x" });
  assert.deepEqual(eventToStep(ev("wait", { query: { text: "Done" }, timeoutMs: 5000 })), { action: "wait", text: "Done", timeoutMs: 5000 });
  assert.equal(eventToStep(ev("stream", { reason: "x" })), null);
  assert.equal(eventToStep(ev("tap", { current: { x: 0.5, y: 0.5 } }, { status: "error" })), null);
  assert.equal(eventToStep(ev("boot", {}, { source: "server" })), null);
});

test("eventsToScript keeps relative timing; parseScript validates; stepToAction prefers targets", () => {
  const script = eventsToScript(
    [ev("tap", { current: { x: 0.5, y: 0.5 } }, {}, 1_000), ev("boot", {}, { source: "server" }, 0), ev("text", { text: "a" }, {}, 2_500)],
    { device: "emulator-5554" },
  );
  assert.equal(script.version, 1);
  assert.equal(script.device, "emulator-5554");
  assert.deepEqual(
    script.steps.map((s) => [s.t, s.action]),
    [
      [0, "tap"],
      [1500, "text"],
    ],
  );
  const parsed = parseScript(JSON.stringify(script));
  assert.equal(parsed.steps.length, 2);
  const bare = parseScript('[{"action":"button","button":"home"},{"action":"text","text":"x"}]');
  assert.deepEqual(
    bare.steps.map((s) => s.t),
    [0, 0],
  );
  assert.throws(() => parseScript('{"steps":[{"x":1}]}'), /no "action"/);

  const step = { t: 0, action: "tap", x: 0.1, y: 0.2, target: { text: "Go" } };
  assert.deepEqual(stepToAction(step), { name: "tap", params: { text: "Go" } });
  assert.deepEqual(stepToAction(step, true), { name: "tap", params: { x: 0.1, y: 0.2 } });
  assert.deepEqual(stepToAction({ t: 5, action: "geo", lat: 1, lon: 2 }), { name: "geo", params: { lat: 1, lon: 2 } });
});

test("runScript honours order, timing at speed, and stopOnError/continue", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const target = {
    async action(name: string, params: Record<string, unknown> = {}) {
      calls.push([name, params]);
      if (name === "boom") throw new Error("nope");
      return { ok: true };
    },
  };
  const script: ReplayScript = {
    version: 1,
    steps: [
      { t: 0, action: "button", button: "home" },
      { t: 400, action: "boom" },
      { t: 800, action: "text", text: "after" },
    ],
  };
  const started = Date.now();
  const stopped = await runScript(script, target, { speed: 4 });
  const elapsed = Date.now() - started;
  assert.deepEqual(stopped, { ok: 1, failed: 1, skipped: 1 });
  assert.ok(elapsed >= 90 && elapsed < 1_000, `elapsed ${elapsed}ms (400ms gap / 4x)`);
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["button", "boom"],
  );

  calls.length = 0;
  const outcomes: boolean[] = [];
  const cont = await runScript(script, target, { wait: false, stopOnError: false, onStep: (_i, _s, o) => outcomes.push(o.ok) });
  assert.deepEqual(cont, { ok: 2, failed: 1, skipped: 0 });
  assert.deepEqual(outcomes, [true, false, true]);
  assert.deepEqual(calls[2], ["text", { text: "after" }]);
});

// ── MCP ────────────────────────────────────────────────────────────────────

test("compactUiTree keeps labelled/interactive nodes with normalized centers", () => {
  const compact = compactUiTree(dump());
  assert.deepEqual(compact.screen, { width: 1000, height: 2000 });
  const labels = compact.nodes.map((n) => n.text ?? n.desc);
  assert.deepEqual(labels, ["Welcome", "Search", "Sign in", "Sign in with Google", "Email"]);
  const email = compact.nodes.find((n) => n.desc === "Email")!;
  assert.equal(email.editable, true);
  assert.equal(email.focused, true);
  assert.equal(email.id, "email");
  assert.deepEqual([email.x, email.y], [0.5, 0.275]);
});

test("MCP handler: initialize negotiation, tools/list, ping, unknown method/tool", async () => {
  const server = await createMcpServer({ version: "test" });
  try {
    const init = (await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })) as { result: { protocolVersion: string; capabilities: unknown; serverInfo: { name: string } } };
    assert.equal(init.result.protocolVersion, "2024-11-05");
    assert.equal(init.result.serverInfo.name, "serve-avd");
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
    const initFuture = (await server.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } })) as { result: { protocolVersion: string } };
    assert.equal(initFuture.result.protocolVersion, "2025-06-18");

    assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
    assert.deepEqual(await server.handle({ jsonrpc: "2.0", id: 3, method: "ping" }), { jsonrpc: "2.0", id: 3, result: {} });

    const list = (await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/list" })) as { result: { tools: Array<{ name: string; inputSchema: { type: string; properties: Record<string, unknown> } }> } };
    const names = list.result.tools.map((t) => t.name);
    for (const expected of ["screenshot", "tap", "type_text", "press_button", "swipe", "ui_tree", "find", "wait_for", "foreground", "event_log", "open_url", "launch_app", "snapshot", "set_location", "device_action"]) {
      assert.ok(names.includes(expected), `tool ${expected} missing`);
    }
    for (const t of list.result.tools) {
      assert.equal(t.inputSchema.type, "object");
      assert.ok("device" in t.inputSchema.properties, `${t.name} lacks device param`);
    }

    const bad = (await server.handle({ jsonrpc: "2.0", id: 5, method: "nope/nope" })) as { error: { code: number } };
    assert.equal(bad.error.code, -32601);
    const badTool = (await server.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } })) as { error: { code: number } };
    assert.equal(badTool.error.code, -32602);
  } finally {
    server.close();
  }
});
