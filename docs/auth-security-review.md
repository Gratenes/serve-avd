# Authentication boundaries and verification

The CLI, detached CLI, MCP preview, standalone server and embedded middleware reject missing authentication configuration. Unauthenticated development requires the explicit `--unsafe-no-auth` or library `auth: false` opt-out. The CLI rejects that opt-out when authentication configuration is also present.

## Access boundaries

| Surface | Required access |
| --- | --- |
| Login page and login submission | Public; submission requires the configured Origin and is throttled |
| Workspace | Anonymous navigation redirects to login |
| APIs, event logs, screenshots, video/log streams, helpers and unknown routes | Valid session before device access |
| Mutating requests | Valid session, configured Origin and CSRF token |
| User administration and emulator startup/shutdown | Administrator; deployments may further restrict operations |
| WebSocket upgrade and input | Valid session and configured Origin; input rechecks session validity |
| Password-change-required session | Identity/account/password/logout only |
| Public capture capability | GET/HEAD access to its single capture until expiry or revocation; logs and controls remain authenticated |

Local and private addresses grant no authentication privileges. Forwarded headers and proxy identity headers do not establish a session. Login throttling uses the actual socket address; origin checks use the configured external origin. Revocation and expiry close tracked HTTP streams and WebSockets.

## Reproducible checks

`test/auth-boundary.test.ts` covers anonymous protected requests, a loopback reverse proxy with forged headers, hostile WebSocket origins, wrapper overrides and capture capability boundaries. Authentication suites cover password policy, persistent sessions and throttles, corrupt storage, CSRF, role checks, forced password changes, cookie scope, expiry, rotation, revocation and last-administrator protection.

Run typecheck, build, unit/integration tests and browser tests. Check CLI startup and embedded middleware with missing configuration. Validate login and revocation against each deployment's external origin separately; mocked-device coverage does not verify a deployed reverse proxy.

## Operational limits

Expose authenticated services over HTTPS and configure a device allowlist appropriate to the deployment. The unsafe opt-out grants device access to every caller and is unsuitable for network or proxy exposure. Clients sharing a reverse proxy share its address throttle. Automated regression coverage does not establish denial-of-service resistance or audit host services.
