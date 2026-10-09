import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, openSync, closeSync, lstatSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import Database from "better-sqlite3";
import { hash, verify } from "@node-rs/argon2";
import { authPage } from "./auth-page.js";

export interface AuthOptions {
  databasePath: string;
  origin: string;
  absoluteTtlMs?: number;
  idleTtlMs?: number;
}
export interface AuthUser {
  id: string;
  username: string;
  role: "admin" | "operator";
  mustChangePassword: boolean;
}
export interface AuthIdentity {
  sessionHash: string;
  user: AuthUser;
  csrfToken: string;
}
type UserRow = {
  id: string;
  username: string;
  normalized: string;
  password: string;
  role: "admin" | "operator";
  enabled: number;
  must_change: number;
};
type SessionRow = UserRow & {
  session_hash: string;
  csrf: string;
  created: number;
  last_used: number;
  expires: number;
  revoked: number;
};
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const random = () => randomBytes(32).toString("base64url");
const publicUser = (u: UserRow): AuthUser => ({
  id: u.id,
  username: u.username,
  role: u.role,
  mustChangePassword: !!u.must_change,
});
const normalized = (name: string) => name.normalize("NFKC").toLowerCase();
function username(value: unknown): string {
  if (typeof value !== "string" || !/^[\p{L}\p{N}_.-]{1,64}$/u.test(value))
    throw new Error(
      "Username must contain 1–64 letters, numbers, dots, underscores or hyphens",
    );
  return value;
}
function password(value: unknown): string {
  if (
    typeof value !== "string" ||
    Array.from(value).length < 15 ||
    Array.from(value).length > 128
  )
    throw new Error("Password must contain 15–128 characters");
  return value;
}
let working = 0;
async function bounded<T>(fn: () => Promise<T>): Promise<T> {
  if (working >= 2) throw new Error("Authentication busy; try again");
  working++;
  try {
    return await fn();
  } finally {
    working--;
  }
}
const hashPassword = (value: string) =>
  bounded(() =>
    hash(value, {
      algorithm: 2,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    }),
  );
const verifyPassword = (encoded: string, value: string) =>
  bounded(() => verify(encoded, value));
// Valid Argon2id dummy credential ensures unknown accounts perform the same expensive verification.
const dummyHash = hash("unusable-dummy-password-" + random(), {
  algorithm: 2,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
});

export class AuthService {
  private db: Database.Database;
  private origin: string;
  private cookieName: string;
  private cookiePath: string;
  private secure: boolean;
  private absolute: number;
  private idle: number;
  private connections = new Map<string, Set<() => void>>();
  private timer: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(
    options: AuthOptions,
    private basePath = "",
  ) {
    const url = new URL(options.origin);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.origin !== options.origin ||
      url.username ||
      url.password
    )
      throw new Error("Auth origin must be an explicit HTTP(S) origin");
    if (!isAbsolute(options.databasePath))
      throw new Error("Auth database path must be absolute");
    this.origin = url.origin;
    this.secure = url.protocol === "https:";
    this.absolute = options.absoluteTtlMs ?? 12 * 60 * 60 * 1000;
    this.idle = options.idleTtlMs ?? 60 * 60 * 1000;
    if (!(
      this.absolute > 0 &&
      this.idle > 0 &&
      Number.isFinite(this.absolute) &&
      Number.isFinite(this.idle)
    ))
      throw new Error("Invalid session expiry");
    this.basePath = basePath.replace(/\/$/, "");
    this.cookiePath = this.basePath + "/";
    this.cookieName = "serve_avd_" + digest(this.cookiePath).slice(0, 12);
    mkdirSync(dirname(options.databasePath), { recursive: true, mode: 0o700 });
    try {
      closeSync(openSync(options.databasePath, "ax", 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const file = lstatSync(options.databasePath);
    if (!file.isFile() || file.isSymbolicLink())
      throw new Error("Auth database must be a regular file");
    chmodSync(options.databasePath, 0o600);
    this.db = new Database(options.databasePath);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("busy_timeout = 5000");
      for (const suffix of ["-wal", "-shm"]) {
        try {
          chmodSync(options.databasePath + suffix, 0o600);
        } catch {}
      }
      const version = this.db.pragma("user_version", {
        simple: true,
      }) as number;
      if (version > 1) {
        throw new Error("Unsupported auth database migration");
      }
      if (version < 1)
        this.db
          .transaction(() => {
            this.db.exec(`
      CREATE TABLE users(id TEXT PRIMARY KEY, normalized TEXT UNIQUE NOT NULL, username TEXT NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','operator')), enabled INTEGER NOT NULL DEFAULT 1, must_change INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE sessions(session_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, created INTEGER NOT NULL, last_used INTEGER NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX sessions_user ON sessions(user_id);
      CREATE TABLE audit(id INTEGER PRIMARY KEY, actor TEXT, action TEXT NOT NULL, target TEXT, outcome TEXT NOT NULL, timestamp INTEGER NOT NULL);
      CREATE TABLE throttles(key TEXT PRIMARY KEY, failures INTEGER NOT NULL, next INTEGER NOT NULL, updated INTEGER NOT NULL);
      PRAGMA user_version=1;`);
          })
          .immediate();
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.timer = setInterval(() => {
      try {
        for (const key of this.connections.keys())
          if (!this.session(key, false)) this.disconnect(key);
      } catch {
        for (const key of this.connections.keys()) this.disconnect(key);
      }
    }, 1000);
    this.timer.unref();
  }
  private audit(
    actor: string | null,
    action: string,
    target: string | null,
    outcome = "success",
  ) {
    this.db
      .prepare(
        "INSERT INTO audit(actor,action,target,outcome,timestamp) VALUES(?,?,?,?,?)",
      )
      .run(actor, action, target, outcome, Date.now());
  }
  private user(id: string) {
    return this.db.prepare("SELECT * FROM users WHERE id=?").get(id) as
      UserRow | undefined;
  }
  private session(key: string, touch: boolean): AuthIdentity | null {
    const row = this.db
      .prepare(
        "SELECT u.*,s.* FROM sessions s JOIN users u ON s.user_id=u.id WHERE session_hash=?",
      )
      .get(key) as SessionRow | undefined;
    const now = Date.now();
    if (
      !row ||
      row.revoked ||
      !row.enabled ||
      row.expires <= now ||
      row.last_used + this.idle <= now
    )
      return null;
    if (touch)
      this.db
        .prepare("UPDATE sessions SET last_used=? WHERE session_hash=?")
        .run(now, key);
    return { sessionHash: key, user: publicUser(row), csrfToken: row.csrf };
  }
  resolve(req: IncomingMessage, touch = true): AuthIdentity | null {
    const match = (req.headers.cookie ?? "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(this.cookieName + "="));
    if (!match) return null;
    const token = match.slice(this.cookieName.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return this.session(digest(token), touch);
  }
  valid(identity: AuthIdentity): boolean {
    const resolved = this.session(identity.sessionHash, true);
    return !!resolved && !resolved.user.mustChangePassword;
  }
  authorizeUpgrade(req: IncomingMessage): AuthIdentity | null {
    if (req.headers.origin !== this.origin) return null;
    const identity = this.resolve(req);
    return identity && !identity.user.mustChangePassword ? identity : null;
  }
  track(identity: AuthIdentity, close: () => void): () => void {
    if (!this.valid(identity)) {
      close();
      return () => {};
    }
    let set = this.connections.get(identity.sessionHash);
    if (!set) this.connections.set(identity.sessionHash, (set = new Set()));
    set.add(close);
    return () => {
      set!.delete(close);
      if (!set!.size) this.connections.delete(identity.sessionHash);
    };
  }
  private disconnect(key: string) {
    const callbacks = this.connections.get(key);
    this.connections.delete(key);
    for (const close of callbacks ?? []) {
      try {
        close();
      } catch {}
    }
  }
  private revoke(userId: string) {
    this.db
      .prepare("UPDATE sessions SET revoked=1 WHERE user_id=?")
      .run(userId);
    for (const key of this.connections.keys())
      if (!this.session(key, false)) this.disconnect(key);
  }
  private cookie(res: ServerResponse, token: string, clear = false) {
    res.setHeader(
      "Set-Cookie",
      `${this.cookieName}=${token}; Path=${this.cookiePath}; HttpOnly; SameSite=Lax${this.secure ? "; Secure" : ""}; Max-Age=${clear ? 0 : Math.floor(this.absolute / 1000)}`,
    );
  }
  private issue(res: ServerResponse, user: UserRow) {
    const token = random(),
      now = Date.now();
    this.db
      .prepare(
        "INSERT INTO sessions(session_hash,user_id,csrf,created,last_used,expires) VALUES(?,?,?,?,?,?)",
      )
      .run(digest(token), user.id, random(), now, now, now + this.absolute);
    this.cookie(res, token);
    return this.session(digest(token), false)!;
  }
  private json(res: ServerResponse, status: number, data: unknown) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(data));
  }
  requireAdmin(req: IncomingMessage, res: ServerResponse): boolean {
    const identity = this.resolve(req);
    if (!identity) {
      this.json(res, 401, { error: "Authentication required" });
      return false;
    }
    if (identity.user.role !== "admin" || identity.user.mustChangePassword) {
      this.json(res, 403, { error: "Administrator permission required" });
      return false;
    }
    return true;
  }
  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8192) throw new Error("Request body too large");
      chunks.push(Buffer.from(chunk));
    }
    if (!req.headers["content-type"]?.startsWith("application/json"))
      throw new Error("JSON body required");
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      throw new Error("Invalid request body");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Invalid request body");
    return parsed as Record<string, unknown>;
  }
  private mutation(
    req: IncomingMessage,
    res: ServerResponse,
    identity?: AuthIdentity,
  ): boolean {
    const token = req.headers["x-csrf-token"];
    if (
      req.headers.origin !== this.origin ||
      (identity &&
        (typeof token !== "string" ||
          Buffer.byteLength(token) !== Buffer.byteLength(identity.csrfToken) ||
          !timingSafeEqual(
            Buffer.from(token),
            Buffer.from(identity.csrfToken),
          )))
    ) {
      this.audit(
        identity?.user.id ?? null,
        "request-rejected",
        null,
        "failure",
      );
      this.json(res, 403, { error: "Request origin or CSRF token rejected" });
      return false;
    }
    return true;
  }
  async bootstrap(name: string, secret: string): Promise<void> {
    const display = username(name),
      encoded = await hashPassword(password(secret));
    this.db
      .transaction(() => {
        if (
          this.db
            .prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1")
            .get()
        )
          throw new Error("Administrator already exists");
        const id = random();
        this.db
          .prepare("INSERT INTO users VALUES(?,?,?,?,?,1,0,?,?)")
          .run(
            id,
            normalized(display),
            display,
            encoded,
            "admin",
            Date.now(),
            Date.now(),
          );
        this.audit(null, "bootstrap", id);
      })
      .immediate();
  }
  async recover(name: string, secret: string): Promise<void> {
    const encoded = await hashPassword(password(secret));
    this.db
      .transaction(() => {
        const user = this.db
          .prepare("SELECT * FROM users WHERE normalized=?")
          .get(normalized(username(name))) as UserRow | undefined;
        if (!user || user.role !== "admin")
          throw new Error("Administrator not found");
        this.db
          .prepare(
            "UPDATE users SET password=?,enabled=1,must_change=0,updated=? WHERE id=?",
          )
          .run(encoded, Date.now(), user.id);
        this.revoke(user.id);
        this.audit(null, "recover", user.id);
      })
      .immediate();
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const pathname = (req.url ?? "/").split("?")[0]!;
    const path = pathname.slice(this.basePath.length);
    if (
      this.basePath &&
      pathname !== this.basePath &&
      !pathname.startsWith(this.basePath + "/")
    )
      return false;
    res.setHeader("Cache-Control", "no-store");
    try {
      if (req.headers.origin && req.headers.origin !== this.origin) {
        this.json(res, 403, { error: "Request origin rejected" });
        return true;
      }
      if (path === "/login" && req.method === "GET") {
        const requested =
          new URL(req.url!, this.origin).searchParams.get("returnTo") ??
          this.basePath + "/";
        const target =
          requested.startsWith(this.basePath + "/") &&
          !requested.startsWith("//") &&
          !/[\\\r\n]/.test(requested)
            ? requested
            : this.basePath + "/";
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(authPage(this.basePath, target));
        return true;
      }
      if (path === "/auth/login" && req.method === "POST") {
        if (!this.mutation(req, res)) return true;
        const data = await this.body(req);
        const name =
          typeof data.username === "string"
            ? normalized(data.username).slice(0, 256)
            : "";
        const secret =
          typeof data.password === "string" && data.password.length <= 512
            ? data.password
            : "";
        const keys = [
          "account:" + digest(name),
          "address:" + digest(req.socket.remoteAddress ?? "unknown"),
        ];
        const now = Date.now();
        this.db
          .prepare("DELETE FROM throttles WHERE updated<?")
          .run(now - 86400000);
        if (
          keys.some(
            (key) =>
              ((
                this.db
                  .prepare("SELECT next FROM throttles WHERE key=?")
                  .get(key) as { next: number } | undefined
              )?.next ?? 0) > now,
          )
        ) {
          res.setHeader("Retry-After", "2");
          this.json(res, 429, {
            error: "Too many login attempts; try again later",
          });
          return true;
        }
        const user = this.db
          .prepare("SELECT * FROM users WHERE normalized=?")
          .get(name) as UserRow | undefined;
        const ok = await verifyPassword(
          user?.password ?? (await dummyHash),
          secret,
        );
        if (
          !ok ||
          !user?.enabled ||
          this.user(user.id)?.password !== user.password ||
          !this.user(user.id)?.enabled
        ) {
          this.db
            .transaction(() => {
              for (const key of keys) {
                const prior = this.db
                  .prepare("SELECT failures FROM throttles WHERE key=?")
                  .get(key) as { failures: number } | undefined;
                const failures = Math.min((prior?.failures ?? 0) + 1, 20);
                this.db
                  .prepare(
                    "INSERT INTO throttles VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET failures=excluded.failures,next=excluded.next,updated=excluded.updated",
                  )
                  .run(
                    key,
                    failures,
                    now +
                      (failures < 5
                        ? 0
                        : Math.min(60000, 1000 * 2 ** (failures - 5))),
                    now,
                  );
              }
              this.db
                .prepare(
                  "DELETE FROM throttles WHERE key IN (SELECT key FROM throttles ORDER BY updated DESC LIMIT -1 OFFSET 10000)",
                )
                .run();
              this.audit(null, "login", user?.id ?? null, "failure");
            })
            .immediate();
          this.json(res, 401, { error: "Invalid username or password" });
          return true;
        }
        const old = this.resolve(req);
        if (old) {
          this.db
            .prepare("UPDATE sessions SET revoked=1 WHERE session_hash=?")
            .run(old.sessionHash);
          this.disconnect(old.sessionHash);
        }
        this.db.prepare("DELETE FROM throttles WHERE key=?").run(keys[0]);
        const identity = this.issue(res, user);
        this.audit(user.id, "login", user.id);
        this.json(res, 200, {
          user: identity.user,
          csrfToken: identity.csrfToken,
        });
        return true;
      }
      const identity = this.resolve(req, path !== "/auth/me");
      if (!identity) {
        if (
          req.method === "GET" &&
          (path === "/" || path === "" || path === "/account")
        ) {
          res.statusCode = 302;
          res.setHeader(
            "Location",
            this.basePath +
              "/login?returnTo=" +
              encodeURIComponent(req.url ?? this.basePath + "/"),
          );
          res.end();
        } else this.json(res, 401, { error: "Authentication required" });
        return true;
      }
      if (path === "/auth/me" && req.method === "GET") {
        this.json(res, 200, {
          user: identity.user,
          csrfToken: identity.csrfToken,
        });
        return true;
      }
      if (
        !["GET", "HEAD", "OPTIONS"].includes(req.method ?? "") &&
        !this.mutation(req, res, identity)
      )
        return true;
      if (path === "/auth/logout" && req.method === "POST") {
        this.db
          .prepare("UPDATE sessions SET revoked=1 WHERE session_hash=?")
          .run(identity.sessionHash);
        this.disconnect(identity.sessionHash);
        this.cookie(res, "", true);
        this.audit(identity.user.id, "logout", identity.user.id);
        this.json(res, 200, { ok: true });
        return true;
      }
      if (path === "/auth/password" && req.method === "POST") {
        const data = await this.body(req),
          user = this.user(identity.user.id)!;
        const secret = password(data.newPassword);
        if (
          typeof data.currentPassword !== "string" ||
          data.currentPassword.length > 512 ||
          !(await verifyPassword(user.password, data.currentPassword))
        ) {
          this.json(res, 400, { error: "Current password is incorrect" });
          return true;
        }
        const encoded = await hashPassword(secret);
        if (!this.session(identity.sessionHash, false)) {
          this.json(res, 401, { error: "Authentication required" });
          return true;
        }
        this.db
          .transaction(() => {
            if (
              !this.session(identity.sessionHash, false) ||
              this.user(user.id)?.password !== user.password
            )
              throw new Error("Authentication busy; try again");
            this.db
              .prepare(
                "UPDATE users SET password=?,must_change=0,updated=? WHERE id=?",
              )
              .run(encoded, Date.now(), user.id);
            this.revoke(user.id);
            this.audit(user.id, "password-change", user.id);
          })
          .immediate();
        const next = this.issue(res, this.user(user.id)!);
        this.json(res, 200, { user: next.user, csrfToken: next.csrfToken });
        return true;
      }
      if (path === "/account" && req.method === "GET") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(authPage(this.basePath, this.basePath + "/"));
        return true;
      }
      if (identity.user.mustChangePassword) {
        this.json(res, 403, {
          error: "Password change required",
          mustChangePassword: true,
        });
        return true;
      }
      if (path.startsWith("/auth/users")) {
        if (identity.user.role !== "admin") {
          this.audit(identity.user.id, "admin-denied", null, "failure");
          this.json(res, 403, { error: "Administrator permission required" });
          return true;
        }
        await this.users(req, res, path, identity);
        return true;
      }
      if (path.startsWith("/auth/")) {
        this.json(res, 404, { error: "Unknown authentication route" });
        return true;
      }
      const untrack = this.track(identity, () => res.destroy());
      res.once("close", untrack);
      res.once("finish", untrack);
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const safe =
        /^(Username|Password|Current|Invalid request|Request body|JSON body|Administrator|User |Role |Enabled |Cannot |Authentication busy)/.test(
          message,
        );
      this.json(res, message.includes("UNIQUE") ? 409 : safe ? 400 : 500, {
        error: message.includes("UNIQUE")
          ? "Username already exists"
          : safe
            ? message
            : "Authentication request failed",
      });
      return true;
    }
  }
  private async users(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    identity: AuthIdentity,
  ) {
    if (path === "/auth/users" && req.method === "GET") {
      const users = this.db
        .prepare("SELECT * FROM users ORDER BY normalized")
        .all() as UserRow[];
      this.json(res, 200, {
        users: users.map((u) => ({ ...publicUser(u), enabled: !!u.enabled })),
      });
      return;
    }
    if (req.method !== "POST") {
      this.json(res, 405, { error: "Method not allowed" });
      return;
    }
    const data = await this.body(req);
    if (path === "/auth/users") {
      const display = username(data.username),
        secret = password(data.password);
      if (data.role !== "admin" && data.role !== "operator")
        throw new Error("Role must be admin or operator");
      const encoded = await hashPassword(secret),
        id = random();
      this.db
        .transaction(() => {
          if (this.session(identity.sessionHash, false)?.user.role !== "admin")
            throw new Error("Administrator permission required");
          this.db
            .prepare("INSERT INTO users VALUES(?,?,?,?,?,1,1,?,?)")
            .run(
              id,
              normalized(display),
              display,
              encoded,
              data.role,
              Date.now(),
              Date.now(),
            );
          this.audit(identity.user.id, "user-create", id);
        })
        .immediate();
      this.json(res, 201, {
        user: { ...publicUser(this.user(id)!), enabled: true },
      });
      return;
    }
    const match =
      /^\/auth\/users\/([^/]+)\/(password|enabled|role|revoke)$/.exec(path);
    if (!match) {
      this.json(res, 404, { error: "Unknown account route" });
      return;
    }
    const id = match[1]!,
      action = match[2]!;
    let encoded: string | undefined;
    if (action === "password")
      encoded = await hashPassword(password(data.password));
    if (action === "enabled" && typeof data.enabled !== "boolean")
      throw new Error("Enabled must be boolean");
    if (action === "role" && data.role !== "admin" && data.role !== "operator")
      throw new Error("Role must be admin or operator");
    this.db
      .transaction(() => {
        if (this.session(identity.sessionHash, false)?.user.role !== "admin")
          throw new Error("Administrator permission required");
        const user = this.user(id);
        if (!user) throw new Error("User not found");
        if (
          user.role === "admin" &&
          user.enabled &&
          ((action === "enabled" && data.enabled === false) ||
            (action === "role" && data.role !== "admin"))
        ) {
          const count = this.db
            .prepare(
              "SELECT COUNT(*) AS n FROM users WHERE role='admin' AND enabled=1",
            )
            .get() as { n: number };
          if (count.n <= 1)
            throw new Error("Cannot remove the last enabled administrator");
        }
        if (action === "password")
          this.db
            .prepare(
              "UPDATE users SET password=?,must_change=1,updated=? WHERE id=?",
            )
            .run(encoded, Date.now(), id);
        if (action === "enabled")
          this.db
            .prepare("UPDATE users SET enabled=?,updated=? WHERE id=?")
            .run(data.enabled ? 1 : 0, Date.now(), id);
        if (action === "role")
          this.db
            .prepare("UPDATE users SET role=?,updated=? WHERE id=?")
            .run(data.role, Date.now(), id);
        this.revoke(id);
        this.audit(identity.user.id, "user-" + action, id);
      })
      .immediate();
    this.json(res, 200, { ok: true });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const key of this.connections.keys()) this.disconnect(key);
    this.db.close();
  }
}
