/**
 * Build script — bundles the CLI, the middleware (ESM + CJS), and the browser
 * preview client into `dist/`. Run with `node build.mjs` (or `npm run build`).
 */
import * as esbuild from "esbuild";
import { writeFileSync, chmodSync, mkdirSync, readFileSync } from "fs";

mkdirSync("dist", { recursive: true });

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const fontCss = [["IBM Plex Sans", "ibm-plex-sans", [400, 500, 600]], ["IBM Plex Mono", "ibm-plex-mono", [400, 500]]]
  .flatMap(([family, file, weights]) => weights.map(weight => {
    const data = readFileSync(`src/client/fonts/${file}-${weight}.woff2`).toString("base64");
    return `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${data}) format("woff2")}`;
  })).join("\n");
const define = { __SERVE_AVD_VERSION__: JSON.stringify(pkg.version), __AUTH_FONT_CSS__: JSON.stringify(fontCss) };

const nodeCommon = {
  platform: "node",
  target: "node18",
  bundle: true,
  sourcemap: false,
  logLevel: "info",
  define,
  // Keep real dependencies external — they're declared in package.json.
  external: ["ws", "commander", "better-sqlite3", "@node-rs/argon2"],
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

mkdirSync("dist/font-licenses", { recursive: true });
for (const family of ["ibm-plex-sans", "ibm-plex-mono"]) {
  writeFileSync(`dist/font-licenses/${family}-OFL.txt`, readFileSync(`src/client/fonts/${family}-OFL.txt`));
}

// Embed the supplied design's fonts so the preview also works offline and behind Access.
writeFileSync("dist/client.css", fontCss + "\n" + ["client.css", "inspector.css", "workspace-remote.css", "logcat.css"].map(name => readFileSync(`src/client/${name}`, "utf8")).join("\n"));

console.log("build complete");
