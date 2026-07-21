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
- Keyboard forwarding — type into the emulator directly, Escape acts as Back, ⌘⇧H goes Home.
- logcat is forwarded to the browser (and mirrored into the browser console for browser-use MCP tools to read).
- Recent actions are available in the browser Tools panel and `serve-avd event-log`.
- UI hierarchy dumps for agents: `serve-avd ax` (uiautomator → JSON).
- Multiple emulators at once — boot and attach AVDs straight from the Devices panel.
- Works headless over the same HTTP API when no browser is attached.

## Why?

Hosted emulators can be hard to test. `serve-avd` lets you test the hosted infra locally first for faster iteration. When you're ready to host an emulator remotely, simply tunnel the served URL and users can interact with the emulator as if it were running locally on their device.

It's also a great way to hand an emulator to an AI agent: everything is driveable over plain HTTP + WebSocket, screenshots and UI dumps are one command away, and the event log tells you what the agent did.

## Install

Requires the Android SDK platform-tools (`adb`; the `emulator` binary is needed to boot AVDs by name) and a [maintained Node.js LTS release](https://nodejs.org/en/about/previous-releases) (Node 18.17+). serve-avd finds your SDK via `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, or the default SDK locations on macOS and Linux.

The H.264 stream needs `screenrecord --output-format=h264` (present on every emulator image from the last decade). If it's unavailable, serve-avd automatically falls back to an MJPEG screenshot stream.

## CLI

```
serve-avd [device...]                 Start preview server (default: localhost:3200)
                                      device = adb serial or AVD name (boots it if needed)
serve-avd --no-preview [device...]    Stream in foreground without a preview server
serve-avd gesture '<json>' [-d serial]
                                      Send a touch gesture
serve-avd tap <x> <y> [-d serial]     Tap at normalized 0..1 coords
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
serve-avd screenshot [path] [-d serial]
                                      Save a screenshot (PNG/JPEG)
serve-avd ax [-d serial]              Dump the UI hierarchy as JSON (uiautomator)
serve-avd foreground [-d serial]      Print the foreground app

Options:
  -p, --port <port>   Starting port (preview default: 3200; --no-preview default: 3100)
      --host <host>   Host to bind (default: 127.0.0.1; use 0.0.0.0 for LAN)
  -d, --detach        Spawn a background server and exit (daemon mode)
  -q, --quiet         JSON-only output
      --no-preview    Skip the web UI; stream in foreground only
      --panes <panes> Initially open preview panes: devices, tools, logs, or none
      --fit           Initially size the emulator to fit the preview viewport
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
serve-avd --panes devices,tools --fit  # start with panes open and fit the emulator
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
```

Multiple devices are supported — pass several serials or AVD names, or leave it empty to attach to every online device.

### Camera

The Android Emulator has camera injection built in — no helper needed. Point the AVD's camera at your host webcam or the animated virtual scene when you boot it:

```sh
emulator -avd Pixel_9_Pro_XL -camera-back virtualscene -camera-front webcam0
```

Inside the virtual scene, custom posters can be placed via the emulator's extended controls. (This replaces serve-sim's dylib-injection camera feature — Android provides the equivalent natively.)

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
WS   /helper/<serial>/ws                   binary input protocol
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
```

The server pushes `0x82` + JSON screen config whenever dimensions or orientation change.

## Connectors

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

No native code, no device daemons: the npm package is plain Node + `adb`.

## Caveats

- `type` supports ASCII only (Android's `input text` limitation) — matching serve-sim's "US keyboard only".
- Apps that lock their orientation (launchers do) won't visibly rotate, exactly like hardware.
- Pinch requires a rootable (non-Play) emulator image.
- Physical devices work for everything except AVD-specific features (boot-by-name, emulator camera flags); enable USB debugging and expect `screenrecord` limits to vary by OEM.

## Development

```sh
npm install
npm run build       # bundle CLI + middleware + browser client into dist/
npm test            # unit tests (H.264 parser, XML/rotation/keymap parsers)
npm run typecheck
```

## Credit & License

Apache-2.0
