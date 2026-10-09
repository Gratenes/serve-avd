# serve-avd

The `npx serve` of Android Emulators.

Host your emulator for use with Agent tools like Codex, Cursor, or Claude Desktop — locally, over your LAN, or host on a remote machine and tunnel anywhere.

```sh
npx serve-avd
# → Preview at http://localhost:3200
```

https://github.com/user-attachments/assets/91ca0811-119e-46f6-8e3e-9b41bd9f9bd7

`serve-avd` captures the emulator's screen via `adb screenrecord`, exposes it as an H.264 WebCodecs stream (with an MJPEG fallback) plus a WebSocket control channel, and serves a browser preview UI on top. It works with any running Android Emulator (and most physical devices over adb) — no root, no plugin, no instrumentation in your app.

It is a faithful Android port of [serve-sim](https://github.com/EvanBacon/serve-sim) by Evan Bacon: same interface, same streaming design, same wire protocol — rebuilt on what Android and adb provide.

## Features

- Smooth H.264 video stream in the browser (WebCodecs), with instant paint on connect — no waiting for the next frame.
- Full interaction: tap, drag, and fling with the mouse; scroll with the wheel.
- Android navigation from the browser: Back, Home, Recents, power, volume, rotate, theme toggle, screenshot.
- Optional TV remote on each preview: D-pad/OK, Back/Home, playback, volume, Menu/Search, and Power for Android TV emulators and ADB-connected TVs.
- Keyboard forwarding — type into the emulator directly, Escape acts as Back, ⌘⇧H goes Home.
- logcat is forwarded to the browser (and mirrored into the browser console for browser-use MCP tools to read).
- Recent actions are available in the browser Tools panel and `serve-avd event-log` — and export as a replayable script (`serve-avd replay`).
- UI hierarchy dumps for agents: `serve-avd ax` (uiautomator → JSON), plus semantic targeting on top: `serve-avd find "Sign in"`, `serve-avd tap --text "Sign in"`, `serve-avd wait "Welcome"`.
- **Built-in MCP server** (`serve-avd mcp`) — one config line hands the emulator to Claude Desktop, Cursor, Codex or any MCP client as tools.
- **Typed client SDK** (`serve-avd/client`) for Playwright-style scripts and agent frameworks — no shelling out.
- Emulator controls from the CLI, Tools panel, SDK and MCP: location (+ routes), network conditions, battery, fingerprint, calls & SMS, font scale / density / locale / TalkBack, snapshots (save/load to reset state), app install/launch/stop/clear/open-URL, and `shell`/`push`/`pull` passthrough.
- Multiple emulators at once — boot and attach AVDs straight from the Devices panel.
- Every command works headless (straight over adb) when no server is running, and through the server (shared event log, live viewers) when one is.

### Device workspace

The workspace has a connected-device rail, live preview cards, a floating TV remote, and a Controls/Logcat inspector. Choose **Focus**, **Split**, or **Stack** to arrange previews. Click a card or a device in the rail to select the remote and inspector target. Use the eye button to hide a preview without disconnecting it, and drag the rail handle (or use its arrow keys) to reorder devices. **Show all devices** restores hidden previews.

The toolbar toggles the device list, remote, and inspector. Inspector controls are searchable and grouped into collapsible sections. Logcat supports text filtering, minimum severity, pause, and clearing the displayed log.

### TV remote

The shared remote targets the selected, visible device. Focus its body to use arrow keys, Enter for OK, and Escape for Back; Tab moves between buttons, where Enter/Space activates the focused button. Use its target button to cycle devices. Drag the handle to move it, use arrow keys while the handle has focus, or double-click the handle to re-dock. The chevron collapses the remote.

**Mirror input** sends remote button presses to all visible, connected previews. Screen taps, typing, and inspector actions still target their own device. On phones only the selected preview is visible, so mirror input affects that preview alone. Controls disable while disconnected or paused, and commands are never replayed on reconnect. This uses the existing ADB connection, without TV discovery/pairing, voice input, or held-button repeat.

### Using the preview on a phone

Open the served URL in your mobile browser. The device selector chooses the preview and inspector target. The device list and inspector become full-width panels, and the remote docks below the preview. Inactive and hidden previews, and previews in background tabs, pause their streams.

Touch the preview to tap or drag; additional fingers are ignored during a gesture. Open **Text input** to type with your phone keyboard, then press **Send**; **Enter** and **Backspace** send those keys separately. ADB text input supports ASCII only. Unsent panel text stays available after disconnection. **Device controls** retains phone navigation, rotation, theme, and screenshot actions.

## Why?

Hosted emulators can be hard to test. `serve-avd` lets you test the hosted infra locally first for faster iteration. When you're ready to host an emulator remotely, simply tunnel the served URL and users can interact with the emulator as if it were running locally on their device.

It's also a great way to hand an emulator to an AI agent: everything is driveable over plain HTTP + WebSocket, screenshots and UI dumps are one command away, and the event log tells you what the agent did.

## Install

Requires the Android SDK platform-tools (`adb`; the `emulator` binary is needed to boot AVDs by name) and a [maintained Node.js LTS release](https://nodejs.org/en/about/previous-releases) (Node 22+; the persistent SQLite driver uses a native addon). serve-avd finds your SDK via `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, or the default SDK locations on macOS and Linux.

The H.264 stream needs `screenrecord --output-format=h264` (present on every emulator image from the last decade). If it's unavailable, serve-avd automatically falls back to an MJPEG screenshot stream.

## CLI

```
serve-avd [device...]                 Start preview server (default: localhost:3200)
                                      device = adb serial or AVD name (boots it if needed)
serve-avd --no-preview [device...]    Stream in foreground without a preview server
serve-avd mcp [--serve] [-d serial]   MCP server over stdio (see Connectors)

serve-avd gesture '<json>' [-d serial]
                                      Send a touch gesture
serve-avd tap <x> <y> [-d serial]     Tap at normalized 0..1 coords
serve-avd tap --text "Sign in"        …or the first UI element matching
          --id submit | --desc Search   text / resource id / description
          [--index n] [--exact] [--long [ms]]
serve-avd find "<text>" [--id|--desc|--class] [--json]
                                      Find UI elements: bounds, centers, normalized coords
serve-avd wait "<text>" [--timeout 10s] [--gone]
                                      Poll until an element appears/disappears (exit 2 on timeout)
serve-avd swipe <x1> <y1> <x2> <y2> [--duration 300ms]
serve-avd button [name] [-d serial]   Send a button press (default: home)
                                      home|back|app-switch|power|lock|wake|
                                      volume-up|volume-down|mute|menu|camera|
                                      notifications|quick-settings|dpad-*|…
serve-avd type <text> [-d serial]     Type text via the emulator keyboard
                                      (ASCII only; also --stdin / --file <path>)
serve-avd rotate <orientation> [-d serial]
                                      portrait | portrait_upside_down |
                                      landscape_left | landscape_right
serve-avd debug <option> <on|off> [-d serial]
                                      Toggle an Android render/debug flag
                                      (overdraw|gpu-profile|layout-bounds|
                                       show-taps|pointer-location|slow-animations)
serve-avd memory-warning [-d serial]  Ask the foreground app to trim memory
serve-avd event-log [-d serial]       Show recent emulator events
serve-avd event-log --export <file>   …as a replayable JSON script
serve-avd replay <file> [--speed 2] [--no-wait] [--coords] [--continue]
                                      Replay a script (exported or hand-written)
serve-avd screenshot [path] [-d serial]
                                      Save a screenshot (PNG/JPEG)
serve-avd ax [-d serial]              Dump the UI hierarchy as JSON (uiautomator)
serve-avd foreground [-d serial]      Print the foreground app

Emulator controls:
serve-avd geo <lat> <lon> [alt]       Set the GPS fix
serve-avd geo --route <file|"lat,lon lat,lon …"> [--interval 1s] [--steps n] [--loop]
                                      Follow a route of fixes
serve-avd network [speed <gsm|edge|lte|full|up:down>] [delay <gprs|edge|umts|none|min:max>]
                  [airplane on|off] [wifi on|off] [data on|off]   (no args: status)
serve-avd battery [<0-100> | unplug | ac | usb | wireless | reset]
serve-avd fingerprint [id] [--remove] Touch the fingerprint sensor
serve-avd call <number> | call accept|end|hold <number>
serve-avd sms <number> <text…>        Deliver an incoming SMS
serve-avd a11y font-scale <n> | density <dpi|reset> | locale <tag> [--app pkg|--system] | talkback on|off
serve-avd snapshot save|load|delete <name> | snapshot list

Apps:
serve-avd install <apk> [--launch]    adb install -r -g
serve-avd launch <package>            Launch by package (or package/.Activity)
serve-avd stop | clear-data | uninstall <package>
serve-avd open <url> [--package pkg]  Open a URL / deep link
serve-avd apps [--all]                List installed packages
serve-avd shell [cmd…] | push <local> <remote> | pull <remote> [local]
                                      adb passthrough against the resolved device

Options:
  -p, --port <port>   Starting port (preview default: 3200; --no-preview default: 3100)
      --host <host>   Host to bind (default: 127.0.0.1; use 0.0.0.0 for LAN)
  -d, --detach        Spawn a background server and exit (daemon mode)
  -q, --quiet         JSON-only output
      --no-preview    Skip the web UI; stream in foreground only
      --panes <panes> Initially open preview panes: devices, tools, logs, or none
      --fit           Deprecated compatibility flag; previews now fit automatically
      --theme <theme> Set device appearance before opening the preview:
                      light or dark
      --codec <codec> Stream codec for the preview UI: 'auto' (H.264 when the
                      browser can decode it) or 'mjpeg' (force screenshot
                      streaming — e.g. in browsers without WebCodecs)
      --bit-rate <mbps>  H.264 bitrate in Mbps (default: 8)
      --size <WxH>    Capture at a fixed size (default: display size, capped
                      at 1920 on the long side)
      --list [device] List running streams
      --kill [device] Kill running stream(s)
```

### Examples

```sh
serve-avd                              # attach every online device, open preview
                                       # (boots your first AVD when none are running)
serve-avd Pixel_9_Pro_XL               # target an AVD by name — boots it if needed
serve-avd emulator-5554 emulator-5556  # two emulators side by side
serve-avd --detach                     # start a background server, return JSON
serve-avd --list                       # show running streams
serve-avd --kill                       # stop all servers
serve-avd --panes devices,tools        # start with the devices and tools panes open
serve-avd --theme dark                 # start the device in Dark Mode

# Type text into the focused field
serve-avd type "Hello, world!"
echo "from stdin" | serve-avd type --stdin
serve-avd type --file ./snippet.txt

# Touch
serve-avd tap 0.5 0.9                  # near bottom-center
serve-avd gesture '{"type":"begin","x":0.5,"y":0.8}'
serve-avd gesture '{"type":"move","x":0.5,"y":0.4}'
serve-avd gesture '{"type":"end","x":0.5,"y":0.3}'   # swipe up

# Agent helpers
serve-avd screenshot ./now.png
serve-avd ax | jq '.root.children[0]'
serve-avd foreground
serve-avd event-log --json

# Semantic targeting — no coordinate guessing
serve-avd find "Sign in"                        # matches text *and* content-description
serve-avd tap --text "Sign in"                  # tap the first match (or --id / --desc / --index)
serve-avd wait "Welcome" --timeout 15s          # poll the UI until it appears (exit 2 on timeout)
serve-avd wait --id progress --gone             # …or until it disappears
serve-avd tap --text "Delete" --long            # long-press

# Emulator controls
serve-avd geo 37.7749 -122.4194                 # GPS fix
serve-avd geo --route route.json --interval 2s --steps 10   # drive along a route
serve-avd network speed lte delay edge          # link conditions (emulator console)
serve-avd network airplane on                   # airplane / wifi / data toggles
serve-avd battery 15 && serve-avd battery unplug
serve-avd fingerprint                           # unblock a biometric prompt (enrol one first)
serve-avd sms 5551234 "Your code is 424242"
serve-avd call 5551234 && serve-avd call end 5551234
serve-avd a11y font-scale 1.3
serve-avd snapshot save clean                   # …run something risky…
serve-avd snapshot load clean                   # reset to the saved state

# Apps
serve-avd install ./app-debug.apk --launch
serve-avd open "myapp://orders/42"
serve-avd launch com.example.app
serve-avd clear-data com.example.app

# Record what a human (or agent) did in the preview, then reproduce it
serve-avd event-log --export flow.json
serve-avd replay flow.json --speed 2
```

Multiple devices are supported — pass several serials or AVD names, or leave it empty to attach to every online device.

Every subcommand goes through a running serve-avd server when there is one for the device (so viewers, the Tools pane and the event log all see it) and falls back to driving adb directly when there isn't — `serve-avd tap --text "OK"` works with nothing else running.

### Semantic targeting

`find`, `tap --text/--id/--desc/--class` and `wait` are a thin layer over the uiautomator dump. Matching is a case-insensitive substring by default (`--exact` for exact); `--text` also matches content-descriptions so icon buttons resolve too; `--id` accepts either `pkg:id/name` or just `name`; `--index n` picks the nth match. `find` prints normalized centers (what `tap x y` and the SDK take) and pixel bounds:

```
[0] "Sign in" Button com.app:id/submit  @ (0.500, 0.925)  px 500,1850  bounds [100,1800][900,1900]  clickable
```

`wait` polls (default every 500 ms, 10 s budget) and exits 2 on timeout, so `serve-avd tap --text Next && serve-avd wait "Done"` is a one-line assertion. A uiautomator dump takes 1–3 s on a healthy emulator; screens that never go idle (spinners) can take longer, and a dump is capped at 20 s.

### Replay

`event-log --export` distils the event log — taps (with the text/id target when there was one), drags, typing, keys, buttons, rotations, and every emulator control — into a JSON script with relative timing:

```json
{ "version": 1, "device": "emulator-5554", "steps": [
  { "t": 0,    "action": "launch", "package": "com.example.app" },
  { "t": 3089, "action": "wait",   "text": "Sign in", "timeoutMs": 8000 },
  { "t": 5256, "action": "tap",    "x": 0.5, "y": 0.925, "target": { "text": "Sign in" } },
  { "t": 7751, "action": "text",   "text": "hello" }
]}
```

`replay` runs it back through the same actions. Taps prefer the recorded target (survives layout shifts) unless you pass `--coords`; `--speed 2` halves the pauses, `--no-wait` drops them, `--continue` keeps going past failures. Scripts are plain JSON — hand-write or generate them.

### Camera

The Android Emulator has camera injection built in — no helper needed. Point the AVD's camera at your host webcam or the animated virtual scene when you boot it:

```sh
emulator -avd Pixel_9_Pro_XL -camera-back virtualscene -camera-front webcam0
```

Inside the virtual scene, custom posters can be placed via the emulator's extended controls. (This replaces serve-sim's dylib-injection camera feature — Android provides the equivalent natively.)

## Authentication and operation

The library retains local unauthenticated compatibility: `emuMiddleware({ auth: false })` explicitly selects it, and omitted `auth` has the same behavior. Use this only for a trusted local development server. The standalone CLI enables authentication when configured through flags or environment variables. Supplying only part of the configuration fails startup before devices are resolved or launched; invalid or unavailable account storage fails startup too. A hosted wrapper must require both values itself and pass `auth` explicitly.

```sh
# Keep account data outside the checkout, in a directory owned by the service user.
export SERVE_AVD_AUTH_DATABASE=/var/lib/serve-avd/auth.sqlite
export SERVE_AVD_AUTH_ORIGIN=https://serve-avd-dev.embedez.com

# Run locally as the service user, in an interactive terminal.
node dist/serve-avd.js auth-bootstrap
# Prompts for username, then a hidden password and confirmation.

node dist/serve-avd.js emulator-5554 --host 127.0.0.1 --port 3201
```

Equivalent flags are `--auth-database <absolute-path>` and `--auth-origin <origin>`. The origin is the exact browser-facing HTTP(S) origin, including a nondefault port, with no path or trailing slash. Use `http://localhost:3200` for local testing; HTTPS origins set Secure cookies even when the service itself listens on HTTP behind a proxy. Arbitrary forwarded headers are never trusted to infer origin or client address. HTTPS session cookies will not authenticate a browser opening the plain HTTP localhost URL; test direct-origin authorization with explicit HTTP requests instead.

Default sessions expire after 12 hours absolutely or 1 hour idle. Override with `--auth-absolute-ttl <milliseconds>` / `SERVE_AVD_AUTH_ABSOLUTE_TTL_MS` and `--auth-idle-ttl <milliseconds>` / `SERVE_AVD_AUTH_IDLE_TTL_MS`. Accounts and hashed opaque sessions persist through restarts. Cookies are HttpOnly, SameSite=Lax, scoped to the mount path and omit Domain. Mutating requests require the configured Origin and `X-CSRF-Token`; login requires the Origin too. Unexpected WebSocket origins are rejected. Revocation closes active sockets and streams.

Argon2id uses 19 MiB memory, two iterations and one lane, with at most two simultaneous verification/hash jobs. A five-hash benchmark on the dev host averaged 183.4 ms per hash; benchmark again when moving hosts. Identity polling does not extend idle expiry. Passwords contain 15–128 characters, support paste and long passphrases, and are never trimmed. There is no public signup or default credential. Initial bootstrap refuses once any administrator exists. Administrators create users, enable/disable users, reset passwords, change roles and revoke sessions from **Accounts**. New and reset passwords require change on the next login; until changed, the session can only inspect its identity, change its password or log out. Disabling or demoting the last enabled administrator is refused. Both administrators and operators control allowlisted devices; administrators additionally manage accounts and device startup/shutdown. Authentication does not widen the device allowlist.

For local account recovery, stop the service first, then run the command as its account/database owner:

```sh
node dist/serve-avd.js auth-recover \
  --auth-database /var/lib/serve-avd/auth.sqlite \
  --auth-origin https://serve-avd-dev.embedez.com
```

Enter the existing administrator username and a new hidden password. Recovery enables that administrator, clears the forced-change flag and revokes their stored sessions; restart the service afterward so any old process closes its connections. No password option or password environment variable exists. Do not put credentials in shell history, source control or service configuration.

Embedded authenticated configuration:

```ts
const middleware = emuMiddleware({
  basePath: "/.emu",
  auth: { databasePath: "/var/lib/serve-avd/auth.sqlite", origin: "https://example.com" },
  allowedDevices: ["emulator-5554", "emulator-5556"],
});
app.use(middleware);
server.on("upgrade", (req, socket, head) => middleware.handleUpgrade(req, socket, head));
// On shutdown: middleware.auth?.close(); closeAllDeviceSessions();
```

A wrapper overriding `/grid/api` or any other route before calling the middleware must first call `await middleware.auth.handle(req, res)` and return when it returns true. Otherwise it exposes an authentication bypass. Require an auth service at startup, preserve the existing two-TV allowlist and disabled startup policy, bind the hosted process to loopback, and keep Cloudflare Access plus tunnel Access-token validation enabled. Production service configuration is separate from the dev rollout.

The database directory is created with mode 0700 and database file with mode 0600. Ensure any existing parent directory also has restrictive ownership/permissions. Migrations run transactionally at startup; newer unsupported schema versions fail closed. Back up while the service is stopped, copying the database and any `-wal`/`-shm` companions together, or use SQLite's online backup API. Treat backups as account data: restrict access, encrypt off-host copies and retain audit history. Restore to the configured absolute path under the service user's ownership, start the service and verify login. A restored snapshot can restore previously revoked sessions; keep the service offline until all restored sessions have been revoked through the account tools if that snapshot is not current.

Provisioning remains an interactive operator step. Build and tests do not create a hosted administrator. For dev rollout, configure persistent storage and the exact external origin, provision locally, deploy the built files, then verify anonymous denial on localhost and the Access-protected domain, login, forced password change, logout and revocation with the allowlisted devices. Do not remove Access or alter production as part of this rollout.

## HTTP + WebSocket API

Everything the preview UI does goes through a small same-origin API you can drive yourself:

```
GET  /api                                  server + device state
GET  /api/event-log?device=&limit=         recent events JSON
GET  /api/event-log/events                 SSE: snapshot + live entries
GET  /grid/api                             connected devices + configured AVDs
POST /grid/api/start {"device": "..."}     attach a serial / boot an AVD

GET  /helper/<serial>/stream.mjpeg         multipart image stream (?raw=1 → bare frames)
GET  /helper/<serial>/stream.avcc          H.264 AVCC envelopes (see below)
GET  /helper/<serial>/config               { width, height, orientation, rotation }
GET  /helper/<serial>/health               { status: "ok" }
GET  /helper/<serial>/screenshot.png       one-shot screenshot
GET  /helper/<serial>/logs                 SSE of logcat lines
GET  /helper/<serial>/ax                   UI hierarchy JSON
GET  /helper/<serial>/foreground           { packageName, activity, pid }
POST /helper/<serial>/action               { "action": "...", ...params } → { ok, result }
WS   /helper/<serial>/ws                   binary input protocol
```

`POST …/action` is the RPC behind every subcommand, the Tools pane, the SDK and the MCP tools. Params can be spread beside `action` or nested under `params`; errors come back as `{ ok: false, error: bad_request | not_found | unsupported | failed, message }` with a matching 4xx/5xx.

| action | params | notes |
|---|---|---|
| `tap` | `x, y` **or** `text \| id \| desc \| class [, exact, index]`, `durationMs` | long-press with `durationMs` |
| `swipe` | `x1, y1, x2, y2, durationMs` | |
| `text` | `text` | ASCII; `\n`/`\t` → Enter/Tab |
| `key` | `code` (browser `KeyboardEvent.code`) or `keycode`, `longPress` | |
| `button` | `button` | `home`, `back`, `app-switch`, `power`, `volume-up`, … |
| `rotate` | `orientation` | resolves once the device has rotated; fails if refused |
| `debug` / `theme` / `scroll` / `memory-warning` | as the WS messages | |
| `find` | `text \| id \| desc \| class, exact, index` | `{ matches: [{ node, center, normalized, bounds }], total, screen }` |
| `wait` | same + `timeoutMs, intervalMs, gone` | `{ ok, match, elapsedMs, attempts }` |
| `geo` | `lat, lon, alt` | emulator only |
| `network` | `speed, delay, airplane, wifi, data` | none → status |
| `battery` | `level, plugged (ac\|usb\|wireless\|none), reset` | returns current state |
| `fingerprint` | `id, remove` | emulator only |
| `call` | `number, op (call\|accept\|end\|hold)` | emulator only |
| `sms` | `number, text` | emulator only |
| `font-scale` / `density` / `locale` / `talkback` | `scale` / `dpi` / `locale, package, system` / `enabled` | |
| `install` / `launch` / `stop` / `clear-data` / `uninstall` | `path` / `package` | `install` reads the APK from the server host |
| `open` | `url, package` | VIEW intent |
| `apps` | `all` | `{ packages }` |
| `snapshot` | `op (save\|load\|delete\|list), name` | emulator only; `load` waits for adb to come back |
| `shell` | `cmd` | `{ code, output }` |

```sh
curl -X POST localhost:3200/helper/emulator-5554/action \
  -H 'content-type: application/json' -d '{"action":"tap","text":"Sign in"}'
```

The `/stream.avcc` wire format matches serve-sim byte-for-byte: each chunk is `[len:u32-be][tag:u8][payload]` where `len` covers the tag + payload. Tags: `0x01` avcC decoder config, `0x02` keyframe, `0x03` delta frame, `0x04` seed image (painted before the first keyframe decodes). The decoder config and the current GOP are replayed to late joiners, so viewers paint instantly even when the screen is static.

The input WebSocket accepts binary `[tag][JSON]` frames (all coordinates normalized 0..1 in the rotated display space):

```
0x03 touch     {"type":"begin|move|end","x":…,"y":…}
0x04 button    {"button":"home"}
0x05 pinch     {"type":"begin|move|end","x1":…,"y1":…,"x2":…,"y2":…}
0x06 key       {"type":"down|up","code":"Enter"}          (browser KeyboardEvent.code)
0x07 rotate    {"orientation":"landscape_left"}
0x08 debug     {"option":"overdraw","enabled":true}
0x09 memory-warning
0x0b scroll    {"dx":…,"dy":…,"x":…,"y":…}
0x0c toggle software keyboard
0x0d text      {"text":"hello"}
0x0e theme     {"theme":"dark"}
0x0f keyframe  (no body — viewer can't decode; re-arm capture for fresh SPS/IDR)
```

The server pushes `0x82` + JSON screen config whenever dimensions or orientation change, and `0x83` + `{"kind","ok","message"}` for one-off notices (e.g. a rotation the device refused).

## Connectors

### MCP (Claude Desktop, Claude Code, Cursor, Codex, …)

`serve-avd mcp` is a Model Context Protocol server over stdio. It exposes the emulator as tools — `screenshot`, `ui_tree`, `find`, `wait_for`, `tap`, `swipe`, `type_text`, `press_button`, `press_key`, `foreground`, `event_log`, `open_url`, `launch_app`, `install_apk`, `list_apps`, `rotate`, `set_location`, `snapshot`, `list_devices`, and a generic `device_action` for everything else (network, battery, fingerprint, call, sms, locale, …). No extra dependencies; nothing else needs to be running (it drives adb directly, or a running serve-avd when there is one).

```json
{
  "mcpServers": {
    "android": {
      "command": "npx",
      "args": ["-y", "serve-avd", "mcp", "--serve"]
    }
  }
}
```

That's the whole config for Claude Desktop (`claude_desktop_config.json`), Cursor (`.cursor/mcp.json`) and Codex; for Claude Code: `claude mcp add android -- npx -y serve-avd mcp --serve`.

- `--serve` also hosts the preview UI in the same process (default port 3200), so a human can watch the agent work at `http://localhost:3200`. Omit it to run headless.
- `-d <serial|AVD>` pins every tool call to one device; otherwise tools take an optional `device` and default to the only/first one.
- `screenshot` returns a JPEG (~250 KB on a 1344×2992 display) plus the screen size; `ui_tree` returns a compact list of labelled/interactive nodes with normalized centers — cheaper and exact, so agents can `find` → `tap` by text without vision at all.
- Everything an agent does lands in the event log (`serve-avd event-log`, the Tools pane) and can be exported and replayed.

### Client SDK (`serve-avd/client`)

A typed, dependency-free client for a running server — plain `fetch`, so it works from Node 18+, Bun, Deno and browsers:

```ts
import { connect } from "serve-avd/client";

const emu = await connect("http://localhost:3200");   // or your mounted base, e.g. http://localhost:8081/.emu
const dev = emu.device();                             // first attached device (or emu.device("Pixel_9_Pro_XL"))

await dev.launch("com.example.app");
await dev.waitFor({ text: "Sign in" }, { timeoutMs: 15_000 });
await dev.tap({ id: "email" });
await dev.type("me@example.com\n");
await dev.tap({ text: "Sign in" });
await dev.waitFor({ text: "Welcome" });

const { data, contentType } = await dev.screenshot(); // Uint8Array
const nodes = await dev.find({ class: "Button" });     // bounds + normalized centers
await dev.swipe({ x: 0.5, y: 0.8 }, { x: 0.5, y: 0.3 });
await dev.geo(48.8566, 2.3522);
await dev.snapshot.save("logged-in");
await dev.action("network", { speed: "edge" });        // any action by name
```

`Device` mirrors the action table above (`tap`, `longPress`, `swipe`, `scroll`, `type`, `key`, `button`/`back`/`home`, `rotate`, `find`/`findFirst`/`exists`/`waitFor`, `ax`, `foreground`, `config`, `screenshot`, `eventLog`, `geo`/`followRoute`, `network`, `battery`, `fingerprint`, `call`, `sms`, `fontScale`, `density`, `locale`, `talkback`, `snapshot.*`, `install`, `launch`, `stop`, `clearData`, `uninstall`, `open`, `apps`, `shell`). Failures throw `ServeAvdError` with a `code` (`bad_request | not_found | unsupported | failed | http | network`); `waitFor` throws on timeout. `emu.attach("Pixel_9_Pro_XL")` boots/attaches devices; `emu.grid()` and `emu.eventLog()` mirror the Devices pane and event log.

Authenticated SDK clients use the same user sessions and CSRF checks as the browser. There is no machine-auth bypass. In a same-origin browser, cookies are sent automatically; obtain a fresh token from `<base>/auth/me` and pass it for actions:

```ts
const identity = await fetch("/.emu/auth/me", { credentials: "same-origin" }).then(r => r.json());
const emu = await connect(`${location.origin}/.emu`, {
  headers: { "X-CSRF-Token": identity.csrfToken },
  credentials: "same-origin",
});
```

A Node client must log in using an explicit configured `Origin`, retain the session cookie privately, then supply `Cookie`, `Origin` and `X-CSRF-Token` through `ConnectOptions.headers` (or a custom `fetch` maintaining a cookie jar). The SDK forwards those headers to all requests and refuses server endpoints on another origin. Password changes rotate the cookie and CSRF token, so reconnect with fresh values. Authentication/permission failures expose `ServeAvdError.code === "http"` and `status === 401` or `403`; they never silently fall back to another identity. Local CLI/MCP adb tools remain host-operator tools and do not provide an authenticated remote session; use the SDK's explicit authenticated transport for a protected HTTP server.

### Claude Code Desktop

Create a `.claude/launch.json` and define a server:

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "Android",
      "runtimeExecutable": "npx",
      "runtimeArgs": ["serve-avd"],
      "port": 3200
    }
  ]
}
```

### Expo / Metro

Automatically start serve-avd with `npx expo start` and access the URL at `http://localhost:8081/.emu`.

First, customize the `metro.config.js` file (`bunx expo customize`):

```js
// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require("expo/metro-config");
const connect = require("connect");
const { emuMiddleware } = require("serve-avd/middleware");

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

config.server = config.server || {};
const originalEnhanceMiddleware = config.server.enhanceMiddleware;
config.server.enhanceMiddleware = (metroMiddleware, server) => {
  const middleware = originalEnhanceMiddleware
    ? originalEnhanceMiddleware(metroMiddleware, server)
    : metroMiddleware;
  const app = connect();
  app.use(emuMiddleware({ basePath: "/.emu" }));
  app.use(middleware);
  return app;
};

module.exports = config;
```

## Embed in your dev server

`serve-avd/middleware` is a Connect-style middleware that mounts the same preview UI inside your existing dev server (Metro, Vite, Next, plain Express, etc.):

```ts
import { emuMiddleware } from "serve-avd/middleware";

const middleware = emuMiddleware({ basePath: "/.emu" });
app.use(middleware);
// → preview HTML at /.emu
// → state JSON  at /.emu/api

const server = app.listen(3000);
server.on("upgrade", (req, socket, head) => middleware.handleUpgrade(req, socket, head));
```

Device sessions are created in-process and everything (video, input socket, logs) is same-origin behind your one port, so remote proxying/tunnelling needs no extra configuration — just forward the `upgrade` event as above so input and live streams work. When terminating TLS at a reverse proxy, the page uses `wss:` automatically based on the page origin.

On shutdown, call `closeAllDeviceSessions()` (exported from `serve-avd/middleware`) to stop the adb capture processes.

## How it works

```
┌──────────────────┐  adb screenrecord  ┌──────────────────┐  AVCC / MJPEG / WS  ┌─────────┐
│ Android Emulator │ ─────────────────► │ serve-avd server │ ──────────────────► │ Browser │
│ (or adb device)  │ ◄───────────────── │ (Node,           │                     └─────────┘
└──────────────────┘   adb shell input  │  in-process)     │
                                        └──────────────────┘
                                                ▲
                                          state files in
                                        $TMPDIR/serve-avd/
                                                ▲
                                        ┌──────────────────┐
                                        │ serve-avd CLI /  │
                                        │ middleware       │
                                        └──────────────────┘
```

- **Video**: `adb exec-out screenrecord --output-format=h264` produces an Annex B elementary stream. serve-avd re-frames it into length-prefixed AVCC envelopes, extracts SPS/PPS into a decoder config, and caches the current GOP so new viewers decode instantly. screenrecord's 3-minute cap and its inability to follow rotation are handled by transparent restarts (viewers just see a new decoder config). The browser decodes with WebCodecs `VideoDecoder` onto a canvas.
- **Stills**: `adb exec-out screencap` (JPEG on modern Android, PNG otherwise) backs the MJPEG fallback stream, seed frames, and screenshots.
- **Input**: a single persistent `adb shell` per device multiplexes `input motionevent/tap/swipe/keyevent/text` commands, skipping the per-command adb handshake for low latency. Devices without `input motionevent` (pre-Android 11) get gestures replayed as `tap`/`swipe` on release.
- **Pinch**: synthesized as raw multi-touch `sendevent`s where `/dev/input` is writable (non-Play images after `adb root`); unavailable on Play-store images — the UI tells you.

Device capture uses Node + `adb`, with no device daemon. Account storage and Argon2id hashing use native Node addons; install dependencies on the target platform.

## Caveats

- `type` supports ASCII only (Android's `input text` limitation) — matching serve-sim's "US keyboard only".
- Apps that lock their orientation (launchers do) won't visibly rotate, exactly like hardware. The rotation is confirmed against the device, so the preview stays put and says so instead of pretending.
- Pinch requires a rootable (non-Play) emulator image.
- Physical devices work for everything except AVD-specific features (boot-by-name, emulator camera flags, and the emulator-console actions: `geo`, `network speed/delay`, `fingerprint`, `call`, `sms`, `snapshot`); enable USB debugging and expect `screenrecord` limits to vary by OEM.
- `fingerprint` needs a fingerprint enrolled in Settings first; `a11y talkback` needs an image with TalkBack installed (Google APIs / Play); `a11y locale` sets a per-app locale (Android 13+) unless `--system`, which needs a rooted (non-Play) image and otherwise applies on the next boot.
- `find`/`wait`/`tap --text` depend on `uiautomator dump`, which is unavailable on secure screens (lock screen, payment sheets) and slow on screens that never go idle.
- The HTTP action endpoint can run `shell` and install APKs. Configure native authentication and a device allowlist before sharing a server. Retain existing Cloudflare Access or other proxy protection during rollout.

## Development

```sh
npm ci
npm run build       # bundle CLI + middleware + browser client into dist/
npm test            # unit tests (H.264 parser, XML/rotation/keymap parsers, find/wait, replay, MCP handler)
npm run typecheck
npx playwright install chromium  # one-time browser setup
npm run test:browser             # builds client, tests UI + WebSocket commands with mock devices
```

Browser tests use mock devices and WebSocket connections; they do not require ADB or a running emulator. Install Chromium once with `npx playwright install chromium`, then run `npm run test:browser` after client changes.

## Credit & License

Apache-2.0
