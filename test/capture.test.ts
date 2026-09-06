import { test } from "node:test";
import assert from "node:assert/strict";
import { fitToCap, shouldReplayGop } from "../src/capture";

test("fitToCap preserves aspect and encoder-safe even dimensions", () => {
  assert.equal(fitToCap(1080, 2400, 1920), "864x1920");
  assert.equal(fitToCap(800, 600, 1920), "800x600");
});

test("late-join replay stays within low-latency frame and byte budgets", () => {
  assert.equal(shouldReplayGop(0, 0), false);
  assert.equal(shouldReplayGop(30, 2 * 1024 * 1024), true);
  assert.equal(shouldReplayGop(31, 1000), false);
  assert.equal(shouldReplayGop(2, 2 * 1024 * 1024 + 1), false);
});
