import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * True when the module at `moduleUrl` is the script node was started with.
 * import.meta.url is the real path while argv[1] keeps any symlink in the
 * path it was given (a symlinked plugin folder, /tmp on macOS), so both are
 * compared as real paths.
 */
export function isMain(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
