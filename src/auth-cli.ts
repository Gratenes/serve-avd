import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { AuthService, type AuthOptions } from "./auth";

export interface AuthCliOptions {
  unsafeNoAuth?: boolean;
  authDatabase?: string;
  authOrigin?: string;
  authAbsoluteTtl?: string;
  authIdleTtl?: string;
}

/** Partial configuration is an error, including for the local CLI. */
export function configuredAuth(options: AuthCliOptions = {}): AuthOptions | false {
  const databasePath = options.authDatabase ?? process.env.SERVE_AVD_AUTH_DATABASE;
  const origin = options.authOrigin ?? process.env.SERVE_AVD_AUTH_ORIGIN;
  const absolute = options.authAbsoluteTtl ?? process.env.SERVE_AVD_AUTH_ABSOLUTE_TTL_MS;
  const idle = options.authIdleTtl ?? process.env.SERVE_AVD_AUTH_IDLE_TTL_MS;
  const configured = [databasePath, origin, absolute, idle].some(value => value !== undefined);
  if (options.unsafeNoAuth === true) {
    if (configured) throw new Error("Cannot combine --unsafe-no-auth with authentication configuration");
    return false;
  }
  if (!configured) throw new Error("Authentication is required, including on localhost. Configure --auth-database and --auth-origin, or explicitly opt out with --unsafe-no-auth (never expose this mode through a proxy or network).");
  if (!databasePath || !origin) throw new Error("Authentication requires both --auth-database / SERVE_AVD_AUTH_DATABASE and --auth-origin / SERVE_AVD_AUTH_ORIGIN");
  const ttl = (value: string | undefined, name: string): number | undefined => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer in milliseconds`);
    return parsed;
  };
  return {
    databasePath,
    origin,
    absoluteTtlMs: ttl(absolute, "Auth absolute TTL"),
    idleTtlMs: ttl(idle, "Auth idle TTL"),
  };
}

/** Reads through readline for Unicode, paste and editing; suppresses terminal echo. */
async function prompt(question: string, hidden = false): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Account provisioning requires an interactive terminal; passwords cannot be passed as arguments or piped");
  const output = new Writable({ write(chunk, encoding, callback) {
    if (!hidden) process.stdout.write(chunk, encoding);
    callback();
  } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  process.stdout.write(question);
  try {
    return await new Promise<string>((resolve, reject) => {
      rl.once("SIGINT", () => reject(new Error("Account provisioning cancelled")));
      rl.once("close", () => reject(new Error("Account provisioning cancelled")));
      rl.question("", resolve);
    });
  } finally {
    rl.close();
    if (hidden) process.stdout.write("\n");
  }
}

export async function provisionAccount(mode: "bootstrap" | "recover", options: AuthCliOptions): Promise<void> {
  const config = configuredAuth(options);
  if (!config) throw new Error("Configure authentication database and origin before provisioning an administrator");
  const auth = new AuthService(config);
  try {
    const username = await prompt("Administrator username: ");
    const password = await prompt("Password (15–128 characters): ", true);
    const confirmation = await prompt("Confirm password: ", true);
    if (password !== confirmation) throw new Error("Passwords do not match");
    if (mode === "bootstrap") await auth.bootstrap(username, password);
    else await auth.recover(username, password);
    console.log(mode === "bootstrap" ? "Administrator created." : "Administrator recovered; previous sessions revoked.");
  } finally {
    auth.close();
  }
}
