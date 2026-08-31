import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

process.env.NODE_ENV = "test";
const { app } = await import("./index.js");

async function req(body) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "" : JSON.stringify(body),
  });
  const text = await res.text();
  server.close();
  await once(server, "close");
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test("returns 200 with a token on valid credentials", async () => {
  const r = await req({ username: "admin", password: "hunter2" });
  assert.equal(r.status, 200);
  assert.ok(typeof r.body?.token === "string");
});

test("returns 400 when password missing", async () => {
  // This is the failing test that captures the bug. Currently server
  // returns 500 because auth.js calls .toLowerCase() on undefined.
  const r = await req({ username: "admin" });
  assert.equal(r.status, 400);
  assert.equal(r.body?.error, "validation failed");
  assert.equal(r.body?.field, "password");
});
