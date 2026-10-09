import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveMediaFile } from '../src/media-response';

test('capture responses support video seeking, suffix ranges, HEAD and invalid ranges', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'capture-range-'));
  const path = join(dir, 'clip.mp4'); writeFileSync(path, '0123456789');
  const server = createServer((req, res) => serveMediaFile(req, res, path, { 'Content-Type':'video/mp4' }));
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const range = await fetch(url, { headers:{Range:'bytes=3-5'} });
    assert.equal(range.status,206); assert.equal(range.headers.get('content-range'),'bytes 3-5/10'); assert.equal(await range.text(),'345');
    const tail = await fetch(url, { headers:{Range:'bytes=-2'} }); assert.equal(await tail.text(),'89');
    const rest = await fetch(url, { headers:{Range:'bytes=7-100'} }); assert.equal(await rest.text(),'789');
    const head = await fetch(url, { method:'HEAD' }); assert.equal(head.headers.get('content-length'),'10'); assert.equal(await head.text(),'');
    for (const value of ['bytes=20-', 'bytes=5-2', 'bytes=-0', 'bytes=0-1,4-5']) {
      const response = await fetch(url,{headers:{Range:value}}); assert.equal(response.status,416);
      assert.equal(response.headers.get('content-range'),'bytes */10'); await response.text();
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); rmSync(dir,{recursive:true,force:true}); }
});
