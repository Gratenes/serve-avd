import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { serveMediaFile } from "./media-response";

type SharedFile = { path: string; format: string };
/** Session-scoped capabilities; capture eviction/closure also invalidates access. */
export class CaptureShares {
  private links = new Map<string, { key: string; expires: number; file: () => SharedFile | null }>();
  constructor(private base = "", private now = Date.now) {}
  create(key: string, file: () => SharedFile | null) {
    for (const [token, link] of this.links) {
      if (link.expires <= this.now() || !link.file()) this.links.delete(token);
      else if (link.key === key) return { url: `${this.base}/share/${token}`, expiresAt: link.expires };
    }
    if (!file()) throw new Error("Capture unavailable");
    if (this.links.size >= 1000) throw new Error("Share link limit reached");
    const token = randomBytes(32).toString("base64url");
    const expires = this.now() + 7 * 24 * 60 * 60 * 1000;
    this.links.set(token, { key, file, expires });
    return { url: `${this.base}/share/${token}`, expiresAt: expires };
  }
  revoke(key: string) {
    for (const [token, link] of this.links) if (link.key === key) this.links.delete(token);
  }
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const path = (req.url ?? "/").split("?")[0]!;
    if (!path.startsWith(`${this.base}/share/`)) return false;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    const match = /^([A-Za-z0-9_-]{43})(\/file)?$/.exec(path.slice(`${this.base}/share/`.length));
    const link = match && this.links.get(match[1]!);
    const file = link && link.expires > this.now() ? link.file() : null;
    if (!file || !match) { res.writeHead(404); res.end("This share link has expired or is unavailable."); return true; }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }); res.end(); return true;
    }
    if (match[2]) {
      try {
        serveMediaFile(req, res, file.path, {
          "Content-Type": file.format === "mp4" || file.format === "webm" ? `video/${file.format}` : `image/${file.format}`,
          "Content-Disposition": `inline; filename="capture.${file.format}"`,
        });
      } catch { res.writeHead(404); res.end("Capture unavailable"); }
      return true;
    }
    res.setHeader("Content-Security-Policy", "default-src 'none'; media-src 'self'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // Relative URL keeps deployment base paths intact without interpolating request headers.
    const url = `${match[1]}/file`;
    const media = ["mp4", "webm"].includes(file.format)
      ? `<video src="${url}" controls playsinline preload="metadata"></video>`
      : `<img src="${url}" alt="Shared capture">`;
    res.end(req.method === "HEAD" ? undefined : `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shared capture · serve-avd</title><style>body{margin:0;background:#101214;color:#edf0f4;font:16px system-ui}main{max-width:1100px;margin:auto;padding:24px}header{display:flex;align-items:center;justify-content:space-between;gap:16px}h1{font-size:20px}a{color:#7cebc4}video,img{display:block;width:100%;height:calc(100dvh - 160px);object-fit:contain;background:#08090a;border-radius:12px}p{color:#a6adb5;font-size:13px}</style><main><header><h1>Shared capture</h1><a href="${url}" download="capture.${file.format}">Download</a></header>${media}<p>Read-only capture · Link expires after seven days and may be revoked earlier.</p></main></html>`);
    return true;
  }
}
