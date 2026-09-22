import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

process.env.NODE_ENV = "test";
const { app } = await import("./index.js");

async function get(path) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await res.json();
  server.close();
  await once(server, "close");
  return { status: res.status, body };
}

test("GET /users returns all users (no filter)", async () => {
  const r = await get("/users");
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 4);
});
