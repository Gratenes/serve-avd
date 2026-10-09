/**
 * Standalone preview server: an http server wrapping emuMiddleware, with
 * per-device state files so the CLI (and other processes) can find us.
 */
import { createServer, type Server } from "http";
import { emuMiddleware, type EmuMiddlewareOptions, type EmuMiddleware } from "./middleware";
import { closeAllDeviceSessions, peekDeviceSession } from "./device-session";
import {
  inProcessServeAvdState,
  writeServeAvdState,
  removeStateForDevice,
  readAllStates,
  statePidAlive,
  type ServeAvdDeviceState,
} from "./state";
import { isPortFree, findFreePort } from "./ports";
import { createDebug } from "./debug";
import { configuredAuth } from "./auth-cli";

const debug = createDebug("server");

export interface StartServerOptions extends Omit<EmuMiddlewareOptions, "onShutdown"> {
  port: number;
  /** Fail (or reclaim a stale serve-avd) instead of scanning when the port is busy. */
  strictPort?: boolean;
  host?: string;
}

export interface RunningServer {
  server: Server;
  middleware: EmuMiddleware;
  port: number;
  host: string;
  /** Attach a device and persist its state file. */
  attach(serial: string): Promise<ServeAvdDeviceState>;
  /** Stop everything and clean up state files. */
  close(): void;
}

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const host = options.host ?? "127.0.0.1";
  let port = options.port;

  let running: RunningServer;
  const middleware = emuMiddleware({
    basePath: options.basePath,
    auth: options.auth === undefined ? configuredAuth() : options.auth,
    allowedDevices: options.allowedDevices,
    codec: options.codec,
    initialState: options.initialState,
    sessionOptions: options.sessionOptions,
    onShutdown: () => {
      debug("shutdown requested from preview");
      running.close();
      process.exit(0);
    },
  });

  try {
    if (!(await isPortFree(port, host))) {
      // Reclaim the port when a previous serve-avd (per its state files) holds it.
      const stale = readAllStates().filter((s) => s.port === port && s.pid !== process.pid);
      const reclaimed = stale.some((s) => {
        if (!statePidAlive(s)) return false;
        try {
          process.kill(s.pid, "SIGTERM");
          return true;
        } catch {
          return false;
        }
      });
      if (reclaimed) {
        console.log(`\x1b[90mPort ${port} was held by a previous serve-avd — restarting it.\x1b[0m`);
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline && !(await isPortFree(port, host))) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      if (!(await isPortFree(port, host))) {
        if (options.strictPort) throw new Error(`Port ${port} is in use`);
        port = await findFreePort(port + 1, host);
      }
    }

  } catch (error) {
    middleware.auth?.close();
    throw error;
  }

  const server = createServer((req, res) => middleware(req, res));
  server.on("upgrade", (req, socket, head) => middleware.handleUpgrade(req, socket as never, head));

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
  } catch (error) {
    middleware.auth?.close();
    throw error;
  }

  const attachedHere = new Set<string>();
  let closed = false;

  running = {
    server,
    middleware,
    port,
    host,
    async attach(serial: string): Promise<ServeAvdDeviceState> {
      await middleware.attachDevice(serial);
      attachedHere.add(serial);
      const name = peekDeviceSession(serial)?.name;
      const state = inProcessServeAvdState(serial, port, options.basePath ?? "/", host, name);
      writeServeAvdState(state);
      return state;
    },
    close(): void {
      if (closed) return;
      closed = true;
      for (const serial of attachedHere) removeStateForDevice(serial);
      closeAllDeviceSessions();
      middleware.auth?.close();
      server.close();
    },
  };
  return running;
}
