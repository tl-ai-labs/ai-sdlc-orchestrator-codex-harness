import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXIT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin", "scripts", "lib", "exit.mjs");

test("exitAfterFlush hands a piped reader everything written before the exit", () => {
  const size = 256 * 1024;
  const script = `import { exitAfterFlush } from ${JSON.stringify(EXIT)};
process.stdout.write("x".repeat(${size}));
process.stderr.write("y".repeat(${size}));
exitAfterFlush(3);`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", maxBuffer: 4 * size });
  assert.equal(r.status, 3);
  assert.equal(r.stdout.length, size);
  assert.equal(r.stderr.length, size);
});
