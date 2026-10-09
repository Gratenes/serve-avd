# Workspace feature additions

This document records workspace acceptance criteria and supported behavior. Examples and test fixtures are sample data, never production measurements or device state.

This is an acceptance checklist and implementation plan. Unchecked items are not claimed complete. The earlier canvas, remote, inspector, and logcat work does not satisfy this feature set. Mark an item complete only with implementation and verification evidence; record environmental limitations separately.

## Shared workspace acceptance

- [ ] Match Main's entry points: per-device recording, focus and version/crash badges; footer metrics and quality chip; Apps and Automate inspector tabs; remote macro controls; bottom Activity/Captures drawer.
- [ ] Keep target selection, visibility, mirror input, offline/reconnecting states and responsive layouts working. "All visible" means the visible, connected devices at invocation time; report individual failures.
- [ ] Device-specific state never leaks when switching the inspector target. Persistent definitions survive reload; session artifacts and data have explicit lifetime.
- [ ] Use the design palette: background `#0D0E10`, panels `#121417`/`#141619`, raised `#1B1E22`, borders `#262A2F`/`#2C3036`, primary text `#ECEEF0`, secondary `#A3A9B0`, muted `#7C838B`, selection `#6EE7B7`, warning `#F5B544`, error/recording `#F2777A`, information `#7CB7FF`. Use IBM Plex Sans/Mono with sensible fallbacks.
- [ ] Controls have accessible names, keyboard focus and pressed/expanded states. Busy, empty, disconnected and failed operations have visible states. Unsupported capabilities are explained rather than simulated.

## 1. Screen recording and captures — Capture.dc.html

- [ ] Device-header Record/Stop controls show a red REC indicator and live elapsed time. Duration choices are 10, 30, 60 seconds and Until stop. All-visible recording has per-device results.
- [ ] Stop creates a real playable capture. Export supports actual MP4, GIF and WebM content, matching extension and MIME type; conversion failures remain visible.
- [ ] Export panel contains preview, clip duration and editable start/end trim handles or equivalent precise controls. Reject reversed/out-of-range trims.
- [ ] Optional key-press burn-in reflects timestamped inputs in the chosen interval; optional logcat attachment contains that device's selected interval.
- [ ] Screenshot and recording results appear together in the bottom Captures tray as selectable thumbnails with device, time and format/duration badges; downloading one and downloading all as a real ZIP work.
- [ ] Copy share link is backed by a usable artifact URL with the existing authentication boundary, or explicitly shown unavailable where sharing cannot be supported.

## 2. APK install and recent builds — Apps.dc.html

- [ ] Dropping an APK onto a device shows a dashed mint target overlay. Inspector Apps also supports file browsing/drop. Shift-drop targets all visible devices.
- [ ] Show filename, device and upload progress; distinguish uploaded, installing and launch phases. Do not invent percentage progress during an opaque ADB install. Cancel cancels the supported operation and reports its final state.
- [ ] Actual installation refreshes package name, version name/code and available debug/install-time/size metadata; device header version badge follows the selected app.
- [ ] Apps panel supports Launch, Restart, Uninstall and Main's Clear data action against the correct package/device.
- [ ] Recent builds show filename and real metadata with installed marking and reusable Install actions; document whether sourced from uploaded artifacts, configured build directories or both.
- [ ] Design's `.aab`/split package affordance is implemented with a real bundle/split workflow or visibly capability-gated; an AAB must not be passed to ordinary APK install.

## 3. Crash alerts and traces — Crash.dc.html

- [ ] Detect real per-device fatal app crashes and retain a bounded history independently of whether Apps/Logcat is open. Do not count each stack frame as a new crash.
- [ ] Device card displays dismissible red alert and crash-count badge, exception summary/time, View trace and Restart app. Dismissing a toast does not erase the report.
- [ ] Apps trace view supports previous/next reports, exception message, available device/app/version/thread/API metadata, numbered frames, highlighted app frames and collapsed framework frames.
- [ ] Copy report and Download .txt include the complete trace and available preceding 10 seconds of logcat. Open in timeline selects the corresponding crash. Restart actually relaunches the crashed package.

## 4. Input macros — Macros.dc.html

- [ ] Remote Record macro and Run macro open the Automate workflow. Recording shows elapsed time, count and recent inputs; Stop & save names/persists a macro; Discard removes the unfinished recording.
- [ ] Record actual delivered keys/text/deep links and timing without duplicate mirrored events. Saved list shows name, steps and estimated duration/use metadata derived from real state.
- [ ] Editor supports adding, editing, deleting and reordering key, text, wait, deep-link and wait-for-screen/check steps, including per-step delay and bounded waits.
- [ ] Run targets selected device or all visible, supports repeat and step-through, displays current step and outcome, and can be stopped.
- [ ] Stop-on-app-crash cancels pending work promptly for the affected run. Timeout, disconnect and action failure do not report success.

## 5. D-pad focus overlay — Focus.dc.html

- [ ] Per-device Focus toggle enables live AX-focused bounds correctly mapped to the displayed image, including scaling/letterboxing; overlay does not intercept device input.
- [ ] Independent Outline, Trail and View info toggles display current bounds, numbered recent focus movement and class/resource ID/geometry.
- [ ] After D-pad input, compare before/after focused nodes. Repeated unchanged focus produces a direction-specific no-movement/dead-end warning; missing AX data is not misreported as a proven dead end.
- [ ] Focus moves, dead ends and focus-lost counts derive from observations. Any claim about nextFocus direction or absent focusable views is supported by available AX data.

## 6. Named emulator snapshots — Snapshots.dc.html

- [ ] Automate lists real snapshots for the selected emulator image and saves named current state. Metadata/thumbnail/description are real where available, otherwise omitted or unknown.
- [ ] Restore presents the design's current-state-loss choice: Save, then restore or Restore; operations display progress/failure and refresh the stream/state afterward.
- [ ] Set/unset startup default is persisted per emulator image and actually used on subsequent launch; show BOOT DEFAULT badge.
- [ ] Snapshot management menu and copying to another image are implemented only when compatibility can be established; unavailable cross-image copy is clearly disabled rather than falsely succeeding.

## 7. Stream quality and performance — Stream.dc.html

- [ ] Footer chip opens quality controls for Native/1080p/720p/540p, maximum 15/30/60 fps and 1–12 Mbps bitrate. Changes affect the delivered encoder stream, not just labels or CSS dimensions.
- [ ] Browser-specific preferences survive reload and are correctly scoped. Auto adaptation responds to connection measurements and lowers resolution before frame rate.
- [ ] Codec options reflect actual capabilities; unsupported H.265/AV1 cannot appear operational on the H.264 path.
- [ ] CPU, app memory, app FPS and stream network sparklines/performance detail use bounded timestamped measurements. Distinguish app frame rate from browser decode/render frame rate and unavailable measurements.
- [ ] Encoder, sent bitrate, latency and dropped-frame summaries use actual observations or explicitly unavailable values. Quality changes and reconnection do not leave stale metric timers.

## 8. Device presets — Presets.dc.html

- [ ] Save current settings as a named reusable preset, with summary chips and persisted definitions. Include network speed/latency, language/locale, geographic location and font scale.
- [ ] Apply to selected device or all visible runs the underlying settings actions, reports partial failures and marks Applied only after successful application.
- [ ] Design's accessibility/offline scenarios support applicable Wi-Fi/mobile/airplane, battery, TalkBack/high contrast settings; unknown current values are not invented.
- [ ] Language/locale or other emulator-image restrictions are reported accurately, including required restart where applicable.

## 9. Deep-link presets — Presets.dc.html

- [ ] Save/edit/delete named link templates and expose a quick-send list plus manual URL input in Automate.
- [ ] A link containing `{id}` asks for a value, substitutes it safely, and sends the resolved link to the chosen device. Cancellation sends nothing; unresolved placeholders are rejected.
- [ ] Successful sends enter macro recording and activity timeline with their resolved URL; app launch errors are surfaced.

## 10. Activity timeline and repro export — Timeline.dc.html

- [ ] Bottom Activity drawer contains a real session time axis and separate labeled device lanes, including disconnected devices with retained events.
- [ ] Record input, install, settings, capture and crash events with device identity and timestamp; use the reference colors and distinct crash markers. Type filters update lanes, selected-event list and count consistently.
- [ ] Adjustable start/end selection shades the interval across lanes and produces a chronological selected-event list. Crash/capture navigation selects the relevant event/range.
- [ ] Save as macro converts replayable selected events to ordered typed steps with relative waits; define device selection/deduplication for mirrored multi-device input, and explain excluded non-replayable events.
- [ ] Export repro downloads a usable bundle with selected event data, device/app context, replay instructions/steps and available related logs/crash/capture artifacts. The exported range and filtering are explicit.

## Implementation seams and sequence

1. Define typed browser contracts for device identity/action transport, timestamped input, crash reports, captures and timeline events. Reuse existing action dispatch/authentication rather than adding an unauthenticated side channel. Separate device mutation from browser-persisted definitions.
2. Backend/device work: package metadata and upload/install lifecycle; crash collection/log history; snapshot/default persistence; real settings read/apply; quality/session encoder options; real performance samples; capture artifact conversion/export. Validate bounded inputs, process arguments, cleanup and device isolation.
3. Frontend work: Apps and Automate modules plus client/remote entry points. A separate observer/capture/timeline module mounts per-device decorations and bottom drawer, accepts delivered-input notifications and exposes selected-range-to-macro callbacks. Keep module ownership explicit to avoid concurrent edits to client.ts.
4. Integrate complete vertical slices: (a) Apps/install + crash; (b) macros + deep links + presets + snapshots; (c) capture + activity; (d) focus + stream/performance. Each slice includes its functional UI, real backend effects and failure paths before being called complete.
5. Verify unit parsers/validation and browser targeting/workflows; run existing unit/browser regression suites and build. Exercise real emulator/media paths where available. Review screenshots against all reference layouts and test keyboard/mobile usability. Report emulator-dependent validation separately from fixture-based tests.

Suggested shared data fields: device `{id,name,serial}`, event `{id,deviceId,at,kind,summary,data}`, macro step discriminated by `key|text|wait|link|check`, capture `{id,deviceId,startedAt,endedAt,kind,mime,url}`, crash `{id,deviceId,at,packageName,message,frames,logcat}`. These are planning shapes; the implemented exported TypeScript types are authoritative. Avoid parallel incompatible schemas.

## Verification record

No implementation results have been marked complete by this planning document. Add exact checks, remaining capability limits and real-device evidence during final review; do not replace this checklist with a blanket completion claim.
