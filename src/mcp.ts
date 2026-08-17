/**
 * `serve-avd mcp` — a Model Context Protocol server over stdio that exposes
 * the emulator as tools (screenshot, tap, find, wait_for, type_text, …).
 *
 * Hand-rolled JSON-RPC 2.0 over newline-delimited stdio: the protocol surface
 * MCP clients need (initialize / tools/list / tools/call / ping) is small and
 * stable, and keeping the package free of an SDK + schema-validator dependency
 * matches the rest of serve-avd (plain Node + adb).
 *
 * stdout is the wire — everything human goes to stderr.
 */
import { createInterface } from "readline";
import { listDevices, listAvds } from "./adb";
import { ACTIONS, ACTIONS_BY_NAME, ActionError, type ActionParams, type ParamSpec } from "./actions";
import { resolveDriver, liveServerStates, type DeviceDriver } from "./driver";
import { flattenAx, axScreenSize, type AxDump, type AxNode } from "./ax";
import { BUTTONS } from "./keymap";
import { ORIENTATIONS } from "./input";
import { startServer, type RunningServer } from "./server";
import { formatEventLogLine } from "./event-log-format";

const LATEST_PROTOCOL = "2025-06-18";
const KNOWN_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", LATEST_PROTOCOL]);

// ── JSON-RPC plumbing ──────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  run(args: Record<string, unknown>): Promise<ToolResult>;
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
interface ToolResult {
  content: Content[];
  isError?: boolean;
}

function text(value: unknown): Content {
  return { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
}

const log = (...args: unknown[]) => console.error("[serve-avd mcp]", ...args);

// ── Schema helpers ─────────────────────────────────────────────────────────

const DEVICE_PROP = {
  device: { type: "string", description: "adb serial or AVD name (default: the pinned/only/first device)" },
};

function schema(properties: Record<string, unknown>, required: string[] = []): JsonSchema {
  return { type: "object", properties: { ...DEVICE_PROP, ...properties }, ...(required.length ? { required } : {}), additionalProperties: false };
}

/** JSON-schema fragment for an action's params (from actions.ts specs). */
function paramSchema(params: Record<string, ParamSpec>): { properties: Record<string, unknown>; required: string[] } {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, spec] of Object.entries(params)) {
    properties[key] = { type: spec.type, description: spec.description, ...(spec.enum ? { enum: spec.enum } : {}) };
    if (spec.required) required.push(key);
  }
  return { properties, required };
}

const QUERY_PROPS = paramSchema({
  text: ACTIONS_BY_NAME.find!.params.text!,
  id: ACTIONS_BY_NAME.find!.params.id!,
  desc: ACTIONS_BY_NAME.find!.params.desc!,
  class: ACTIONS_BY_NAME.find!.params.class!,
  exact: ACTIONS_BY_NAME.find!.params.exact!,
  index: ACTIONS_BY_NAME.find!.params.index!,
}).properties;

// ── Compact UI tree for LLM consumption ────────────────────────────────────

interface CompactNode {
  text?: string;
  desc?: string;
  id?: string;
  class?: string;
  x: number;
  y: number;
  bounds: [number, number, number, number];
  clickable?: true;
  focused?: true;
  checked?: true;
  scrollable?: true;
  editable?: true;
  depth: number;
}

/** Flatten to the nodes an agent cares about: labelled, interactive or scrollable. */
export function compactUiTree(dump: AxDump, screen?: { width: number; height: number }): { screen: { width: number; height: number }; nodes: CompactNode[] } {
  const size = axScreenSize(dump, screen);
  const nodes: CompactNode[] = [];
  for (const { node, path } of flattenAx(dump.root)) {
    const b = node.bounds;
    if (!b) continue;
    // Labelled or interactive nodes only — bare layout containers (id-only
    // FrameLayouts) are noise for an agent choosing what to tap.
    const interesting = node.text || node.contentDesc || node.clickable || node.scrollable || node.focused || node.checkable || isEditable(node);
    if (!interesting) continue;
    const cls = node.class?.split(".").pop();
    const n: CompactNode = {
      ...(node.text ? { text: node.text } : {}),
      ...(node.contentDesc ? { desc: node.contentDesc } : {}),
      ...(node.resourceId ? { id: node.resourceId.replace(/^.*:id\//, "") } : {}),
      ...(cls ? { class: cls } : {}),
      x: size.width ? round3((b.left + b.right) / 2 / size.width) : 0,
      y: size.height ? round3((b.top + b.bottom) / 2 / size.height) : 0,
      bounds: [b.left, b.top, b.right, b.bottom],
      depth: path.length,
    };
    if (node.clickable) n.clickable = true;
    if (node.focused) n.focused = true;
    if (node.checked) n.checked = true;
    if (node.scrollable) n.scrollable = true;
    if (isEditable(node)) n.editable = true;
    nodes.push(n);
  }
  return { screen: size, nodes };
}

function isEditable(node: AxNode): boolean {
  return /EditText|AutoCompleteTextView|TextInput/i.test(node.class ?? "") || node.password === true;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// ── Server ─────────────────────────────────────────────────────────────────

export interface McpServerOptions {
  /** Pin every tool call to this device (adb serial / AVD name). */
  device?: string;
  /** Host the preview server in this process too. */
  serve?: boolean;
  port?: number;
  version: string;
  /** Resolve device args → serials, booting AVDs as needed (used with --serve). */
  resolveDevices?: (args: string[]) => Promise<string[]>;
}

export interface McpServer {
  /** Handle one JSON-RPC message; resolves with the response (null for notifications). */
  handle(req: JsonRpcRequest): Promise<unknown | null>;
  /** Tool table (name/description/inputSchema) as advertised by tools/list. */
  tools: Array<{ name: string; description: string; inputSchema: JsonSchema }>;
  close(): void;
}

/** Build the MCP request handler (no I/O) — `runMcpServer` wires it to stdio. */
export async function createMcpServer(options: McpServerOptions): Promise<McpServer> {
  let running: RunningServer | null = null;
  if (options.serve) {
    try {
      const serials = options.resolveDevices ? await options.resolveDevices(options.device ? [options.device] : []) : [];
      running = await startServer({ port: options.port ?? 3200, strictPort: options.port !== undefined });
      for (const serial of serials) await running.attach(serial);
      log(`preview server at http://${running.host}:${running.port} (${serials.length} device${serials.length === 1 ? "" : "s"})`);
    } catch (err) {
      log(`could not start the preview server: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const drivers = new Map<string, DeviceDriver>();
  const driverFor = async (device?: string): Promise<DeviceDriver> => {
    const key = device ?? options.device ?? "";
    const cached = drivers.get(key);
    if (cached) {
      // A cached server-backed driver goes stale when that server exits.
      if (cached.mode === "server" && !liveServerStates(cached.serial).length) drivers.delete(key);
      else return cached;
    }
    const driver = await resolveDriver(device ?? options.device);
    drivers.set(key, driver);
    return driver;
  };

  const withDevice = async (args: Record<string, unknown>, fn: (d: DeviceDriver) => Promise<ToolResult>): Promise<ToolResult> => {
    const device = typeof args.device === "string" && args.device ? args.device : undefined;
    let driver: DeviceDriver;
    try {
      driver = await driverFor(device);
    } catch (err) {
      return { content: [text(err instanceof Error ? err.message : String(err))], isError: true };
    }
    try {
      return await fn(driver);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/Failed to reach serve-avd server/.test(message)) drivers.delete(device ?? options.device ?? "");
      return { content: [text(message)], isError: true };
    }
  };

  /** Strip `device` and forward the rest as action params. */
  const actionTool = (name: string, args: Record<string, unknown>, transform?: (params: ActionParams) => ActionParams) =>
    withDevice(args, async (driver) => {
      const { device: _d, ...params } = args;
      const result = await driver.action(name, transform ? transform(params) : params);
      return { content: [text(result ?? { ok: true })] };
    });

  const tools: ToolDef[] = [
    {
      name: "list_devices",
      description: "List emulators/devices: running serve-avd streams (with preview URLs), adb devices, and configured AVDs.",
      inputSchema: schema({}),
      run: async () => {
        const [states, devices, avds] = await Promise.all([liveServerStates(), listDevices().catch(() => []), listAvds()]);
        return {
          content: [
            text({
              streams: states.map((s) => ({ device: s.device, name: s.name, previewUrl: s.url })),
              devices: devices.map((d) => ({ serial: d.serial, state: d.state, model: d.model, isEmulator: d.isEmulator })),
              avds,
            }),
          ],
        };
      },
    },
    {
      name: "screenshot",
      description:
        "Capture the current screen as an image. Also returns the screen size and orientation. Coordinates for tap/swipe are normalized 0..1 of this image. Prefer ui_tree/find (cheaper, exact) when you need element positions.",
      inputSchema: schema({}),
      run: (args) =>
        withDevice(args, async (driver) => {
          const [shot, config] = await Promise.all([driver.screenshot(), driver.screenConfig().catch(() => null)]);
          return {
            content: [
              { type: "image", data: shot.data.toString("base64"), mimeType: shot.contentType },
              text({ device: driver.serial, name: driver.name, ...(config ?? {}), bytes: shot.data.length }),
            ],
          };
        }),
    },
    {
      name: "ui_tree",
      description:
        "Dump the UI hierarchy (uiautomator). Default compact=true returns a flat list of labelled/interactive nodes with normalized center (x,y) and pixel bounds — ideal for choosing what to tap. compact=false returns the raw tree.",
      inputSchema: schema({ compact: { type: "boolean", description: "Flat, filtered list (default true)" } }),
      run: (args) =>
        withDevice(args, async (driver) => {
          const dump = await driver.ax();
          if (args.compact === false) return { content: [text(dump)] };
          const config = await driver.screenConfig().catch(() => undefined);
          return { content: [text(compactUiTree(dump, config))] };
        }),
    },
    {
      name: "find",
      description: "Find UI elements by text (also matches content-description), resource id, description or class. Returns matches with normalized centers and pixel bounds.",
      inputSchema: schema(QUERY_PROPS),
      run: (args) => actionTool("find", args),
    },
    {
      name: "wait_for",
      description: "Wait until an element matching text/id/desc/class appears (or disappears with gone=true). Use after taps/navigation instead of sleeping.",
      inputSchema: schema({
        ...QUERY_PROPS,
        timeoutMs: { type: "number", description: "Budget in ms (default 10000)" },
        gone: { type: "boolean", description: "Wait for the element to disappear" },
      }),
      run: (args) => actionTool("wait", args),
    },
    {
      name: "tap",
      description:
        "Tap the screen. Either give x,y (normalized 0..1 of the screen) or a target: text / id / desc / class (first match; index picks another). durationMs makes it a long-press.",
      inputSchema: schema({
        x: { type: "number", description: "Normalized x 0..1" },
        y: { type: "number", description: "Normalized y 0..1" },
        ...QUERY_PROPS,
        durationMs: { type: "number", description: "Hold for a long-press" },
      }),
      run: (args) => actionTool("tap", args),
    },
    {
      name: "swipe",
      description: "Swipe/drag from (x1,y1) to (x2,y2), normalized 0..1, over durationMs (default 300). Use for scrolling: e.g. 0.5,0.8 → 0.5,0.3 scrolls down.",
      inputSchema: schema(paramSchema(ACTIONS_BY_NAME.swipe!.params).properties, ["x1", "y1", "x2", "y2"]),
      run: (args) => actionTool("swipe", args),
    },
    {
      name: "type_text",
      description: "Type text into the focused field (ASCII; \\n = Enter, \\t = Tab). Tap the field first.",
      inputSchema: schema({ text: { type: "string", description: "Text to type" } }, ["text"]),
      run: (args) => actionTool("text", args),
    },
    {
      name: "press_button",
      description: `Press a hardware/navigation button: ${Object.keys(BUTTONS).join(", ")}.`,
      inputSchema: schema({ button: { type: "string", enum: Object.keys(BUTTONS), description: "Button name" } }, ["button"]),
      run: (args) => actionTool("button", args),
    },
    {
      name: "press_key",
      description: "Press a keyboard key by browser KeyboardEvent.code (Enter, Backspace, Tab, ArrowDown, KeyA, Digit1…) or an Android keycode number.",
      inputSchema: schema(paramSchema(ACTIONS_BY_NAME.key!.params).properties),
      run: (args) => actionTool("key", args),
    },
    {
      name: "foreground",
      description: "The foreground app: { packageName, activity, pid }.",
      inputSchema: schema({}),
      run: (args) => withDevice(args, async (driver) => ({ content: [text((await driver.foreground()) ?? { error: "no resumed activity" })] })),
    },
    {
      name: "event_log",
      description: "Recent actions on the device (taps, typing, navigation, emulator controls) — from every source: browser viewers, CLI, and these tools.",
      inputSchema: schema({ limit: { type: "number", description: "Max entries (default 50)" }, json: { type: "boolean", description: "Raw JSON entries instead of lines" } }),
      run: (args) =>
        withDevice(args, async (driver) => {
          const events = await driver.eventLog(typeof args.limit === "number" ? args.limit : 50);
          if (args.json) return { content: [text(events)] };
          return { content: [text(events.length ? events.map((e) => formatEventLogLine(e, { deviceLabel: driver.name })).join("\n") : "No events.")] };
        }),
    },
    {
      name: "open_url",
      description: "Open a URL or deep link on the device (android.intent.action.VIEW).",
      inputSchema: schema(paramSchema(ACTIONS_BY_NAME.open!.params).properties, ["url"]),
      run: (args) => actionTool("open", args),
    },
    {
      name: "launch_app",
      description: "Launch an installed app by package name (or package/.Activity).",
      inputSchema: schema(paramSchema(ACTIONS_BY_NAME.launch!.params).properties, ["package"]),
      run: (args) => actionTool("launch", args),
    },
    {
      name: "install_apk",
      description: "Install an APK from a path on the machine running serve-avd (adb install -r -g).",
      inputSchema: schema({ path: { type: "string", description: "Host path to the .apk" } }, ["path"]),
      run: (args) => actionTool("install", args),
    },
    {
      name: "list_apps",
      description: "List installed packages (third-party by default; all=true includes system apps).",
      inputSchema: schema(paramSchema(ACTIONS_BY_NAME.apps!.params).properties),
      run: (args) => actionTool("apps", args),
    },
    {
      name: "rotate",
      description: `Rotate the display: ${Object.keys(ORIENTATIONS).join(" | ")}. Fails if the foreground app locks orientation.`,
      inputSchema: schema({ orientation: { type: "string", enum: Object.keys(ORIENTATIONS), description: "Orientation" } }, ["orientation"]),
      run: (args) => actionTool("rotate", args),
    },
    {
      name: "set_location",
      description: "Set the emulator's GPS location (lat, lon, optional alt).",
      inputSchema: schema(paramSchema(ACTIONS_BY_NAME.geo!.params).properties, ["lat", "lon"]),
      run: (args) => actionTool("geo", args),
    },
    {
      name: "snapshot",
      description: "Emulator snapshots — save the current state, load (restore) one, delete, or list. Use save before a risky flow and load to reset between runs.",
      inputSchema: schema(paramSchema(ACTIONS_BY_NAME.snapshot!.params).properties, ["op"]),
      run: (args) => actionTool("snapshot", args),
    },
    {
      name: "device_action",
      description:
        "Run any other device action by name with params. Actions: " +
        ACTIONS.filter((a) => !["tap", "swipe", "text", "key", "button", "find", "wait", "open", "launch", "install", "apps", "rotate", "geo", "snapshot"].includes(a.name))
          .map((a) => {
            const ps = Object.entries(a.params)
              .map(([k, s]) => `${k}${s.required ? "*" : ""}:${s.type}`)
              .join(", ");
            return `${a.name} (${ps || "no params"}) — ${a.description}`;
          })
          .join("; "),
      inputSchema: schema(
        {
          action: { type: "string", enum: ACTIONS.map((a) => a.name), description: "Action name" },
          params: { type: "object", description: "Action parameters", additionalProperties: true },
        },
        ["action"],
      ),
      run: (args) =>
        withDevice(args, async (driver) => {
          const name = String(args.action ?? "");
          const params = args.params && typeof args.params === "object" ? (args.params as ActionParams) : {};
          const result = await driver.action(name, params);
          return { content: [text(result ?? { ok: true })] };
        }),
    },
  ];
  const toolsByName = new Map(tools.map((t) => [t.name, t]));

  const instructions = [
    "serve-avd exposes an Android emulator (or device). Typical loop: ui_tree (or find) to see what's on screen → tap by text/id → wait_for the next screen → repeat; take a screenshot when layout matters.",
    "Coordinates are normalized 0..1 of the current screen (x right, y down). Prefer targeting by text/id over raw coordinates.",
    "type_text needs a focused field — tap it first. press_button back/home/app-switch for navigation.",
    "Emulator-only helpers: set_location, snapshot (save/load to reset state), device_action for network/battery/fingerprint/call/sms/locale/etc.",
    options.device ? `All calls target ${options.device}.` : "Pass device to target a specific emulator when several are attached.",
  ].join("\n");

  // ── Request loop ─────────────────────────────────────────────────────────

  const ok = (id: JsonRpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (id: JsonRpcRequest["id"], code: number, message: string, data?: unknown) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });

  const handle = async (req: JsonRpcRequest): Promise<unknown | null> => {
    const isNotification = req.id === undefined;
    switch (req.method) {
      case "initialize": {
        const requested = String(req.params?.protocolVersion ?? "");
        return ok(req.id, {
          protocolVersion: KNOWN_PROTOCOLS.has(requested) ? requested : LATEST_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "serve-avd", version: options.version },
          instructions,
        });
      }
      case "notifications/initialized":
      case "notifications/cancelled":
      case "notifications/roots/list_changed":
        return null;
      case "ping":
        return ok(req.id, {});
      case "tools/list":
        return ok(req.id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case "tools/call": {
        const name = String(req.params?.name ?? "");
        const tool = toolsByName.get(name);
        if (!tool) return fail(req.id, -32602, `Unknown tool: ${name}`);
        const args = (req.params?.arguments && typeof req.params.arguments === "object" ? req.params.arguments : {}) as Record<string, unknown>;
        try {
          return ok(req.id, await tool.run(args));
        } catch (err) {
          return ok(req.id, { content: [text(err instanceof Error ? err.message : String(err))], isError: true });
        }
      }
      case "resources/list":
        return ok(req.id, { resources: [] });
      case "prompts/list":
        return ok(req.id, { prompts: [] });
      default:
        return isNotification ? null : fail(req.id, -32601, `Method not found: ${req.method}`);
    }
  };

  return {
    handle,
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    close() {
      for (const d of drivers.values()) d.close();
      running?.close();
    },
  };
}

/** Serve MCP over stdio (newline-delimited JSON-RPC) until stdin closes. */
export async function runMcpServer(options: McpServerOptions): Promise<void> {
  // stdout is the protocol channel — route any stray console.log to stderr.
  console.log = (...args: unknown[]) => console.error(...args);
  const server = await createMcpServer(options);
  const send = (message: unknown) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let chain: Promise<void> = Promise.resolve();
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const msg of messages) {
      if (!msg || typeof msg !== "object" || typeof (msg as JsonRpcRequest).method !== "string") {
        // Responses to server-initiated requests (we send none) or junk — ignore.
        continue;
      }
      const req = msg as JsonRpcRequest;
      // Serialize tool calls: they share one adb shell per device and an
      // agent's steps are ordered anyway.
      chain = chain
        .then(async () => {
          const response = await server.handle(req);
          if (response) send(response);
        })
        .catch((err) => log("handler error", err));
    }
  });

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      server.close();
      resolve();
    };
    rl.on("close", shutdown);
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
  process.exit(0);
}

export { ActionError };
export type { JsonRpcRequest };
