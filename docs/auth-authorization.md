# Authentication boundary and authorization matrix

Inventory taken before authentication integration. Every path is relative to the middleware base path.

| Surface | Anonymous | Operator | Admin |
| --- | --- | --- | --- |
| `/login`, login POST | Public, origin checked on POST | Public | Public |
| `/account`, `/auth/me`, logout/password POST | Login required | Own account | Own account |
| `/auth/users` and user mutations | 401 | 403 | Allowed, CSRF and origin required |
| `/`, `/api`, `/grid/api` | Page redirect / API 401 | Allowed | Allowed |
| `/api/event-log`, `/api/event-log/events` | 401 | Allowed | Allowed |
| `/helper/:serial/config`, health, ax, foreground, logs, screenshots, MJPEG, AVCC | 401 | Allowlisted devices | Allowlisted devices |
| `/helper/:serial/action` | 401 | Full device control, CSRF and origin required | Same |
| `/helper/:serial/ws` | Reject before device session creation | Session and origin required | Same |
| `/grid/api/start`, `/grid/api/shutdown` | 401 | 403 | Allowed only where deployment permits |
| Hosted dev wrapper `/grid/api` override | 401 before override | All connected ADB devices | Same |
| Future or unknown routes | Authentication required by default | Routing determines availability | Same |

Forced-password-change sessions may only access identity/account UI, change password, or log out. HTTP response lifetimes and WebSocket commands are tied to the server session. Revocation/expiry closes connections. The dev wrapper prohibits device startup and restricts helper routes to currently connected ADB serials, refreshed every 5 seconds. The X and eye control preview visibility in each browser. Cloudflare Access stays enabled; production is outside this rollout.

Native HTTP cookies use the configured external origin, never forwarded headers. Authentication is a shared boundary, applied before deployment overrides and lazy device-session lookup. Unauthenticated local library compatibility is explicitly `auth: false`; the hosted wrapper rejects missing configuration.
