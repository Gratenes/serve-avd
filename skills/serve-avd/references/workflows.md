# App setup, emulator conditions, and replay

Use the installed MCP schemas or CLI help for exact parameters. For MCP controls without a dedicated tool, consult `device_action`'s advertised action schema.

## App and device state

- `install_apk` takes a path on the serve-avd host. CLI `install APK --launch` installs and launches. Check the foreground package afterward.
- App data clearing, uninstalling, snapshot loading/deletion, and shell commands can alter existing work. Keep these within the requested test/reset scope; inspect state before selecting a reset strategy.
- Snapshots (`snapshot save|load|delete NAME`, `snapshot list`) are emulator-only. Use a distinct name for a baseline, and reload only when restoring that state is intended. Verify the foreground app and UI after restoration.
- Location, network speed/delay, fingerprint, calls, SMS, and snapshots use emulator-console capabilities and are unavailable on physical devices. Wi-Fi/data/airplane controls are separate from network speed/delay.
- Fingerprint simulation requires an enrolled fingerprint. TalkBack requires an image where it is installed. Per-app locale requires Android 13+; system locale needs a rooted image or may apply only after reboot. Pinch needs writable input devices on a rootable non-Play image.
- Record original settings before changing battery, network, accessibility, or location conditions, and restore temporary test changes when finished. `battery reset` resumes real battery reporting. An app may lock orientation; confirm rotation rather than repeatedly forcing it.

Examples (append `-d SERIAL` to each action):

```sh
serve-avd snapshot save before-test
serve-avd network speed lte delay edge
serve-avd battery 15
serve-avd battery unplug
serve-avd geo 37.7749 -122.4194
serve-avd a11y font-scale 1.3
```

## Capture and replay

```sh
serve-avd event-log --export ./flow.json -d emulator-5554
serve-avd replay ./flow.json -d emulator-5554
```

Use a running preview server when collecting shared history from the browser, CLI, and MCP. Inspect the exported script before replay: it can contain typed secrets, app operations, and device changes. Keep only the intended flow before sharing or rerunning it.

Replay prefers recorded semantic targets so taps survive layout changes. `--coords` forces recorded coordinates; use it only when the current layout matches. `--speed 2` halves pauses. `--no-wait` drops recorded pauses; retain explicit UI assertions. Default failure stopping is useful for tests; use `--continue` only when continuing after failed steps is deliberate. Verify the final screen independently of replay completion.
