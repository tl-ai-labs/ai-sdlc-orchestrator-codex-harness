import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

test("loadConfig deep-merges overrides into defaults", () => {
  const c = loadConfig({ server: { port: 8080 } });
  assert.equal(c.server.port, 8080);
  assert.equal(c.server.host, "0.0.0.0");     // preserved from defaults
  assert.equal(c.logging.level, "info");      // untouched section preserved
});

test("loadConfig returns a fresh object each call", () => {
  const a = loadConfig();
  a.server.port = 9999;
  const b = loadConfig();
  assert.equal(b.server.port, 3000);
});
