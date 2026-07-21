import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUiAutomatorXml } from "../src/ax";
import { textToSteps, UnsupportedCharacterError, shellQuote } from "../src/keymap";
import { parseRotation } from "../src/adb";
import { parseMultiTouchDevice, displayToNatural } from "../src/input";

test("parseUiAutomatorXml builds a tree with bounds and flags", () => {
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="1"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.android.launcher" content-desc="" checkable="false" clickable="false" enabled="true" bounds="[0,0][2400,1080]"><node index="0" text="Say &quot;hi&quot; &amp; wave" resource-id="com.app:id/greeting" class="android.widget.TextView" package="com.app" content-desc="Greeting" clickable="true" enabled="true" bounds="[10,20][300,80]" /></node></hierarchy>`;
  const dump = parseUiAutomatorXml(xml);
  assert.equal(dump.rotation, 1);
  assert.equal(dump.root?.class, "android.widget.FrameLayout");
  assert.equal(dump.root?.children?.length, 1);
  const child = dump.root!.children![0]!;
  assert.equal(child.text, 'Say "hi" & wave');
  assert.equal(child.resourceId, "com.app:id/greeting");
  assert.equal(child.clickable, true);
  assert.deepEqual(child.bounds, { left: 10, top: 20, right: 300, bottom: 80 });
});

test("textToSteps chunks text and maps newline/tab to keyevents", () => {
  const steps = textToSteps("ab\ncd\te", 2);
  assert.deepEqual(steps, [
    { kind: "text", text: "ab" },
    { kind: "key", keycode: 66 },
    { kind: "text", text: "cd" },
    { kind: "key", keycode: 61 },
    { kind: "text", text: "e" },
  ]);
  assert.throws(() => textToSteps("héllo"), UnsupportedCharacterError);
});

test("shellQuote survives single quotes", () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
});

test("parseRotation understands assorted dumpsys formats", () => {
  assert.equal(parseRotation("mCurrentRotation=1"), 1);
  assert.equal(parseRotation("mCurrentRotation=ROTATION_270"), 3);
  assert.equal(parseRotation("... rotation=ROTATION_90 ..."), 1);
  assert.equal(parseRotation("rotation: 2"), 2);
  assert.equal(parseRotation("SurfaceOrientation: 3"), 3);
  assert.equal(parseRotation("nothing here"), null);
});

test("parseMultiTouchDevice picks the MT panel with ranges", () => {
  const out = `
add device 1: /dev/input/event2
  name:     "virtio_input_rotary"
  events:
    REL (0002): 0008
add device 2: /dev/input/event4
  name:     "virtio_input_multi_touch_1"
  events:
    KEY (0001): 014a
    ABS (0003): 002f  : value 0, min 0, max 9, fuzz 0, flat 0, resolution 0
                0035  : value 0, min 0, max 32767, fuzz 0, flat 0, resolution 0
                0036  : value 0, min 0, max 32767, fuzz 0, flat 0, resolution 0
`;
  const device = parseMultiTouchDevice(out);
  assert.deepEqual(device, {
    path: "/dev/input/event4",
    maxX: 32767,
    maxY: 32767,
    hasBtnTouch: true,
  });
});

test("displayToNatural round-trips the four rotations", () => {
  // A point near the top-left in display space for each rotation maps into
  // distinct natural-space corners; identity at rotation 0.
  assert.deepEqual(displayToNatural(0.25, 0.5, 0), [0.25, 0.5]);
  assert.deepEqual(displayToNatural(0, 0, 1), [1, 0]);
  assert.deepEqual(displayToNatural(0, 0, 2), [1, 1]);
  assert.deepEqual(displayToNatural(0, 0, 3), [0, 1]);
});
