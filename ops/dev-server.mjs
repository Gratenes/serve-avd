import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createDevHandler } from "./dev-handler.mjs";
import {
  emuMiddleware,
  closeAllDeviceSessions,
  closeDeviceSession,
} from "../dist/middleware.js";

// Discover every connected ADB device; visibility belongs to each browser.
const serials = [];
const attached = new Set();
const exec = promisify(execFile);
const databasePath = process.env.SERVE_AVD_AUTH_DATABASE;
const origin = process.env.SERVE_AVD_AUTH_ORIGIN;
const host = process.env.SERVE_AVD_HOST ?? "127.0.0.1";
const port = Number(process.env.SERVE_AVD_PORT ?? "3200");
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("SERVE_AVD_PORT must be an integer from 1 to 65535");
if (!databasePath || !origin)
  throw new Error("Native auth database and external origin are required");
const middleware = emuMiddleware({
  codec: "auto",
  sessionOptions: { bitRateMbps: 2 },
  auth: { databasePath, origin },
});
if (!middleware.auth) throw new Error("Native authentication is required");
let discovering = false;
const discoverDevices = async () => {
  if (discovering) return;
  discovering = true;
  try {
    const { stdout } = await exec("adb", ["devices"], { timeout: 10000 });
    const online = stdout.split("\n").filter(line => /\sdevice\s*$/.test(line))
      .map(line => line.trim().split(/\s+/)[0]);
    serials.splice(0, serials.length, ...online);
    for (const s of attached) {
      if (!online.includes(s)) {
        closeDeviceSession(s);
        attached.delete(s);
      }
    }
    for (const s of online) {
      if (attached.has(s)) continue;
      try {
        await middleware.attachDevice(s);
        attached.add(s);
        console.log(`serve-avd: attached ${s}`);
      } catch {
        // Retry devices that are still booting on the next discovery pass.
      }
    }
  } catch {
    console.error("serve-avd: device discovery unavailable; retrying");
  } finally {
    discovering = false;
  }
};
await discoverDevices();
const discoveryTimer = setInterval(discoverDevices, 5000);
discoveryTimer.unref();
const pathFor = (req) => (req.url ?? "/").split("?")[0];
const server = createServer(createDevHandler(middleware, serials, attached, { discoverAll: true }));
server.on("upgrade", (req, socket, head) => {
  const path = pathFor(req);
  if (!serials.some((s) => path === `/helper/${encodeURIComponent(s)}/ws`)) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  middleware.handleUpgrade(req, socket, head);
});
server.listen(port, host, () =>
  console.log(`serve-avd: listening on ${host}:${port}`),
);
const stop = () => {
  clearInterval(discoveryTimer);
  middleware.auth.close();
  closeAllDeviceSessions();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", () => {
  stop();
  setTimeout(() => process.exit(0), 2000).unref();
});
process.on("SIGINT", stop);
