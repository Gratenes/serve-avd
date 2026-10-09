import test from "node:test";
import assert from "node:assert/strict";
import { harness } from "./browser-harness.mjs";
async function featureRoutes(h) {
  const calls = [];
  const snapshots = [{ tag: "clean", size: "10 MB", date: "today" }];
  let defaultSnapshot = null;
  await h.page.route("**/*", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path.endsWith("/apps"))
      return route.fulfill({
        json: {
          apps: [
            {
              packageName: "demo.app",
              versionName: "2.0",
              versionCode: "20",
              debuggable: true,
              bytes: 3145728,
              installedAt: "2026-10-09 12:30:00",
            },
          ],
        },
      });
    if (path.endsWith("/builds"))
      return route.fulfill({
        json: {
          builds: [
            {
              id: "build1",
              filename: "demo.apk",
              bytes: 2097152,
              createdAt: "2026-10-09T12:00:00Z",
              app: {
                packageName: "demo.app",
                versionName: "2.0",
                versionCode: "20",
                debuggable: true,
              },
            },
          ],
        },
      });
    if (path.endsWith("/crashes"))
      return route.fulfill({ json: { crashes: [] } });
    if (path.endsWith("/snapshot-default")) {
      if (req.method() === "POST") defaultSnapshot = req.postDataJSON().name;
      return route.fulfill({ json: { name: defaultSnapshot } });
    }
    if (path.endsWith("/preset-current"))
      return route.fulfill({
        json: {
          network: { speed: "umts", delay: "200" },
          locale: "pt-BR",
          geo: { lat: -23.55, lon: -46.63 },
          fontScale: 1.3,
        },
      });
    if (path.endsWith("/action")) {
      const body = req.postDataJSON();
      calls.push({ path, ...body });
      return route.fulfill({
        json: {
          ok: true,
          result:
            body.action === "snapshot"
              ? { snapshots }
              : body.action === "find"
                ? { total: 1 }
                : {},
        },
      });
    }
    if (path.endsWith("/apk")) {
      calls.push({
        path,
        file: req.headers()["x-filename"],
        bytes: req.postDataBuffer()?.length,
      });
      return route.fulfill({
        json: { build: { id: "build2" }, app: { packageName: "demo.app" } },
      });
    }
    return route.continue();
  });
  return { calls };
}
test("Apps installs APK bytes on the captured target and displays real build metadata", async () => {
  const h = await harness({ width: 1440, height: 1000 });
  try {
    const { calls } = await featureRoutes(h);
    await h.page.locator("[data-pane=apps]").click();
    await h.page.getByRole("button", { name: "Reinstall demo.apk" }).waitFor();
    assert.match(
      await h.page.locator(".workspace-apps").innerText(),
      /2.0.*20.*debug/s,
    );
    assert.match(
      await h.page.locator(".workspace-apps").innerText(),
      /2.0 MB.*INSTALLED/s,
    );
    assert.match(
      await h.page.locator(".workspace-apps").innerText(),
      /3.0 MB APK.*Installed 2026-10-09 12:30:00/s,
    );
    await h.page
      .getByRole("checkbox", { name: "Launch after install", exact: true })
      .check();
    await h.page.locator(".workspace-apps input[type=file]").setInputFiles({
      name: "demo.apk",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("apk test bytes"),
    });
    await h.page
      .getByText("Installed and launched demo.apk", { exact: true })
      .first()
      .waitFor();
    assert.ok(
      calls.some(
        (call) =>
          call.path === "/phone/apk" &&
          call.file === "demo.apk" &&
          call.bytes === 14,
      ),
    );
    assert.ok(
      calls.some(
        (call) =>
          call.path === "/phone/action" &&
          call.action === "launch" &&
          call.params.package === "demo.app",
      ),
    );
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});
test("Remote records delivered inputs once with mirror, editor persists and run captures selected target", async () => {
  const h = await harness({ width: 1440, height: 1000 });
  try {
    const { calls } = await featureRoutes(h);
    const remote = h.page.locator(".workspace-remote");
    await h.page
      .getByRole("switch", { name: "Mirror input", exact: true })
      .click();
    await remote
      .getByRole("button", { name: "Record macro", exact: true })
      .click();
    await remote.locator(".workspace-remote-dpad-up").click();
    await remote.locator(".workspace-remote-dpad-center").click();
    await remote
      .getByRole("button", { name: "Stop and save macro", exact: true })
      .click();
    await remote
      .getByRole("button", { name: "Run macro", exact: true })
      .click();
    assert.equal(await h.page.locator(".macro-step").count(), 2);
    await h.page
      .getByRole("textbox", { name: "Macro name", exact: true })
      .fill("Login flow");
    await h.page
      .getByRole("textbox", { name: "Macro name", exact: true })
      .press("Tab");
    await h.page
      .getByRole("button", { name: "Select Living Room TV", exact: true })
      .click();
    await h.page
      .locator(".workspace-automate")
      .getByRole("button", { name: "Run macro", exact: true })
      .click();
    await h.page.getByText("Login flow completed", { exact: true }).waitFor();
    assert.deepEqual(
      calls
        .filter((call) => call.action === "button")
        .map((call) => [call.path, call.params.button]),
      [
        ["/tv/action", "dpad-up"],
        ["/tv/action", "dpad-center"],
      ],
    );
    await h.page.reload();
    await h.page.locator("[data-pane=automate]").click();
    assert.equal(
      await h.page
        .getByRole("textbox", { name: "Macro name", exact: true })
        .inputValue(),
      "Login flow",
    );
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});
test("Deep-link id prompts encode the resolved value and cancellation sends nothing; presets persist real current settings", async () => {
  const h = await harness({ width: 1440, height: 1000 });
  try {
    const { calls } = await featureRoutes(h);
    await h.page.locator("[data-pane=automate]").click();
    await h.page
      .getByRole("textbox", { name: "Deep link", exact: true })
      .fill("demo://title/{id}");
    h.page.once("dialog", (dialog) => dialog.accept("a/b"));
    await h.page
      .locator('[aria-label="Deep links"]')
      .getByRole("button", { name: "Send", exact: true })
      .click();
    await h.page.waitForTimeout(100);
    assert.equal(
      calls.find((call) => call.action === "open")?.params.url,
      "demo://title/a%2Fb",
    );
    h.page.once("dialog", (dialog) => dialog.dismiss());
    await h.page
      .locator('[aria-label="Deep links"]')
      .getByRole("button", { name: "Send", exact: true })
      .click();
    assert.equal(calls.filter((call) => call.action === "open").length, 1);
    h.page.once("dialog", (dialog) => dialog.accept("Brazil lab"));
    await h.page
      .getByRole("button", { name: "Save current as preset", exact: true })
      .click();
    await h.page
      .getByRole("button", { name: "Apply Brazil lab", exact: true })
      .click();
    await h.page.getByText(/Applied Brazil lab/).waitFor();
    assert.ok(
      calls.some(
        (call) =>
          call.action === "network" &&
          call.params.speed === "umts" &&
          call.params.delay === "200",
      ),
    );
    assert.ok(
      calls.some(
        (call) => call.action === "locale" && call.params.locale === "pt-BR",
      ),
    );
    await h.page.reload();
    await h.page.locator("[data-pane=automate]").click();
    await h.page
      .getByRole("button", { name: "Apply Brazil lab", exact: true })
      .waitFor();
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});
test("Snapshots require an explicit restore choice and boot default is persisted through server endpoint", async () => {
  const h = await harness({ width: 1440, height: 1000 });
  try {
    const { calls } = await featureRoutes(h);
    await h.page.locator("[data-pane=automate]").click();
    const snapshots = h.page.locator("[aria-label=Snapshots]");
    await snapshots
      .getByRole("button", { name: "Boot default", exact: true })
      .click();
    await snapshots.getByText(/BOOT DEFAULT/).waitFor();
    await snapshots
      .getByRole("button", { name: "Restore", exact: true })
      .click();
    assert.equal(
      calls.filter(
        (call) => call.action === "snapshot" && call.params.op === "load",
      ).length,
      0,
    );
    await snapshots
      .getByRole("button", { name: "Save, then restore", exact: true })
      .click();
    await h.page.getByText("load clean completed", { exact: true }).waitFor();
    const mutations = calls.filter(
      (call) => call.action === "snapshot" && call.params.op !== "list",
    );
    assert.equal(mutations[0].params.op, "save");
    assert.equal(mutations[1].params.op, "load");
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test("Macro recording shows live elapsed time and recent inputs; editor estimates configured waits", async () => {
  const h = await harness({ width: 1440, height: 1000 });
  try {
    await featureRoutes(h);
    await h.page.locator("[data-pane=automate]").click();
    const automate = h.page.locator(".workspace-automate");
    await automate
      .getByRole("button", { name: "● Record", exact: true })
      .click();
    await h.page
      .getByText("Recording 0 steps · 00:01", { exact: true })
      .waitFor();
    await h.page.locator(".workspace-remote-dpad-up").click();
    await h.page.locator(".workspace-remote-dpad-center").click();
    assert.equal(
      await h.page
        .getByLabel("Recent recorded inputs", { exact: true })
        .innerText(),
      "↑ OK",
    );
    await automate
      .getByRole("button", { name: "Stop & save", exact: true })
      .click();
    await automate
      .getByRole("button", { name: "New macro", exact: true })
      .click();
    await h.page
      .getByRole("combobox", { name: "Step 1 type", exact: true })
      .selectOption("WAIT");
    await h.page
      .getByRole("textbox", { name: "Step 1 value", exact: true })
      .fill("2000");
    await h.page
      .getByRole("textbox", { name: "Step 1 value", exact: true })
      .press("Tab");
    await h.page
      .getByRole("spinbutton", { name: "Step 1 delay ms", exact: true })
      .fill("1250");
    await h.page
      .getByRole("spinbutton", { name: "Step 1 delay ms", exact: true })
      .press("Tab");
    assert.equal(await h.page.locator(".macro-duration").innerText(), "~3.3 s");
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test("A successful install refreshes the version badge even when optional launch fails", async () => {
  const h = await harness({ width: 1440, height: 1000 });
  let installed = false;
  try {
    await h.page.route("**/*", async (route) => {
      const req = route.request(),
        path = new URL(req.url()).pathname;
      if (path.endsWith("/apps"))
        return route.fulfill({
          json: {
            apps: installed
              ? [
                  {
                    packageName: "demo.app",
                    versionName: "3.0",
                    versionCode: "30",
                    debuggable: true,
                  },
                ]
              : [],
          },
        });
      if (path.endsWith("/foreground"))
        return route.fulfill({ json: { packageName: "demo.app" } });
      if (path.endsWith("/builds"))
        return route.fulfill({ json: { builds: [] } });
      if (path.endsWith("/apk")) {
        installed = true;
        return route.fulfill({ json: { app: { packageName: "demo.app" } } });
      }
      if (path.endsWith("/action") && req.postDataJSON().action === "launch")
        return route.fulfill({
          json: { ok: false, message: "No launchable activity" },
        });
      return route.continue();
    });
    await h.page.locator("[data-pane=apps]").click();
    await h.page
      .getByText("No installed user apps.", { exact: true })
      .waitFor();
    await h.page
      .getByRole("checkbox", { name: "Launch after install", exact: true })
      .check();
    await h.page
      .locator(".workspace-apps input[type=file]")
      .setInputFiles({
        name: "demo.apk",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("apk bytes"),
      });
    await h.page
      .getByText("APK installed; launch failed: No launchable activity", {
        exact: true,
      })
      .first()
      .waitFor();
    await h.page
      .locator("[data-device=phone] .installed-version")
      .getByText("demo.app 3.0 (30) · debug", { exact: true })
      .waitFor();
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});
