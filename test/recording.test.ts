import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Exercise the actual native recorder and MP4 finalizer. Only the Android transport
// is replaced; ffmpeg produces real moving 60fps video with real timestamps.
test('native recording preserves moving 60fps video, duration and owned-process cleanup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'avd-native-recording-'));
  const sdk = join(dir, 'sdk');
  mkdirSync(join(sdk, 'platform-tools'), { recursive: true });
  const script = `#!/usr/bin/env python3
import sys,os,re,subprocess,shutil,signal
args=sys.argv[3:]
root=${JSON.stringify(dir)}
def local(remote): return os.path.join(root,os.path.basename(remote))
if args[0]=='shell':
 cmd=args[1]
 if cmd.startswith('screenrecord '):
  path=re.search(r'(/data/local/tmp/[^ ]+)',cmd).group(1)
  length=re.search(r'--time-limit (\\d+)',cmd).group(1)
  p=subprocess.Popen(['ffmpeg','-v','error','-y','-re','-f','lavfi','-i','testsrc2=size=320x180:rate=60','-t',length,'-c:v','libx264','-preset','ultrafast','-threads','1','-pix_fmt','yuv420p',local(path)])
  print('SERVE_AVD_PID:'+str(p.pid),flush=True)
  code=p.wait(); sys.exit(0 if code in [0,255] else code)
 elif cmd.startswith('kill -2 '):
  try: os.kill(int(cmd.split()[-1]),signal.SIGINT)
  except ProcessLookupError: pass
 elif cmd.startswith('stat '): print(os.stat(local(cmd.split()[-1])).st_size)
 elif cmd.startswith('rm '):
  try: os.unlink(local(cmd.split()[-1]))
  except FileNotFoundError: pass
elif args[0]=='pull': shutil.copyfile(local(args[1]),args[2])
`;
  writeFileSync(join(sdk, 'platform-tools', 'adb'), script, { mode: 0o755 });
  const previous = process.env.ANDROID_HOME;
  process.env.ANDROID_HOME = sdk;
  const { DeviceMedia } = await import('../src/workspace-media');
  const output = join(dir, 'captures');
  const media = new DeviceMedia('fixture', output, () => []);
  try {
    await media.start({ maxSeconds: 10 });
    await new Promise(r => setTimeout(r, 1500));
    const clip = await media.stop();
    assert.ok(clip.fps! >= 55, `native frame rate ${clip.fps}`);
    assert.ok(clip.duration >= 1 && clip.duration < 2.5, `duration ${clip.duration}`);
    assert.equal(clip.width, 320);
    const hashes = execFileSync('ffmpeg', ['-v','error','-i',media.path(clip.id),'-f','framemd5','-'], { encoding:'utf8' })
      .split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1));
    assert.ok(new Set(hashes).size >= 50, 'contains distinct motion frames, not duplicated screenshots');
    assert.ok(!readdirSync(output).some(name => /part-|concat/.test(name)), 'host segments removed');
    assert.ok(!readdirSync(dir).some(name => name.startsWith('serve-avd-')), 'Android artifacts removed');
    assert.equal(media.recordingError, null);
  } finally {
    media.close();
    if (previous === undefined) delete process.env.ANDROID_HOME; else process.env.ANDROID_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('native recording failure is visible and never published as success', async () => {
  const { DeviceMedia } = await import('../src/workspace-media');
  const dir = mkdtempSync(join(tmpdir(), 'avd-recording-error-'));
  let fail!: (error: Error) => void;
  const done = new Promise<import("../src/native-recording").RecordingPart[]>((_, reject) => { fail = reject; });
  const media = new DeviceMedia('fixture', dir, () => [], undefined, () => ({
    ready: Promise.resolve(), done, stop: async () => {}, abort: () => {},
  }));
  try {
    await media.start();
    fail(new Error('device disconnected'));
    await assert.rejects(media.stop(), /device disconnected/);
    assert.equal(media.captures.length, 0);
    assert.match(media.recordingError!, /disconnected/);
  } finally { media.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a static Android clip with one zero-duration sample becomes a full-length playable recording', async () => {
  const { DeviceMedia } = await import('../src/workspace-media');
  const dir = mkdtempSync(join(tmpdir(), 'avd-static-recording-'));
  const file = join(dir, 'static.mp4');
  execFileSync('ffmpeg', ['-v','error','-y','-f','lavfi','-i','color=c=blue:s=160x90:r=60','-frames:v','1','-c:v','libx264',file]);
  // Reproduce Android's unchanged-screen MP4: one sample, zero duration.
  const data = readFileSync(file);
  for (const [atom, offset] of [['stts',16], ['mdhd',20], ['mvhd',20], ['tkhd',24], ['elst',12]] as const) {
    const index = data.indexOf(atom); assert.ok(index > 0); data.writeUInt32BE(0, index + offset);
  }
  writeFileSync(file, data);
  let finish!: (parts: import('../src/native-recording').RecordingPart[]) => void;
  const done = new Promise<import('../src/native-recording').RecordingPart[]>(resolve => { finish = resolve; });
  const media = new DeviceMedia('static-fixture', dir, () => [], undefined, () => ({
    ready:Promise.resolve(), done,
    stop:async () => { finish([{path:file, startedAt:Date.now()-1200, duration:1.2}]); }, abort:() => {},
  }));
  try {
    await media.start(); const clip = await media.stop();
    assert.ok(clip.duration >= 1.1 && clip.duration <= 1.3, `duration ${clip.duration}`);
    assert.equal(clip.fps, 60);
    const decoded = execFileSync('ffmpeg', ['-v','error','-i',media.path(clip.id),'-f','framemd5','-'], {encoding:'utf8'});
    assert.ok(decoded.split('\n').filter(line=>line && !line.startsWith('#')).length >= 66);
  } finally { media.close(); rmSync(dir,{recursive:true,force:true}); }
});
