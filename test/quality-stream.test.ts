import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { AvccDemuxer } from "../src/client/avcc-codec";

test("custom native profiles isolate resolution/fps and restart after recorder EOF", async () => {
  const dir = mkdtempSync(join(tmpdir(), "avd-quality-test-"));
  const sdk = join(dir, "sdk");
  mkdirSync(join(sdk, "platform-tools"), { recursive: true });
  const starts = join(dir, "starts.txt");
  const script = join(sdk, "platform-tools", "adb");
  writeFileSync(
    script,
    `#!/usr/bin/env python3\nimport sys,os\na=sys.argv\ns=a[a.index('--size')+1]\nwith open(${JSON.stringify(starts)},'a') as f:f.write(s+'\\n')\nos.execvp('ffmpeg',['ffmpeg','-hide_banner','-loglevel','error','-re','-f','lavfi','-i','testsrc2=size='+s+':rate=60','-t','1.4','-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-threads','1','-f','h264','pipe:1'])\n`,
  );
  chmodSync(script, 0o755);
  const prior = process.env.ANDROID_HOME;
  process.env.ANDROID_HOME = sdk;
  const { handleQualityStream, parseQuality } =
    await import("../src/quality-stream");
  let geometry = { width: 1280, height: 720 };
  const server = createServer((req, res) =>
    handleQualityStream(
      "fixture",
      () => geometry,
      parseQuality(
        Object.fromEntries(new URL(req.url!, "http://x").searchParams),
      ),
      req,
      res,
      async () => Buffer.from("fixture seed"),
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  const collect = async (profile: string) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 2800);
    const demux = new AvccDemuxer();
    const chunks: any[] = [];
    const start = Date.now();
    let first: number | null = null;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/?${profile}`, {
        signal: abort.signal,
      });
      for await (const bytes of response.body!) {
        for (const chunk of demux.push(bytes)) {
          if (chunk.type === "keyframe" || chunk.type === "delta")
            first ??= Date.now() - start;
          chunks.push(chunk);
        }
      }
    } catch (err) {
      if (!abort.signal.aborted) throw err;
    } finally {
      clearTimeout(timer);
    }
    return { chunks, first };
  };
  try {
    const [low, high] = await Promise.all([
      collect("resolution=540p&fps=15&bitRateMbps=1"),
      collect("resolution=720p&fps=30&bitRateMbps=3"),
    ]);
    for (const [index, result] of [low, high].entries()) {
      assert.ok(
        result.first !== null && result.first < 1800,
        `profile ${index} first encoded frame ${result.first}`,
      );
      assert.ok(result.chunks.some((c) => c.type === "seed"));
      const description = result.chunks.find((c) => c.type === "description")
        .payload as Uint8Array;
      const data = Buffer.from(description);
      const spsLength = data.readUInt16BE(6);
      const sps = data.subarray(8, 8 + spsLength);
      const ppsOffset = 9 + spsLength;
      const ppsLength = data.readUInt16BE(ppsOffset);
      const pps = data.subarray(ppsOffset + 2, ppsOffset + 2 + ppsLength);
      const raw: Buffer[] = [
        Buffer.from([0, 0, 0, 1]),
        sps,
        Buffer.from([0, 0, 0, 1]),
        pps,
      ];
      for (const chunk of result.chunks.filter(
        (c) => c.type === "keyframe" || c.type === "delta",
      )) {
        raw.push(
          Buffer.from([0, 0, 0, 1]),
          Buffer.from(chunk.payload).subarray(4),
        );
      }
      const file = join(dir, `profile-${index}.h264`);
      writeFileSync(file, Buffer.concat(raw));
      const probe = JSON.parse(
        execFileSync(
          "ffprobe",
          ["-v", "error", "-show_streams", "-of", "json", file],
          { encoding: "utf8" },
        ),
      );
      assert.equal(probe.streams[0].width, index ? 1280 : 960);
      assert.equal(probe.streams[0].height, index ? 720 : 540);
      assert.ok(
        result.chunks.filter((c) => c.type === "description").length >= 2,
        "natural recorder EOF restarted pipeline",
      );
    }
    const count = (r: any) =>
      r.chunks.filter((c: any) => c.type === "keyframe" || c.type === "delta")
        .length;
    assert.ok(
      count(high) > count(low) * 1.35,
      `profiles cap changing frames independently: ${count(low)} vs ${count(high)}`,
    );
    const startCount = readFileSync(starts, "utf8").trim().split("\n").length;
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(
      readFileSync(starts, "utf8").trim().split("\n").length,
      startCount,
      "disconnect stopped every producer",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    if (prior === undefined) delete process.env.ANDROID_HOME;
    else process.env.ANDROID_HOME = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
