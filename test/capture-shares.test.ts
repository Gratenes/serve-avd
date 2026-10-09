import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { CaptureShares } from "../src/capture-shares";

test("share tokens expire, cannot address other resources, and do not survive a new registry", async () => {
  let now = 1000;
  const shares = new CaptureShares("/emu", () => now);
  const file = () => ({ path: "/unused", format: "png" });
  const first = shares.create("capture", file);
  assert.deepEqual(shares.create("capture", file), first);
  const server = createServer((req, res) => { if (!shares.handle(req, res)) { res.writeHead(401); res.end(); } });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const page = await fetch(origin + first.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<img/);
    assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    assert.equal((await fetch(origin + first.url + "/logs")).status, 404);
    assert.equal((await fetch(origin + first.url.replace(/.$/, "!"))).status, 404);
    assert.equal((await fetch(origin + "/emu/api")).status, 401);
    now = first.expiresAt;
    assert.equal((await fetch(origin + first.url)).status, 404);
    assert.notEqual(shares.create("capture", file).url, first.url);
    assert.notEqual(new CaptureShares("/emu").create("capture", file).url, first.url);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
