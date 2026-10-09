import { spawn, type ChildProcess } from 'node:child_process';
import { statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { adb, adbPath } from './adb';

export interface RecordingPart { path: string; startedAt: number; duration: number }

export interface NativeRecording {
  ready: Promise<void>;
  done: Promise<RecordingPart[]>;
  stop(): Promise<void>;
  abort(): void;
}

/** Record timestamped MP4 on Android, rather than sampling host screenshots.
 * Each screenrecord process is owned by its PID; never stop other recorders.
 * Android limits each invocation to 180 seconds, so longer recordings use segments.
 */
export function startNativeRecording(serial: string, dir: string, id: string,
  seconds: number, byteLimit: number): NativeRecording {
  let stopped = false, aborted = false;
  let stopDeadline: ReturnType<typeof setTimeout> | null = null;
  let current: { proc: ChildProcess; pid: Promise<number> } | null = null;
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => {});
  const command = (args: string[]) => adb(['-s', serial, ...args], { timeout: 20_000 });
  const signal = async () => {
    const segment = current;
    if (!segment) return;
    const pid = await segment.pid;
    // The process may have finished naturally while the PID was being received.
    if (current === segment && segment.proc.exitCode === null)
      await command(['shell', `kill -2 ${pid}`]);
  };
  const done = (async () => {
    const files: RecordingPart[] = [];
    const deadline = Date.now() + seconds * 1000;
    let bytes = 0;
    try {
      for (let index = 0; !stopped && Date.now() < deadline; index++) {
        const remote = `/data/local/tmp/serve-avd-${id}-${index}.mp4`;
        const local = join(dir, `${id}-part-${index}.mp4`);
        const length = Math.max(1, Math.min(179, Math.ceil((deadline - Date.now()) / 1000)));
        let resolvePid!: (pid: number) => void, rejectPid!: (error: Error) => void;
        const pid = new Promise<number>((resolve, reject) => { resolvePid = resolve; rejectPid = reject; });
        void pid.catch(() => {});
        let startedAt = Date.now();
        let endedAt = startedAt;
        const proc = spawn(adbPath(), ['-s', serial, 'shell',
          `screenrecord --bit-rate 8000000 --time-limit ${length} ${remote} & recorder=$!; echo SERVE_AVD_PID:$recorder; wait $recorder`],
          { stdio: ['ignore', 'pipe', 'pipe'] });
        current = { proc, pid };
        let output = '', error = '';
        const timeout = setTimeout(() => { void signal().catch(() => {}); proc.kill('SIGKILL'); }, (length + 20) * 1000);
        const startup = setTimeout(() => { rejectPid(new Error('Android recorder did not start')); proc.kill('SIGKILL'); }, 10_000);
        proc.stdout!.on('data', chunk => {
          output = (output + chunk).slice(-4000);
          const match = /SERVE_AVD_PID:(\d+)/.exec(output);
          if (match) { clearTimeout(startup); startedAt = Date.now(); resolvePid(Number(match[1])); }
        });
        proc.stderr!.on('data', chunk => { error = (error + chunk).slice(-4000); });
        const exited = new Promise<void>((resolve, reject) => {
          proc.once('error', reject);
          proc.once('close', code => {
            endedAt = Date.now();
            const failure = new Error(error.trim() || output.replace(/SERVE_AVD_PID:\d+\s*/, '').trim() || `Android recorder exited ${code}`);
            rejectPid(failure);
            if (code === 0 || (stopped && code === 130)) resolve(); else reject(failure);
          });
        });
        void exited.catch(() => {});
        try {
          await pid;
          resolveReady();
          await exited;
          current = null;
          if (aborted) throw new Error('Recording cancelled');
          // Check on-device size before pulling to bound host storage.
          const size = Number((await command(['shell', `stat -c %s ${remote}`])).trim());
          if (!Number.isFinite(size) || size <= 0) throw new Error('Android recorder produced no video');
          if (bytes + size > byteLimit) throw new Error('Recording exceeds the 256 MB limit; choose a shorter duration');
          await command(['pull', remote, local]);
          bytes += statSync(local).size;
          files.push({ path: local, startedAt, duration: Math.max(1 / 60, (endedAt - startedAt) / 1000) });
        } finally {
          clearTimeout(startup); clearTimeout(timeout);
          if (stopDeadline) clearTimeout(stopDeadline);
          if (current?.proc === proc) {
            await signal().catch(() => {});
            proc.kill('SIGKILL'); current = null;
          }
          await command(['shell', `rm -f ${remote}`]).catch(() => {});
          if (!files.some(file => file.path === local)) { try { unlinkSync(local); } catch {} }
        }
      }
      if (aborted) throw new Error('Recording cancelled');
      if (!files.length) throw new Error('Android recorder produced no video');
      return files;
    } catch (error) {
      rejectReady(error instanceof Error ? error : new Error(String(error)));
      for (const file of files) { try { unlinkSync(file.path); } catch {} }
      throw error;
    }
  })();
  void done.catch(() => {});
  const stop = async () => {
      stopped = true;
      const segment = current;
      if (segment && !stopDeadline) {
        stopDeadline = setTimeout(() => {
          void segment.pid.then(pid => command(['shell', `kill -9 ${pid}`])).catch(() => {});
          segment.proc.kill('SIGKILL');
        }, 20_000);
        stopDeadline.unref();
      }
      try { await signal(); }
      catch (error) { if (current === segment && segment?.proc.exitCode === null) throw error; }
    };
  return { ready, done, stop,
    abort() { aborted = true; void stop().catch(() => {}); },
  };
}
