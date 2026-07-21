/**
 * Tiny namespaced debug logger, enabled with `DEBUG=serve-avd*` (matches the
 * conventions of the `debug` package without the dependency).
 */
const pattern = process.env.DEBUG ?? "";
const enabled =
  pattern === "*" ||
  pattern
    .split(/[\s,]+/)
    .some((p) => p === "serve-avd" || p === "serve-avd*" || p === "serve-avd:*");

export function createDebug(scope: string): (...args: unknown[]) => void {
  if (!enabled) return () => {};
  return (...args: unknown[]) => {
    console.error(`\x1b[90m[serve-avd:${scope}]\x1b[0m`, ...args);
  };
}
