import {
  control,
  deviceAction,
  errorText,
  field,
  helperBase,
  node,
  request,
  row,
  section,
  type FeatureDevice,
} from "./feature-dom";
import type { InstalledApp, RecentBuild as Build } from "../workspace-types";
interface InstallState {
  message: string;
  percent?: number;
  xhr?: XMLHttpRequest;
  phase: "upload" | "install" | "launch" | "done" | "error";
}
/** Install jobs belong to their captured device, even when the inspector target changes. */
export class WorkspaceApps {
  readonly root = node("div", "", "workspace-apps");
  private selected: FeatureDevice | null = null;
  private launchAfterInstall = false;
  private generation = 0;
  private readonly jobs = new Map<string, InstallState>();
  private readonly badges = new Map<string, HTMLElement>();
  private readonly progress = new Map<string, HTMLElement>();
  private crashRenderer?: (root: HTMLElement, serial: string) => void;
  constructor(
    private readonly visibleDevices: () => FeatureDevice[],
    private readonly auth: () => { csrfToken: string; expired: boolean },
    private readonly onAuthExpired: () => void,
  ) {}
  setCrashRenderer(render: (root: HTMLElement, serial: string) => void): void {
    this.crashRenderer = render;
  }
  mountDevice(device: FeatureDevice): void {
    const badge = node("span", "", "installed-version chip");
    badge.hidden = true;
    device.root.querySelector(".device-title")?.append(badge);
    this.badges.set(device.entry.device, badge);
    const progress = node("div", "", "install-progress");
    progress.hidden = true;
    progress.setAttribute("role", "status");
    device.root.querySelector(".device-frame")?.append(progress);
    this.progress.set(device.entry.device, progress);
    const overlay = node(
      "div",
      `Drop APK on ${device.entry.name}\nHold Shift for all visible devices`,
      "apk-drop-overlay",
    );
    overlay.hidden = true;
    device.root.querySelector(".screen-wrap")?.append(overlay);
    const isFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");
    device.root.addEventListener("dragover", (event) => {
      if (!isFiles(event)) return;
      event.preventDefault();
      overlay.hidden = false;
    });
    device.root.addEventListener("dragleave", (event) => {
      if (
        !(event.relatedTarget instanceof Node) ||
        !device.root.contains(event.relatedTarget)
      )
        overlay.hidden = true;
    });
    device.root.addEventListener("drop", (event) => {
      if (!isFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      overlay.hidden = true;
      const files = Array.from(event.dataTransfer?.files ?? []);
      void this.installFiles(
        files,
        event.shiftKey ? this.visibleDevices() : [device],
      );
    });
    void this.updateBadge(device);
  }
  removeDevice(serial: string): void {
    this.jobs.get(serial)?.xhr?.abort();
    this.badges.delete(serial);
    this.progress.delete(serial);
  }
  async updateBadge(device: FeatureDevice): Promise<void> {
    try {
      const data = await request<{ apps: InstalledApp[] }>(
        `${helperBase(device)}/apps`,
      );
      const foreground = await request<{ packageName?: string }>(
        device.entry.foregroundEndpoint,
      );
      const app = data.apps?.find(
        (app) => app.packageName === foreground.packageName,
      );
      const badge = this.badges.get(device.entry.device);
      if (!badge) return;
      badge.hidden = !app;
      if (app) {
        badge.textContent = `${app.packageName} ${app.versionName ?? "?"} (${app.versionCode ?? "?"})${app.debuggable ? " · debug" : ""}`;
        badge.title = badge.textContent;
      }
    } catch {
      /* Metadata is optional on restricted devices; existing stream remains usable. */
    }
  }
  select(device: FeatureDevice | null): void {
    this.selected = device;
    void this.render();
  }
  refreshDevice(serial: string): void {
    if (this.selected?.entry.device === serial && this.root.isConnected)
      void this.render();
  }

  private async installFiles(
    files: File[],
    targets: FeatureDevice[],
  ): Promise<void> {
    if (!files.length) return;
    if (files.some((file) => !file.name.toLowerCase().endsWith(".apk"))) {
      this.status(
        "Choose APK files. Android App Bundles must be converted to APKs before installation.",
        true,
      );
      return;
    }
    if (!targets.length) {
      this.status("Select a visible device first.", true);
      return;
    }
    for (const file of files)
      await Promise.all(targets.map((target) => this.install(target, file)));
  }
  private async install(device: FeatureDevice, file: File): Promise<void> {
    const serial = device.entry.device;
    if (
      this.jobs.get(serial)?.xhr ||
      ["install", "launch"].includes(this.jobs.get(serial)?.phase ?? "")
    ) {
      this.status(
        `An installation is already in progress on ${device.entry.name}.`,
        true,
      );
      return;
    }
    const launchAfterInstall = this.launchAfterInstall;
    const job: InstallState = {
      message: `Uploading ${file.name}`,
      percent: 0,
      phase: "upload",
    };
    this.jobs.set(serial, job);
    await new Promise<void>((resolve) => {
      const xhr = (job.xhr = new XMLHttpRequest());
      xhr.open("POST", `${helperBase(device)}/apk`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
      const auth = this.auth();
      if (auth.expired) {
        job.message = "Session ended";
        job.phase = "error";
        delete job.xhr;
        resolve();
        return;
      }
      if (auth.csrfToken) xhr.setRequestHeader("X-CSRF-Token", auth.csrfToken);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable)
          job.percent = Math.round((event.loaded / event.total) * 100);
        this.paintJob(serial);
      };
      xhr.upload.onload = () => {
        job.phase = "install";
        job.percent = undefined;
        job.message = `Installing ${file.name}…`;
        this.paintJob(serial);
      };
      const finish = (error?: string, launched = false) => {
        delete job.xhr;
        job.phase = error ? "error" : "done";
        job.percent = undefined;
        job.message =
          error ??
          `${launched ? "Installed and launched" : "Installed"} ${file.name}`;
        this.paintJob(serial);
        if (!error) void this.updateBadge(device);
        if (this.selected?.entry.device === serial) void this.render();
        resolve();
      };
      xhr.onload = async () => {
        if (xhr.status === 401) this.onAuthExpired();
        try {
          const data = JSON.parse(xhr.responseText) as {
            error?: string;
            message?: string;
            app?: InstalledApp | null;
          };
          if (xhr.status < 200 || xhr.status >= 300)
            finish(
              data.message ??
                data.error ??
                `Install failed (HTTP ${xhr.status})`,
            );
          else if (launchAfterInstall) {
            void this.updateBadge(device);
            if (!data.app?.packageName) {
              finish(
                "APK installed; launch unavailable because package metadata could not be read.",
              );
              return;
            }
            delete job.xhr;
            job.phase = "launch";
            job.message = `Launching ${data.app.packageName}…`;
            this.paintJob(serial);
            try {
              await deviceAction(device, "launch", {
                package: data.app.packageName,
              });
              finish(undefined, true);
            } catch (error) {
              finish(`APK installed; launch failed: ${errorText(error)}`);
            }
          } else finish();
        } catch {
          finish("Invalid install response.");
        }
      };
      xhr.onerror = () =>
        finish("Upload failed. Check the connection and try again.");
      xhr.onabort = () =>
        finish(
          job.phase === "install"
            ? "Connection stopped; installation may still finish on the device."
            : "Upload cancelled.",
        );
      xhr.send(file);
      this.paintJob(serial);
    });
  }
  private paintJob(serial: string): void {
    const job = this.jobs.get(serial),
      target = this.progress.get(serial);
    if (!job || !target) return;
    target.hidden = false;
    target.classList.toggle("error", job.phase === "error");
    target.replaceChildren(node("span", job.message));
    if (job.percent != null) {
      const bar = node("progress");
      bar.max = 100;
      bar.value = job.percent;
      bar.setAttribute("aria-label", "APK upload progress");
      target.append(bar, node("span", `${job.percent}%`));
    }
    if (job.phase === "upload")
      target.append(control("Cancel upload", () => job.xhr?.abort()));
  }
  private status(message: string, error = false): void {
    let status = this.root.querySelector<HTMLElement>(".feature-status");
    if (!status) {
      status = node("p", "", "feature-status");
      this.root.prepend(status);
    }
    status.textContent = message;
    status.classList.toggle("error", error);
    status.setAttribute("role", error ? "alert" : "status");
  }
  private async render(): Promise<void> {
    const generation = ++this.generation,
      device = this.selected;
    this.root.replaceChildren();
    if (!device) {
      this.root.append(node("p", "Select a device to manage apps.", "muted"));
      return;
    }
    const browse = node("input");
    browse.type = "file";
    browse.accept = ".apk";
    browse.multiple = true;
    browse.hidden = true;
    browse.addEventListener("change", () => {
      const files = Array.from(browse.files ?? []);
      void this.installFiles(files, [device]);
      browse.value = "";
    });
    const drop = control("Drop an APK or browse", () => browse.click());
    drop.className = "btn apk-browse";
    drop.addEventListener("dragover", (event) => event.preventDefault());
    drop.addEventListener("drop", (event) => {
      event.preventDefault();
      void this.installFiles(
        Array.from(event.dataTransfer?.files ?? []),
        event.shiftKey ? this.visibleDevices() : [device],
      );
    });
    const launch = node("input");
    launch.type = "checkbox";
    launch.checked = this.launchAfterInstall;
    launch.addEventListener("change", () => {
      this.launchAfterInstall = launch.checked;
    });
    const launchLabel = node("label", "", "feature-row");
    launchLabel.append(launch, node("span", "Launch after install"));
    const installed = section(
      `Installed on ${device.entry.name}`,
      node("p", "Loading apps…", "muted"),
    );
    const recent = section(
      "Recent builds",
      node("p", "Loading builds…", "muted"),
    );
    const crash = node("div");
    this.crashRenderer?.(crash, device.entry.device);
    this.root.append(
      crash,
      installed,
      recent,
      drop,
      browse,
      launchLabel,
      node(
        "p",
        "APK files supported. Hold Shift while dropping to install on all visible devices.",
        "muted",
      ),
    );
    const job = this.jobs.get(device.entry.device);
    if (job) this.status(job.message, job.phase === "error");
    try {
      const [apps, builds] = await Promise.all([
        request<{ apps: InstalledApp[] }>(`${helperBase(device)}/apps`),
        request<{ builds: Build[] }>(`${helperBase(device)}/builds`),
      ]);
      if (generation !== this.generation) return;
      installed.replaceChildren(
        node("h3", `Installed on ${device.entry.name}`),
      );
      for (const app of apps.apps ?? []) {
        const item = node("div", "", "feature-card");
        item.append(
          node("strong", app.packageName),
          node(
            "span",
            `${app.versionName ?? "?"} (${app.versionCode ?? "?"})${app.debuggable ? " · debug" : ""}`,
            "feature-meta",
          ),
        );
        const metadata: string[] = [];
        if (app.bytes != null)
          metadata.push(`${(app.bytes / 1048576).toFixed(1)} MB APK`);
        if (app.installedAt) metadata.push(`Installed ${app.installedAt}`);
        if (app.updatedAt && app.updatedAt !== app.installedAt)
          metadata.push(`Updated ${app.updatedAt}`);
        if (metadata.length)
          item.append(node("span", metadata.join(" · "), "feature-meta"));
        const run = async (action: string) => {
          try {
            if (action === "restart") {
              await deviceAction(device, "stop", { package: app.packageName });
              await deviceAction(device, "launch", {
                package: app.packageName,
              });
            } else if (action === "uninstall") {
              if (!confirm(`Uninstall ${app.packageName}?`)) return;
              await deviceAction(device, action, { package: app.packageName });
              void this.render();
            } else
              await deviceAction(device, action, { package: app.packageName });
            this.status(`${action} completed`);
            void this.updateBadge(device);
          } catch (error) {
            this.status(errorText(error), true);
          }
        };
        item.append(
          row(
            control("Launch", () => void run("launch")),
            control("Restart", () => void run("restart")),
            control("Clear data", () => {
              if (confirm(`Clear all data for ${app.packageName}?`))
                void run("clear-data");
            }),
            control("Uninstall", () => void run("uninstall")),
          ),
        );
        installed.append(item);
      }
      if (!apps.apps?.length)
        installed.append(node("p", "No installed user apps.", "muted"));
      recent.replaceChildren(node("h3", "Recent builds"));
      for (const build of builds.builds ?? []) {
        const install = control(
          "Reinstall",
          () => {
            install.disabled = true;
            void request(
              `${helperBase(device)}/builds/${encodeURIComponent(build.id)}/install`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
              },
            )
              .then(() => {
                this.status(`Installed ${build.filename}`);
                void this.updateBadge(device);
                void this.render();
              })
              .catch((error) => this.status(errorText(error), true))
              .finally(() => {
                install.disabled = false;
              });
          },
          `Reinstall ${build.filename}`,
        );
        const installed = apps.apps?.some(
          (app) =>
            build.app &&
            app.packageName === build.app.packageName &&
            app.versionCode === build.app.versionCode,
        );
        const item = node("div", "", "feature-card");
        item.append(
          row(node("span", build.filename, "feature-build"), install),
          node(
            "span",
            `${new Date(build.createdAt).toLocaleString()} · ${(build.bytes / 1048576).toFixed(1)} MB${installed ? " · INSTALLED" : ""}`,
            "feature-meta",
          ),
        );
        recent.append(item);
      }
      if (!builds.builds?.length)
        recent.append(
          node("p", "Uploaded builds appear here for reinstallation.", "muted"),
        );
    } catch (error) {
      if (generation === this.generation) this.status(errorText(error), true);
    }
  }
  destroy(): void {
    this.generation++;
    for (const job of this.jobs.values()) job.xhr?.abort();
  }
}
