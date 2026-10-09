import test, { mock } from "node:test";
import {
  EmulatorSession,
  closeDeviceSession,
  type HidSocket,
} from "../src/device-session";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createDevHandler } from "../ops/dev-handler.mjs";
import { DeviceMedia } from "../src/workspace-media";
import { emuMiddleware } from "../src/middleware";

async function fixture(basePath = "", allowedDevices: string[] = [], wrapper = false, discoverAll = false) {
  const dir = mkdtempSync(join(tmpdir(), "avd-boundary-"));
  const origin = "http://127.0.0.1";
  const middleware = emuMiddleware({
    basePath,
    workspaceDir: join(dir, "workspace"),
    allowedDevices,
    auth: { databasePath: join(dir, "accounts.db"), origin },
  });
  const server = createServer(
    wrapper
      ? createDevHandler(
          middleware,
          ["emulator-5554", "emulator-5556"],
          new Set(["emulator-5554"]),
          { discoverAll },
        )
      : middleware,
  );
  server.on("upgrade", middleware.handleUpgrade);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}${basePath}`;
  const password = "temporary test password only";
  await middleware.auth!.bootstrap("admin", password);
  const request = (path: string, init: RequestInit = {}) =>
    fetch(url + path, { redirect: "manual", ...init });
  const login = async () => {
    const res = await request("/auth/login", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password }),
    });
    assert.equal(res.status, 200);
    return {
      cookie: res.headers.get("set-cookie")!.split(";")[0]!,
      ...((await res.json()) as { csrfToken: string; user: { id: string } }),
    };
  };
  return {
    dir,
    middleware,
    request,
    login,
    url,
    origin,
    close: async () => {
      middleware.auth!.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("every device surface denies anonymous requests before device discovery", async () => {
  const h = await fixture("/emu");
  try {
    for (const path of [
      "/api",
      "/grid/api",
      "/api/event-log",
      "/api/event-log/events",
      ...[
        "config",
        "health",
        "ax",
        "foreground",
        "logs",
        "screenshot.png",
        "stream.mjpeg",
        "stream.avcc",
        "action",
        "ws",
        "workspace", "apps", "builds", "preset-current", "metrics", "quality", "crashes", "snapshot-default", "apk", "recording", "captures/id/file", "captures/id/logs", "captures/id/export", "captures/id/share", "builds/id/install",
      ].map((x) => "/helper/unknown/" + x),
      "/future-api",
    ]) {
      const res = await h.request(path);
      assert.equal(res.status, 401, path);
      assert.match(res.headers.get("content-type")!, /application\/json/);
      assert.equal(res.headers.get("access-control-allow-origin"), null);
    }
    const root = await h.request("/");
    assert.equal(root.status, 302);
    assert.match(root.headers.get("location")!, /^\/emu\/login/);
    const wsStatus = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(
        h.url.replace("http:", "ws:") + "/helper/unknown/ws",
        { origin: h.origin },
      );
      ws.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode!);
        res.resume();
        ws.terminate();
      });
      ws.on("error", () => {});
      ws.on("open", () => {
        ws.close();
        reject(new Error("Unauthorized upgrade succeeded"));
      });
    });
    assert.equal(wsStatus, 401);
    assert.deepEqual(h.middleware.attachedSerials(), []);
  } finally {
    await h.close();
  }
});

test("base path, CORS, CSRF, role checks and allowlist enforce authenticated boundary", async () => {
  const h = await fixture("/emu");
  try {
    const session = await h.login();
    const headers = {
      Cookie: session.cookie,
      Origin: h.origin,
      "X-CSRF-Token": session.csrfToken,
      "Content-Type": "application/json",
    };
    for (const route of ["workspace","apps","builds","metrics","quality","crashes","snapshot-default","captures/id/file","apk","recording"]) {
      assert.equal((await h.request(`/helper/unknown/${route}`,{headers})).status,403,route);
      assert.equal((await h.request(`/helper/unknown/${route}`,{method:"POST",headers:{Cookie:session.cookie},body:"{}"})).status,403,route);
    }
    const boot = await h.request("/api", { headers });
    assert.equal(boot.status, 200);
    assert.equal(boot.headers.get("access-control-allow-origin"), null);
    assert.equal(
      (await h.request("/helper/unknown/config", { headers })).status,
      403,
    );
    assert.equal(
      (
        await h.request("/grid/api/start", {
          method: "POST",
          headers: { Cookie: session.cookie },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await h.request("/auth/users", {
          method: "POST",
          headers: { ...headers, Origin: "https://evil.example" },
          body: "{}",
        })
      ).status,
      403,
    );
    const created = await h.request("/auth/users", {
      method: "POST",
      headers,
      body: JSON.stringify({
        username: "operator",
        password: "temporary operator password",
        role: "operator",
      }),
    });
    assert.equal(created.status, 201);
    const opLogin = await h.request("/auth/login", {
      method: "POST",
      headers: { Origin: h.origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "operator",
        password: "temporary operator password",
      }),
    });
    const opCookie = opLogin.headers.get("set-cookie")!.split(";")[0]!;
    const op = (await opLogin.json()) as { csrfToken: string };
    const changed = await h.request("/auth/password", {
      method: "POST",
      headers: { ...headers, Cookie: opCookie, "X-CSRF-Token": op.csrfToken },
      body: JSON.stringify({
        currentPassword: "temporary operator password",
        newPassword: "changed operator password",
      }),
    });
    assert.equal(changed.status, 200);
    const newOp = (await changed.json()) as { csrfToken: string };
    const opHeaders = {
      ...headers,
      Cookie: changed.headers.get("set-cookie")!.split(";")[0]!,
      "X-CSRF-Token": newOp.csrfToken,
    };
    for (const path of ["/grid/api/start", "/grid/api/shutdown", "/auth/users"])
      assert.equal(
        (
          await h.request(path, {
            method: "POST",
            headers: opHeaders,
            body: "{}",
          })
        ).status,
        403,
        path,
      );
    const sse = await h.request("/api/event-log/events", { headers });
    assert.equal(sse.status, 200);
    assert.equal(sse.headers.get("access-control-allow-origin"), null);
    const reader = sse.body!.getReader();
    await reader.read();
    const ended = reader.read().then(
      () => true,
      () => true,
    );
    assert.equal(
      (await h.request("/auth/logout", { method: "POST", headers, body: "{}" }))
        .status,
      200,
    );
    await Promise.race([
      ended,
      new Promise((_, reject) => {
        const t = setTimeout(
          () => reject(new Error("SSE not closed by logout")),
          2500,
        );
        t.unref();
      }),
    ]);
    assert.equal((await h.request("/api", { headers })).status, 401);
  } finally {
    await h.close();
  }
});

test("real input WebSocket closes on revocation and command adapter rejects revoked input", async () => {
  const starts = mock.method(
    EmulatorSession.prototype,
    "start",
    async () => {},
  );
  const commands: Buffer[] = [];
  const attach = mock.method(
    EmulatorSession.prototype,
    "attachHidSocket",
    (socket: HidSocket) => {
      socket.on("message", (data) => commands.push(data));
    },
  );
  const close = mock.method(EmulatorSession.prototype, "close", () => {});
  const h = await fixture("", ["mock-only"]);
  let ws: WebSocket | undefined;
  try {
    const session = await h.login();
    ws = new WebSocket(h.url.replace("http:", "ws:") + "/helper/mock-only/ws", {
      origin: h.origin,
      headers: { Cookie: session.cookie },
    });
    await new Promise<void>((resolve, reject) => {
      ws!.once("open", resolve);
      ws!.once("error", reject);
    });
    ws.send(Buffer.from([1, 2, 3]));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(commands.length, 1);
    const closed = new Promise<number>((resolve) =>
      ws!.once("close", (code) => resolve(code)),
    );
    const headers = {
      Cookie: session.cookie,
      Origin: h.origin,
      "X-CSRF-Token": session.csrfToken,
      "Content-Type": "application/json",
    };
    const revoke = await h.request(`/auth/users/${session.user.id}/revoke`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(revoke.status, 200);
    assert.equal(await closed, 4401);
    assert.equal(commands.length, 1);
    assert.equal(starts.mock.callCount(), 1);
  } finally {
    ws?.terminate();
    closeDeviceSession("mock-only");
    await h.close();
    starts.mock.restore();
    attach.mock.restore();
    close.mock.restore();
  }
});

test("hosted grid override requires native authentication and retains startup restrictions", async () => {
  const h = await fixture("", [], true);
  try {
    const anonymous = await h.request("/grid/api");
    assert.equal(anonymous.status, 401);
    assert.ok(!(await anonymous.text()).includes("emulator-5554"));
    const session = await h.login();
    const headers = {
      Cookie: session.cookie,
      Origin: h.origin,
      "X-CSRF-Token": session.csrfToken,
      "Content-Type": "application/json",
    };
    const grid = await h.request("/grid/api", { headers });
    assert.equal(grid.status, 200);
    assert.deepEqual(
      ((await grid.json()) as { devices: { serial: string }[] }).devices.map(
        (d) => d.serial,
      ),
      ["emulator-5554"],
    );
    assert.equal(
      (
        await h.request("/grid/api/start", {
          method: "POST",
          headers,
          body: JSON.stringify({ device: "emulator-5554" }),
        })
      ).status,
      403,
    );
    assert.equal(
      (await h.request("/helper/arbitrary/config", { headers })).status,
      403,
    );
    assert.throws(
      () => createDevHandler(() => {}, [], new Set()),
      /authentication is required/,
    );
  } finally {
    await h.close();
  }
});


test("automatic discovery retains authentication and blocks emulator startup", async () => {
  const h = await fixture("", [], true, true);
  try {
    assert.equal((await h.request("/grid/api")).status, 401);
    const session = await h.login();
    const headers = { Cookie: session.cookie, Origin: h.origin, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" };
    const response = await h.request("/grid/api", { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { devices: [], avds: [] });
    assert.equal((await h.request("/grid/api/start", { method: "POST", headers, body: JSON.stringify({device:"unconfigured"}) })).status, 403);
    assert.equal((await h.request("/helper/unconfigured/config", { headers })).status, 403);
  } finally { await h.close(); }
});


test("loopback reverse proxy and forged local headers never bypass HTTP or WebSocket authentication", async () => {
  const h = await fixture("", [], true, true);
  const forged = {
    "X-Forwarded-For": "127.0.0.1, 10.0.0.1",
    "X-Real-IP": "::1",
    Forwarded: 'for=127.0.0.1;host=localhost;proto=https',
    "X-Forwarded-Host": "localhost",
    "X-Forwarded-Proto": "https",
    "CF-Connecting-IP": "192.168.1.1",
    "CF-Access-Authenticated-User-Email": "admin@example.test",
    "X-Original-URL": "/login",
    "X-Rewrite-URL": "/login",
  };
  const proxy = createServer((req, res) => {
    const upstream = httpRequest(h.url + req.url, { method: req.method, headers: { ...req.headers, ...forged } }, reply => {
      res.writeHead(reply.statusCode!, reply.headers);
      reply.pipe(res);
    });
    upstream.on("error", () => { res.destroy(); });
    req.pipe(upstream);
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  try {
    for (const url of [h.url, proxyUrl]) {
      for (const path of ["/api", "/grid/api", "/api/event-log/events", "/helper/unknown/screenshot.png", "/helper/unknown/stream.avcc", "/helper/unknown/action", "/grid/api/start", "/auth/users", "/future-api"]) {
        for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"]) {
          const response = await fetch(url + path, { method, headers: { ...forged, Origin: h.origin }, redirect: "manual" });
          assert.equal(response.status, 401, `${url} ${method} ${path}`);
          await response.arrayBuffer();
        }
      }
    }
    const session = await h.login();
    for (const headers of [forged, { ...forged, Cookie: session.cookie }]) {
      // A valid session still cannot use a forged forwarded origin for mutations.
      const response = await h.request("/grid/api/start", {
        method: "POST", headers: { ...headers, "X-CSRF-Token": session.csrfToken }, body: "{}",
      });
      assert.equal(response.status, "Cookie" in headers ? 403 : 401);
    }
    for (const headers of [
      { ...forged, Origin: h.origin },
      { ...forged, Cookie: session.cookie },
      { ...forged, Cookie: session.cookie, Origin: "https://evil.example" },
    ]) {
      const status = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(h.url.replace("http:", "ws:") + "/helper/unknown/ws", { headers, handshakeTimeout: 2000 });
        ws.once("unexpected-response", (_req, res) => { resolve(res.statusCode!); res.resume(); ws.terminate(); });
        ws.on("error", reject);
        ws.once("open", () => { ws.terminate(); reject(new Error("Unauthorized upgrade succeeded")); });
      });
      assert.equal(status, 401);
    }
    assert.deepEqual(h.middleware.attachedSerials(), []);
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await h.close();
  }
});


test("capture capabilities cross auth only for one read-only file, including deployment wrappers", async () => {
  const starts = mock.method(EmulatorSession.prototype, "start", async () => {});
  try {
    for (const wrapper of [false, true]) {
      const h = await fixture(wrapper ? "" : "/emu", ["emulator-5554"], wrapper);
      const file = join(h.dir, "capture.mp4"); writeFileSync(file, "0123456789");
      const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const scoped = `/helper/emulator-5554/captures/${id}`;
      let available = true;
      const media = mock.method(DeviceMedia.prototype, "sharedFile", (capture: string) =>
        available && capture === id ? { path: file, format: "mp4" } : null);
      try {
        await h.middleware.attachDevice("emulator-5554");
        const user = await h.login();
        const headers = { Cookie: user.cookie, Origin: h.origin, "X-CSRF-Token": user.csrfToken };
        assert.equal((await h.request(scoped + "/share", { method: "POST" })).status, 401);
        assert.equal((await h.request(scoped + "/share", { method: "POST", headers: { Cookie: user.cookie } })).status, 403);
        const created = await h.request(scoped + "/share", { method: "POST", headers });
        assert.equal(created.status, 200);
        const share = await created.json() as { url: string };
        const publicUrl = new URL(share.url, h.url).href;
        assert.equal((await fetch(publicUrl)).status, 200);
        const range = await fetch(publicUrl + "/file", { headers: { Range: "bytes=2-5" } });
        assert.equal(range.status, 206); assert.equal(await range.text(), "2345");
        assert.equal(range.headers.get("referrer-policy"), "no-referrer");
        assert.equal((await fetch(publicUrl + "/file", { method: "HEAD" })).headers.get("content-length"), "10");
        assert.equal((await fetch(publicUrl + "/logs")).status, 404);
        assert.equal((await fetch(publicUrl + "/file", { method: "POST" })).status, 405);
        assert.equal((await h.request(scoped + "/file")).status, 401);
        assert.equal((await h.request("/api")).status, 401);
        assert.equal((await h.request(scoped + "/share", { method: "DELETE", headers })).status, 200);
        assert.equal((await fetch(publicUrl)).status, 404);
        const replacement = await (await h.request(scoped + "/share", { method: "POST", headers })).json() as { url: string };
        assert.notEqual(replacement.url, share.url);
        available = false;
        assert.equal((await fetch(new URL(replacement.url, h.url))).status, 404);
      } finally { media.mock.restore(); closeDeviceSession("emulator-5554"); await h.close(); }
    }
  } finally { starts.mock.restore(); }
});
