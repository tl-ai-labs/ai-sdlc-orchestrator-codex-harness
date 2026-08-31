/**
 * Regression tests for the server-side logger (src/log.ts). Pins: logfmt
 * encoding rules (docs/logging.md), level-resolution precedence, and that
 * setLevel actually gates emission. Cross-implementation parity against the
 * ESM twin (plugin/scripts/lib/log.mjs) lives in tools/test/logging.test.mjs
 * instead, since that test needs to run both without either importing the
 * other.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatLine, setLevel, getLevel, log } from "../dist/log.js";

test("formatLine: bare values pass through unquoted", () => {
  const line = formatLine("info", "route.decide", { model_id: "flash-completion", ok: true, n: 3 });
  assert.match(line, /^MMO: \S+ INFO {3}route\.decide model_id=flash-completion ok=true n=3$/);
});

test("formatLine: values needing quoting are double-quoted with escapes", () => {
  const line = formatLine("error", "dispatch.error", { message: 'line1\nline2\ttab "quoted" back\\slash' });
  assert.ok(line.includes('message="line1\\nline2\\ttab \\"quoted\\" back\\\\slash"'));
});

test("formatLine: null and undefined fields are omitted entirely, not printed as k=null", () => {
  const line = formatLine("info", "run.start", { a: "x", b: null, c: undefined, d: "y" });
  assert.ok(!line.includes("b="));
  assert.ok(!line.includes("c="));
  assert.ok(line.includes("a=x"));
  assert.ok(line.includes("d=y"));
});

test("formatLine: field order is insertion order, never sorted", () => {
  const line = formatLine("info", "phase.start", { zeta: "1", alpha: "2", mid: "3" });
  const idx = (k) => line.indexOf(`${k}=`);
  assert.ok(idx("zeta") < idx("alpha"));
  assert.ok(idx("alpha") < idx("mid"));
});

test("formatLine: event name must be a dotted lower_snake verb", () => {
  assert.throws(() => formatLine("info", "NotDotted", {}));
  assert.throws(() => formatLine("info", "no_dot_at_all", {}));
  assert.doesNotThrow(() => formatLine("info", "dispatch.attempt.retry", {}));
});

test("formatLine: level is upper-cased and column-padded to a fixed width", () => {
  const info = formatLine("info", "a.b", {});
  const error = formatLine("error", "a.b", {});
  const infoLevel = info.split(/\d{2}:\d{2}:\d{2}\.\d{3}Z /)[1].split("a.b")[0];
  const errorLevel = error.split(/\d{2}:\d{2}:\d{2}\.\d{3}Z /)[1].split("a.b")[0];
  assert.equal(infoLevel.length, errorLevel.length, "INFO and ERROR must occupy the same column width");
});

test("formatLine: prefix defaults to 'MMO: ' and honors MMO_LOG_PREFIX", () => {
  assert.ok(formatLine("info", "a.b", {}).startsWith("MMO: "));
  process.env.MMO_LOG_PREFIX = "TEST: ";
  try {
    assert.ok(formatLine("info", "a.b", {}).startsWith("TEST: "));
  } finally {
    delete process.env.MMO_LOG_PREFIX;
  }
});

test("setLevel gates emission: DEBUG is suppressed at the default info level", () => {
  setLevel("info");
  assert.equal(getLevel(), "info");
  const originalWrite = process.stderr.write;
  const lines = [];
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    log("debug", "adapter.construct", {});
    log("info", "phase.start", {});
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(lines.length, 1, "only the INFO line should have been emitted");
  assert.ok(lines[0].includes("phase.start"));
});

test("setLevel(trace) allows every level through", () => {
  setLevel("trace");
  const originalWrite = process.stderr.write;
  const lines = [];
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    for (const level of ["error", "warn", "info", "debug", "trace"]) {
      log(level, `${level}.event`, {});
    }
  } finally {
    process.stderr.write = originalWrite;
    setLevel("info");
  }
  assert.equal(lines.length, 5);
});

test("log() never writes to stdout", () => {
  setLevel("trace");
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let stdoutBytes = 0;
  process.stdout.write = (chunk) => { stdoutBytes += Buffer.byteLength(String(chunk)); return true; };
  process.stderr.write = () => true;
  try {
    log("info", "dispatch.start", { packet_id: "p1", secret_looking: "AKIAIOSFODNN7EXAMPLE" });
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    setLevel("info");
  }
  assert.equal(stdoutBytes, 0, "the logger must never write to stdout — it is the MCP JSON-RPC transport");
});

test("log() redacts secret-shaped values before they reach any sink", () => {
  setLevel("trace");
  const originalStderr = process.stderr.write;
  let captured = "";
  process.stderr.write = (chunk) => { captured += String(chunk); return true; };
  try {
    log("error", "dispatch.error", { message: "leaked key AKIAIOSFODNN7EXAMPLE here" });
  } finally {
    process.stderr.write = originalStderr;
  }
  assert.ok(!captured.includes("AKIAIOSFODNN7EXAMPLE"), "the raw secret must never reach the sink");
  assert.ok(captured.includes("[redacted:aws-access-key-id]"));
});
