import { randomUUID } from "node:crypto";
import type {
  CrashReport,
  InstalledApp,
  PerformanceSample,
} from "./workspace-types";

/** AndroidRuntime lines carry a pid: interleaved logcat traffic must not pollute a trace. */
export class CrashCollector {
  readonly reports: CrashReport[] = [];
  private pending: (CrashReport & { pid: string | null }) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private history: { at: number; line: string }[] = [];
  constructor(
    private device: string,
    private onCrash: (report: CrashReport) => void,
  ) {}
  feed(line: string, now = Date.now()): void {
    this.history.push({ at: now, line });
    this.history = this.history
      .filter((item) => item.at >= now - 10_000)
      .slice(-500);
    const runtime = /AndroidRuntime(?:\s*\(\s*(\d+)\))?\s*:\s*(.*)/.exec(line);
    const native = /(?:Fatal signal \d+|>>>\s*([\w.]+)\s*<<<)/.exec(line);
    if (runtime && /FATAL EXCEPTION:/.test(runtime[2]!)) {
      this.flush();
      this.pending = {
        id: randomUUID(),
        device: this.device,
        timestamp: new Date(now).toISOString(),
        packageName: null,
        thread: runtime[2]!.split("FATAL EXCEPTION:")[1]!.trim(),
        exception: "Fatal exception",
        message: "",
        lines: [],
        logs: this.history.map((item) => item.line),
        pid: runtime[1] ?? null,
      };
    } else if (!this.pending && native && /Fatal signal/.test(line)) {
      const report: CrashReport = {
        id: randomUUID(),
        device: this.device,
        timestamp: new Date(now).toISOString(),
        packageName: /name:.*?\(([^)]+)\)/.exec(line)?.[1] ?? null,
        thread: "native",
        exception: /Fatal signal[^,)]+/.exec(line)?.[0] ?? "Native crash",
        message: line,
        lines: [line],
        logs: this.history.map((item) => item.line),
      };
      this.publish(report);
    }
    if (
      this.pending &&
      runtime &&
      (!this.pending.pid || !runtime[1] || runtime[1] === this.pending.pid)
    ) {
      const body = runtime[2]!;
      this.pending.lines.push(body);
      if (this.pending.lines.length > 300) this.flush();
      else {
        const process = /^Process:\s*([^,]+)/.exec(body);
        if (process) this.pending.packageName = process[1]!;
        const exception = /^([\w.$]+(?:Exception|Error))(?::\s*(.*))?$/.exec(
          body,
        );
        if (exception) {
          this.pending.exception = exception[1]!;
          this.pending.message = exception[2] ?? "";
        }
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), 450);
        this.timer.unref();
      }
    }
  }
  private publish(report: CrashReport): void {
    this.reports.push(report);
    if (this.reports.length > 30) this.reports.shift();
    this.onCrash(report);
  }
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending) return;
    const { pid: _pid, ...report } = this.pending;
    this.pending = null;
    this.publish(report);
  }
  close(): void {
    this.flush();
  }
}

export function parsePackageMetadata(
  packageName: string,
  dump: string,
): InstalledApp {
  return {
    packageName,
    versionName: /\bversionName=([^\s]+)/.exec(dump)?.[1] ?? "unknown",
    versionCode: /\bversionCode=(\d+)/.exec(dump)?.[1] ?? "unknown",
    debuggable: /\bDEBUGGABLE\b/.test(dump),
    ...(/firstInstallTime=([^\n\r]+)/.exec(dump)?.[1]
      ? { installedAt: /firstInstallTime=([^\n\r]+)/.exec(dump)![1]!.trim() }
      : {}),
    ...(/lastUpdateTime=([^\n\r]+)/.exec(dump)?.[1]
      ? { updatedAt: /lastUpdateTime=([^\n\r]+)/.exec(dump)![1]!.trim() }
      : {}),
  };
}
export function parseCpuPercent(
  packageName: string,
  dump: string,
): number | null {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const values = [
    ...dump.matchAll(
      new RegExp("([\\d.]+)%\\s+\\d+/" + escaped + "(?:\\s|:)", "g"),
    ),
  ].map((m) => Number(m[1]));
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
}
export function parseMemoryMb(dump: string): number | null {
  const value =
    /TOTAL PSS:\s*(\d+)/.exec(dump)?.[1] ??
    /^\s*TOTAL\s+(\d+)/m.exec(dump)?.[1];
  return value ? Number(value) / 1024 : null;
}
/** SurfaceFlinger latency timestamps are nanoseconds; only fresh completed frames count. */
export function parseSurfaceFps(
  dump: string,
  uptimeSeconds?: number,
): number | null {
  const times = dump
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length === 3)
    .map((cols) => Number(cols[1]))
    .filter((value) => value > 0 && value < 9e18);
  const ordered = [...new Set(times)].sort((a, b) => a - b);
  if (ordered.length < 2) return null;
  if (
    uptimeSeconds !== undefined &&
    uptimeSeconds * 1e9 - ordered.at(-1)! > 2e9
  )
    return 0;
  const duration = (ordered.at(-1)! - ordered[0]!) / 1e9;
  return duration > 0 ? Math.min(240, (ordered.length - 1) / duration) : null;
}
export async function collectPerformance(
  shell: { run(cmd: string): Promise<string> },
  packageName: string | null,
  counters: { fps: number; mbps: number },
): Promise<PerformanceSample> {
  const sample: PerformanceSample = {
    timestamp: new Date().toISOString(),
    packageName,
    cpuPercent: null,
    memoryMb: null,
    appFps: null,
    streamFps: counters.fps,
    streamMbps: counters.mbps,
    unavailable: [],
  };
  if (!packageName || !/^[\w.]+$/.test(packageName)) {
    sample.unavailable.push("No foreground app");
    return sample;
  }
  const [cpu, mem, layers] = await Promise.all([
    shell.run("dumpsys cpuinfo").catch(() => ""),
    shell.run(`dumpsys meminfo ${packageName}`).catch(() => ""),
    shell.run("dumpsys SurfaceFlinger --list").catch(() => ""),
  ]);
  sample.cpuPercent = parseCpuPercent(packageName, cpu);
  sample.memoryMb = parseMemoryMb(mem);
  const layer = layers
    .split("\n")
    .find(
      (line) => line.includes(packageName) && !line.startsWith("Background"),
    );
  if (layer) {
    const quoted = "'" + layer.replace(/'/g, "'\\''") + "'";
    const [timings, uptime] = await Promise.all([
      shell.run(`dumpsys SurfaceFlinger --latency ${quoted}`).catch(() => ""),
      shell.run("cat /proc/uptime").catch(() => ""),
    ]);
    sample.appFps = parseSurfaceFps(
      timings,
      Number(uptime.split(" ")[0]) || undefined,
    );
  }
  if (sample.cpuPercent === null)
    sample.unavailable.push("CPU sample unavailable");
  if (sample.memoryMb === null)
    sample.unavailable.push("App memory unavailable");
  if (sample.appFps === null)
    sample.unavailable.push("App frame timing unavailable on this image");
  return sample;
}
