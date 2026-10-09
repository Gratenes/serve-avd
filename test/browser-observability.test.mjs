import test from "node:test";
import assert from "node:assert/strict";
import { harness } from "./browser-harness.mjs";
async function observedHarness() {
  const h = await harness({ width: 1440, height: 1000 });
  const calls = [];
  const state = new Map(
    ["phone", "tv"].map((device) => [
      device,
      {
        captures: [],
        recording: null,
        crashes: [],
        builds: [],
        defaultSnapshot: null,
      },
    ]),
  );
  await h.page.route("**/*", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname,
      serial = path.split("/")[1];
    if (path.endsWith("/workspace"))
      return route.fulfill({ json: state.get(serial) });
    if (path.endsWith("/recording")) {
      const body = req.postDataJSON();
      calls.push({ serial, ...body });
      const current = state.get(serial);
      if (body.op === "start")
        current.recording = {
          id: "rec",
          startedAt: new Date().toISOString(),
          format: "mp4",
          maxSeconds: 30,
          captureFps: 4,
        };
      else {
        current.recording = null;
        current.captures.unshift({
          id: "capture" + current.captures.length,
          device: serial,
          name: "capture",
          createdAt: new Date().toISOString(),
          duration: body.op === "stop" ? 2 : 0,
          format: body.op === "stop" ? "mp4" : "png",
          bytes: 12,
          hasLogs: false,
          hasKeys: false,
        });
      }
      return route.fulfill({ json: current });
    }
    if (path.endsWith("/apps")) return route.fulfill({ json: { apps: [] } });
    if (path.endsWith("/builds"))
      return route.fulfill({ json: { builds: [] } });
    if (path.endsWith("/crashes"))
      return route.fulfill({ json: { crashes: state.get(serial).crashes } });
    if (path.includes("/captures/") && path.endsWith("/file"))
      return route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="green"/></svg>',
      });
    return route.continue();
  });
  return { h, calls, state };
}
test("Every existing screenshot entry point saves a real capture in the drawer; all-visible recording excludes hidden devices", async () => {
  const { h, calls } = await observedHarness();
  try {
    await h.page
      .locator("[data-device=phone] .device-head-actions")
      .getByRole("button", { name: "Screenshot", exact: true })
      .click();
    await h.page
      .getByRole("button", { name: "PNG Pixel Phone", exact: false })
      .waitFor();
    assert.ok(
      calls.some((call) => call.serial === "phone" && call.op === "screenshot"),
    );
    assert.equal(
      await h.page
        .getByRole("button", { name: "Screenshot to captures", exact: true })
        .count(),
      0,
    );
    await h.page
      .getByRole("button", { name: "Hide Living Room TV", exact: true })
      .click();
    await h.page
      .getByRole("button", { name: "Record visible", exact: true })
      .click();
    await h.page
      .getByRole("button", { name: "Stop recording", exact: true })
      .waitFor();
    assert.deepEqual(
      calls.filter((call) => call.op === "start").map((call) => call.serial),
      ["phone"],
    );
    await h.page.getByRole("button", { name: "Stop all", exact: true }).click();
    await h.page
      .getByRole("button", { name: "MP4 Pixel Phone", exact: false })
      .waitFor();
    assert.ok(
      calls.some((call) => call.op === "stop" && call.serial === "phone"),
    );
    assert.match(
      await h.page.locator(".workspace-drawer-bar").innerText(),
      /Captures 2/,
    );
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});
test("Activity uses real device lanes and selection saves a named macro with resolved deep links", async () => {
  const { h } = await observedHarness();
  try {
    const events = [
      {
        id: 1,
        timestamp: "2026-10-09T12:00:00Z",
        source: "hid",
        kind: "button",
        action: "press",
        device: "phone",
        summary: "Home",
        msg: "Home",
        details: { button: "home" },
      },
      {
        id: 2,
        timestamp: "2026-10-09T12:00:01Z",
        source: "api",
        kind: "app",
        action: "open",
        device: "phone",
        summary: "Deep link",
        msg: "Deep link",
        details: { url: "demo://title/42" },
      },
    ];
    await h.page.route("**/events", (r) =>
      r.fulfill({
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ events })}\n\n`,
      }),
    );
    await h.page.reload();
    await h.page
      .getByRole("button", { name: "Activity 2", exact: true })
      .click();
    assert.equal(await h.page.locator(".timeline-lane").count(), 2);
    h.page.once("dialog", (dialog) => dialog.accept("Repro flow"));
    await h.page
      .getByRole("button", { name: "Save as macro", exact: true })
      .click();
    await h.page
      .getByRole("textbox", { name: "Macro name", exact: true })
      .waitFor();
    assert.equal(
      await h.page
        .getByRole("textbox", { name: "Macro name", exact: true })
        .inputValue(),
      "Repro flow",
    );
    assert.equal(await h.page.locator(".macro-step").count(), 2);
    assert.equal(
      await h.page
        .getByRole("textbox", { name: "Step 2 value", exact: true })
        .inputValue(),
      "demo://title/42",
    );
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});
test("Observed crashes appear in header alerts and Apps with actual report context", async () => {
  const { h, state } = await observedHarness();
  try {
    state
      .get("phone")
      .crashes.push({
        id: "fatal1",
        device: "phone",
        timestamp: new Date().toISOString(),
        packageName: "demo.app",
        thread: "main",
        exception: "NullPointerException",
        message: "Demo crashed",
        lines: [
          "java.lang.NullPointerException",
          "at demo.app.Player.run(Player.java:42)",
        ],
        logs: ["pre-crash line"],
        versionName: "2.0",
        versionCode: "20",
        apiLevel: "34",
      });
    await h.page
      .locator("[data-device=phone]")
      .getByRole("button", { name: "View crash report", exact: true })
      .waitFor();
    await h.page.locator("[data-pane=apps]").click();
    await h.page
      .locator(".workspace-apps")
      .getByText("FATAL · NullPointerException", { exact: true })
      .waitFor();
    assert.match(
      await h.page.locator(".workspace-apps").innerText(),
      /thread main.*API 34/s,
    );
    assert.match(
      await h.page.locator(".workspace-apps").innerText(),
      /Player.java:42/,
    );
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});
