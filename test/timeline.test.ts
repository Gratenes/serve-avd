import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { rangeToMacro, selectedEvents } from "../src/client/timeline-model";
import { zipFiles, zipText } from "../src/client/zip";
import type { EventLogEntry } from "../src/event-log";
const event = (
  id: number,
  at: number,
  kind: string,
  details: Record<string, unknown>,
  device = "tv",
): EventLogEntry => ({
  id,
  timestamp: new Date(at).toISOString(),
  kind,
  device,
  source: "hid",
  summary: kind,
  msg: kind,
  details,
});
test("timeline macros contain actual swipe moves and consume gesture duration exactly once", () => {
  const events = [
    event(1, 1000, "drag", {
      start: { x: 0.1, y: 0.2 },
      current: { x: 0.8, y: 0.9 },
      durationMs: 1200,
    }),
    event(2, 2300, "button", { button: "dpad-center" }),
    event(3, 2400, "key", { code: "ArrowDown" }, "phone"),
  ];
  const result = rangeToMacro(events, "tv");
  assert.equal(result.excluded, 1);
  assert.equal(result.steps[0]?.body?.type, "begin");
  assert.ok(
    result.steps.some(
      (s) =>
        s.body?.type === "move" &&
        Number(s.body.x) > 0.1 &&
        Number(s.body.x) < 0.8,
    ),
  );
  assert.equal(result.steps.at(-2)?.body?.type, "end");
  assert.equal(result.steps.at(-1)?.waitMs, 100);
  assert.equal(
    result.steps.slice(1, -1).reduce((sum, s) => sum + s.waitMs, 0),
    1200,
  );
});
test("excluded settings do not inject waits and filtering is consistent", () => {
  const events = [
    event(1, 1000, "button", { button: "dpad-center" }),
    event(2, 90000, "snapshot", { op: "load", name: "clean" }),
    event(3, 121000, "key", { code: "ArrowDown" }),
  ];
  const result = rangeToMacro(events, "tv");
  assert.equal(result.excluded, 1);
  assert.deepEqual(
    result.steps.map((s) => s.kind),
    ["KEY", "WAIT", "KEY"],
  );
  assert.equal(result.steps.at(-1)?.waitMs, 60000);
  assert.equal(
    selectedEvents(events, 0, 200000, new Set(["settings"])).length,
    2,
  );
});
test("real ZIP has valid UTF8 entries, CRCs and safe paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "avd-zip-"));
  try {
    const file = join(dir, "bundle.zip");
    const zip = zipFiles([
      zipText("../../report.json", { ok: true }),
      zipText("logs/écran.txt", "actual logcat"),
    ]);
    writeFileSync(file, Buffer.from(await zip.arrayBuffer()));
    const result = execFileSync(
      "python3",
      [
        "-c",
        "import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;assert z.namelist()==['report.json','logs/écran.txt'];assert z.read('logs/écran.txt').decode()=='actual logcat';print('validated')",
        file,
      ],
      { encoding: "utf8" },
    );
    assert.match(result, /validated/);
    assert.throws(
      () => zipFiles(Array.from({ length: 65536 }, () => zipText("a", ""))),
      /too many/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
