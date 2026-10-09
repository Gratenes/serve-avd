# Remote and SDK control

Use `serve-avd/client` for scripted flows against a running server. Preserve the supplied base URL and explicitly select the device:

```ts
import { connect } from "serve-avd/client";

const emu = await connect("http://localhost:3200");
const dev = emu.device("emulator-5554");
await dev.launch("com.example.app");
await dev.waitFor({ text: "Sign in" }, { timeoutMs: 15_000 });
await dev.tap({ id: "email" });
await dev.type("tester@example.com");
await dev.tap({ text: "Sign in", exact: true });
await dev.waitFor({ text: "Welcome" });
const { data, contentType } = await dev.screenshot();
// Save data with an extension matching contentType.
```

`emu.grid()` discovers attached devices. `emu.attach(AVD_NAME)` can boot/attach a device when that is part of the task. `dev.find`, `dev.ax`, `dev.foreground`, and `dev.eventLog` provide inspection. `dev.action(name, params)` exposes additional actions. SDK errors throw `ServeAvdError`; `waitFor` throws on timeout.

## Authenticated servers

Use the user's authorized session. There is no machine-auth bypass. For a same-origin browser, obtain the CSRF token from the mounted `/auth/me` endpoint:

```ts
const base = `${location.origin}/.emu`; // Use the actual mount, or just location.origin.
const response = await fetch(`${base}/auth/me`, { credentials: "same-origin" });
if (!response.ok) throw new Error(`Session unavailable: ${response.status}`);
const identity = await response.json();
const emu = await connect(base, {
  credentials: "same-origin",
  headers: { "X-CSRF-Token": identity.csrfToken },
});
```

A Node client needs an explicit login using the configured browser-facing `Origin`, a private cookie jar, and `Cookie`, `Origin`, and `X-CSRF-Token` on subsequent requests through `ConnectOptions.headers` or a custom `fetch`. Inspect the deployed version's login contract before implementing this flow. Password changes rotate both cookie and CSRF token; reconnect with fresh values. Keep credentials and session tokens out of saved scripts and reports.

On HTTP 401/403, resolve the session or device permission with the authorized user. Do not switch to local ADB as a workaround for remote access denial. HTTPS origins issue Secure cookies, which do not authenticate a plain HTTP localhost browser session.

For direct HTTP, inspection endpoints include `<base>/helper/<serial>/ax`, `/foreground`, and `/screenshot.png`; actions use `POST <base>/helper/<serial>/action` with JSON such as `{"action":"tap","id":"submit"}`. Check both the HTTP status and `{ok, result}` / `{ok:false, error, message}` envelope. Use the same session and CSRF rules as the SDK. APK installation paths refer to the server host, not the agent's local machine.
