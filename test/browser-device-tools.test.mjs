import test from "node:test";
import assert from "node:assert/strict";
import { harness } from "./browser-harness.mjs";
test("Focus observes AX bounds, directional dead ends and unavailable data without intercepting input", async () => {
  const h = await harness({ width: 1440, height: 1000 });
  try {
    let unavailable = false;
    await h.page.route("**/phone/ax", (route) =>
      unavailable
        ? route.fulfill({ status: 500, json: { error: "Secure screen" } })
        : route.fulfill({
            json: {
              root: {
                children: [
                  {
                    focused: true,
                    class: "android.widget.Button",
                    resourceId: "demo:id/play",
                    text: "Play",
                    bounds: { left: 108, top: 240, right: 540, bottom: 1200 },
                  },
                ],
              },
            },
          }),
    );
    await h.page
      .getByRole("button", {
        name: "Focus overlay for Pixel Phone",
        exact: true,
      })
      .click();
    await h.page.locator("[data-device=phone] .device-focus-box").waitFor();
    assert.equal(
      await h.page
        .locator("[data-device=phone] .device-focus-box")
        .evaluate((node) => node.style.left),
      "10%",
    );
    const remote = h.page.locator(".workspace-remote");
    for (let i = 0; i < 3; i++) {
      await remote.locator(".workspace-remote-dpad-right").click();
      await h.page.waitForTimeout(260);
    }
    await h.page
      .getByText(/dpad-right did not move focus after 3 attempts/)
      .waitFor();
    assert.equal(
      h.messages.filter(
        (item) => item.tag === 4 && item.body.button === "dpad-right",
      ).length,
      3,
    );
    unavailable = true;
    await h.page.getByText(/Focus data unavailable: Secure screen/).waitFor();
    assert.equal(
      await h.page.locator("[data-device=phone] .device-focus-box").count(),
      0,
    );
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});
test("H264 quality changes restart only the target AVCC stream using real encoder query and persist on reload", async () => {
  const h = await harness({ width: 1440, height: 1000 }, "auto");
  try {
    await h.page
      .getByRole("button", {
        name: "Stream quality for Pixel Phone",
        exact: true,
      })
      .click();
    const panel = h.page.getByRole("dialog", {
      name: "Stream quality for Pixel Phone",
      exact: true,
    });
    await panel
      .getByRole("combobox", {
        name: "Resolution for Pixel Phone",
        exact: true,
      })
      .selectOption("720p");
    await panel
      .getByRole("combobox", {
        name: "Max frame rate for Pixel Phone",
        exact: true,
      })
      .selectOption("15");
    await h.page.waitForTimeout(1200);
    assert.ok(
      h.requests.some(
        (url) =>
          url.startsWith("/phone/streamAvcc?") &&
          url.includes("resolution=720p") &&
          url.includes("fps=15") &&
          url.includes("bitRateMbps=4"),
      ),
    );
    assert.equal(
      h.requests.filter((url) => url.startsWith("/tv/streamAvcc?")).length,
      0,
    );
    await h.page.reload();
    await h.page
      .getByRole("button", {
        name: "Stream quality for Pixel Phone",
        exact: true,
      })
      .click();
    assert.equal(
      await h.page
        .getByRole("combobox", {
          name: "Resolution for Pixel Phone",
          exact: true,
        })
        .inputValue(),
      "720p",
    );
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});
test("MJPEG quality encoding controls are disabled with an explicit availability explanation", async () => {
  const h = await harness({ width: 1440, height: 1000 });
  try {
    await h.page
      .getByRole("button", {
        name: "Stream quality for Pixel Phone",
        exact: true,
      })
      .click();
    const panel = h.page.getByRole("dialog", {
      name: "Stream quality for Pixel Phone",
      exact: true,
    });
    assert.equal(
      await panel
        .getByRole("combobox", {
          name: "Resolution for Pixel Phone",
          exact: true,
        })
        .isDisabled(),
      true,
    );
    assert.match(await panel.innerText(), /MJPEG fallback.*unavailable/);
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});
