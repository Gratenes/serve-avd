import test from "node:test";
import assert from "node:assert/strict";
import {
  focusedNode,
  focusRect,
  adaptiveQuality,
} from "../src/client/device-tools";
test("focus finds genuinely focused descendant and maps physical bounds into displayed percentages", () => {
  const root = {
    focused: false,
    children: [
      {
        focused: true,
        text: "Play",
        bounds: { left: 192, top: 108, right: 960, bottom: 540 },
      },
    ],
  };
  assert.equal(focusedNode(root)?.node.text, "Play");
  assert.deepEqual(focusRect(root.children[0]!.bounds, 1920, 1080), {
    left: 10,
    top: 10,
    width: 40,
    height: 40,
  });
  assert.equal(focusedNode({ selected: true }), null);
  assert.equal(
    focusRect({ left: 0, top: 0, right: 0, bottom: 20 }, 1920, 1080),
    null,
  );
});
test("adaptive quality responds to measured pressure and reduces resolution before frame rate", () => {
  const quality = {
    resolution: "1080p",
    fps: 60,
    bitRateMbps: 8,
    adaptive: true,
  } as const;
  const next = adaptiveQuality(quality, 250, 0);
  assert.equal(next.resolution, "720p");
  assert.equal(next.fps, 60);
  assert.equal(
    adaptiveQuality({ ...quality, resolution: "540p" }, 250, 0.2).fps,
    30,
  );
  assert.equal(adaptiveQuality(quality, 50, 0), quality);
  const manual = { ...quality, adaptive: false };
  assert.equal(adaptiveQuality(manual, 300, 0.5), manual);
});
