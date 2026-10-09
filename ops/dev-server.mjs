import { createServer } from "node:http";
import { createDevHandler } from "./dev-handler.mjs";
import {
  emuMiddleware,
  closeAllDeviceSessions,
} from "../dist/middleware.js";

// emulator-5554 is the shared viptv-design-tv AVD and must attach at startup.
// emulator-5556 is the optional viptv-hero-qa AVD (tmux session viptv-hero-emulator);
// it attaches whenever it is running, without blocking or failing the service.
const serial = "emulator-5554";
const optional = ["emulator-5556"];
const serials = [serial, ...optional];
const databasePath = process.env.SERVE_AVD_AUTH_DATABASE;
const origin = process.env.SERVE_AVD_AUTH_ORIGIN;
if (!databasePath || !origin)
  throw new Error("Native auth database and external origin are required");
const middleware = emuMiddleware({
  codec: "auto",
  sessionOptions: { bitRateMbps: 2 },
  auth: { databasePath, origin },
  allowedDevices: serials,
});
if (!middleware.auth) throw new Error("Native authentication is required");
await middleware.attachDevice(serial);
const attached = new Set([serial]);
let attaching = false;
const attachOptional = async () => {
  if (attaching) return;
  attaching = true;
  try {
    for (const s of optional) {
      if (attached.has(s)) continue;
      try {
        await middleware.attachDevice(s);
        attached.add(s);
        console.log(`serve-avd: attached ${s}`);
      } catch {
        /* not running yet */
      }
    }
  } finally {
    attaching = false;
  }
};
attachOptional();
setInterval(attachOptional, 15000).unref();
const pathFor = (req) => (req.url ?? "/").split("?")[0];
const server = createServer(createDevHandler(middleware, serials, attached));
server.on("upgrade", (req, socket, head) => {
  const path = pathFor(req);
  if (!serials.some((s) => path === `/helper/${s}/ws`)) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  middleware.handleUpgrade(req, socket, head);
});
server.listen(3201, "127.0.0.1", () =>
  console.log("serve-avd: http://127.0.0.1:3201"),
);
const stop = () => {
  middleware.auth.close();
  closeAllDeviceSessions();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", () => {
  stop();
  setTimeout(() => process.exit(0), 2000).unref();
});
process.on("SIGINT", stop);
