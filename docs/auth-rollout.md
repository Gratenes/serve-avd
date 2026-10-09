# Authentication deployment guide

Use Node.js 22 or later and build the project before provisioning accounts. Account storage belongs outside the checkout, under the service user's ownership.

## Configure and provision

```sh
mkdir -p "$HOME/.local/share/serve-avd/auth"
chmod 700 "$HOME/.local/share/serve-avd/auth"
export SERVE_AVD_AUTH_DATABASE="$HOME/.local/share/serve-avd/auth/accounts.sqlite"
export SERVE_AVD_AUTH_ORIGIN="http://localhost:3200"
serve-avd auth-bootstrap
serve-avd emulator-5554 --host 127.0.0.1 --port 3200
```

Choose an administrator username and enter a password at the hidden prompts. Bootstrap refuses an existing administrator. No credentials belong in source control. Environment variables must be provided by the shell or service manager; the server does not load `.env` automatically.

For public hosting, configure the exact external HTTPS origin, terminate TLS at a reverse proxy, and forward HTTP and WebSocket upgrades to the loopback listener. Native authentication is required. Any additional proxy authentication is deployment configuration.

## Optional wrapper example

`ops/dev-server.mjs` demonstrates authenticated discovery of connected ADB devices. Configure `SERVE_AVD_HOST` and `SERVE_AVD_PORT` as needed; the defaults are `127.0.0.1` and `3200`. Its example handler blocks emulator startup and limits helper access to discovered devices. Adapt these policies to the deployment. The standard CLI supports an explicit device selection.

Wrapper routes must share the middleware authentication boundary. Public capture shares must pass through `handleShare` before authentication; all remaining routes must authenticate before exposing device information or creating sessions.

## Verify an installation

- Anonymous workspace navigation redirects to login; protected APIs, screenshots and streams deny access.
- Login, password change, logout and session revocation work at the configured origin.
- Operators cannot manage accounts or start/stop emulators.
- HTTP and WebSocket origin checks reject unexpected origins.
- Accounts survive a service restart and device restrictions remain in effect.

Run `npm run typecheck`, `npm test`, `npm run test:browser` and `npm run build` for project regression checks. Browser tests use mocked devices; validate device-dependent operations separately on disposable devices.

See the README for backup, recovery, session policy and authenticated SDK usage.
