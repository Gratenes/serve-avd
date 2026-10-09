import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Serve capture bytes after the caller has checked access with seeking support for browser video players. */
export function serveMediaFile(req: IncomingMessage, res: ServerResponse, path: string,
  headers: Record<string, string>): void {
  const size = statSync(path).size;
  let start = 0, end = size - 1;
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    let valid = !!match && !!(match[1] || match[2]);
    if (match && valid) {
      if (!match[1]) {
        const suffix = Number(match[2]);
        valid = Number.isSafeInteger(suffix) && suffix > 0;
        start = Math.max(0, size - suffix);
      } else {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      }
      valid &&= Number.isSafeInteger(start) && Number.isSafeInteger(end) && start < size && end >= start;
    }
    if (!valid) {
      res.writeHead(416, { ...headers, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
      res.end(); return;
    }
  }
  res.writeHead(range ? 206 : 200, {
    ...headers, 'Accept-Ranges': 'bytes', 'Content-Length': range ? end - start + 1 : size,
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  });
  if (req.method === 'HEAD' || size === 0) { res.end(); return; }
  const stream = createReadStream(path, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
