import test from "node:test";
import assert from "node:assert/strict";
import { configuredAuth } from "../src/auth-cli";
import { createMcpServer } from "../src/mcp";
import { connect, ServeAvdError, type ServerInfo } from "../src/sdk";

test("auth CLI rejects partial configuration and invalid session lifetimes", () => {
  assert.throws(() => configuredAuth({ authDatabase: "", authOrigin: "https://test.example" }), /requires both/);
  assert.throws(() => configuredAuth({
    authDatabase: "/tmp/unused.sqlite",
    authOrigin: "https://test.example",
    authIdleTtl: "-1",
  }), /positive integer/);
  assert.deepEqual(configuredAuth({
    authDatabase: "/tmp/unused.sqlite",
    authOrigin: "https://test.example",
    authAbsoluteTtl: "120000",
    authIdleTtl: "30000",
  }), {
    databasePath: "/tmp/unused.sqlite", origin: "https://test.example", absoluteTtlMs: 120000, idleTtlMs: 30000,
  });
});

test("MCP refuses invalid auth before resolving or launching devices", async () => {
  let resolved = false;
  await assert.rejects(createMcpServer({
    serve: true,
    version: "test",
    auth: { databasePath: "relative.sqlite", origin: "https://test.example" },
    resolveDevices: async () => { resolved = true; return []; },
  }), /absolute/);
  assert.equal(resolved, false);
});

test("SDK forwards session credentials and preserves auth failures without cross-origin leaks", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let foreignEndpoint = false;
  const transport: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/api")) return Response.json({
      version: "test", codec: "auto", basePath: "/mount",
      devices: [{
        device: "mock", name: "mock", actionEndpoint: "/mount/helper/mock/action",
        screenshotEndpoint: foreignEndpoint ? "https://hostile.example/screenshot" : "/mount/helper/mock/screenshot.png",
      }],
      gridStartEndpoint: "/mount/grid/api/start",
    } as Partial<ServerInfo>);
    return Response.json({ error: "Authentication required" }, { status: 403 });
  };
  const client = await connect("https://test.example/mount", {
    fetch: transport,
    headers: { Cookie: "session=fake-test-token", Origin: "https://test.example", "X-CSRF-Token": "fake-test-csrf" },
  });
  const permissionError = (error: unknown) => error instanceof ServeAvdError && error.code === "http" && error.status === 403;
  await assert.rejects(client.device().button("home"), permissionError);
  await assert.rejects(client.attach("mock"), permissionError);
  await assert.rejects(client.device().screenshot(), permissionError);
  for (const { init } of requests) {
    const headers = new Headers(init.headers);
    assert.equal(headers.get("Cookie"), "session=fake-test-token");
    assert.equal(headers.get("Origin"), "https://test.example");
    assert.equal(headers.get("X-CSRF-Token"), "fake-test-csrf");
    assert.equal(init.credentials, "same-origin");
    assert.equal(init.redirect, "error");
  }
  foreignEndpoint = true;
  await client.refresh();
  const count = requests.length;
  await assert.rejects(client.device().screenshot(), /another origin/);
  assert.equal(requests.length, count);
});
