---
name: serve-avd
description: Control Android emulators and ADB-connected devices with serve-avd. Use for inspecting screens, tapping and scrolling, typing, navigating Android TV, testing app flows, capturing evidence, and replaying interactions through its MCP tools, CLI, or SDK.
---

# Control Android with serve-avd

Use an existing serve-avd MCP connection when available. Tool names below are the server's names; the agent client may prefix them. Read the advertised tool schemas for the installed version.

## Choose the connection and device

- Local MCP: call `list_devices`, select the intended online serial, and pass `device` on subsequent calls. A configured default can otherwise select the first device. Check `foreground` before interacting with an app.
- Local CLI: use the installed `serve-avd` binary. Discover connected devices with `adb devices -l`; `serve-avd --list` lists running streams, not all ADB devices. Pass `-d SERIAL` on action subcommands. On the top-level server command, `-d` means **detach**, not device selection.
- Remote server URL: use the browser or SDK against that URL, retaining any mount prefix such as `/.emu`. Local CLI/MCP are host-operator tools, not remote authenticated clients. Read [references/remote.md](references/remote.md) for SDK and authentication details.

Local operation needs Node 22+ and Android SDK platform-tools. SDK discovery uses `ANDROID_HOME`, `ANDROID_SDK_ROOT`, or standard SDK locations. The emulator binary is also needed to boot an AVD. For a missing local MCP connection, configure a stdio server with command `serve-avd` and args `["mcp"]`; add `--serve` for a human-visible preview and `-d SERIAL` for a default device. The skill itself does not establish the connection.

For this fork, use its installed `serve-avd` executable; unscoped `npx serve-avd` resolves the upstream npm package. Preview startup (including `--detach` and MCP `--serve`) requires `SERVE_AVD_AUTH_DATABASE` and `SERVE_AVD_AUTH_ORIGIN` plus an administrator provisioned interactively with `serve-avd auth-bootstrap`. Reuse the configured database and external origin. Localhost and private networks require the same authentication; preserve auth when proxying a preview.

To start a preview for a selected running device: `serve-avd SERIAL --detach`. To boot a known AVD, use its name in place of the serial. Reuse an existing preview when possible and use the returned URL rather than assuming port 3200 is free. CLI actions and headless MCP also work without a preview server.

## Observe, act, verify

1. Inspect `ui_tree` or `find` to locate the target. Prefer stable resource IDs, then text or content-description. Matching defaults to case-insensitive substrings; `text` also searches content-descriptions. Use `exact` or a zero-based `index` after inspecting matches when ambiguous.
2. Issue one meaningful action against the selected device. For text entry, tap the editable field first. `type_text` supports ASCII; newline and tab send Enter and Tab. It types into existing content rather than replacing it automatically.
3. Use `wait_for` for the expected next UI state (`gone: true` for disappearance). Inspect the returned result as well as MCP `isError`; an accepted action is not evidence that the app completed the task.
4. Capture a fresh tree or screenshot to confirm the requested outcome. Report the device, observed result, and any evidence paths or failed assertion.

If a target is absent, inspect the current screen before retrying. Scroll the relevant container and inspect again; stop when the target is found, the screen stops changing, or a small explicit attempt budget is exhausted. After an uncertain action, observe before repeating a submission or other consequential operation.

Use `screenshot` when the hierarchy omits a custom canvas or visual details matter. Tap/swipe coordinates are **normalized 0..1 in the current rotated screen**, not pixels. Convert pixel positions with `x / width`, `y / height`; reacquire positions after scrolling or rotation. Secure screens may reject UI dumps, and continuously animating screens can make them slow. A dump can take up to 20 seconds, so avoid rapid repeated requests.

## Common MCP calls

Each example also needs `device: "YOUR_SERIAL"`.

| Intent | Tool and arguments |
| --- | --- |
| Inspect | `ui_tree {}` or `find {"text":"Sign in"}` |
| Tap an identified field | `tap {"id":"email"}` |
| Type | `type_text {"text":"tester@example.com"}` |
| Assert navigation | `wait_for {"text":"Welcome","timeoutMs":15000}` |
| Scroll down | `swipe {"x1":0.5,"y1":0.8,"x2":0.5,"y2":0.3,"durationMs":300}` |
| Long press | `tap {"text":"Item","durationMs":700}` |
| Navigate | `press_button {"button":"back"}` |
| TV focus navigation | `press_key {"code":"ArrowDown"}`, then `press_key {"code":"Enter"}` |
| Launch | `launch_app {"package":"com.example.app"}` |
| Deep link | `open_url {"url":"myapp://orders/42"}` |
| Evidence | `screenshot {}`, `event_log {"limit":50,"json":true}` |

For TV apps, observe focus after directional keys before activating it. In the browser, turn on Mirror input only when the requested operation should affect all visible connected devices.

For emulator conditions, APK installation, snapshots, or replay, read [references/workflows.md](references/workflows.md).

## CLI equivalent

Replace the serial and app-specific selectors with discovered values:

```sh
serve-avd foreground -d emulator-5554
serve-avd find 'Sign in' --json -d emulator-5554
serve-avd tap --id email -d emulator-5554
serve-avd type 'tester@example.com' -d emulator-5554
serve-avd tap --text 'Sign in' --exact -d emulator-5554
serve-avd wait 'Welcome' --timeout 15s -d emulator-5554
serve-avd screenshot ./result.png -d emulator-5554
```

CLI `wait` exits 2 on timeout. Capture evidence and diagnose the unexpected screen instead of reporting success. Use `serve-avd <command> --help` for flags supported by the installed version.
