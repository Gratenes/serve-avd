import http from "node:http";
import fs from "node:fs/promises";
import { WebSocketServer } from "ws";
import { chromium } from "playwright";

// Exercise the built browser client and real WebSockets without requiring adb.
export async function harness(viewport = { width: 390, height: 844 }, codec = "mjpeg") {
  const messages = [];
  const requests = [];
  const streamClosures = [];
  const devices = ["phone", "tv"].map((id, index) => ({
    device: id,
    name: index ? "Living Room TV" : "Pixel Phone",
    videoAvailable: codec === "auto",
    config: {
      width: index ? 1920 : 1080,
      height: index ? 1080 : 2400,
      rotation: index ? 1 : 0,
      orientation: index ? "landscape_left" : "portrait",
    },
    ...Object.fromEntries(
      ["streamMjpeg", "streamAvcc", "ws", "config", "logs", "screenshot", "ax", "foreground", "action"]
        .map((key) => [`${key}Endpoint`, `/${id}/${key}`]),
    ),
  }));
  const state = {
    version: "test", codec, basePath: "", initialState: {}, devices,
    gridApiEndpoint: "/grid", gridStartEndpoint: "/start",
    eventLogEndpoint: "/event-log", eventLogEventsEndpoint: "/events",
  };
  const server = http.createServer(async (req, res) => {
    requests.push(req.url);
    const path = req.url.split("?")[0];
    if (path === "/") {
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" href="/client.css"><div id="app"></div>
        <script>window.__SERVE_AVD__={basePath:"",initialState:{},version:"test"}</script>
        <script src="/client.js"></script>`);
      return;
    }
    if (path === "/client.js" || path === "/client.css") {
      res.setHeader("content-type", path.endsWith("js") ? "text/javascript" : "text/css");
      res.end(await fs.readFile(new URL(`../dist${path}`, import.meta.url)));
      return;
    }
    if (path === "/events" || path.endsWith("/logs")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": open\n\n");
      return;
    }
    if (path.endsWith("/streamAvcc")) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.flushHeaders();
      req.on("close", () => streamClosures.push(path));
      return;
    }
    if (path.endsWith("/streamMjpeg") || path.endsWith("/screenshot")) {
      const device = devices.find((device) => path.startsWith(`/${device.device}/`));
      res.setHeader("content-type", "image/svg+xml");
      res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="${device.config.width}" height="${device.config.height}">
        <rect width="100%" height="100%" fill="#273749"/>
        <text x="40" y="100" fill="white" font-size="60">${device.name}</text></svg>`);
      return;
    }
    res.setHeader("content-type", "application/json");
    const data = path === "/api" ? state : path === "/grid" ? {
      devices: devices.map((device) => ({ serial: device.device, model: device.name, state: "device", attached: true })),
      avds: [],
    } : path === "/event-log" ? [] : { ok: true, result: { snapshots: [] } };
    res.end(JSON.stringify(data));
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => ws.on("message", (data) => {
    messages.push({
      device: req.url.split("/")[1],
      tag: data[0],
      body: data.length > 1 ? JSON.parse(data.subarray(1).toString()) : null,
    });
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  const close = async () => {
    await browser?.close();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport, hasTouch: true });
    const page = await context.newPage();
    page.setDefaultTimeout(5_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => document.querySelector(".device .chip-status.live"));
    return { page, browser, messages, requests, streamClosures, errors, wss, close };
  } catch (error) {
    await close();
    throw error;
  }
}
