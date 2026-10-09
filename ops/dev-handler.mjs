// Deployment-specific routes share the middleware's authentication boundary.
export function createDevHandler(middleware, serials, attached, { discoverAll = false } = {}) {
  if (!middleware.auth) throw new Error("Native authentication is required");
  const pathFor = (req) => (req.url ?? "/").split("?")[0];
  const helperOf = (path) =>
    serials.find((s) => path.startsWith(`/helper/${encodeURIComponent(s)}/`));
  const allowed = (path) =>
    path === "/" ||
    path === "/api" ||
    path === "/api/event-log" ||
    path === "/api/event-log/events" ||
    Boolean(helperOf(path));

  async function handleRequest(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (middleware.handleShare?.(req, res)) return;
    if (await middleware.auth.handle(req, res)) return;
    const path = pathFor(req);
    if (path === "/grid/api" && discoverAll) {
      middleware(req, res);
      return;
    }
    if (path === "/grid/api") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          devices: [...attached].map((s) => ({
            serial: s,
            state: "device",
            model: "Android TV",
            isEmulator: true,
            attached: true,
          })),
          avds: [],
        }),
      );
      return;
    }
    if (!allowed(path)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "This service is restricted to its configured emulator.",
        }),
      );
      return;
    }
    middleware(req, res);
  }
  return (req, res) => {
    void handleRequest(req, res).catch(() => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "service_unavailable" }));
    });
  };
}
