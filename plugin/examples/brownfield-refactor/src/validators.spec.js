import { test } from "node:test";
import assert from "node:assert/strict";
import { signup } from "./signup.js";
import { invite } from "./invite.js";

test("signup accepts valid email", () => {
  assert.ok(signup("foo@example.com", "12345678"));
});
test("signup rejects invalid email", () => {
  assert.throws(() => signup("not-an-email", "12345678"), /invalid email/);
});
test("invite accepts valid email", () => {
  assert.ok(invite("bar@example.com", 1));
});
test("invite rejects invalid email", () => {
  assert.throws(() => invite("nope", 1), /invalid email/);
});
