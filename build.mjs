/**
 * Build script — bundles the CLI, the middleware (ESM + CJS), and the browser
 * preview client into `dist/`. Run with `node build.mjs` (or `npm run build`).
 */
import * as esbuild from "esbuild";
import { copyFileSync, chmodSync, mkdirSync, readFileSync } from "fs";

mkdirSync("dist", { recursive: true });

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const define = { __SERVE_AVD_VERSION__: JSON.stringify(pkg.version) };

const nodeCommon = {
  platform: "node",
  target: "node18",
  bundle: true,
  sourcemap: false,
  logLevel: "info",
  define,
  // Keep real dependencies external — they're declared in package.json.
  external: ["ws", "commander"],
};

// CLI entry (ESM, executable).
await esbuild.build({
  ...nodeCommon,
  entryPoints: ["src/index.ts"],
  outfile: "dist/serve-avd.js",
  format: "esm",
  banner: { js: "#!/usr/bin/env node" },
});
chmodSync("dist/serve-avd.js", 0o755);

// Middleware — ESM.
await esbuild.build({
  ...nodeCommon,
  entryPoints: ["src/middleware.ts"],
  outfile: "dist/middleware.js",
  format: "esm",
});

// Middleware — CJS (for require() consumers like metro.config.js).
// `import.meta.url` doesn't exist under CJS; shim it so asset resolution works.
await esbuild.build({
  ...nodeCommon,
  entryPoints: ["src/middleware.ts"],
  outfile: "dist/middleware.cjs",
  format: "cjs",
  define: { ...define, "import.meta.url": "__importMetaUrl" },
  banner: {
    js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;",
  },
});

// Client SDK (`serve-avd/client`) — ESM + CJS, runtime-neutral (plain fetch).
await esbuild.build({
  entryPoints: ["src/sdk.ts"],
  outfile: "dist/sdk.js",
  platform: "neutral",
  target: ["es2022"],
  format: "esm",
  bundle: true,
  sourcemap: false,
  logLevel: "info",
  define,
});
await esbuild.build({
  entryPoints: ["src/sdk.ts"],
  outfile: "dist/sdk.cjs",
  platform: "node",
  target: "node18",
  format: "cjs",
  bundle: true,
  sourcemap: false,
  logLevel: "info",
  define,
});

// Browser preview client.
await esbuild.build({
  entryPoints: ["src/client/client.ts"],
  outfile: "dist/client.js",
  platform: "browser",
  target: ["chrome110", "safari16", "firefox115"],
  format: "iife",
  bundle: true,
  minify: true,
  sourcemap: false,
  logLevel: "info",
  define,
});

copyFileSync("src/client/client.css", "dist/client.css");

console.log("build complete");
