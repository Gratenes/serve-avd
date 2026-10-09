/** Each custom viewer owns an encoder, so one browser's profile cannot alter another. */
import { spawn, type ChildProcess } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { adbPath } from "./adb";
import { fitToCap } from "./capture";
import { AvccEncoder } from "./h264";
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
      ? 1920
      : (Number(quality.resolution.slice(0, -1)) *
          Math.max(size.width, size.height)) /
        Math.min(size.width, size.height);
  return fitToCap(size.width, size.height, cap);
}
export function handleQualityStream(
  serial: string,
  size: { width: number; height: number },
  quality: StreamQuality,
  req: IncomingMessage,
  res: ServerResponse,
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
  let stopped = false;
  let capture: ChildProcess | undefined;
  let encoder: ChildProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    active.set(serial, Math.max(0, (active.get(serial) ?? 1) - 1));
    if (timer) clearTimeout(timer);
    if (settle) clearTimeout(settle);
    capture?.kill("SIGKILL");
    encoder?.kill("SIGKILL");
  };
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Cache-Control": "no-cache, no-store",
    Connection: "keep-alive",
  });
  res.once("close", stop);
  res.once("error", stop);
  const start = () => {
    if (stopped) return;
    const parser = new AvccEncoder();
    capture = spawn(
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
        qualitySize(quality, size),
        "--bit-rate",
        String(Math.round(quality.bitRateMbps * 1e6)),
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    encoder = spawn(
      process.env.SERVE_AVD_FFMPEG || "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "h264",
        "-i",
        "pipe:0",
        "-an",
        "-vf",
        `fps=${quality.fps}`,
        "-c:v",
        "libx264",
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
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    capture.stdout!.pipe(encoder.stdin!);
    capture.stderr!.resume();
    encoder.stderr!.resume();
    encoder.stdin!.on("error", () => {});
    const forward = (events: ReturnType<AvccEncoder["push"]>) => {
      for (const event of events) {
        if (stopped) return;
        if (res.writableLength > 2 * 1024 * 1024) {
          res.destroy();
          return;
        }
        res.write(event.envelope);
      }
    };
    encoder.stdout!.on("data", (chunk: Buffer) => {
      forward(parser.push(chunk));
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => forward(parser.flush()), 25);
    });
    capture.on("error", () => res.destroy());
    encoder.on("error", () => res.destroy());
    encoder.on("close", (code) => {
      capture?.kill("SIGKILL");
      if (stopped) return;
      if (code !== 0) {
        res.destroy();
        return;
      }
      timer = setTimeout(start, 250);
      timer.unref();
    });
  };
  start();
}
