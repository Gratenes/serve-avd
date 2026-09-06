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
import type { Socket } from "net";
import { readFileSync } from "fs";
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
import { listDevices, listAvds, launchAvd, waitForNewEmulatorSerial, waitForBoot } from "./adb";
import { listEventLogEvents, subscribeEventLog, recordEventLogEvent } from "./event-log";
import { ActionError } from "./actions";
import { createDebug } from "./debug";

const debug = createDebug("middleware");

declare const __SERVE_AVD_VERSION__: string | undefined;
const VERSION = typeof __SERVE_AVD_VERSION__ === "string" ? __SERVE_AVD_VERSION__ : "dev";

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
  (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void): void;
  handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void;
  /** Serials this middleware has attached sessions for (or will list in /api). */
  attachDevice(serial: string): Promise<void>;
  attachedSerials(): string[];
}

// ── Assets ─────────────────────────────────────────────────────────────────

function assetsDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

let cachedHtml: { codec: string; initial: string; html: string } | null = null;

function previewHtml(base: string, codec: string, initialState: PreviewInitialState | undefined): string {
  const initial = JSON.stringify(initialState ?? {});
  if (cachedHtml && cachedHtml.codec === codec && cachedHtml.initial === initial) return cachedHtml.html;
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
  const boot = JSON.stringify({ basePath: base, codec, initialState: initialState ?? {}, version: VERSION });
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
  cachedHtml = { codec, initial, html };
  return html;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function normalizeBase(basePath: string | undefined): string {
  const trimmed = (basePath ?? "/").replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed === "" ? "" : `/${trimmed}`;
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
function wsHidSocket(ws: WsSocket): HidSocket {
  return {
    send(data: Buffer) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    },
    on(event: "message" | "close" | "error", cb: (data: Buffer) => void) {
      if (event === "message") {
        ws.on("message", (data) => {
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

export function emuMiddleware(options: EmuMiddlewareOptions = {}): EmuMiddleware {
  const base = normalizeBase(options.basePath);
  const codec = options.codec ?? "auto";
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
    await getDeviceSession(serial, options.sessionOptions);
    attached.add(serial);
  };

  const sessionFor = async (serial: string) => {
    const session = await getDeviceSession(serial, options.sessionOptions);
    attached.add(serial);
    return session;
  };

  const handler = async (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void) => {
    const rawUrl = req.url ?? "/";
    const pathname = rawUrl.split("?")[0]!;
    const notMine = () => {
      if (next) next();
      else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
      }
    };

    if (base !== "" && pathname !== base && !pathname.startsWith(`${base}/`)) return notMine();
    const rel = base === "" ? pathname : pathname.slice(base.length) || "/";

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    try {
      // Preview HTML
      if (rel === "/" || rel === "") {
        sendHtml(res, previewHtml(base, codec, options.initialState));
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
          events: listEventLogEvents({ device, limit: Number.isFinite(limit) ? limit : undefined }),
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
        res.write(`data: ${JSON.stringify({ events: listEventLogEvents({ device, limit: 100 }) })}\n\n`);
        const unsubscribe = subscribeEventLog((entry) => {
          if (device && entry.device !== device) return;
          if (res.writableEnded || res.destroyed || res.writableNeedDrain) return;
          res.write(`data: ${JSON.stringify({ event: entry })}\n\n`);
        });
        res.on("close", unsubscribe);
        res.on("error", unsubscribe);
        return;
      }

      // Device grid: everything adb knows about + configured AVDs
      if (rel === "/grid/api") {
        const [devices, avds] = await Promise.all([listDevices().catch(() => []), listAvds()]);
        const runningAvds = new Set<string>();
        for (const session of listDeviceSessions()) runningAvds.add(session.name.replace(/ /g, "_"));
        sendJson(res, 200, {
          devices: devices.map((d) => ({
            serial: d.serial,
            state: d.state,
            model: d.model,
            isEmulator: d.isEmulator,
            attached: attached.has(d.serial),
            ...(attached.has(d.serial) ? deviceEntry(d.serial) : {}),
          })),
          avds: avds.map((name) => ({ name, running: runningAvds.has(name) })),
        });
        return;
      }

      // Attach a serial or boot an AVD by name
      if (rel === "/grid/api/start" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as { device?: string };
        const target = body.device?.trim();
        if (!target) {
          sendJson(res, 400, { error: "device required" });
          return;
        }
        const devices = await listDevices().catch(() => []);
        const bySerial = devices.find((d) => d.serial === target && d.state === "device");
        if (bySerial) {
          await sessionFor(bySerial.serial);
          sendJson(res, 200, { device: deviceEntry(bySerial.serial) });
          return;
        }
        const avds = await listAvds();
        const avd = avds.find((name) => name === target || name.replace(/_/g, " ") === target);
        if (!avd) {
          sendJson(res, 404, { error: `No connected device or AVD named '${target}'` });
          return;
        }
        recordEventLogEvent({ source: "server", kind: "boot", summary: `Booting AVD ${avd}` });
        const known = new Set(devices.map((d) => d.serial));
        launchAvd(avd);
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
          sendJson(res, 501, { error: "shutdown not available in embedded mode" });
          return;
        }
        sendJson(res, 200, { ok: true });
        setTimeout(() => options.onShutdown!(), 50);
        return;
      }

      // Per-device helper endpoints
      const helper = parseHelperPath(rel);
      if (helper) {
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
        const endpoint = helper.endpoint.split("?")[0]!;
        switch (endpoint) {
          case "/stream.mjpeg":
            session.handleMjpeg(req, res);
            return;
          case "/stream.avcc":
            session.handleAvcc(req, res);
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
              sendJson(res, 405, { ok: false, error: "method_not_allowed", message: "POST { action, ...params }" });
              return;
            }
            let body: { action?: string; params?: Record<string, unknown> } & Record<string, unknown>;
            try {
              body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
            } catch {
              sendJson(res, 400, { ok: false, error: "bad_request", message: "invalid JSON body" });
              return;
            }
            const name = typeof body.action === "string" ? body.action : "";
            // Params may be nested under `params` or spread alongside `action`.
            const { action: _a, params: nested, ...spread } = body;
            const params = { ...spread, ...(nested && typeof nested === "object" ? nested : {}) };
            try {
              const result = await session.runAction(name, params);
              sendJson(res, 200, { ok: true, action: name, result });
            } catch (err) {
              const e = err as ActionError;
              const code = e instanceof ActionError ? e.code : "failed";
              const status = code === "bad_request" ? 400 : code === "not_found" ? 404 : code === "unsupported" ? 501 : 500;
              sendJson(res, status, { ok: false, action: name, error: code, message: e?.message ?? String(err) });
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
        sendJson(res, 500, { error: "internal", message: err instanceof Error ? err.message : String(err) });
      } else {
        res.destroy();
      }
    }
  };

  const middleware = ((req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void) => {
    void handler(req, res, next);
  }) as EmuMiddleware;

  middleware.handleUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const pathname = (req.url ?? "/").split("?")[0]!;
    if (base !== "" && !pathname.startsWith(`${base}/`)) {
      socket.destroy();
      return;
    }
    const rel = base === "" ? pathname : pathname.slice(base.length);
    const helper = parseHelperPath(rel);
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
      wss.handleUpgrade(req, socket, head, (ws) => {
        session.attachHidSocket(wsHidSocket(ws));
      });
    })();
  };

  middleware.attachDevice = attachDevice;
  middleware.attachedSerials = () => [...attached];

  return middleware;
}
