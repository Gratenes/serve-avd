# Workspace feature additions

This document records workspace acceptance criteria and supported behavior. Examples and test fixtures are sample data, never production measurements or device state.

This is an acceptance checklist and implementation record. Checked items have implementation and focused test/source-review evidence; they do not imply a destructive or end-to-end live-emulator test. Live-device validation limits are described separately below. The earlier canvas, remote, inspector, and logcat work does not satisfy this feature set. Mark an item complete only with implementation and verification evidence; record environmental limitations separately.

## Shared workspace acceptance

- [x] Match Main's entry points: per-device recording, focus and version/crash badges; footer metrics and quality chip; Apps and Automate inspector tabs; remote macro controls; bottom Activity/Captures drawer.
- [x] Keep target selection, visibility, mirror input, offline/reconnecting states and responsive layouts working. "All visible" means the visible, connected devices at invocation time; report individual failures.
- [x] Device-specific state never leaks when switching the inspector target. Persistent definitions survive reload; session artifacts and data have explicit lifetime.
- [x] Use the design palette: background `#0D0E10`, panels `#121417`/`#141619`, raised `#1B1E22`, borders `#262A2F`/`#2C3036`, primary text `#ECEEF0`, secondary `#A3A9B0`, muted `#7C838B`, selection `#6EE7B7`, warning `#F5B544`, error/recording `#F2777A`, information `#7CB7FF`. Use IBM Plex Sans/Mono with sensible fallbacks.
- [x] Controls have accessible names, keyboard focus and pressed/expanded states. Busy, empty, disconnected and failed operations have visible states. Unsupported capabilities are explained rather than simulated.

## 1. Screen recording and captures — Capture.dc.html

- [x] Device-header Record/Stop controls show a red REC indicator and live elapsed time. Duration choices are 10, 30, 60 seconds and Until stop. All-visible recording has per-device results.
- [x] Stop creates a real playable capture. Export supports actual MP4, GIF and WebM content, matching extension and MIME type; conversion failures remain visible.
- [x] Export panel contains preview, clip duration and editable start/end trim handles or equivalent precise controls. Reject reversed/out-of-range trims.
- [x] Optional key-press burn-in reflects timestamped inputs in the chosen interval; optional logcat attachment contains that device's selected interval.
- [x] Screenshot and recording results appear together in the bottom Captures tray as selectable thumbnails with device, time and format/duration badges; downloading one and downloading all as a real ZIP work.
- [x] Copy share link is backed by a usable artifact URL with the existing authentication boundary, or explicitly shown unavailable where sharing cannot be supported.

## 2. APK install and recent builds — Apps.dc.html

- [x] Dropping an APK onto a device shows a dashed mint target overlay. Inspector Apps also supports file browsing/drop. Shift-drop targets all visible devices.
- [x] Show filename, device and upload progress; distinguish uploaded, installing and launch phases. Do not invent percentage progress during an opaque ADB install. Cancel cancels the supported operation and reports its final state.
- [x] Actual installation refreshes package name, version name/code and available debug/install-time/size metadata; device header version badge follows the selected app.
- [x] Apps panel supports Launch, Restart, Uninstall and Main's Clear data action against the correct package/device.
- [x] Recent builds show filename and real metadata with installed marking and reusable Install actions; document whether sourced from uploaded artifacts, configured build directories or both.
- [x] Design's `.aab`/split package affordance is implemented with a real bundle/split workflow or visibly capability-gated; an AAB must not be passed to ordinary APK install.

## 3. Crash alerts and traces — Crash.dc.html

- [x] Detect real per-device fatal app crashes and retain a bounded history independently of whether Apps/Logcat is open. Do not count each stack frame as a new crash.
- [x] Device card displays dismissible red alert and crash-count badge, exception summary/time, View trace and Restart app. Dismissing a toast does not erase the report.
- [x] Apps trace view supports previous/next reports, exception message, available device/app/version/thread/API metadata, numbered frames, highlighted app frames and collapsed framework frames.
- [x] Copy report and Download .txt include the complete trace and available preceding 10 seconds of logcat. Open in timeline selects the corresponding crash. Restart actually relaunches the crashed package.

## 4. Input macros — Macros.dc.html

- [x] Remote Record macro and Run macro open the Automate workflow. Recording shows elapsed time, count and recent inputs; Stop & save names/persists a macro; Discard removes the unfinished recording.
- [x] Record actual delivered keys/text/deep links and timing without duplicate mirrored events. Saved list shows name, steps and estimated duration/use metadata derived from real state.
- [x] Editor supports adding, editing, deleting and reordering key, text, wait, deep-link and wait-for-screen/check steps, including per-step delay and bounded waits.
- [x] Run targets selected device or all visible, supports repeat and step-through, displays current step and outcome, and can be stopped.
- [x] Stop-on-app-crash cancels pending work promptly for the affected run. Timeout, disconnect and action failure do not report success.

## 5. D-pad focus overlay — Focus.dc.html

- [x] Per-device Focus toggle enables live AX-focused bounds correctly mapped to the displayed image, including scaling/letterboxing; overlay does not intercept device input.
- [x] Independent Outline, Trail and View info toggles display current bounds, numbered recent focus movement and class/resource ID/geometry.
- [x] After D-pad input, compare before/after focused nodes. Repeated unchanged focus produces a direction-specific no-movement/dead-end warning; missing AX data is not misreported as a proven dead end.
- [x] Focus moves, dead ends and focus-lost counts derive from observations. Any claim about nextFocus direction or absent focusable views is supported by available AX data.

## 6. Named emulator snapshots — Snapshots.dc.html

- [x] Automate lists real snapshots for the selected emulator image and saves named current state. Metadata/thumbnail/description are real where available, otherwise omitted or unknown.
- [x] Restore presents the design's current-state-loss choice: Save, then restore or Restore; operations display progress/failure and refresh the stream/state afterward.
- [x] Set/unset startup default is persisted per emulator image and actually used on subsequent launch; show BOOT DEFAULT badge.
- [x] Snapshot management menu and copying to another image are implemented only when compatibility can be established; unavailable cross-image copy is clearly disabled rather than falsely succeeding.

## 7. Stream quality and performance — Stream.dc.html

- [x] Footer chip opens quality controls for Native/1080p/720p/540p, maximum 15/30/60 fps and 1–12 Mbps bitrate. Changes affect the delivered encoder stream, not just labels or CSS dimensions.
- [x] Browser-specific preferences survive reload and are correctly scoped. Auto adaptation responds to connection measurements and lowers resolution before frame rate.
- [x] Codec options reflect actual capabilities; unsupported H.265/AV1 cannot appear operational on the H.264 path.
- [x] CPU, app memory, app FPS and stream network sparklines/performance detail use bounded timestamped measurements. Distinguish app frame rate from browser decode/render frame rate and unavailable measurements.
- [x] Encoder, sent bitrate, latency and dropped-frame summaries use actual observations or explicitly unavailable values. Quality changes and reconnection do not leave stale metric timers.

## 8. Device presets — Presets.dc.html

- [x] Save current settings as a named reusable preset, with summary chips and persisted definitions. Include network speed/latency, language/locale, geographic location and font scale.
- [x] Apply to selected device or all visible runs the underlying settings actions, reports partial failures and marks Applied only after successful application.
- [x] Design's accessibility/offline scenarios support applicable Wi-Fi/mobile/airplane, battery, TalkBack/high contrast settings; unknown current values are not invented.
- [x] Language/locale or other emulator-image restrictions are reported accurately, including required restart where applicable.

## 9. Deep-link presets — Presets.dc.html

- [x] Save/edit/delete named link templates and expose a quick-send list plus manual URL input in Automate.
- [x] A link containing `{id}` asks for a value, substitutes it safely, and sends the resolved link to the chosen device. Cancellation sends nothing; unresolved placeholders are rejected.
- [x] Successful sends enter macro recording and activity timeline with their resolved URL; app launch errors are surfaced.

## 10. Activity timeline and repro export — Timeline.dc.html

- [x] Bottom Activity drawer contains a real session time axis and separate labeled device lanes, including disconnected devices with retained events.
- [x] Record input, install, settings, capture and crash events with device identity and timestamp; use the reference colors and distinct crash markers. Type filters update lanes, selected-event list and count consistently.
- [x] Adjustable start/end selection shades the interval across lanes and produces a chronological selected-event list. Crash/capture navigation selects the relevant event/range.
- [x] Save as macro converts replayable selected events to ordered typed steps with relative waits; define device selection/deduplication for mirrored multi-device input, and explain excluded non-replayable events.
- [x] Export repro downloads a usable bundle with selected event data, device/app context, replay instructions/steps and available related logs/crash/capture artifacts. The exported range and filtering are explicit.

## Implementation seams and sequence

1. Define typed browser contracts for device identity/action transport, timestamped input, crash reports, captures and timeline events. Reuse existing action dispatch/authentication rather than adding an unauthenticated side channel. Separate device mutation from browser-persisted definitions.
2. Backend/device work: package metadata and upload/install lifecycle; crash collection/log history; snapshot/default persistence; real settings read/apply; quality/session encoder options; real performance samples; capture artifact conversion/export. Validate bounded inputs, process arguments, cleanup and device isolation.
3. Frontend work: Apps and Automate modules plus client/remote entry points. A separate observer/capture/timeline module mounts per-device decorations and bottom drawer, accepts delivered-input notifications and exposes selected-range-to-macro callbacks. Keep module ownership explicit to avoid concurrent edits to client.ts.
4. Integrate complete vertical slices: (a) Apps/install + crash; (b) macros + deep links + presets + snapshots; (c) capture + activity; (d) focus + stream/performance. Each slice includes its functional UI, real backend effects and failure paths before being called complete.
5. Verify unit parsers/validation and browser targeting/workflows; run existing unit/browser regression suites and build. Exercise real emulator/media paths where available. Review screenshots against all reference layouts and test keyboard/mobile usability. Report emulator-dependent validation separately from fixture-based tests.

Suggested shared data fields: device `{id,name,serial}`, event `{id,deviceId,at,kind,summary,data}`, macro step discriminated by `key|text|wait|link|check`, capture `{id,deviceId,startedAt,endedAt,kind,mime,url}`, crash `{id,deviceId,at,packageName,message,frames,logcat}`. These are planning shapes; the implemented exported TypeScript types are authoritative. Avoid parallel incompatible schemas.

## Current verification and remaining gaps

| Feature | Delivered and tested | Live-device evidence / remaining verification |
|---|---|---|
| Recording/captures | Device recording controls, screenshot tray, previews, trim/conversion, key burn-in, range log attachments, ZIP writer and authenticated artifact links | Recording follow-up replaces screenshot sampling with native Android video and 60-fps playback. a moving 60-fps fixture verifies distinct frames survive recording, and static zero-duration Android samples have regression coverage. MP4/GIF/WebM conversion and key/log interval checks remain covered. Actual ZIP structure, CRC and UTF-8 names passed Python validation; full user download flow was not exercised against the live emulator. |
| APK/builds | Captured-target APK upload, progress/cancel states, app lifecycle controls, version metadata, retained builds and installed marker; browser upload test | No actual app install/uninstall/clear-data was performed on installed applications. Optional actual install/update timestamps and APK size are now supplied when Android makes them available. Launch remains available explicitly and as an opt-in post-install phase; builds come from uploads. |
| Crash reports | Independent per-device collector, deduplication, pre-crash logs, alert/badge, Apps detail, copy/download/restart and timeline navigation; parser/browser tests | No intentional real app crash/restart was performed. Trace now includes numbered app frames, collapsed framework frames and full-report exports, verified in the final focused UI run. |
| Macros | Persistent editor/recorder, target capture, repeat/step-through, cloned run steps, abort/crash polling and touch-release cleanup; unit/browser tests | Live app automation and crash-stop not exercised. The recorder now includes a live elapsed timer and recent-key strip; saved/editor views show estimated duration, verified in the final focused UI run. |
| Focus | AX-focused bounds, outline/trail/info, movement/lost/dead-end observations; geometry and browser tests | Real navigation/rotation across both phone and TV was not exhaustively exercised. No unsupported nextFocus claims are made. |
| Snapshots | Named save/list/rename/delete, restore choice, save-before-restore, per-image persisted boot default and actual `-snapshot` launch wiring; browser workflow test | Actual snapshot restore and subsequent emulator startup were not performed, these are recorded as unrun live validation, separate from implemented acceptance. Cross-image copy is disabled. |
| Stream/performance | Browser-scoped profile controls, separate custom H.264 encoder, adaptive downshift, real metric parsers and bounded graphs; unit/browser tests | `test/quality-stream.test.ts` passed with a native 60-fps motion fixture: simultaneous 960×540/15-fps/1-Mbps and 1280×720/30-fps/3-Mbps profiles, independently ffprobe-decoded; first encoded output under 1.8 seconds; source EOF/restart and disconnect cleanup verified. A long live-device session was not exercised. |
| Presets | Save-current/create/persist/apply, numeric network profiles, mobile data, geo/font/locale/accessibility, unavailable-field prompt and partial-failure reporting; unit/browser tests | Locale/network/accessibility mutation combinations were not live-tested. TalkBack toggling preserves unrelated services. |
| Deep links | Named CRUD/manual send, encoded `{id}` prompt/cancel and macro/event integration; unit/browser tests | Installed-app URI destination handling was not live-tested. |
| Timeline/repro | Session lanes/filters/range selection, named macro export, gesture timing conversion, ZIP/repro packaging; unit/browser tests | Repro archive replay against a real app was not exercised. Native scroll conversion and gesture-start timestamps are now covered by four timeline unit tests. Numeric Android keycodes without browser-key names may be excluded; excluded events are counted. Full exported-bundle execution against a live app remains unverified; bundle construction and replay representation are implemented and covered by focused source/unit/browser checks. |

The shared workspace target/visibility/mirror and keyboard/responsive regression suites pass. These checks establish delivered workspace behavior; exhaustive device-specific failure scenarios remain a validation limit.

### Test evidence

Recorded automated verification: **typecheck and build passed; all 71 unit tests and all 57 browser tests passed**. The final browser run includes the successful-install/failed-launch badge regression and the macro recorder, numbered/collapsed crash trace, installed metadata and opt-in launch details.

Media tests exercise MP4/WebM/GIF conversion, trimming, key burn-in and matching log ranges. Python validates ZIP structure, CRC and UTF-8 names. Quality tests independently decode concurrent profile outputs and verify source EOF restart and disconnect cleanup.

Primary test files: `test/workspace.test.ts`, `test/workspace-macros.test.ts`, `test/device-tools.test.ts`, `test/timeline.test.ts`, `test/browser-workspace-features.test.mjs`, `test/browser-device-tools.test.mjs`, and `test/browser-observability.test.mjs`. Fixture-based browser actions prove transport/targeting/UI behavior; they do not prove Android mutations.

Source trace for startup defaults: `WorkspaceService.setDefault()` persists a key derived from the emulator AVD name; middleware launch calls `launchAvd(avd, {snapshot: workspace.getDefault(avd)})`; `launchAvd()` passes `-snapshot`. Existing device-header, expanded-header and Controls Quick actions screenshots all enter the capture tray.

### Capability and lifecycle limits

- Recording uses Android screenrecord and preserves native frame timestamps, then encodes 60-fps playback with held frames while the display is unchanged. Actual motion detail depends on device rendering/encoding. Until stop is bounded to 30 minutes / 256 MB; Android's per-process duration limit is handled with segments, holding the last frame across transfer/restart gaps. Recording requires Android screenrecord, ffmpeg and ffprobe. These settings are independent of browser live-stream quality. Failed or truncated captures report errors rather than successful artifacts.
- Installation accepts APK files. Android bundles require external conversion/signing; no AAB or split-package support is claimed. Recent builds are retained uploaded APKs, not host build-directory discovery.
- Snapshot copying across emulator images is unavailable. Save/restore/boot-default support is scoped to an emulator image.
- Custom video profiles use separate H.264 encoders, limited to four per device. H.265/AV1 are unavailable; MJPEG retains its existing encoding. Unsupported app metrics display unavailable instead of fabricated values.
- Definitions persist in account/base-path-scoped browser storage. Direct artifact links require workspace access. Copy share link creates a read-only public capability for only that capture, expiring after seven days or earlier revocation, capture eviction, device-session closure or server restart. Attached logs and all workspace controls remain authenticated. Recording input history is bounded to 10,000 events; ZIP exports are bounded to 256 MB (repro media inclusion to 128 MB).
- Recordings and artifacts belong to the shared server/device session. An already authorized recording may continue after its initiating tab closes or identity is revoked, until its configured duration or session shutdown. Revocation blocks new commands/downloads; it is not per-identity cancellation of existing shared recordings.

All ten feature groups are implemented with source review and focused automated coverage. This is not a claim of all-ten end-to-end live-device validation: the table separately identifies device mutation scenarios that were not run. A live mutation not performed is a validation limit, not an implementation gap.

### Recording and log viewer follow-up

- Saved captures have a large aspect-fitted player, native playback/fullscreen controls, measured format/duration/resolution/FPS/size, precise trim controls and a separate export panel. Video endpoints support authenticated byte-range requests for seeking.
- Logcat uses a read-only CodeMirror text viewer with selectable original log lines, severity highlighting, search, optional wrapping, and one shared horizontal scrollbar. Viewport rendering keeps long streams responsive. Scrolling back stops following new entries; Jump to latest resumes it. Pausing freezes the display while bounded collection continues. The server retains up to 5,000 recent lines; the browser retains up to 1,000 grouped rows and 5,000 raw entries.
- Attached recording logs use the same searchable text viewer without leaving the player. Both viewers support copy/download and full-width expansion. Logcat retry timers are cancelled on session shutdown.
- Browser regression coverage includes long log messages, pause/resume retention, expanded viewing, actual MP4 playback/seeking, trim validation, attached logs and desktop/mobile sizing.
- CodeMirror follow-up verification: typecheck/build, 79 unit tests and 65 browser tests pass. The log regressions cover shared scrolling, wrapping, full-document copying, find, viewport rendering, live selection/scroll preservation, buffer eviction and mobile expansion.


### Public capture sharing

- Copy share link creates an unguessable capability and opens an isolated image/video viewer without login. It supports download and video range requests. The original capture and attached logs endpoints remain authenticated.
- Revoke share link disables the existing capability. Creating a new link after revocation does not reactivate old links. Links are session-scoped and expire after seven days at most; they do not survive a server restart.
- Deployment wrappers must call `middleware.handleShare(req, res)` before their own authentication gate; the shipped dev handler does this. This handler recognizes only `/share/…` and permits only GET/HEAD for an existing capability.
- Boundary tests cover public viewing/ranges, protected workspace and log access, mutation authentication/CSRF, revocation, expiry, invalidation and base paths, including the example wrapper.


### Design parity and workspace placement follow-up

The original feature checklist established working operations, but overstated presentation parity. The performance view requires four large graph cards beside quality controls; the delivered footer had tiny sparklines and a text-only detail popup. The canvas could arrange only device previews, so detailed work remained tied to emulator size or the narrow sidebar.

| Reference areas | Assessment before this pass | Change / retained behavior |
| --- | --- | --- |
| Main / Stream | Entry points existed; expanded performance composition was missing | Performance is now a movable grid panel with four large timestamped charts, device comparison, 1/5/10-minute windows, minimum/average/peak readings, display pause, JSON export and per-device quality controls. |
| Apps / Crash | Operations and trace detail existed in the inspector; narrow width limited reading and comparing builds | Apps can open on the grid; installed apps and recent builds use separate columns, crash detail spans the panel. Pin/Dock moves the existing view rather than creating duplicate jobs. |
| Macros / Snapshots / Presets | Functional editors and actions existed but competed for sidebar space | Automate can open as a grid panel, with the macro editor spanning both columns and snapshots/presets/deep links below. The active target remains the inspector’s selected device. |
| Capture / Timeline | The bottom drawer's compact height constrained detailed work | Expand/Restore gives Activity and Captures workspace-sized room, reusing the existing player, trim/export, log viewer and timeline. |
| Focus | Overlay placement belongs on the emulator | Retained. Observed focus bounds/dead ends are real; unsupported Android nextFocus claims from prototype sample text remain omitted. |

Panels participate in canvas placement and layout presets, and have Expand/Restore and Close controls. Tool panels are distinct from devices: they do not acquire emulator input, count as connected devices, or become Focus thumbnails. Header dragging/arrow movement reuses the canvas coordinate store. Mobile uses full-width stacked cards; graphs and controls do not overflow the viewport.

The performance view reuses existing authenticated samplers and encoder controls. It adds no API routes or polling of its own. Up to 600 distinct app-sample timestamps are retained per device in memory; app changes and unavailable samples break chart lines. Display pause freezes the view/export while collection continues. Exports identify device, timestamps, window and browser measurements. Collection failures retain history with an explicit unavailable label; missing app FPS, MJPEG bitrate and end-to-end latency are never replaced with made-up values.

This pass improves layout and workflow depth, not unsupported capabilities: AAB/split installation, cross-image snapshot copying, H.265/AV1 and inferred nextFocus relationships remain unavailable as documented above. Native design runtime examples still use sample data and are not pixel-identical production screens.

Verification: `test/browser-performance.test.mjs` exercises real browser comparison, display pause/resume, exported measurements, retained error history, expanded sizing, sidebar/grid docking, mobile overflow/input isolation, single-device encoder changes, keyboard positioning and non-overlapping grid arrangement. Existing device, recording, log, focus and authentication suites remain the regression boundary. Screenshots were inspected on desktop and at 390px mobile width; no live app mutations were needed for this UI change.

Final verification for this pass: typecheck and build passed, all **81 unit tests** and **70 browser tests** passed.
