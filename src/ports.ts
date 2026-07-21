/** TCP port helpers for server lifecycle management. */
import { execSync } from "child_process";
import { createServer } from "net";

/**
 * Return PIDs currently *listening* on a TCP port (excluding ourselves).
 *
 * The LISTEN filter is load-bearing: a bare `lsof -ti tcp:<port>` also lists
 * processes holding *client* sockets to the port — most notably the user's
 * browser streaming from a previous server. Killing those SIGKILLs the
 * browser's network process and aborts every in-flight fetch in the new
 * preview tab.
 */
export function getPortHolders(port: number): number[] {
  try {
    const output = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    if (!output) return [];
    const myPid = process.pid;
    return output
      .split("\n")
      .map((s) => parseInt(s, 10))
      .filter((pid) => Number.isFinite(pid) && pid !== myPid);
  } catch {
    return [];
  }
}

export function isPortFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/** First free port in [start, start+span). Rejects when none are free. */
export async function findFreePort(start: number, host = "127.0.0.1", span = 100): Promise<number> {
  for (let port = start; port < start + span; port++) {
    if (await isPortFree(port, host)) return port;
  }
  throw new Error(`No free port in ${start}..${start + span - 1}`);
}
