/** Each custom viewer owns an encoder, so one browser's profile cannot alter another. */
import { spawn, type ChildProcess } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { adbPath } from "./adb";
import { fitToCap } from "./capture";
import { AvccEncoder, wrapEnvelope, AVCC_TAG_SEED } from "./h264";
import type { StreamQuality } from "./workspace-types";
const active = new Map<string, number>();
export function parseQuality(value: Record<string, unknown>): StreamQuality {
  const resolution = value.resolution ?? "native",
    fps = Number(value.fps ?? 30),
    bitRateMbps = Number(value.bitRateMbps ?? 4);
  if (!["native", "1080p", "720p", "540p"].includes(String(resolution)))
    throw new Error("Invalid resolution");
  if (![15, 30, 60].includes(fps))
    throw new Error("Frame rate must be 15, 30 or 60");
  if (!Number.isFinite(bitRateMbps) || bitRateMbps < 1 || bitRateMbps > 12)
    throw new Error("Bitrate must be 1–12 Mbps");
  return {
    resolution: resolution as StreamQuality["resolution"],
    fps: fps as StreamQuality["fps"],
    bitRateMbps,
    adaptive: value.adaptive === true || value.adaptive === "true",
  };
}
export function qualitySize(
  quality: StreamQuality,
  size: { width: number; height: number },
): string {
  const cap =
    quality.resolution === "native"
      ? Math.max(size.width, size.height)
      : (Number(quality.resolution.slice(0, -1)) *
          Math.max(size.width, size.height)) /
        Math.min(size.width, size.height);
  return fitToCap(size.width, size.height, cap);
}
export function qualityEncoderArgs(quality: StreamQuality): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-probesize",
    "32",
    "-analyzeduration",
    "0",
    "-use_wallclock_as_timestamps",
    "1",
    "-flags",
    "low_delay",
    "-f",
    "h264",
    "-i",
    "pipe:0",
    "-an",
    // select caps real changing frames; fps duplicates static frames and waits for the next input.
    "-vf",
    `select=isnan(prev_selected_t)+gte(t-prev_selected_t\\,${1 / quality.fps})`,
    "-fps_mode",
    "passthrough",
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-preset",
    "ultrafast",
    "-tune",
    "zerolatency",
    "-b:v",
    `${quality.bitRateMbps}M`,
    "-maxrate",
    `${quality.bitRateMbps}M`,
    "-bufsize",
    `${quality.bitRateMbps}M`,
    "-g",
    String(quality.fps),
    "-f",
    "h264",
    "pipe:1",
  ];
}
export function handleQualityStream(
  serial: string,
  size:
    | { width: number; height: number }
    | (() => { width: number; height: number }),
  quality: StreamQuality,
  _req: IncomingMessage,
  res: ServerResponse,
  seed?: () => Promise<Buffer | null>,
): void {
  if ((active.get(serial) ?? 0) >= 4) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "custom_stream_limit",
        message: "At most four custom streams per device",
      }),
    );
    return;
  }
  active.set(serial, (active.get(serial) ?? 0) + 1);
  let stopped = false,
    generation = 0;
  let capture: ChildProcess | undefined, encoder: ChildProcess | undefined;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let rotationTimer: ReturnType<typeof setInterval> | undefined;
  const dimensions = () => (typeof size === "function" ? size() : size);
  let geometry = dimensions();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    generation++;
    active.set(serial, Math.max(0, (active.get(serial) ?? 1) - 1));
    if (restartTimer) clearTimeout(restartTimer);
    if (settleTimer) clearTimeout(settleTimer);
    if (rotationTimer) clearInterval(rotationTimer);
    capture?.kill("SIGKILL");
    encoder?.kill("SIGKILL");
  };
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Cache-Control": "no-cache, no-store",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  res.once("close", stop);
  res.once("error", stop);
  let videoFrame = false;
  const sendSeed = () => {
    if (seed)
      void seed()
        .then((data) => {
          if (data && !stopped && !videoFrame && !res.destroyed)
            res.write(wrapEnvelope(AVCC_TAG_SEED, data));
        })
        .catch(() => {});
  };
  sendSeed();
  const start = () => {
    if (stopped) return;
    const current = ++generation;
    geometry = dimensions();
    const parser = new AvccEncoder();
    const recorder = spawn(
      adbPath(),
      [
        "-s",
        serial,
        "exec-out",
        "screenrecord",
        "--output-format=h264",
        "--time-limit",
        "179",
        "--size",
        qualitySize(quality, geometry),
        "--bit-rate",
        String(Math.round(quality.bitRateMbps * 1e6)),
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const transcoder = spawn(
      process.env.SERVE_AVD_FFMPEG || "ffmpeg",
      qualityEncoderArgs(quality),
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    capture = recorder;
    encoder = transcoder;
    recorder.stdout!.pipe(transcoder.stdin!);
    recorder.stderr!.resume();
    transcoder.stderr!.resume();
    transcoder.stdin!.on("error", () => {});
    const forward = (events: ReturnType<AvccEncoder["push"]>) => {
      if (stopped || generation !== current) return;
      for (const event of events) {
        if (res.writableLength > 2 * 1024 * 1024) {
          res.destroy();
          return;
        }
        if (event.kind === "keyframe" || event.kind === "delta")
          videoFrame = true;
        res.write(event.envelope);
      }
    };
    transcoder.stdout!.on("data", (chunk: Buffer) => {
      if (generation !== current) return;
      forward(parser.push(chunk));
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => forward(parser.flush()), 25);
    });
    recorder.on("error", () => res.destroy());
    transcoder.on("error", () => res.destroy());
    recorder.on("close", (code) => {
      transcoder.stdin!.end();
      if (code !== 0 && !stopped && generation === current) res.destroy();
    });
    transcoder.on("close", (code) => {
      recorder.kill("SIGKILL");
      if (stopped || generation !== current) return;
      if (code !== 0) {
        res.destroy();
        return;
      }
      restartTimer = setTimeout(start, 250);
      restartTimer.unref();
    });
  };
  start();
  rotationTimer = setInterval(() => {
    const next = dimensions();
    if (next.width !== geometry.width || next.height !== geometry.height) {
      generation++;
      if (restartTimer) clearTimeout(restartTimer);
      capture?.kill("SIGKILL");
      encoder?.kill("SIGKILL");
      if (settleTimer) clearTimeout(settleTimer);
      videoFrame = false;
      sendSeed();
      start();
    }
  }, 1000);
  rotationTimer.unref();
}
