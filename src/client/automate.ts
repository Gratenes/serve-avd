import {
  control,
  deviceAction,
  errorText,
  field,
  helperBase,
  node,
  readSaved,
  request,
  row,
  saveItems,
  section,
  type FeatureDevice,
} from "./feature-dom";
import {
  MacroRunner,
  recordedStep,
  resolveDeepLink,
  validateMacroSteps,
  type Macro,
  type MacroKind,
  type MacroStep,
} from "./macro-model";
interface SavedLink {
  id: string;
  name: string;
  url: string;
}
interface PresetValues {
  network?: Record<string, unknown>;
  locale?: string;
  geo?: { lat: number; lon: number } | null;
  fontScale?: number;
  talkback?: boolean;
  highContrast?: boolean;
}
interface SavedPreset extends PresetValues {
  id: string;
  name: string;
}
interface Snapshot {
  tag: string;
  name?: string;
  size?: string;
  date?: string;
}
function choose(
  label: string,
  options: string[],
  value: string,
): HTMLSelectElement {
  const item = node("select", "", "select");
  item.setAttribute("aria-label", label);
  for (const value of options) {
    const option = node("option", value);
    option.value = value;
    item.append(option);
  }
  item.value = value;
  return item;
}
/** Durable definitions are account/base-path scoped in browser storage; device state comes from adb. */
export class WorkspaceAutomate {
  readonly root = node("div", "", "workspace-automate");
  private readonly macros: Macro[];
  private readonly presets: SavedPreset[];
  private readonly links: SavedLink[];
  private readonly runner = new MacroRunner();
  private selectedMacro: string | null = null;
  private device: FeatureDevice | null = null;
  private generation = 0;
  private recording: {
    device: string;
    steps: MacroStep[];
    last: number;
    started: number;
  } | null = null;
  private repeat = 1;
  private runAll = false;
  private stopOnCrash = true;
  private stepIndex = 0;
  private activePreset = new Map<string, string>();
  private message = "";
  private isError = false;
  private macroStatus: HTMLElement | null = null;
  private runningTargets: FeatureDevice[] = [];
  constructor(
    private readonly storageKey: string,
    private readonly visibleDevices: () => FeatureDevice[],
    private readonly onRecordChange: (active: boolean, steps: number) => void,
  ) {
    const macros = readSaved<unknown>(`${storageKey}:macros`, []);
    this.macros = Array.isArray(macros)
      ? macros.filter((macro): macro is Macro => {
          try {
            if (
              !macro ||
              typeof macro.name !== "string" ||
              typeof macro.id !== "string"
            )
              return false;
            validateMacroSteps(macro.steps);
            return true;
          } catch {
            return false;
          }
        })
      : [];
    const presets = readSaved<unknown>(`${storageKey}:presets`, []);
    this.presets = Array.isArray(presets)
      ? presets.filter(
          (item) =>
            item &&
            typeof item.name === "string" &&
            typeof item.id === "string",
        )
      : [];
    const links = readSaved<unknown>(`${storageKey}:links`, []);
    this.links = Array.isArray(links)
      ? links.filter(
          (item) =>
            item &&
            typeof item.name === "string" &&
            typeof item.url === "string" &&
            typeof item.id === "string",
        )
      : [];
    this.selectedMacro = this.macros[0]?.id ?? null;
  }
  private persist(): void {
    saveItems(`${this.storageKey}:macros`, this.macros);
    saveItems(`${this.storageKey}:presets`, this.presets);
    saveItems(`${this.storageKey}:links`, this.links);
  }
  select(device: FeatureDevice | null): void {
    if (this.recording && this.recording.device !== device?.entry.device) {
      this.stopRecording(true);
      this.message = "Recording saved before changing the target.";
    }
    this.device = device;
    this.stepIndex = 0;
    this.render();
  }
  observeInput(
    serial: string,
    tag: number,
    body: Record<string, unknown>,
  ): void {
    const recording = this.recording;
    if (!recording || this.runner.running || recording.device !== serial)
      return;
    const now = performance.now(),
      step = recordedStep(
        tag,
        body,
        Math.min(60000, Math.round(now - recording.last)),
      );
    if (!step) return;
    recording.steps.push(step);
    recording.last = now;
    this.onRecordChange(true, recording.steps.length);
    if (this.macroStatus)
      this.macroStatus.textContent = `Recording ${recording.steps.length} steps · ${Math.round((now - recording.started) / 1000)}s`;
  }
  observeLink(serial: string, url: string): void {
    if (this.recording?.device === serial) {
      const now = performance.now();
      this.recording.steps.push({
        kind: "LINK",
        value: url,
        waitMs: Math.min(60000, Math.round(now - this.recording.last)),
      });
      this.recording.last = now;
      this.onRecordChange(true, this.recording.steps.length);
    }
  }
  toggleRecording(): void {
    if (this.recording) this.stopRecording(true);
    else this.startRecording();
  }
  startRecording(): void {
    if (!this.device?.connected) {
      this.flash("Select a connected device before recording.", true);
      return;
    }
    if (this.runner.running) {
      this.flash("Stop the running macro first.", true);
      return;
    }
    this.recording = {
      device: this.device.entry.device,
      steps: [],
      last: performance.now(),
      started: performance.now(),
    };
    this.onRecordChange(true, 0);
    this.render();
  }
  private stopRecording(save: boolean): void {
    const recording = this.recording;
    this.recording = null;
    this.onRecordChange(false, 0);
    if (save && recording?.steps.length) {
      const macro: Macro = {
        id: crypto.randomUUID(),
        name: `Recorded ${new Date().toLocaleString()}`,
        steps: recording.steps,
        uses: 0,
      };
      this.macros.push(macro);
      this.selectedMacro = macro.id;
      this.persist();
    }
    this.render();
  }
  saveFromTimeline(steps: MacroStep[]): void {
    try {
      validateMacroSteps(steps);
      const macro: Macro = {
        id: crypto.randomUUID(),
        name: `Activity ${new Date().toLocaleString()}`,
        steps,
        uses: 0,
      };
      this.macros.push(macro);
      this.selectedMacro = macro.id;
      this.persist();
      this.render();
    } catch (error) {
      this.flash(errorText(error), true);
    }
  }
  checkTargets(): void {
    if (
      this.runner.running &&
      this.runningTargets.some((target) => !target.connected)
    )
      this.runner.stop();
  }
  private flash(text: string, error = false): void {
    this.message = text;
    this.isError = error;
    const status = this.root.querySelector<HTMLElement>(".feature-status");
    if (status) {
      status.textContent = text;
      status.classList.toggle("error", error);
      status.setAttribute("role", error ? "alert" : "status");
    }
  }
  private render(): void {
    this.generation++;
    this.root.replaceChildren();
    const status = node(
      "p",
      this.message,
      `feature-status${this.isError ? " error" : ""}`,
    );
    status.setAttribute("role", this.isError ? "alert" : "status");
    this.root.append(status);
    this.renderMacros();
    if (!this.device) {
      this.root.append(
        node(
          "p",
          "Select a device for snapshots, presets and deep links.",
          "muted",
        ),
      );
      return;
    }
    this.renderSnapshots(this.device);
    this.renderPresets(this.device);
    this.renderLinks(this.device);
    this.root.append(
      node(
        "p",
        "Macros, presets and links are saved in this browser for your account.",
        "muted feature-storage-note",
      ),
    );
  }
  private renderMacros(): void {
    const list = node("div", "", "feature-list");
    for (const macro of this.macros)
      list.append(
        row(
          control(
            macro.name,
            () => {
              this.selectedMacro = macro.id;
              this.stepIndex = 0;
              this.render();
            },
            `Edit ${macro.name}`,
          ),
          node(
            "span",
            `${macro.steps.length} steps · used ${macro.uses ?? 0}×`,
            "feature-meta",
          ),
        ),
      );
    if (!this.macros.length)
      list.append(
        node(
          "p",
          "Record input or create a macro to automate a flow.",
          "muted",
        ),
      );
    const recording = node("div", "", "macro-recording");
    this.macroStatus = node(
      "span",
      this.recording ? `Recording ${this.recording.steps.length} steps` : "",
      "feature-meta",
    );
    recording.append(
      this.macroStatus,
      row(
        control(this.recording ? "Stop & save" : "● Record", () =>
          this.toggleRecording(),
        ),
        control(this.recording ? "Discard" : "New macro", () => {
          if (this.recording) this.stopRecording(false);
          else {
            const macro: Macro = {
              id: crypto.randomUUID(),
              name: "New macro",
              uses: 0,
              steps: [{ kind: "KEY", value: "home", waitMs: 0 }],
            };
            this.macros.push(macro);
            this.selectedMacro = macro.id;
            this.persist();
            this.render();
          }
        }),
      ),
    );
    const panel = section("Saved macros", recording, list);
    this.root.append(panel);
    const macro = this.macros.find((item) => item.id === this.selectedMacro);
    if (!macro) return;
    const name = field("Macro name", macro.name);
    name.addEventListener("change", () => {
      macro.name = name.value.trim() || macro.name;
      this.persist();
    });
    const steps = node("ol", "", "macro-steps");
    let dragged = -1;
    macro.steps.forEach((step, index) => {
      const kind = choose(
        `Step ${index + 1} type`,
        ["KEY", "TEXT", "WAIT", "LINK", "CHECK", "INPUT"],
        step.kind,
      );
      const value = field(`Step ${index + 1} value`, step.value);
      const wait = field(
        `Step ${index + 1} delay ms`,
        String(step.waitMs),
        "number",
      );
      wait.min = "0";
      wait.max = "60000";
      wait.title = "Delay before this step, in milliseconds";
      const change = () => {
        step.kind = kind.value as MacroKind;
        step.value = value.value;
        step.waitMs = Number(wait.value);
        this.persist();
        this.stepIndex = 0;
      };
      kind.addEventListener("change", change);
      value.addEventListener("change", change);
      wait.addEventListener("change", change);
      if (step.kind === "INPUT") value.disabled = true;
      const item = node("li", "", "macro-step");
      item.draggable = true;
      item.addEventListener("dragstart", () => {
        dragged = index;
      });
      item.addEventListener("dragover", (event) => event.preventDefault());
      item.addEventListener("drop", (event) => {
        event.preventDefault();
        if (dragged < 0 || dragged === index) return;
        const [moved] = macro.steps.splice(dragged, 1);
        macro.steps.splice(index, 0, moved!);
        this.persist();
        this.render();
      });
      const move = (delta: number) => {
        const to = index + delta;
        if (to < 0 || to >= macro.steps.length) return;
        const [moved] = macro.steps.splice(index, 1);
        macro.steps.splice(to, 0, moved!);
        this.persist();
        this.render();
      };
      item.append(
        row(
          node("span", String(index + 1), "feature-meta"),
          kind,
          control("↑", () => move(-1), `Move step ${index + 1} up`),
          control("↓", () => move(1), `Move step ${index + 1} down`),
          control(
            "×",
            () => {
              macro.steps.splice(index, 1);
              this.persist();
              this.render();
            },
            `Delete step ${index + 1}`,
          ),
        ),
        value,
        row(node("span", "Delay ms", "feature-meta"), wait),
      );
      steps.append(item);
    });
    const repeat = field("Macro repeat", String(this.repeat), "number");
    repeat.min = "1";
    repeat.max = "100";
    repeat.addEventListener("change", () => {
      this.repeat = Number(repeat.value);
    });
    const target = choose(
      "Run macro on",
      ["Selected device", "All visible"],
      this.runAll ? "All visible" : "Selected device",
    );
    target.addEventListener("change", () => {
      this.runAll = target.value === "All visible";
    });
    const crash = node("input");
    crash.type = "checkbox";
    crash.checked = this.stopOnCrash;
    crash.addEventListener("change", () => {
      this.stopOnCrash = crash.checked;
    });
    const crashLabel = node("label", "Stop if the app crashes");
    crashLabel.prepend(crash);
    const execute = async (single: boolean) => {
      if (this.recording) this.stopRecording(true);
      const targets = this.runAll
        ? this.visibleDevices()
        : this.device
          ? [this.device]
          : [];
      this.runningTargets = targets.slice();
      const runSteps = single
        ? [macro.steps[this.stepIndex % macro.steps.length]!]
        : macro.steps;
      try {
        this.flash(`Running ${macro.name}…`);
        await this.runner.run(
          runSteps,
          targets,
          single ? 1 : this.repeat,
          this.stopOnCrash,
          (index, total) =>
            this.flash(`${macro.name}: ${index}/${total} steps`),
        );
        macro.uses = (macro.uses ?? 0) + 1;
        if (single) this.stepIndex = (this.stepIndex + 1) % macro.steps.length;
        this.persist();
        this.flash(
          single
            ? `Step ${this.stepIndex || macro.steps.length} completed`
            : `${macro.name} completed`,
        );
      } catch (error) {
        this.flash(errorText(error), true);
      } finally {
        this.runningTargets = [];
      }
    };
    panel.append(
      name,
      steps,
      control("+ Add step", () => {
        macro.steps.push({ kind: "KEY", value: "dpad-center", waitMs: 300 });
        this.persist();
        this.render();
      }),
      node(
        "p",
        "KEY: remote button or browser key. WAIT: milliseconds. CHECK: wait for visible text. LINK: a resolved URL.",
        "muted",
      ),
      row(target, repeat),
      crashLabel,
      row(
        control("Step through", () => void execute(true)),
        control("Run macro", () => void execute(false)),
        control("Stop", () => this.runner.stop()),
      ),
      control("Delete macro", () => {
        this.macros.splice(this.macros.indexOf(macro), 1);
        this.selectedMacro = this.macros[0]?.id ?? null;
        this.persist();
        this.render();
      }),
    );
  }
  private renderSnapshots(device: FeatureDevice): void {
    const generation = this.generation;
    const name = field("Snapshot name");
    const list = node("div", "", "feature-list");
    const panel = section(
      "Snapshots",
      row(
        name,
        control("Save snapshot", () => {
          const value = name.value.trim();
          if (!value || value.length > 120) {
            this.flash(
              "Enter a snapshot name with up to 120 characters.",
              true,
            );
            return;
          }
          void deviceAction(device, "snapshot", {
            op: "save",
            name: `snapshot-${crypto.randomUUID()}`,
            displayName: value,
          })
            .then(() => {
              this.flash(`Saved ${value}`);
              void load();
            })
            .catch((error) => this.flash(errorText(error), true));
        }),
      ),
      list,
    );
    this.root.append(panel);
    const run = async (op: string, tag: string) => {
      try {
        await deviceAction(device, "snapshot", { op, name: tag });
        this.flash(`${op} ${tag} completed`);
        await load();
      } catch (error) {
        this.flash(errorText(error), true);
      }
    };
    const load = async () => {
      try {
        const [result, defaults] = await Promise.all([
          deviceAction<{ snapshots: Snapshot[] }>(device, "snapshot", {
            op: "list",
          }),
          request<{ name: string | null }>(
            `${helperBase(device)}/snapshot-default`,
          ),
        ]);
        if (generation !== this.generation) return;
        list.replaceChildren();
        for (const snapshot of result.snapshots ?? []) {
          const tag = snapshot.tag,
            item = node("div", "", "feature-card");
          item.append(
            node("strong", snapshot.name ?? tag),
            node(
              "span",
              `${snapshot.size ?? ""} ${snapshot.date ?? ""}${defaults.name === tag ? " · BOOT DEFAULT" : ""}`,
              "feature-meta",
            ),
          );
          const restore = () => {
            const dialog = node("div", "", "snapshot-confirm");
            dialog.setAttribute("role", "alertdialog");
            dialog.setAttribute("aria-label", `Restore ${tag}`);
            dialog.append(
              node(
                "p",
                `Restore ${tag}? Save the current state first to keep it.`,
              ),
              row(
                control("Save, then restore", () => {
                  const backup = `before-restore-${Date.now()}`;
                  void deviceAction(device, "snapshot", {
                    op: "save",
                    name: backup,
                  })
                    .then(() => run("load", tag))
                    .catch((error) => this.flash(errorText(error), true));
                }),
                control("Restore", () => void run("load", tag)),
                control("Cancel", () => dialog.remove()),
              ),
            );
            item.append(dialog);
          };
          item.append(
            row(
              control("Restore", restore),
              control(
                defaults.name === tag ? "Clear boot default" : "Boot default",
                () =>
                  void request(`${helperBase(device)}/snapshot-default`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      name: defaults.name === tag ? null : tag,
                    }),
                  })
                    .then(() => load())
                    .catch((error) => this.flash(errorText(error), true)),
              ),
              control("Rename", () => {
                const next = prompt("New snapshot name", snapshot.name ?? tag);
                if (next && next !== tag)
                  void deviceAction(device, "snapshot", {
                    op: "rename",
                    name: tag,
                    newName: next,
                  })
                    .then(() => load())
                    .catch((error) => this.flash(errorText(error), true));
              }),
              (() => {
                const copy = control("Copy", () => {});
                copy.disabled = true;
                copy.title =
                  "Copy requires compatible emulator images; cross-image snapshot copying is unavailable.";
                return copy;
              })(),
              control("Delete", () => {
                if (confirm(`Delete snapshot ${tag}?`)) void run("delete", tag);
              }),
            ),
          );
          list.append(item);
        }
        if (!result.snapshots?.length)
          list.append(
            node("p", "No snapshots saved on this emulator.", "muted"),
          );
      } catch (error) {
        if (generation === this.generation)
          list.replaceChildren(node("p", errorText(error), "error"));
      }
    };
    void load();
  }
  private renderPresets(device: FeatureDevice): void {
    const panel = section("Device presets");
    const form = node("details", "", "feature-card");
    form.append(node("summary", "Create preset"));
    const name = field("Preset name"),
      locale = field("Language (BCP-47)", "en-US"),
      font = field("Font scale", "1", "number"),
      lat = field("Latitude", "", "number"),
      lon = field("Longitude", "", "number");
    font.min = "0.5";
    font.max = "3";
    font.step = "0.1";
    const speed = choose(
        "Preset network speed",
        ["full", "lte", "umts", "edge", "off"],
        "full",
      ),
      delay = choose("Preset latency", ["none", "50", "200", "1000"], "none");
    const wifi = node("input");
    wifi.type = "checkbox";
    wifi.checked = true;
    const wifiLabel = node("label", "Wi-Fi");
    wifiLabel.prepend(wifi);
    const airplane = node("input");
    airplane.type = "checkbox";
    const airplaneLabel = node("label", "Airplane");
    airplaneLabel.prepend(airplane);
    const save = () => {
      const scale = Number(font.value),
        latitude = Number(lat.value),
        longitude = Number(lon.value);
      if (!name.value.trim()) {
        this.flash("Name the preset.", true);
        return;
      }
      if (!Number.isFinite(scale) || scale < 0.5 || scale > 3) {
        this.flash("Font scale must be 0.5–3.", true);
        return;
      }
      if (
        (lat.value || lon.value) &&
        (!lat.value ||
          !lon.value ||
          !Number.isFinite(latitude) ||
          !Number.isFinite(longitude) ||
          Math.abs(latitude) > 90 ||
          Math.abs(longitude) > 180)
      ) {
        this.flash("Enter valid latitude and longitude.", true);
        return;
      }
      this.presets.push({
        id: crypto.randomUUID(),
        name: name.value.trim(),
        locale: locale.value.trim(),
        fontScale: scale,
        network: {
          ...(speed.value === "off"
            ? { data: false }
            : { speed: speed.value, data: true }),
          delay: delay.value,
          wifi: wifi.checked,
          airplane: airplane.checked,
        },
        geo: lat.value && lon.value ? { lat: latitude, lon: longitude } : null,
      });
      this.persist();
      this.render();
    };
    form.append(
      name,
      row(speed, delay),
      row(wifiLabel, airplaneLabel),
      locale,
      font,
      row(lat, lon),
      control("Save preset", save),
    );
    panel.append(
      form,
      control("Save current as preset", () => {
        void request<PresetValues>(`${helperBase(device)}/preset-current`)
          .then((current) => {
            const name = prompt("Preset name");
            if (!name?.trim()) return;
            this.presets.push({
              ...current,
              id: crypto.randomUUID(),
              name: name.trim(),
            });
            this.persist();
            this.render();
          })
          .catch((error) => this.flash(errorText(error), true));
      }),
    );
    for (const preset of this.presets) {
      const card = node("div", "", "feature-card");
      card.append(
        node("strong", preset.name),
        node(
          "span",
          `${preset.network?.speed ?? "network unchanged"} · ${preset.locale ?? "language unchanged"} · font ${preset.fontScale ?? "?"}×${this.activePreset.get(device.entry.device) === preset.id ? " · APPLIED" : ""}`,
          "feature-meta",
        ),
      );
      const apply = async (all: boolean) => {
        const targets = all ? this.visibleDevices() : [device];
        const outcomes: string[] = [];
        let failed = false;
        for (const target of targets) {
          try {
            if (preset.network) {
              const network = { ...preset.network };
              if (network.speed === "off") {
                delete network.speed;
                network.data = false;
              }
              await deviceAction(target, "network", network);
            }
            if (preset.geo) await deviceAction(target, "geo", preset.geo);
            if (preset.fontScale != null)
              await deviceAction(target, "font-scale", {
                scale: preset.fontScale,
              });
            if (preset.talkback != null)
              await deviceAction(target, "talkback", {
                enabled: preset.talkback,
              });
            if (preset.highContrast != null)
              await deviceAction(target, "high-contrast", {
                enabled: preset.highContrast,
              });
            let localeNote = "";
            if (preset.locale) {
              const result = await deviceAction<{
                applied?: string;
                note?: string;
              }>(target, "locale", { locale: preset.locale, system: true });
              localeNote = result.note ?? result.applied ?? "";
            }
            this.activePreset.set(target.entry.device, preset.id);
            outcomes.push(
              `Applied ${preset.name} to ${target.entry.name}${localeNote ? ` · ${localeNote}` : ""}`,
            );
          } catch (error) {
            failed = true;
            outcomes.push(
              `${target.entry.name}: partially applied · ${errorText(error)}`,
            );
          }
        }
        this.message = outcomes.join(" | ");
        this.isError = failed;
        this.render();
      };
      card.append(
        row(
          control("Apply", () => void apply(false), `Apply ${preset.name}`),
          control(
            "All",
            () => void apply(true),
            `Apply ${preset.name} to all visible devices`,
          ),
          control(
            "Delete",
            () => {
              this.presets.splice(this.presets.indexOf(preset), 1);
              this.persist();
              this.render();
            },
            `Delete ${preset.name}`,
          ),
        ),
      );
      panel.append(card);
    }
    if (!this.presets.length)
      panel.append(
        node("p", "Save actual device settings or create a preset.", "muted"),
      );
    this.root.append(panel);
  }
  private renderLinks(device: FeatureDevice): void {
    const name = field("Link name"),
      url = field("Deep link");
    const send = async (template: string) => {
      try {
        const resolved = resolveDeepLink(
          template,
          template.includes("{id}") ? prompt("Value for {id}") : undefined,
        );
        if (!resolved) return;
        await deviceAction(device, "open", { url: resolved });
        this.observeLink(device.entry.device, resolved);
        this.flash(`Opened ${resolved}`);
      } catch (error) {
        this.flash(errorText(error), true);
      }
    };
    const panel = section(
      "Deep links",
      row(
        url,
        control("Send", () => void send(url.value)),
      ),
      row(
        name,
        control("Save link", () => {
          if (!name.value.trim() || !url.value.trim()) {
            this.flash("Enter a name and URL to save the link.", true);
            return;
          }
          this.links.push({
            id: crypto.randomUUID(),
            name: name.value.trim(),
            url: url.value.trim(),
          });
          this.persist();
          this.render();
        }),
      ),
    );
    for (const link of this.links)
      panel.append(
        row(
          node("div", "", "feature-build"),
          control(link.name, () => void send(link.url), `Send ${link.name}`),
          control(
            "Edit",
            () => {
              const nextName = prompt("Link name", link.name);
              if (!nextName?.trim()) return;
              const nextUrl = prompt("Deep link URL", link.url);
              if (!nextUrl?.trim()) return;
              link.name = nextName.trim();
              link.url = nextUrl.trim();
              this.persist();
              this.render();
            },
            `Edit ${link.name}`,
          ),
          control(
            "×",
            () => {
              this.links.splice(this.links.indexOf(link), 1);
              this.persist();
              this.render();
            },
            `Delete ${link.name}`,
          ),
        ),
        node("span", link.url, "feature-meta"),
      );
    panel.append(
      node(
        "p",
        "Links containing {id} ask for a value before sending.",
        "muted",
      ),
    );
    this.root.append(panel);
  }
  destroy(): void {
    this.generation++;
    this.runner.stop();
    this.stopRecording(false);
  }
}
