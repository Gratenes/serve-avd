import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  CrashCollector,
  parseCpuPercent,
  parseMemoryMb,
  parsePackageMetadata,
  parseSurfaceFps,
} from "../src/observability";
import { DeviceMedia, ffmpeg } from "../src/workspace-media";
import { recordEventLogEvent } from "../src/event-log";
import {
  validateApkFilename,
  validateSnapshotName,
  WorkspaceService,
} from "../src/workspace";
import { parseQuality, qualitySize } from "../src/quality-stream";

test("crash traces isolate runtime pid, keep app frames, and include preceding logs", () => {
  const reports: any[] = [];
  const collector = new CrashCollector("device-a", (r) => reports.push(r));
  collector.feed("10-09 12:00:00.000 I Activity: playback", 1000);
  collector.feed(
    "10-09 12:00:01.000 E AndroidRuntime( 123): FATAL EXCEPTION: main",
    2000,
  );
  collector.feed(
    "10-09 12:00:01.001 E AndroidRuntime( 123): Process: org.viptv.app, PID: 123",
    2001,
  );
  collector.feed(
    "10-09 12:00:01.002 E AndroidRuntime( 888): other app stack",
    2002,
  );
  collector.feed(
    "10-09 12:00:01.003 E AndroidRuntime( 123): java.lang.NullPointerException: player missing",
    2003,
  );
  collector.feed(
    "10-09 12:00:01.004 E AndroidRuntime( 123): at org.viptv.app.Player.onResume(Player.kt:88)",
    2004,
  );
  collector.flush();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].packageName, "org.viptv.app");
  assert.equal(reports[0].exception, "java.lang.NullPointerException");
  assert.equal(reports[0].lines.length, 4);
  assert.ok(reports[0].logs.some((line: string) => line.includes("playback")));
  collector.close();
});
test("observed metric parsers avoid similarly named apps and stale frame rates", () => {
  assert.equal(
    parseCpuPercent(
      "org.viptv.app",
      " 15% 123/org.viptv.app: 10% user\n 90% 456/org.viptv.app.beta: 90% user\n 3% 124/org.viptv.app:player: 2% user",
    ),
    18,
  );
  assert.equal(parseMemoryMb("TOTAL PSS: 102400"), 100);
  assert.equal(parseMemoryMb("Permission Denial"), null);
  assert.equal(
    parseSurfaceFps(
      "16666666\n1 1000000000 2\n2 1016666667 3\n3 1033333334 4",
      10,
    ),
    0,
  );
  assert.ok(
    Math.abs(
      parseSurfaceFps(
        "16666666\n1 1000000000 2\n2 1016666667 3\n3 1033333334 4",
        1.1,
      )! - 60,
    ) < 0.1,
  );
  assert.deepEqual(
    parsePackageMetadata(
      "org.viptv.app",
      "versionCode=142 minSdk=21\nversionName=1.4.2\nflags=[ DEBUGGABLE HAS_CODE ]",
    ),
    {
      packageName: "org.viptv.app",
      versionName: "1.4.2",
      versionCode: "142",
      debuggable: true,
    },
  );
});
test("upload/default/profile validation confines host paths and profile scope", () => {
  assert.equal(validateApkFilename("../../app-debug.apk"), "app-debug.apk");
  assert.throws(() => validateApkFilename("bad.aab"), /conversion/);
  assert.throws(() => validateSnapshotName("../../bad"));
  assert.equal(validateSnapshotName("logged-in"), "logged-in");
  assert.throws(() => parseQuality({ fps: 90 }));
  assert.throws(() => parseQuality({ bitRateMbps: 0 }));
  assert.equal(
    qualitySize(parseQuality({ resolution: "720p" }), {
      width: 1920,
      height: 1080,
    }),
    "1280x720",
  );
});
test("actual ffmpeg artifacts support MP4, WebM, GIF, trim, key burn and matching log range", async () => {
  const dir = mkdtempSync(join(tmpdir(), "avd-media-test-"));
  try {
    const png = join(dir, "frame.png");
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=green:s=160x90",
      "-frames:v",
      "1",
      png,
    ]);
    const frame = readFileSync(png);
    const logs: { at: number; line: string }[] = [];
    const media = new DeviceMedia(
      "fixture-device",
      dir,
      (start, end) => logs.filter((l) => l.at >= start && l.at <= end),
      async () => frame,
    );
    const state = await media.start({
      format: "mp4",
      maxSeconds: 10,
      attachLogs: true,
    });
    const keyAt = Date.now();
    logs.push({ at: keyAt, line: "inside recording" });
    recordEventLogEvent({
      device: "fixture-device",
      source: "hid",
      kind: "button",
      summary: "Button DOWN",
      details: { button: "down" },
    });
    await new Promise((r) => setTimeout(r, 1250));
    const mp4 = await media.stop();
    assert.ok(mp4.bytes > 100);
    const probe = JSON.parse(
      execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_format",
          "-show_streams",
          "-of",
          "json",
          media.path(mp4.id),
        ],
        { encoding: "utf8" },
      ),
    );
    assert.equal(probe.streams[0].codec_name, "h264");
    assert.ok(Number(probe.format.duration) < 3);
    assert.ok(Number(probe.format.duration) >= 1);
    const gif = await media.convert(mp4.id, {
      format: "gif",
      trimStart: 0,
      trimEnd: 0.75,
      burnKeys: true,
    });
    assert.equal(
      readFileSync(media.path(gif.id)).subarray(0, 3).toString(),
      "GIF",
    );
    assert.equal(
      readFileSync(media.path(gif.id, "logs"), "utf8"),
      "inside recording",
    );
    const webm = await media.convert(mp4.id, {
      format: "webm",
      trimStart: 0.8,
      trimEnd: 1.1,
    });
    const webmProbe = JSON.parse(
      execFileSync(
        "ffprobe",
        ["-v", "error", "-show_streams", "-of", "json", media.path(webm.id)],
        { encoding: "utf8" },
      ),
    );
    assert.equal(webmProbe.streams[0].codec_name, "vp9");
    assert.equal(readFileSync(media.path(webm.id, "logs"), "utf8"), "");
    assert.throws(() => media.path("../../etc/passwd"));
    media.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
