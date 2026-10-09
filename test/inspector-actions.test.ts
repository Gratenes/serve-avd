import { test } from "node:test";
import assert from "node:assert/strict";
import { runAction, type ActionContext } from "../src/actions";

function context(values: Record<string, string> = {}, failWrite = false) {
  const commands: string[] = [], records: unknown[] = [], emu: string[][] = [];
  const ctx = {
    serial: "emulator-5554",
    shell: {
      run: async (command: string) => { commands.push(command); return values[command] ?? "null"; },
      runWithCode: async (command: string) => { commands.push(command); return { code: failWrite ? 1 : 0, out: failWrite ? "Permission denied" : "" }; },
    },
    emu: async (args: string[]) => { emu.push(args); return "OK"; },
    record: (entry: unknown) => { records.push(entry); },
  } as unknown as ActionContext;
  return { ctx, commands, records, emu };
}

test("high contrast reads without writing and writes the Android secure preference", async () => {
  const h = context({ "settings get secure high_text_contrast_enabled": "1\n" });
  assert.deepEqual(await runAction(h.ctx, "high-contrast"), { enabled: true });
  assert.equal(h.records.length, 0);
  assert.deepEqual(await runAction(h.ctx, "high-contrast", { enabled: false }), { enabled: false });
  assert.deepEqual(h.commands, ["settings get secure high_text_contrast_enabled", "settings put secure high_text_contrast_enabled 0"]);
  assert.equal(h.records.length, 1);
  await assert.rejects(runAction(h.ctx, "high-contrast", { enabled: "invalid" }), /must be on/);
  await assert.rejects(runAction(context({}, true).ctx, "high-contrast", { enabled: true }), /Permission denied/);
});

test("debug readback identifies partial animation overrides as unknown", async () => {
  const h = context({
    "getprop debug.hwui.overdraw": "show", "getprop debug.hwui.profile": "false", "getprop debug.layout": "false",
    "settings get system show_touches": "1", "settings get system pointer_location": "0",
    "settings get global window_animation_scale": "1", "settings get global transition_animation_scale": "5", "settings get global animator_duration_scale": "5",
  });
  assert.deepEqual(await runAction(h.ctx, "debug"), { flags: {
    overdraw: true, "gpu-profile": false, "layout-bounds": false, "show-taps": true, "pointer-location": false, "slow-animations": null,
  } });
  assert.equal(h.records.length, 0);
});

test("font and TalkBack readback report actual settings and reject invalid font output", async () => {
  const h = context({ "settings get system font_scale": "1.5", "settings get secure accessibility_enabled": "1", "settings get secure enabled_accessibility_services": "org.example.other/.Service" });
  assert.deepEqual(await runAction(h.ctx, "font-scale"), { scale: 1.5 });
  assert.deepEqual(await runAction(h.ctx, "talkback"), { enabled: false });
  await assert.rejects(runAction(context({ "settings get system font_scale": "Permission denied" }).ctx, "font-scale"), /Could not read font scale/);
});

test("numeric latency reaches emulator console and mobile Off uses the radio switch", async () => {
  const h = context();
  await runAction(h.ctx, "network", { delay: "50" });
  await runAction(h.ctx, "network", { delay: "200" });
  await runAction(h.ctx, "network", { delay: "1000" });
  await runAction(h.ctx, "network", { data: false });
  assert.deepEqual(h.emu, [["network", "delay", "50"], ["network", "delay", "200"], ["network", "delay", "1000"]]);
  assert.deepEqual(h.commands, ["svc data disable"]);
});
