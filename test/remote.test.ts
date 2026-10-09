import { test } from "node:test";
import assert from "node:assert/strict";
import { REMOTE_BUTTONS, RemoteInput, remoteShortcut } from "../src/client/remote-controls";
import { BUTTONS } from "../src/keymap";

const key = (code: string, overrides = {}) => ({
  code, repeat: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...overrides,
});

test("remote commands all use existing Android button mappings", () => {
  for (const [button] of REMOTE_BUTTONS) assert.ok(BUTTONS[button]?.keycode, button);
  assert.equal(BUTTONS[remoteShortcut(key("Enter"), false)!]?.keycode, 23);
  assert.equal(BUTTONS[remoteShortcut(key("Escape"), false)!]?.keycode, 4);
  assert.equal(BUTTONS[remoteShortcut(key("ArrowLeft"), true)!]?.keycode, 21);
});

test("remote shortcuts preserve native button activation and browser shortcuts", () => {
  assert.equal(remoteShortcut(key("Enter"), true), null);
  assert.equal(remoteShortcut(key("NumpadEnter"), true), null);
  assert.equal(remoteShortcut(key("Space"), true), null);
  assert.equal(remoteShortcut(key("Tab"), false), null);
  assert.equal(remoteShortcut(key("ArrowLeft", { altKey: true }), false), null);
  assert.equal(remoteShortcut(key("ArrowLeft", { metaKey: true }), false), null);
  assert.equal(remoteShortcut(key("ArrowLeft", { ctrlKey: true }), false), null);
  assert.equal(remoteShortcut(key("ArrowLeft", { shiftKey: true }), false), null);
});

test("remote commands stay bound to their device and never replay after reconnect", () => {
  const sent: string[] = [];
  const first = new RemoteInput((button) => sent.push(`first:${button}`));
  const second = new RemoteInput((button) => sent.push(`second:${button}`));
  first.visible = second.visible = true;
  first.press("power");
  first.connected = second.connected = true;
  first.press("home");
  second.press("back");
  first.connected = false;
  first.press("power");
  second.press("dpad-center");
  first.connected = true;
  assert.deepEqual(sent, ["first:home", "second:back", "second:dpad-center"]);
  first.visible = false;
  first.press("volume-up");
  assert.equal(sent.length, 3);
});
