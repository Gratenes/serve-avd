import test from "node:test";
import assert from "node:assert/strict";
import { harness } from "./browser-harness.mjs";

async function metrics(h) {
  const values = { phone: 23, tv: 67 };
  let fail = false;
  await h.page.route("**/metrics", route => {
    const id = new URL(route.request().url()).pathname.split("/")[1];
    return fail ? route.fulfill({ status: 503, json: { error: "Collector unavailable" } }) : route.fulfill({ json: {
      timestamp: new Date().toISOString(), packageName: `com.example.${id}`, cpuPercent: values[id], memoryMb: 412,
      appFps: id === "phone" ? 57 : null, streamFps: 30, streamMbps: 2.1, unavailable: id === "tv" ? ["App FPS unavailable"] : [],
    } });
  });
  return { values, fail: () => { fail = true; } };
}

test("performance grid panel compares actual histories, pauses and exports its selected window", async () => {
  const h = await harness({ width: 1600, height: 1100 });
  try {
    const m = await metrics(h);
    await h.page.getByRole("button", { name: "Open performance workspace", exact: true }).first().click();
    const panel = h.page.getByRole("region", { name: "Performance workspace", exact: true });
    await panel.getByText("23%", { exact: true }).waitFor();
    await panel.getByText("67%", { exact: true }).waitFor();
    assert.equal(await panel.locator(".performance-chart-card").count(), 8);
    assert.match(await panel.innerText(), /App FPS unavailable/);
    assert.match(await panel.innerText(), /MJPEG.*unavailable/);
    assert.equal(await panel.locator(".performance-chart-card path").first().getAttribute("d").then(Boolean), true);
    await panel.getByRole("combobox", { name: "Performance device" }).selectOption("phone");
    assert.equal(await panel.locator(".performance-device").count(), 1);
    await panel.getByRole("button", { name: "Pause performance display" }).click();
    m.values.phone = 88;
    await h.page.waitForTimeout(2300);
    assert.equal(await panel.getByText("23%", { exact: true }).count(), 1);
    const downloadPromise = h.page.waitForEvent("download");
    await panel.getByRole("button", { name: "Export performance measurements" }).click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    const chunks = []; for await (const chunk of stream) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(data.paused, true);
    assert.equal(data.devices.length, 1);
    assert.equal(data.devices[0].device, "phone");
    assert.equal(data.devices[0].samples.at(-1).cpuPercent, 23);
    await panel.getByRole("button", { name: "Resume performance display" }).click();
    await panel.getByText("88%", { exact: true }).waitFor();
    await panel.getByRole("combobox", { name: "Performance history window" }).selectOption("300");
    await panel.getByRole("button", { name: "Expand performance workspace" }).click();
    assert.equal(await panel.evaluate(n => n.offsetWidth), 1100);
    m.fail();
    await panel.getByText(/Measurements unavailable: Collector unavailable/).waitFor();
    assert.equal(await panel.getByText("88%", { exact: true }).count(), 1);
    await h.page.screenshot({ path: "/tmp/serve-avd-performance-desktop.png" });
    await panel.getByRole("button", { name: "Close performance workspace" }).click();
    assert.equal(await panel.isVisible(), false);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("Apps and Automate share a movable inspector panel and return to the sidebar", async () => {
  const h = await harness({ width: 1600, height: 1100 });
  try {
    await h.page.getByRole("button", { name: "Open Apps on grid", exact: true }).click();
    const panel = h.page.getByRole("region", { name: "Inspector workspace", exact: true });
    await panel.waitFor();
    assert.equal(await panel.getByRole("button", { name: "Apps", exact: true }).getAttribute("aria-pressed"), "true");
    assert.equal(await panel.evaluate(n => n.offsetWidth), 760);
    await h.page.getByRole("button", { name: "Open Automate on grid", exact: true }).click();
    assert.equal(await panel.getByRole("button", { name: "Automate", exact: true }).getAttribute("aria-pressed"), "true");
    assert.equal(await h.page.locator(".panes.inspector").count(), 1);
    await panel.getByRole("button", { name: "Return inspector to sidebar", exact: true }).click();
    assert.equal(await panel.isVisible(), false);
    assert.equal(await h.page.locator(".layout > .panes.inspector").count(), 1);
    await h.page.getByRole("button", { name: "Expand drawer to workspace", exact: true }).click();
    assert.equal(await h.page.locator(".workspace-drawer.drawer-expanded").count(), 1);
    await h.page.getByRole("button", { name: "Restore drawer size", exact: true }).click();
    assert.equal(await h.page.locator(".workspace-drawer.drawer-expanded").count(), 0);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("mobile performance expands into readable cards without horizontal overflow or Android input", async () => {
  const h = await harness({ width: 390, height: 844 });
  try {
    await metrics(h);
    await h.page.getByRole("button", { name: "Open performance workspace", exact: true }).first().click();
    const panel = h.page.getByRole("region", { name: "Performance workspace", exact: true });
    await panel.getByText("23%", { exact: true }).waitFor();
    assert.ok(await panel.evaluate(n => n.scrollWidth <= n.clientWidth + 1));
    const box = await panel.boundingBox();
    assert.ok(box.width <= 390);
    await panel.getByRole("combobox", { name: "Performance device" }).selectOption("phone");
    await panel.getByRole("combobox", { name: "Performance history window" }).focus();
    await h.page.keyboard.press("ArrowDown");
    assert.equal(h.messages.length, 0);
    await h.page.screenshot({ path: "/tmp/serve-avd-performance-mobile.png" });
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test("performance controls change only the chosen encoder and panels participate in canvas layouts", async () => {
  const h = await harness({ width: 1600, height: 1100 }, "auto");
  try {
    await metrics(h);
    await h.page.getByRole("button", { name: "Open performance workspace", exact: true }).first().click();
    const panel = h.page.getByRole("region", { name: "Performance workspace", exact: true });
    await panel.getByRole("combobox", { name: "Performance device" }).selectOption("phone");
    await panel.locator(".performance-quality summary").click();
    await panel.getByRole("combobox", { name: "Resolution for Pixel Phone", exact: true }).selectOption("540p");
    await h.page.waitForTimeout(1200);
    assert.ok(h.requests.some(url => url.startsWith("/phone/streamAvcc?") && url.includes("resolution=540p")));
    assert.equal(h.requests.some(url => url.startsWith("/tv/streamAvcc?")), false);
    const head = panel.locator(":scope > .device-head");
    const before = await panel.evaluate(n => parseFloat(n.style.left));
    await head.focus();
    await h.page.keyboard.press("ArrowRight");
    assert.equal(await panel.evaluate(n => parseFloat(n.style.left)), before + 24);
    await h.page.getByRole("button", { name: "Grid", exact: true }).click();
    const boxes = await h.page.locator(".stage > .device:visible, .stage > .workspace-tool-card:visible").evaluateAll(nodes => nodes.map(n => ({ x:n.offsetLeft,y:n.offsetTop,w:n.offsetWidth,h:n.offsetHeight })));
    assert.equal(boxes.length, 3);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, "grid cards overlap");
    }
    await h.page.getByRole("button", { name: "Focus", exact: true }).click();
    assert.equal(await panel.evaluate(n => n.classList.contains("focus-thumbnail")), false);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
