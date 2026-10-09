import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { AuthService } from "../src/auth.js";

const secret = "long password for tests";
async function setup(basePath = "") {
  const directory = mkdtempSync(join(tmpdir(), "serve-auth-"));
  const options = {
    databasePath: join(directory, "auth.sqlite"),
    origin: "https://example.test",
  };
  let service = new AuthService(options, basePath);
  await service.bootstrap("Admin", secret);
  const server = createServer((req, res) => {
    void service.handle(req, res).then((handled) => {
      if (!handled) res.end("device");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  let cookie = "",
    csrf = "";
  async function request(
    path: string,
    method = "GET",
    data?: unknown,
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(
      `http://127.0.0.1:${address.port}${basePath}${path}`,
      {
        method,
        redirect: "manual",
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(method !== "GET"
            ? {
                origin: options.origin,
                "content-type": "application/json",
                "x-csrf-token": csrf,
              }
            : {}),
          ...headers,
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      },
    );
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0]!;
    const text = await response.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    if (body.csrfToken) csrf = body.csrfToken;
    return { response, body };
  }
  return {
    request,
    options,
    service: () => service,
    restart: () => {
      service.close();
      service = new AuthService(options, basePath);
    },
    cleanup: async () => {
      service.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("login, base path, origin/CSRF, persistence, rotation, revocation, last admin", async () => {
  const app = await setup("/devices");
  try {
    assert.equal((await app.request("/api")).response.status, 401);
    assert.equal(
      (await app.request("/")).response.headers.get("location"),
      "/devices/login?returnTo=%2Fdevices%2F",
    );
    assert.equal(
      (
        await app.request(
          "/auth/login",
          "POST",
          { username: "Admin", password: secret },
          { origin: "https://evil.test" },
        )
      ).response.status,
      403,
    );
    const bad = await app.request("/auth/login", "POST", {
      username: "unknown",
      password: secret,
    });
    assert.equal(bad.response.status, 401);
    assert.equal(bad.body.error, "Invalid username or password");
    const login = await app.request("/auth/login", "POST", {
      username: "ADMIN",
      password: secret,
    });
    assert.equal(login.response.status, 200);
    assert.match(
      login.response.headers.get("set-cookie")!,
      /Path=\/devices\/; HttpOnly; SameSite=Lax; Secure/,
    );
    assert.equal((await app.request("/api")).body, "device");
    assert.equal(
      (
        await app.request(
          "/auth/users",
          "POST",
          { username: "person", password: secret, role: "operator" },
          { "x-csrf-token": "bad" },
        )
      ).response.status,
      403,
    );
    app.restart();
    assert.equal((await app.request("/auth/me")).body.user.username, "Admin");
    const me = await app.request("/auth/me");
    const adminId = me.body.user.id;
    assert.equal(
      (
        await app.request(`/auth/users/${adminId}/enabled`, "POST", {
          enabled: false,
        })
      ).response.status,
      400,
    );
    assert.equal(
      (
        await app.request(`/auth/users/${adminId}/role`, "POST", {
          role: "operator",
        })
      ).response.status,
      400,
    );
    const changed = await app.request("/auth/password", "POST", {
      currentPassword: secret,
      newPassword: "another long password",
    });
    assert.equal(changed.response.status, 200);
    assert.notEqual(
      changed.response.headers.get("set-cookie"),
      login.response.headers.get("set-cookie"),
    );
    assert.equal(
      (await app.request("/auth/logout", "POST", {})).response.status,
      200,
    );
    assert.equal((await app.request("/api")).response.status, 401);
    await assert.rejects(
      app.service().bootstrap("newadmin", secret),
      /already exists/,
    );
    await app.service().recover("Admin", secret);
  } finally {
    await app.cleanup();
  }
});

test("operator permission and required password change, disabled account, generic errors", async () => {
  const app = await setup();
  try {
    await app.request("/auth/login", "POST", {
      username: "Admin",
      password: secret,
    });
    assert.equal(
      (
        await app.request("/auth/users", "POST", {
          username: "short",
          password: "short",
          role: "operator",
        })
      ).response.status,
      400,
    );
    const created = await app.request("/auth/users", "POST", {
      username: "Operator",
      password: secret,
      role: "operator",
    });
    assert.equal(created.response.status, 201);
    assert.equal(
      (
        await app.request("/auth/users", "POST", {
          username: "operator",
          password: secret,
          role: "operator",
        })
      ).response.status,
      409,
    );
    await app.request("/auth/logout", "POST", {});
    const login = await app.request("/auth/login", "POST", {
      username: "operator",
      password: secret,
    });
    assert.equal(login.body.user.mustChangePassword, true);
    assert.equal((await app.request("/api")).response.status, 403);
    assert.equal(
      (
        await app.request("/auth/password", "POST", {
          currentPassword: secret,
          newPassword: "new operator password",
        })
      ).response.status,
      200,
    );
    assert.equal((await app.request("/api")).response.status, 200);
    assert.equal((await app.request("/auth/users")).response.status, 403);
    await app.request("/auth/logout", "POST", {});
    await app.request("/auth/login", "POST", {
      username: "Admin",
      password: secret,
    });
    await app.request(`/auth/users/${created.body.user.id}/enabled`, "POST", {
      enabled: false,
    });
    await app.request("/auth/logout", "POST", {});
    const denied = await app.request("/auth/login", "POST", {
      username: "Operator",
      password: "new operator password",
    });
    assert.equal(denied.body.error, "Invalid username or password");
  } finally {
    await app.cleanup();
  }
});

test("login throttles persist across restart and forwarded address is ignored", async () => {
  const app = await setup();
  try {
    for (let i = 0; i < 5; i++)
      assert.equal(
        (
          await app.request("/auth/login", "POST", {
            username: "unknown",
            password: secret,
          })
        ).response.status,
        401,
      );
    app.restart();
    assert.equal(
      (
        await app.request(
          "/auth/login",
          "POST",
          { username: "Admin", password: secret },
          { "x-forwarded-for": "1.2.3.4" },
        )
      ).response.status,
      429,
    );
  } finally {
    await app.cleanup();
  }
});

test("tracked streams close on revocation; hostile WebSocket origins are denied", async () => {
  const app = await setup();
  try {
    const login = await app.request("/auth/login", "POST", {
      username: "Admin",
      password: secret,
    });
    const cookie = login.response.headers.get("set-cookie")!.split(";")[0]!;
    const req = { headers: { cookie, origin: "https://example.test" } } as any;
    const identity = app.service().authorizeUpgrade(req);
    assert(identity);
    assert.equal(
      app.service().authorizeUpgrade({
        headers: { cookie, origin: "https://evil.test" },
      } as any),
      null,
    );
    let closed = 0;
    app.service().track(identity, () => closed++);
    await app.request(`/auth/users/${identity.user.id}/revoke`, "POST", {});
    assert.equal(closed, 1);
    assert.equal(app.service().valid(identity), false);
    assert.equal((await app.request("/auth/me")).response.status, 401);
  } finally {
    await app.cleanup();
  }
});

test("idle and absolute expiry are server enforced", async () => {
  const directory = mkdtempSync(join(tmpdir(), "serve-expiry-"));
  const auth = new AuthService({
    databasePath: join(directory, "auth.sqlite"),
    origin: "https://example.test",
    idleTtlMs: 40,
    absoluteTtlMs: 150,
  });
  await auth.bootstrap("Admin", secret);
  const server = createServer((req, res) => {
    void auth.handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const login = async () => {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/auth/login`,
      {
        method: "POST",
        headers: {
          origin: "https://example.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ username: "Admin", password: secret }),
      },
    );
    await response.text();
    return response.headers.get("set-cookie")!.split(";")[0]!;
  };
  try {
    let cookie = await login();
    let identity = auth.authorizeUpgrade({
      headers: { cookie, origin: "https://example.test" },
    } as any);
    assert(identity);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(auth.valid(identity), false);
    cookie = await login();
    identity = auth.authorizeUpgrade({
      headers: { cookie, origin: "https://example.test" },
    } as any);
    assert(identity);
    const started = Date.now();
    while (Date.now() - started < 180) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      auth.valid(identity);
    }
    assert.equal(auth.valid(identity), false);
  } finally {
    auth.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("malformed payloads rejected and unavailable/corrupt storage fails closed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "serve-invalid-"));
  try {
    assert.throws(
      () =>
        new AuthService({
          databasePath: directory,
          origin: "https://example.test",
        }),
    );
    const { writeFileSync } = await import("node:fs");
    const path = join(directory, "corrupt.sqlite");
    writeFileSync(path, "this is not sqlite");
    assert.throws(
      () =>
        new AuthService({ databasePath: path, origin: "https://example.test" }),
    );
    assert.throws(
      () =>
        new AuthService({
          databasePath: "relative.sqlite",
          origin: "https://example.test",
        }),
      /absolute/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const app = await setup();
  try {
    await app.request("/auth/login", "POST", {
      username: "Admin",
      password: secret,
    });
    assert.equal(
      (
        await app.request(
          "/auth/logout",
          "POST",
          {},
          { "x-csrf-token": "é".repeat(43) },
        )
      ).response.status,
      403,
    );
    assert.equal(
      (await app.request("/auth/users", "POST", ["invalid"])).response.status,
      400,
    );
    assert.equal(
      (
        await app.request("/auth/me", "GET", undefined, {
          origin: "https://evil.test",
        })
      ).response.status,
      403,
    );
  } finally {
    await app.cleanup();
  }
});

test("encoded traversal cannot bypass mounted auth boundary", async () => {
  const app = await setup("/emu");
  try {
    // Use IncomingMessage-shaped raw URL: WHATWG/fetch clients normalize dot segments.
    const req = {
      url: "/emu/helper/%2e%2e/%2e%2e/login",
      method: "GET",
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    } as any;
    let output = "";
    const headers = new Map();
    const res = {
      statusCode: 200,
      setHeader: (key: string, value: string) => headers.set(key, value),
      end: (value: string) => {
        output = value;
      },
    } as any;
    assert.equal(await app.service().handle(req, res), true);
    assert.equal(res.statusCode, 401);
    assert.match(output, /Authentication required/);
  } finally {
    await app.cleanup();
  }
});

test("reset and role changes revoke existing sessions and require new credentials", async () => {
  const app = await setup();
  try {
    const admin = await app.request(
      "/auth/login",
      "POST",
      {
        username: "Admin",
        password: secret,
      },
      { cookie: "" },
    );
    const created = await app.request("/auth/users", "POST", {
      username: "Operator",
      password: secret,
      role: "operator",
    });
    await app.request("/auth/logout", "POST", {});
    const login = await app.request("/auth/login", "POST", {
      username: "Operator",
      password: secret,
    });
    await app.request("/auth/password", "POST", {
      currentPassword: secret,
      newPassword: "initial operator password",
    });
    const operator = await app.request("/auth/me");
    // Obtain raw token from the rotated password response through a fresh login.
    const fresh = await app.request("/auth/login", "POST", {
      username: "Operator",
      password: "initial operator password",
    });
    const oldCookie = fresh.response.headers.get("set-cookie")!.split(";")[0]!;
    const oldIdentity = app.service().authorizeUpgrade({
      headers: { cookie: oldCookie, origin: "https://example.test" },
    } as any);
    assert(oldIdentity);
    assert.equal(app.service().valid(oldIdentity), true);
    await app.request(
      "/auth/login",
      "POST",
      {
        username: "Admin",
        password: secret,
      },
      { cookie: "" },
    );
    assert.equal(
      (
        await app.request(
          `/auth/users/${created.body.user.id}/password`,
          "POST",
          { password: "reset operator password" },
        )
      ).response.status,
      200,
    );
    assert.equal(app.service().valid(oldIdentity), false);
    assert.equal(
      (
        await app.request("/auth/login", "POST", {
          username: "Operator",
          password: "initial operator password",
        })
      ).response.status,
      401,
    );
    const resetLogin = await app.request("/auth/login", "POST", {
      username: "Operator",
      password: "reset operator password",
    });
    assert.equal(resetLogin.body.user.mustChangePassword, true);
    const rotated = await app.request("/auth/password", "POST", {
      currentPassword: "reset operator password",
      newPassword: "final operator password",
    });
    const currentCookie = rotated.response.headers
      .get("set-cookie")!
      .split(";")[0]!;
    const currentIdentity = app.service().authorizeUpgrade({
      headers: { cookie: currentCookie, origin: "https://example.test" },
    } as any);
    assert(currentIdentity);
    assert.equal(app.service().valid(currentIdentity), true);
    await app.request(
      "/auth/login",
      "POST",
      {
        username: "Admin",
        password: secret,
      },
      { cookie: "" },
    );
    assert.equal(
      (
        await app.request(`/auth/users/${created.body.user.id}/role`, "POST", {
          role: "admin",
        })
      ).response.status,
      200,
    );
    assert.equal(app.service().valid(currentIdentity), false);
    assert.equal(
      (
        await app.request("/auth/login", "POST", {
          username: "Operator",
          password: "final operator password",
        })
      ).body.user.role,
      "admin",
    );
  } finally {
    await app.cleanup();
  }
});

test("concurrent admin disable requests preserve an enabled administrator", async () => {
  const app = await setup();
  try {
    const login = await app.request("/auth/login", "POST", {
      username: "Admin",
      password: secret,
    });
    const created = await app.request("/auth/users", "POST", {
      username: "Second",
      password: secret,
      role: "admin",
    });
    await app.request(
      "/auth/login",
      "POST",
      {
        username: "Second",
        password: secret,
      },
      { cookie: "" },
    );
    await app.request("/auth/password", "POST", {
      currentPassword: secret,
      newPassword: "second administrator password",
    });
    const second = await app.request("/auth/login", "POST", {
      username: "Second",
      password: "second administrator password",
    });
    const results = await Promise.all([
      app.request(
        `/auth/users/${created.body.user.id}/enabled`,
        "POST",
        { enabled: false },
        {
          cookie: login.response.headers.get("set-cookie")!.split(";")[0]!,
          "x-csrf-token": login.body.csrfToken,
        },
      ),
      app.request(
        `/auth/users/${login.body.user.id}/enabled`,
        "POST",
        { enabled: false },
        {
          cookie: second.response.headers.get("set-cookie")!.split(";")[0]!,
          "x-csrf-token": second.body.csrfToken,
        },
      ),
    ]);
    assert.equal(
      results.filter((result) => result.response.status === 200).length,
      1,
    );
    assert.equal(
      results.filter((result) => result.response.status !== 200).length,
      1,
    );
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(app.options.databasePath, { readonly: true });
    try {
      assert.equal(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM users WHERE role='admin' AND enabled=1",
            )
            .get() as { n: number }
        ).n,
        1,
      );
    } finally {
      db.close();
    }
  } finally {
    await app.cleanup();
  }
});
