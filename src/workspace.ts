/** Files and metadata are confined to a private workspace directory, never client paths. */
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  createWriteStream,
  unlinkSync,
  statSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir, homedir } from "node:os";
import { spawn, execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { DeviceMedia } from "./workspace-media";
import { parsePackageMetadata } from "./observability";
import { adbPath, adbEmu } from "./adb";
import { ActionError } from "./actions";
import { recordEventLogEvent } from "./event-log";
import type { EmulatorSession } from "./device-session";
import type {
  InstalledApp,
  RecentBuild,
  WorkspaceState,
} from "./workspace-types";

export const MAX_APK_BYTES = 200 * 1024 * 1024;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);
export function validateSnapshotName(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(value))
    throw new Error(
      "Snapshot tag must contain 1–64 letters, digits, dots, underscores or hyphens",
    );
  return value;
}
export function validateApkFilename(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 160 ||
    !value.toLowerCase().endsWith(".apk")
  )
    throw new Error(
      "Choose an .apk file. Android bundles require conversion and signing before installation.",
    );
  return basename(value.replace(/\\/g, "/")).replace(/[^\w .()-]/g, "_");
}

async function apkPackage(path: string): Promise<string | null> {
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), "Android", "Sdk"),
    join(homedir(), "android-sdk"),
  ].filter(Boolean) as string[];
  for (const root of roots) {
    const dir = join(root, "build-tools");
    if (!existsSync(dir)) continue;
    for (const version of readdirSync(dir).sort().reverse()) {
      const aapt = join(dir, version, "aapt");
      if (!existsSync(aapt)) continue;
      const out = await new Promise<string>((resolve) =>
        execFile(
          aapt,
          ["dump", "badging", path],
          { timeout: 10_000, maxBuffer: 1024 * 1024 },
          (err, out) => resolve(err ? "" : out),
        ),
      );
      const packageName = /package: name='([\w.]+)'/.exec(out)?.[1];
      if (packageName) return packageName;
    }
  }
  return null;
}
export class WorkspaceService {
  private devices = new Map<
    string,
    { media: DeviceMedia; builds: RecentBuild[]; dir: string }
  >();
  private defaults: Record<string, string> = {};
  private snapshotNames: Record<string, Record<string, string>> = {};
  private appCache = new Map<string, { at: number; apps: InstalledApp[] }>();
  private imageNames = new Map<string, string>();
  private defaultsFile: string;
  constructor(private root = join(homedir(), ".serve-avd", "workspace")) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.defaultsFile = join(root, "snapshot-defaults.json");
    try {
      const saved = JSON.parse(readFileSync(this.defaultsFile, "utf8"));
      this.defaults = saved.defaults ?? saved;
      this.snapshotNames = saved.names ?? {};
    } catch {}
  }
  device(session: EmulatorSession) {
    let device = this.devices.get(session.serial);
    if (!device) {
      const dir = join(
        this.root,
        `session-${process.pid}`,
        digest(session.serial),
      );
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      device = {
        media: new DeviceMedia(session.serial, dir, (start, end) =>
          session.logsBetween(start, end),
        ),
        builds: [],
        dir,
      };
      this.devices.set(session.serial, device);
      session.onClose(() => device!.media.close());
    }
    return device;
  }
  getDefault(key: string): string | null {
    return this.defaults[digest(key)] ?? null;
  }
  private async image(session: EmulatorSession): Promise<string> {
    let name = this.imageNames.get(session.serial);
    if (!name) {
      name = (await adbEmu(session.serial, ["avd", "name"])).trim();
      this.imageNames.set(session.serial, name);
    }
    return name;
  }
  private persist(): void {
    writeFileSync(
      this.defaultsFile,
      JSON.stringify(
        { defaults: this.defaults, names: this.snapshotNames },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
  async setDefault(
    session: EmulatorSession,
    name: unknown,
  ): Promise<string | null> {
    if (!session.serial.startsWith("emulator-"))
      throw new ActionError("Snapshots require an emulator", "unsupported");
    const tag = validateSnapshotName(name);
    if (tag) {
      const listed = (await session.runAction("snapshot", { op: "list" })) as {
        snapshots: { tag: string }[];
      };
      if (!listed.snapshots.some((s) => s.tag === tag))
        throw new ActionError(
          "Snapshot not found on this emulator",
          "not_found",
        );
    }
    const avd = await this.image(session);
    if (tag) this.defaults[digest(avd)] = tag;
    else delete this.defaults[digest(avd)];
    this.persist();
    return tag;
  }
  async snapshotAction(
    session: EmulatorSession,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const image = await this.image(session);
    const imageKey = digest(image);
    const names = (this.snapshotNames[imageKey] ??= {});
    if (params.op === "copy")
      throw new ActionError(
        "Copying snapshots requires compatible emulator images and is unavailable in this workspace. Save a snapshot on the target emulator instead.",
        "unsupported",
      );
    if (params.op === "rename") {
      const tag = validateSnapshotName(params.name);
      const display = String(params.newName ?? "").trim();
      if (!tag || !display || display.length > 120)
        throw new ActionError(
          "Snapshot display name must be 1–120 characters",
          "bad_request",
        );
      const list = (await session.runAction("snapshot", { op: "list" })) as {
        snapshots: { tag: string }[];
      };
      if (!list.snapshots.some((s) => s.tag === tag))
        throw new ActionError("Snapshot not found", "not_found");
      names[tag] = display;
      this.persist();
      recordEventLogEvent({
        device: session.serial,
        source: "ui",
        kind: "snapshot",
        summary: `Renamed snapshot to ${display}`,
      });
      return { op: "rename", name: tag, displayName: display };
    }
    const result = (await session.runAction("snapshot", params)) as {
      snapshots?: { tag: string; name?: string }[];
    };
    if (params.op === "save" && typeof params.name === "string") {
      const display = String(params.displayName ?? params.name).trim();
      if (display.length > 120)
        throw new ActionError(
          "Snapshot display name must be at most 120 characters",
          "bad_request",
        );
      names[params.name] = display;
      this.persist();
    }
    if (params.op === "delete" && typeof params.name === "string") {
      delete names[params.name];
      if (this.defaults[imageKey] === params.name)
        delete this.defaults[imageKey];
      this.persist();
    }
    if (result.snapshots)
      for (const snapshot of result.snapshots)
        snapshot.name = names[snapshot.tag] ?? snapshot.tag;
    return { ...result, capabilities: { rename: true, copy: false } };
  }
  state(session: EmulatorSession): WorkspaceState {
    const data = this.device(session);
    return {
      captures: data.media.captures,
      recording: data.media.recording,
      builds: data.builds,
      crashes: session.crashes.reports,
      defaultSnapshot: this.getDefault(
        this.imageNames.get(session.serial) ?? session.name.replace(/ /g, "_"),
      ),
    };
  }
  async apps(session: EmulatorSession): Promise<InstalledApp[]> {
    const cached = this.appCache.get(session.serial);
    if (cached && Date.now() - cached.at < 10_000) return cached.apps;
    const out = await session.shell.run("pm list packages -3");
    const names = out
      .split("\n")
      .map((line) => line.replace(/^package:/, "").trim())
      .filter((name) => /^[\w.]+$/.test(name))
      .slice(0, 200);
    const apps = await Promise.all(
      names.map(async (name) =>
        parsePackageMetadata(
          name,
          await session.shell.run(`dumpsys package ${name}`),
        ),
      ),
    );
    this.appCache.set(session.serial, { at: Date.now(), apps });
    return apps;
  }
  async upload(
    session: EmulatorSession,
    req: IncomingMessage,
    res: ServerResponse,
    filename: unknown,
    authorized: () => boolean,
  ): Promise<RecentBuild> {
    const name = validateApkFilename(filename);
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_APK_BYTES)
      throw new Error("APK exceeds the 200 MB upload limit");
    const data = this.device(session);
    const id = randomUUID();
    const path = join(data.dir, `${id}.apk`);
    let size = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > MAX_APK_BYTES)
          callback(new Error("APK exceeds the 200 MB upload limit"));
        else if (!authorized()) callback(new Error("Session expired"));
        else callback(null, chunk);
      },
    });
    try {
      await pipeline(
        req,
        limiter,
        createWriteStream(path, { mode: 0o600, flags: "wx" }),
      );
      const header = readFileSync(path).subarray(0, 4);
      if (!size || header[0] !== 0x50 || header[1] !== 0x4b)
        throw new Error("Uploaded file is not an APK archive");
      if (!authorized()) throw new Error("Session expired");
      const build: RecentBuild = {
        id,
        device: session.serial,
        filename: name,
        createdAt: new Date().toISOString(),
        bytes: size,
        app: null,
      };
      await this.install(session, build, path, res, authorized);
      data.builds.unshift(build);
      while (
        data.builds.length > 10 ||
        data.builds.reduce((sum, b) => sum + b.bytes, 0) > 512 * 1024 * 1024
      ) {
        const old = data.builds.pop()!;
        try {
          unlinkSync(join(data.dir, `${old.id}.apk`));
        } catch {}
      }
      return build;
    } catch (err) {
      try {
        unlinkSync(path);
      } catch {}
      throw err;
    }
  }
  async reinstall(
    session: EmulatorSession,
    id: string,
    res: ServerResponse,
    authorized: () => boolean,
  ): Promise<RecentBuild> {
    const data = this.device(session);
    const build = data.builds.find((b) => b.id === id);
    if (!build) throw new Error("Build not found");
    await this.install(
      session,
      build,
      join(data.dir, `${id}.apk`),
      res,
      authorized,
    );
    return build;
  }
  private async install(
    session: EmulatorSession,
    build: RecentBuild,
    path: string,
    res: ServerResponse,
    authorized: () => boolean,
  ): Promise<void> {
    const packageName = build.app?.packageName ?? (await apkPackage(path));
    if (!authorized()) throw new Error("Session expired");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        adbPath(),
        ["-s", session.serial, "install", "-r", "-g", path],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      const append = (chunk: Buffer) =>
        (output = (output + chunk.toString()).slice(-4000));
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      const cancel = () => {
        child.kill("SIGKILL");
      };
      res.once("close", cancel);
      const timer = setTimeout(cancel, 300_000);
      timer.unref();
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        res.off("close", cancel);
        if (code !== 0 || !/Success/i.test(output))
          reject(new Error(output || "APK install cancelled"));
        else resolve();
      });
    });
    this.appCache.delete(session.serial);
    if (packageName)
      build.app = parsePackageMetadata(
        packageName,
        await session.shell.run(`dumpsys package ${packageName}`),
      );
    recordEventLogEvent({
      device: session.serial,
      source: "ui",
      kind: "install",
      action: "install",
      summary: `Installed ${build.filename}${build.app ? ` · ${build.app.versionName} (${build.app.versionCode})` : ""}`,
      details: { buildId: build.id, packageName: build.app?.packageName },
    });
  }
  async currentPreset(
    session: EmulatorSession,
  ): Promise<Record<string, unknown>> {
    const [font, locale, network, wifi, airplane, battery, talkback, contrast] =
      await Promise.all([
        session.shell.run("settings get system font_scale"),
        session.shell.run("getprop persist.sys.locale"),
        session.serial.startsWith("emulator-")
          ? adbEmu(session.serial, ["network", "status"]).catch(() => "")
          : Promise.resolve(""),
        session.shell.run("settings get global wifi_on"),
        session.shell.run("settings get global airplane_mode_on"),
        session.runAction("battery", {}).catch(() => null),
        session.runAction("talkback", {}).catch(() => null),
        session.runAction("high-contrast", {}).catch(() => null),
      ]);
    const speedRaw =
      /(?:download|speed)[^\n]*:\s*([^\n]+)/i.exec(network)?.[1]?.trim() ?? "";
    const delayRaw =
      /latency[^\n]*:\s*([^\n]+)/i.exec(network)?.[1]?.trim() ?? "";
    const knownSpeed = [
      "gsm",
      "hscsd",
      "gprs",
      "edge",
      "umts",
      "hsdpa",
      "lte",
      "evdo",
      "full",
    ].find((value) => new RegExp(`\\b${value}\\b`, "i").test(speedRaw));
    const knownDelay = ["none", "gprs", "edge", "umts"].find((value) =>
      new RegExp(`\\b${value}\\b`, "i").test(delayRaw),
    );
    const location = await session.shell
      .run("dumpsys location")
      .catch(() => "");
    const match = /Location\[(?:gps|fused)\s+(-?[\d.]+),(-?[\d.]+)/.exec(
      location,
    );
    return {
      fontScale: Number(font) || 1,
      ...(locale ? { locale } : {}),
      network: {
        ...(knownSpeed ? { speed: knownSpeed } : {}),
        ...(knownDelay ? { delay: knownDelay } : {}),
        wifi: wifi.trim() === "1",
        airplane: airplane.trim() === "1",
      },
      talkback: (talkback as { enabled?: boolean } | null)?.enabled,
      highContrast: (contrast as { enabled?: boolean } | null)?.enabled,
      geo: match ? { lat: Number(match[1]), lon: Number(match[2]) } : null,
      unavailable: [
        ...(!knownSpeed ? ["Network speed unavailable"] : []),
        ...(!match ? ["Current location unavailable"] : []),
      ],
    };
  }

  close(): void {
    for (const item of this.devices.values()) item.media.close();
  }
}
