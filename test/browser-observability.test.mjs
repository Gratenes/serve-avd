import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
          captureFps: 60,
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
    state.get("phone").crashes.push({
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
        "at android.os.Handler.handleCallback(Handler.java:942)",
        "at android.os.Looper.loop(Looper.java:200)",
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
    const trace = h.page.locator(".workspace-apps .observer-crash-detail");
    assert.deepEqual(
      await trace.locator(".crash-line-number").allTextContents(),
      ["1", "2", "3", "4"],
    );
    const framework = trace.locator("details");
    assert.equal(await framework.getAttribute("open"), null);
    assert.equal(
      await framework.locator("summary").innerText(),
      "2 framework frames",
    );
    assert.equal(
      await framework
        .getByText("at android.os.Looper.loop(Looper.java:200)", {
          exact: true,
        })
        .isVisible(),
      false,
    );
    await framework.locator("summary").click();
    assert.equal(
      await framework
        .getByText("at android.os.Looper.loop(Looper.java:200)", {
          exact: true,
        })
        .isVisible(),
      true,
    );
    await h.page
      .getByRole("checkbox", { name: "App frames only", exact: true })
      .check();
    assert.deepEqual(
      await trace.locator(".crash-line-number").allTextContents(),
      ["1", "2"],
    );
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test('Saved video has a large playable preview, precise trim controls and readable attached logs on desktop and mobile', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'avd-browser-video-'));
  const path = join(dir, 'clip.mp4');
  execFileSync('ffmpeg', ['-v','error','-y','-f','lavfi','-i','testsrc2=size=640x360:rate=60','-t','2','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',path]);
  const { h, state } = await observedHarness();
  try {
    state.get('tv').captures = [{ id:'playable', device:'tv', name:'Living Room TV', createdAt:new Date().toISOString(),
      duration:2, format:'mp4', width:640, height:360, fps:60, bytes:readFileSync(path).length, hasLogs:true, hasKeys:false }];
    await h.page.route('**/tv/captures/playable/file', route => {
      const data = readFileSync(path), range = route.request().headers().range;
      if (!range) return route.fulfill({ contentType:'video/mp4', body:data, headers:{'accept-ranges':'bytes'} });
      const match = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(match[1]), end = match[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1;
      return route.fulfill({status:206, contentType:'video/mp4', body:data.subarray(start,end+1), headers:{'accept-ranges':'bytes','content-range':`bytes ${start}-${end}/${data.length}`}});
    });
    await h.page.route('**/tv/captures/playable/logs', route => route.fulfill({ contentType:'text/plain', body:'10-09 12:00:01.000 E/Player(42): Actual device exception with full context\n10-09 12:00:02.000 I/Player(42): playback resumed' }));
    await h.page.reload();
    await h.page.getByRole('button', { name:'Captures 1', exact:true }).click();
    const video = h.page.getByLabel('Saved recording of Living Room TV', { exact:true });
    await h.page.waitForFunction(() => document.querySelector('.capture-player video')?.readyState >= 2);
    const bounds = await video.boundingBox();
    assert.ok(bounds.width >= 400 && bounds.height >= 240, JSON.stringify(bounds));
    await video.evaluate(async element => { await element.play(); });
    await h.page.waitForTimeout(150);
    assert.ok(await video.evaluate(element => element.currentTime > 0));
    await video.evaluate(element => { element.pause(); element.currentTime = 1; });
    await h.page.waitForFunction(() => Math.abs(document.querySelector('.capture-player video').currentTime - 1) < 0.1);
    await h.page.getByLabel('Trim start (seconds)', { exact:true }).fill('1.5');
    await h.page.getByLabel('Trim end (seconds)', { exact:true }).fill('1');
    assert.equal(await h.page.getByRole('button', { name:'Export trimmed clip', exact:true }).isEnabled(), false);
    await h.page.getByLabel('Trim end (seconds)', { exact:true }).fill('2');
    assert.equal(await h.page.getByRole('button', { name:'Export trimmed clip', exact:true }).isEnabled(), true);
    assert.match(await h.page.locator('.capture-metadata').innerText(), /60 fps/);
    await h.page.screenshot({ path:'/tmp/serve-avd-capture-desktop.png' });
    await h.page.getByRole('button', { name:'View attached logs', exact:true }).click();
    await h.page.getByText(/Actual device exception with full context/).waitFor();
    await h.page.getByRole('searchbox', { name:'Search attached logs', exact:true }).fill('exception');
    assert.doesNotMatch(await h.page.locator('.saved-log-content').innerText(), /playback resumed/);
    await h.page.getByRole('button', { name:'Close logs', exact:true }).click();
    assert.equal(await video.count(), 1);
    await h.page.setViewportSize({ width:390,height:844 });
    await video.scrollIntoViewIfNeeded();
    assert.ok((await video.boundingBox()).width <= 390);
    assert.ok(await h.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await h.page.screenshot({ path:'/tmp/serve-avd-capture-mobile.png' });
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); rmSync(dir,{recursive:true,force:true}); }
});


test('Capture sharing creates a scoped public link and lets the user revoke it', async () => {
  const { h, state } = await observedHarness();
  try {
    state.get('phone').captures = [{ id:'shared', device:'phone', name:'Pixel Phone', createdAt:new Date().toISOString(), duration:1, format:'png', bytes:12, hasLogs:false, hasKeys:false }];
    const methods = [];
    await h.page.route('**/phone/captures/shared/share', route => {
      methods.push(route.request().method());
      return route.fulfill({ json: { url:'/share/public-token', expiresAt:Date.now()+86400000 } });
    });
    await h.page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await h.page.reload();
    await h.page.getByRole('button', { name:'Captures 1', exact:true }).click();
    await h.page.getByRole('button', { name:'Copy share link', exact:true }).click();
    await h.page.waitForFunction(() => document.body.textContent.includes('Share link copied. Anyone with it'));
    assert.match(await h.page.evaluate(() => navigator.clipboard.readText()), /\/share\/public-token$/);
    await h.page.getByRole('button', { name:'Revoke share link', exact:true }).click();
    await h.page.waitForFunction(() => document.body.textContent.includes('Share link revoked.'));
    assert.deepEqual(methods, ['POST', 'DELETE']);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
