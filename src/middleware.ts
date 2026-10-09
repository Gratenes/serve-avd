/**
 * Connect-style middleware serving the serve-avd preview UI and per-device
 * helper endpoints, mirroring serve-sim's route map:
 *
 *   {base}/                        preview HTML (inlined JS/CSS)
 *   {base}/api                     preview boot state (devices + endpoints)
 *   {base}/api/event-log           recent events JSON  (?device=&limit=)
 *   {base}/api/event-log/events    SSE: snapshot + live event entries
 *   {base}/grid/api                connected devices + configured AVDs
 *   {base}/grid/api/start          POST { device } — attach serial / boot AVD
 *   {base}/helper/<serial>/…       stream.mjpeg | stream.avcc | config |
 *                                  health | ax | foreground | logs |
 *                                  screenshot.png
 *   {base}/helper/<serial>/action  POST { action, ...params } → JSON result
 *                                  (tap/find/wait/geo/network/… see actions.ts)
 *   {base}/helper/<serial>/ws      input WebSocket (via handleUpgrade)
 *
 * Everything is same-origin on one port, so embedding in an existing dev
 * server just works; wire `server.on("upgrade", middleware.handleUpgrade)`
 * for input and live streams.
 */
import type { IncomingMessage, ServerResponse } from "http";
import { AuthService, type AuthOptions } from "./auth";
export { AuthService, type AuthOptions } from "./auth";
import type { Socket } from "net";
import { readFileSync, createReadStream, statSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import {
  getDeviceSession,
  peekDeviceSession,
  listDeviceSessions,
  closeAllDeviceSessions,
  closeDeviceSession,
  type HidSocket,
  type SessionOptions,
} from "./device-session";

// Re-exported so embedders can tear down adb capture processes on shutdown.
export { closeAllDeviceSessions, closeDeviceSession };
import {
  listDevices,
  listAvds,
  launchAvd,
  waitForNewEmulatorSerial,
  waitForBoot,
} from "./adb";
import {
  listEventLogEvents,
  subscribeEventLog,
  recordEventLogEvent,
} from "./event-log";
import { ActionError } from "./actions";
import { createDebug } from "./debug";
import { WorkspaceService } from "./workspace";
import { handleQualityStream, parseQuality } from "./quality-stream";

const debug = createDebug("middleware");

declare const __SERVE_AVD_VERSION__: string | undefined;
const VERSION =
  typeof __SERVE_AVD_VERSION__ === "string" ? __SERVE_AVD_VERSION__ : "dev";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export interface PreviewInitialState {
  /** Panes to open initially: "devices", "tools", "logs" — or "none". */
  panes?: string[];
  /** @deprecated Previews now fit the viewport automatically. */
  fit?: boolean;
}

export interface EmuMiddlewareOptions {
  /** Mount path, e.g. "/.emu". Default "/" (serve at the root). */
  basePath?: string;
  /** Private artifact/default metadata directory. */
  workspaceDir?: string;
  /** Persistent authentication; false explicitly enables unauthenticated local use. */
  auth?: AuthOptions | false;
  /** Only these device serials may be attached or accessed. */
  allowedDevices?: string[];
  /** Stream codec preference surfaced to the client: "auto" (default) or "mjpeg". */
  codec?: "auto" | "mjpeg";
  /** Initial preview UI state. */
  initialState?: PreviewInitialState;
  /** Per-session capture options (bit rate, size). */
  sessionOptions?: SessionOptions;
  /**
   * Accepted for serve-sim API compatibility. serve-avd sessions are always
   * in-process and same-origin, so helper traffic is always "proxied";
   * `handleUpgrade` must be wired either way.
   */
  proxyHelpers?: boolean;
  /** Called when the preview UI requests a shutdown (standalone server only). */
  onShutdown?: () => void;
}

export interface EmuMiddleware {
  (
    req: IncomingMessage,
    res: ServerResponse,
    next?: (err?: unknown) => void,
  ): void;
  handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void;
  /** Serials this middleware has attached sessions for (or will list in /api). */
  attachDevice(serial: string): Promise<void>;
  attachedSerials(): string[];
  /** Shared boundary for deployment wrapper routes. Run handle before overrides. */
  auth?: AuthService;
}

// ── Assets ─────────────────────────────────────────────────────────────────

function assetsDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

let cachedHtml: {
  authEnabled: boolean;
  base: string;
  codec: string;
  initial: string;
  html: string;
} | null = null;

function previewHtml(
  base: string,
  codec: string,
  initialState: PreviewInitialState | undefined,
  authEnabled = false,
): string {
  const initial = JSON.stringify(initialState ?? {});
  if (
    cachedHtml &&
    cachedHtml.authEnabled === authEnabled &&
    cachedHtml.base === base &&
    cachedHtml.codec === codec &&
    cachedHtml.initial === initial
  )
    return cachedHtml.html;
  const dir = assetsDir();
  let js = "";
  let css = "";
  try {
    js = readFileSync(join(dir, "client.js"), "utf8");
    css = readFileSync(join(dir, "client.css"), "utf8");
  } catch (err) {
    debug("client assets missing", err);
    return `<!doctype html><meta charset="utf-8"><title>serve-avd</title><body style="font-family:system-ui;background:#0c0d10;color:#e8e8ea;display:grid;place-items:center;height:100vh;margin:0"><div><h1>serve-avd</h1><p>Client assets not built. Run <code>npm run build</code>.</p></div>`;
  }
  const boot = JSON.stringify({
    basePath: base,
    authEnabled,
    codec,
    initialState: initialState ?? {},
    version: VERSION,
  });
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>serve-avd</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🤖</text></svg>')}">
<style>${css}</style>
</head>
<body>
<div id="app"></div>
<script>window.__SERVE_AVD__ = ${boot};</script>
<script>${js}</script>
</body>
</html>`;
  cachedHtml = { authEnabled, base, codec, initial, html };
  return html;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function normalizeBase(basePath: string | undefined): string {
  const trimmed = (basePath ?? "/").replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed === "" ? "" : `/${trimmed}`;
}

/** Suppress legacy wildcard CORS on every protected nested response. */
function sameOriginResponse(res: ServerResponse): void {
  for (const name of res.getHeaderNames()) {
    if (name.toLowerCase().startsWith("access-control-"))
      res.removeHeader(name);
  }
  const setHeader = res.setHeader.bind(res);
  res.setHeader = (name, value) =>
    name.toLowerCase().startsWith("access-control-")
      ? res
      : setHeader(name, value);
  const writeHead = res.writeHead.bind(res);
  res.writeHead = ((
    status: number,
    messageOrHeaders?: string | Record<string, unknown>,
    headers?: Record<string, unknown>,
  ) => {
    const clean = (value: Record<string, unknown> | undefined) =>
      value &&
      Object.fromEntries(
        Object.entries(value).filter(
          ([name]) => !name.toLowerCase().startsWith("access-control-"),
        ),
      );
    return typeof messageOrHeaders === "string"
      ? writeHead(status, messageOrHeaders, clean(headers) as never)
      : writeHead(status, clean(messageOrHeaders) as never);
  }) as ServerResponse["writeHead"];
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache, no-store",
    "Content-Length": String(buf.length),
    ...CORS,
  });
  res.end(buf);
}

function sendHtml(res: ServerResponse, html: string): void {
  const buf = Buffer.from(html, "utf8");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache, no-store",
    "Content-Length": String(buf.length),
  });
  res.end(buf);
}

function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Adapt a `ws` socket to the minimal HidSocket surface. */
function wsHidSocket(
  ws: WsSocket,
  authorized: () => boolean = () => true,
): HidSocket {
  return {
    send(data: Buffer) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    },
    on(event: "message" | "close" | "error", cb: (data: Buffer) => void) {
      if (event === "message") {
        ws.on("message", (data) => {
          try {
            if (!authorized()) {
              ws.close(4401, "Session expired");
              return;
            }
          } catch {
            ws.terminate();
            return;
          }
          const buf = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data as ArrayBuffer);
          cb(buf);
        });
      } else {
        ws.on(event, () => (cb as () => void)());
      }
    },
    close() {
      try {
        ws.close();
      } catch {}
    },
  };
}

interface HelperTarget {
  serial: string;
  endpoint: string;
}

function parseHelperPath(rel: string): HelperTarget | null {
  const match = /^\/helper\/([^/]+)(\/.*)$/.exec(rel);
  if (!match) return null;
  return { serial: decodeURIComponent(match[1]!), endpoint: match[2]! };
}

// ── Middleware ─────────────────────────────────────────────────────────────

export function emuMiddleware(
  options: EmuMiddlewareOptions = {},
): EmuMiddleware {
  const base = normalizeBase(options.basePath);
  const codec = options.codec ?? "auto";
  const workspace = new WorkspaceService(options.workspaceDir);
  const auth = options.auth ? new AuthService(options.auth, base) : undefined;
  const allowed = options.allowedDevices
    ? new Set(options.allowedDevices)
    : undefined;
  const checkDevice = (serial: string) => {
    if (allowed && !allowed.has(serial))
      throw new Error("Device is not allowlisted");
  };
  const wss = new WebSocketServer({ noServer: true });
  const attached = new Set<string>();

  const deviceEntry = (serial: string) => {
    const session = peekDeviceSession(serial);
    const prefix = `${base}/helper/${encodeURIComponent(serial)}`;
    return {
      device: serial,
      name: session?.name || serial,
      videoAvailable: session ? session.videoAvailable : true,
      config: session?.screenConfig() ?? null,
      streamMjpegEndpoint: `${prefix}/stream.mjpeg`,
      streamAvccEndpoint: `${prefix}/stream.avcc`,
      wsEndpoint: `${prefix}/ws`,
      configEndpoint: `${prefix}/config`,
      logsEndpoint: `${prefix}/logs`,
      screenshotEndpoint: `${prefix}/screenshot.png`,
      axEndpoint: `${prefix}/ax`,
      foregroundEndpoint: `${prefix}/foreground`,
      actionEndpoint: `${prefix}/action`,
    };
  };

  const attachDevice = async (serial: string): Promise<void> => {
    checkDevice(serial);
    const session = await getDeviceSession(serial, options.sessionOptions);
    attached.add(serial);
  };

  const sessionFor = async (serial: string) => {
    checkDevice(serial);
    const session = await getDeviceSession(serial, options.sessionOptions);
    attached.add(serial);
    return session;
  };

  const handler = async (
    req: IncomingMessage,
    res: ServerResponse,
    next?: (err?: unknown) => void,
  ) => {
    const rawUrl = req.url ?? "/";
    const pathname = rawUrl.split("?")[0]!;
    const notMine = () => {
      if (next) next();
      else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
      }
    };

    if (base !== "" && pathname !== base && !pathname.startsWith(`${base}/`))
      return notMine();
    const rel = base === "" ? pathname : pathname.slice(base.length) || "/";

    if (auth) {
      sameOriginResponse(res);
      if (await auth.handle(req, res)) return;
    }

    const identity = auth?.resolve(req);
    const authorized = () => !auth || (!!identity && auth.valid(identity));
    if (!authorized()) {
      sendJson(res, 401, { error: "authentication_required" });
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    try {
      if (
        auth &&
        (rel === "/grid/api/start" || rel === "/grid/api/shutdown") &&
        !auth.requireAdmin(req, res)
      )
        return;
      // Preview HTML
      if (rel === "/" || rel === "") {
        sendHtml(res, previewHtml(base, codec, options.initialState, !!auth));
        return;
      }

      // Preview boot state
      if (rel === "/api") {
        sendJson(res, 200, {
          version: VERSION,
          codec,
          basePath: base,
          initialState: options.initialState ?? {},
          devices: [...attached].map(deviceEntry),
          gridApiEndpoint: `${base}/grid/api`,
          gridStartEndpoint: `${base}/grid/api/start`,
          eventLogEndpoint: `${base}/api/event-log`,
          eventLogEventsEndpoint: `${base}/api/event-log/events`,
        });
        return;
      }

      // Event log JSON
      if (rel === "/api/event-log") {
        const params = new URL(rawUrl, "http://x").searchParams;
        const device = params.get("device") ?? undefined;
        const limitRaw = params.get("limit");
        const limit = limitRaw != null ? parseInt(limitRaw, 10) : undefined;
        sendJson(res, 200, {
          events: listEventLogEvents({
            device,
            limit: Number.isFinite(limit) ? limit : undefined,
          }).filter((e) => !allowed || (!!e.device && allowed.has(e.device))),
        });
        return;
      }

      // Event log SSE: snapshot, then live entries
      if (rel === "/api/event-log/events") {
        const params = new URL(rawUrl, "http://x").searchParams;
        const device = params.get("device") ?? undefined;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-store",
          Connection: "keep-alive",
          ...CORS,
        });
        res.write(
          `data: ${JSON.stringify({ events: listEventLogEvents({ device, limit: 100 }).filter((e) => !allowed || (!!e.device && allowed.has(e.device))) })}\n\n`,
        );
        const unsubscribe = subscribeEventLog((entry) => {
          if (allowed && (!entry.device || !allowed.has(entry.device))) return;
          if (device && entry.device !== device) return;
          if (res.writableEnded || res.destroyed || res.writableNeedDrain)
            return;
          res.write(`data: ${JSON.stringify({ event: entry })}\n\n`);
        });
        res.on("close", unsubscribe);
        res.on("error", unsubscribe);
        return;
      }

      // Device grid: everything adb knows about + configured AVDs
      if (rel === "/grid/api") {
        const [devices, avds] = await Promise.all([
          listDevices().catch(() => []),
          listAvds(),
        ]);
        const runningAvds = new Set<string>();
        for (const session of listDeviceSessions())
          runningAvds.add(session.name.replace(/ /g, "_"));
        sendJson(res, 200, {
          devices: devices
            .filter((d) => !allowed || allowed.has(d.serial))
            .map((d) => ({
              serial: d.serial,
              state: d.state,
              model: d.model,
              isEmulator: d.isEmulator,
              attached: attached.has(d.serial),
              ...(attached.has(d.serial) ? deviceEntry(d.serial) : {}),
            })),
          avds: (allowed ? [] : avds).map((name) => ({
            name,
            running: runningAvds.has(name),
          })),
        });
        return;
      }

      // Attach a serial or boot an AVD by name
      if (rel === "/grid/api/start" && req.method === "POST") {
        const body = JSON.parse(
          (await readBody(req)).toString("utf8") || "{}",
        ) as { device?: string };
        const target = body.device?.trim();
        if (!target) {
          sendJson(res, 400, { error: "device required" });
          return;
        }
        if (allowed && !allowed.has(target)) {
          sendJson(res, 403, { error: "device_not_allowed" });
          return;
        }
        if (!authorized() || (auth && !auth.requireAdmin(req, res))) return;
        const devices = await listDevices().catch(() => []);
        const bySerial = devices.find(
          (d) => d.serial === target && d.state === "device",
        );
        if (!authorized()) {
          res.destroy();
          return;
        }
        if (bySerial) {
          await sessionFor(bySerial.serial);
          sendJson(res, 200, { device: deviceEntry(bySerial.serial) });
          return;
        }
        const avds = await listAvds();
        const avd = avds.find(
          (name) => name === target || name.replace(/_/g, " ") === target,
        );
        if (!avd) {
          sendJson(res, 404, {
            error: `No connected device or AVD named '${target}'`,
          });
          return;
        }
        if (!authorized()) {
          res.destroy();
          return;
        }
        recordEventLogEvent({
          source: "server",
          kind: "boot",
          summary: `Booting AVD ${avd}`,
        });
        const known = new Set(devices.map((d) => d.serial));
        launchAvd(avd, { snapshot: workspace.getDefault(avd) });
        const serial = await waitForNewEmulatorSerial(known, 120_000);
        if (!serial) {
          sendJson(res, 504, { error: `AVD ${avd} did not come online` });
          return;
        }
        await waitForBoot(serial, 180_000);
        await sessionFor(serial);
        sendJson(res, 200, { device: deviceEntry(serial) });
        return;
      }

      if (rel === "/grid/api/shutdown" && req.method === "POST") {
        if (!options.onShutdown) {
          sendJson(res, 501, {
            error: "shutdown not available in embedded mode",
          });
          return;
        }
        sendJson(res, 200, { ok: true });
        setTimeout(() => options.onShutdown!(), 50);
        return;
      }

      // Per-device helper endpoints
      const helper = parseHelperPath(rel);
      if (helper) {
        if (allowed && !allowed.has(helper.serial)) {
          sendJson(res, 403, { error: "device_not_allowed" });
          return;
        }
        let session;
        try {
          session = await sessionFor(helper.serial);
        } catch (err) {
          sendJson(res, 404, {
            error: "device_unavailable",
            message: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        if (!authorized()) {
          res.destroy();
          return;
        }
        const endpoint = helper.endpoint.split("?")[0]!;
        const featureRoute =
          /^\/(?:workspace|apps|builds|preset-current|metrics|quality|crashes|snapshot-default|apk|recording|captures)(?:\/|$)/.test(
            endpoint,
          );
        if (featureRoute && !["GET", "POST"].includes(req.method ?? "")) {
          sendJson(res, 405, { error: "method_not_allowed" });
          return;
        }
        if (
          [
            "/workspace",
            "/apps",
            "/builds",
            "/preset-current",
            "/metrics",
          ].includes(endpoint) &&
          req.method !== "GET"
        ) {
          sendJson(res, 405, { error: "method_not_allowed" });
          return;
        }
        if (endpoint === "/workspace") {
          sendJson(res, 200, workspace.state(session));
          return;
        }
        if (endpoint === "/apps") {
          sendJson(res, 200, { apps: await workspace.apps(session) });
          return;
        }
        if (endpoint === "/builds") {
          sendJson(res, 200, { builds: workspace.device(session).builds });
          return;
        }
        if (endpoint === "/preset-current") {
          sendJson(res, 200, await workspace.currentPreset(session));
          return;
        }
        if (endpoint === "/metrics") {
          sendJson(res, 200, await session.performance());
          return;
        }
        if (endpoint === "/quality") {
          sendJson(res, 200, {
            scope: "browser",
            codecs: ["H.264"],
            maxCustomStreams: 4,
          });
          return;
        }
        if (endpoint === "/crashes") {
          if (req.method === "POST") {
            const body = JSON.parse((await readBody(req)).toString() || "{}");
            if (!authorized()) {
              res.destroy();
              return;
            }
            if (body.op === "clear") session.crashes.reports.splice(0);
            else if (body.op === "restart") {
              const report = session.crashes.reports.find(
                (c) => c.id === body.id,
              );
              const pkg = body.packageName ?? report?.packageName;
              if (!pkg) throw new Error("Crash package unavailable");
              await session.runAction("stop", { package: pkg });
              if (!authorized()) {
                res.destroy();
                return;
              }
              await session.runAction("launch", { package: pkg });
            } else throw new Error("Unknown crash operation");
          }
          sendJson(res, 200, { crashes: session.crashes.reports });
          return;
        }
        if (endpoint === "/snapshot-default") {
          let name = workspace.state(session).defaultSnapshot;
          if (req.method === "POST") {
            const body = JSON.parse((await readBody(req)).toString() || "{}");
            if (!authorized()) {
              res.destroy();
              return;
            }
            name = await workspace.setDefault(session, body.name);
          }
          sendJson(res, 200, { name });
          return;
        }
        if (endpoint === "/apk" && req.method === "POST") {
          const filename =
            new URL(rawUrl, "http://x").searchParams.get("filename") ??
            req.headers["x-filename"];
          const build = await workspace.upload(
            session,
            req,
            res,
            filename,
            authorized,
          );
          if (!authorized()) {
            res.destroy();
            return;
          }
          sendJson(res, 200, { build, app: build.app });
          return;
        }
        const install = /^\/builds\/([a-f0-9-]+)\/install$/.exec(endpoint);
        if (install && req.method === "POST") {
          await readBody(req);
          if (!authorized()) {
            res.destroy();
            return;
          }
          const build = await workspace.reinstall(
            session,
            install[1]!,
            res,
            authorized,
          );
          sendJson(res, 200, { build, app: build.app });
          return;
        }
        if (endpoint === "/recording" && req.method === "POST") {
          const body = JSON.parse((await readBody(req)).toString() || "{}");
          if (!authorized()) {
            res.destroy();
            return;
          }
          const media = workspace.device(session).media;
          const result =
            body.op === "start"
              ? await media.start(body)
              : body.op === "stop"
                ? await media.stop()
                : body.op === "screenshot"
                  ? await media.shot()
                  : null;
          if (!result) throw new Error("Unknown recording operation");
          sendJson(res, 200, { result, ...workspace.state(session) });
          return;
        }
        const artifact = /^\/captures\/([a-f0-9-]+)\/(file|logs|export)$/.exec(
          endpoint,
        );
        if (artifact) {
          const media = workspace.device(session).media;
          if (artifact[2] === "export" && req.method === "POST") {
            const body = JSON.parse((await readBody(req)).toString() || "{}");
            if (!authorized()) {
              res.destroy();
              return;
            }
            const capture = await media.convert(artifact[1]!, body);
            sendJson(res, 200, { capture });
            return;
          }
          if (req.method !== "GET") {
            sendJson(res, 405, { error: "method_not_allowed" });
            return;
          }
          const capture = media.captures.find((c) => c.id === artifact[1]);
          if (!capture) {
            sendJson(res, 404, { error: "capture_not_found" });
            return;
          }
          const part = artifact[2] === "logs" ? "logs" : "file";
          if (part === "logs" && !capture.hasLogs) {
            sendJson(res, 404, { error: "logs_unavailable" });
            return;
          }
          const path = media.path(capture.id, part);
          res.writeHead(200, {
            "Content-Type":
              part === "logs"
                ? "text/plain; charset=utf-8"
                : capture.format === "mp4"
                  ? "video/mp4"
                  : capture.format === "webm"
                    ? "video/webm"
                    : `image/${capture.format}`,
            "Content-Length": statSync(path).size,
            "Cache-Control": "private, no-store",
            "Content-Disposition": `inline; filename="capture-${capture.id}.${part === "logs" ? "txt" : capture.format}"`,
          });
          createReadStream(path).pipe(res);
          return;
        }
        switch (endpoint) {
          case "/stream.mjpeg":
            session.handleMjpeg(req, res);
            return;
          case "/stream.avcc":
            {
              const query = new URL(rawUrl, "http://x").searchParams;
              if (
                query.has("resolution") ||
                query.has("fps") ||
                query.has("bitRateMbps")
              )
                handleQualityStream(
                  helper.serial,
                  session.screenConfig(),
                  parseQuality(Object.fromEntries(query)),
                  req,
                  res,
                );
              else session.handleAvcc(req, res);
            }
            return;
          case "/config":
            session.handleConfig(req, res);
            return;
          case "/health":
            session.handleHealth(req, res);
            return;
          case "/ax":
            await session.handleAx(req, res);
            return;
          case "/foreground":
            await session.handleForeground(req, res);
            return;
          case "/logs":
            session.handleLogs(req, res);
            return;
          case "/screenshot.png":
            await session.handleScreenshot(req, res);
            return;
          case "/action": {
            if (req.method !== "POST") {
              sendJson(res, 405, {
                ok: false,
                error: "method_not_allowed",
                message: "POST { action, ...params }",
              });
              return;
            }
            let body: {
              action?: string;
              params?: Record<string, unknown>;
            } & Record<string, unknown>;
            try {
              body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
            } catch {
              sendJson(res, 400, {
                ok: false,
                error: "bad_request",
                message: "invalid JSON body",
              });
              return;
            }
            const name = typeof body.action === "string" ? body.action : "";
            // Params may be nested under `params` or spread alongside `action`.
            const { action: _a, params: nested, ...spread } = body;
            const params = {
              ...spread,
              ...(nested && typeof nested === "object" ? nested : {}),
            };
            try {
              if (!authorized()) {
                res.destroy();
                return;
              }
              const result =
                name === "snapshot"
                  ? await workspace.snapshotAction(session, params)
                  : await session.runAction(name, params);
              sendJson(res, 200, { ok: true, action: name, result });
            } catch (err) {
              const e = err as ActionError;
              const code = e instanceof ActionError ? e.code : "failed";
              const status =
                code === "bad_request"
                  ? 400
                  : code === "not_found"
                    ? 404
                    : code === "unsupported"
                      ? 501
                      : 500;
              sendJson(res, status, {
                ok: false,
                action: name,
                error: code,
                message: e?.message ?? String(err),
              });
            }
            return;
          }
          default:
            sendJson(res, 404, { error: "unknown helper endpoint" });
            return;
        }
      }

      notMine();
    } catch (err) {
      debug("request failed", rawUrl, err);
      if (!res.headersSent) {
        const message = err instanceof Error ? err.message : String(err);
        const status =
          err instanceof ActionError
            ? err.code === "bad_request"
              ? 400
              : err.code === "not_found"
                ? 404
                : err.code === "unsupported"
                  ? 501
                  : 500
            : /must |invalid |exceeds |choose |unknown .*operation|not an APK|already running|no active recording|trim |format must/i.test(
                  message,
                )
              ? 400
              : /not found/i.test(message)
                ? 404
                : 500;
        sendJson(res, status, {
          error:
            status === 400
              ? "bad_request"
              : status === 404
                ? "not_found"
                : status === 501
                  ? "unsupported"
                  : "internal",
          message,
        });
      } else {
        res.destroy();
      }
    }
  };

  const middleware = ((
    req: IncomingMessage,
    res: ServerResponse,
    next?: (err?: unknown) => void,
  ) => {
    void handler(req, res, next).catch(() => {
      if (!res.headersSent)
        sendJson(res, 503, { error: "service_unavailable" });
      else res.destroy();
    });
  }) as EmuMiddleware;

  middleware.handleUpgrade = (
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ) => {
    const pathname = (req.url ?? "/").split("?")[0]!;
    if (base !== "" && !pathname.startsWith(`${base}/`)) {
      socket.destroy();
      return;
    }
    const rel = base === "" ? pathname : pathname.slice(base.length);
    let identity;
    try {
      identity = auth?.authorizeUpgrade(req);
    } catch {
      socket.destroy();
      return;
    }
    if (auth && !identity) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    let helper: HelperTarget | null;
    try {
      helper = parseHelperPath(rel);
    } catch {
      socket.destroy();
      return;
    }
    if (helper && allowed && !allowed.has(helper.serial)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    if (!helper || helper.endpoint.split("?")[0] !== "/ws") {
      socket.destroy();
      return;
    }
    void (async () => {
      let session;
      try {
        session = await sessionFor(helper.serial);
      } catch {
        socket.destroy();
        return;
      }
      if (auth && identity && !auth.valid(identity)) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (auth && identity) {
          const untrack = auth.track(identity, () =>
            ws.close(4401, "Session expired"),
          );
          ws.once("close", untrack);
        }
        session.attachHidSocket(
          wsHidSocket(ws, () => !auth || (!!identity && auth.valid(identity))),
        );
      });
    })().catch(() => socket.destroy());
  };

  middleware.auth = auth;
  middleware.attachDevice = attachDevice;
  middleware.attachedSerials = () => [...attached];

  return middleware;
}
