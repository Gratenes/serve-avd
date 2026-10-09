# Native authentication dev rollout

Implementation and automated verification completed on 2026-10-09 using Node 24.21.0. The new maintained SQLite driver requires Node 22+, a deliberate change from the previous advertised Node 18 minimum. Argon2id uses [OWASP's recommended minimum parameters](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html): 19 MiB, two iterations, one lane. Five hashes averaged 183.4 ms on this host. Native driver requirements were checked against [better-sqlite3's package metadata](https://github.com/WiseLibs/better-sqlite3/blob/master/package.json).

## Deployed dev configuration

- Service: user unit `serve-avd-dev.service`; Node 24, loopback port 3201.
- Wrapper: `ops/dev-server.mjs` and `ops/dev-handler.mjs`, installed under `/home/vm/.local/share/serve-avd/dev/`.
- Drop-in: `/home/vm/.config/systemd/user/serve-avd-dev.service.d/auth.conf`.
- Database: `/home/vm/.local/share/serve-avd/auth-dev/accounts.sqlite`; directory mode 0700, database/WAL/SHM mode 0600.
- External origin: `https://serve-avd-dev.embedez.com`.
- Device allowlist remains `emulator-5580`, `emulator-5590`; startup remains blocked by the wrapper.
- Cloudflare Access and tunnel token validation were not changed. Production configuration was not changed.

The wrapper refuses missing auth configuration. An administrator was subsequently provisioned at the user’s explicit request, with a generated password saved only in the ignored root `.env` (mode 0600). Live localhost login/logout was verified. The service is active and fails closed for device traffic until an administrator signs in.

## Initial provisioning reference

For a fresh installation only, run this as the service user in a terminal on the dev host:

```sh
/home/vm/.nvm/versions/node/v24.21.0/bin/node \
  /home/vm/code/serve-avd/dist/serve-avd.js auth-bootstrap \
  --auth-database /home/vm/.local/share/serve-avd/auth-dev/accounts.sqlite \
  --auth-origin https://serve-avd-dev.embedez.com
```

Choose the username and enter a 15–128-character password at the hidden prompts. Do not send the password through chat. Bootstrap is transactional and refuses an existing administrator. No restart is needed after bootstrap.

Then open the public domain, pass Cloudflare Access, verify native login, account menu and logout, and confirm the device workspace returns to login. **Real dev-domain login/logout verification still requires an authenticated Cloudflare Access browser session.** Local mocked-device browser tests cover the full flow independently.

## Verification evidence

- `npm run typecheck` passed.
- `npm test`: 46 tests passed.
- `npm run test:browser`: 22 tests passed (includes a build).
- ESM and CommonJS middleware imports passed on Node 24.
- Temporary databases tested migration, restart persistence, malformed/corrupt storage, policy, throttles, CSRF, origin validation, cookie scope, session rotation and expiry, reset/role revocation and concurrent last-admin protection.
- Mocked-device tests exercised real WebSocket input and revocation, real HTTP SSE revocation, the deployment grid override, mobile/base-path login and account flows, and no command replay after reauthentication. No test sent destructive commands to the shared TVs.
- Direct localhost: workspace redirects to native login; login page is 200; API, grid override, event stream, screenshot and video requests without a session are JSON 401.
- Public workspace and grid API with a browser User-Agent return 302 to `gratenes.cloudflareaccess.com`. Cloudflare rejects the default Python User-Agent with 1010; this is an edge policy response, not an application response.

For backup, recovery and SDK use, see the README authentication section. Back up the database only while stopped or using SQLite's backup API; retain a consistent WAL snapshot if copying live files.
