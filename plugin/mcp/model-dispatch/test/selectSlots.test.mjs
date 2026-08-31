/**
 * Select slots. Two invariants:
 *   1. Golden: with no selection made, opus-plus-flash resolves to exactly
 *      what it did before slots existed (same adapter, model, rates).
 *   2. Selections are obeyed only on phases the slot governs, and the
 *      routing decision carries a trace saying the run asked (not defaulted).
 *
 * Offline; policy loading, parsing, and pure routing only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadPolicy, getModel } from "../dist/policy.js";
import {
  pickModel,
  resolveNamed,
  parseSelectOverrides,
  validateSelectOverrides,
  simulatePolicyCost,
  unreachableModelIds,
} from "../dist/routing.js";

const ctx = (phase, task_type = "misc", module = "cross", retry_count = 0) => ({
  phase,
  task_type,
  module,
  retry_count,
});

/**
 * What every rule of opus-plus-flash routed to at v0.2.4, before slots existed.
 * Transcribed from that policy file, not from the current one — the point of a
 * golden is that it is written down independently of the thing it checks.
 */
const V024_OPUS = {
  adapter: "builtin-anthropic",
  model_name: "claude-opus-4-7",
  pricing: { input: 5.0, input_cached: 0.5, output: 25.0 },
};
const V024_FLASH = {
  adapter: "mcp:model-dispatch",
  model_name: "gemini-3.5-flash",
  pricing: { input: 1.5, input_cached: 0.15, output: 9.0 },
};

/** One context per rule in the shipped policy, with the leaf it must reach. */
const GOLDEN_ROUTES = [
  [ctx("requirements_analysis"), V024_OPUS],
  [ctx("architecture_design"), V024_OPUS],
  [ctx("plan_task_packets"), V024_OPUS],
  [ctx("senior_code_review"), V024_OPUS],
  [ctx("security_review"), V024_OPUS],
  [ctx("codegen", "controller_handler"), V024_FLASH],
  [ctx("codegen", "dto"), V024_FLASH],
  [ctx("codegen", "react_component"), V024_FLASH],
  [ctx("tests", "test_unit"), V024_FLASH],
  [ctx("docs", "readme"), V024_FLASH],
  [ctx("debug", "fix", "cross", 0), V024_FLASH],
  // Escalation rule: two mechanical attempts already failed.
  [ctx("debug", "fix", "cross", 2), V024_OPUS],
  // Anything unrecognised falls through to the policy's default.
  [ctx("refactor", "unknown_type"), V024_OPUS],
  [ctx("codegen", "a_task_type_no_rule_names"), V024_OPUS],
];

const shipped = () => loadPolicy({ policyName: "opus-plus-flash" });

test("with no selection, the shipped policy routes exactly as it did before slots existed", () => {
  const policy = shipped();
  for (const [context, expected] of GOLDEN_ROUTES) {
    const decision = pickModel(context, policy);
    const leaf = getModel(policy, decision.modelId);
    const where = `${context.phase}/${context.task_type}@retry${context.retry_count}`;
    assert.equal(leaf.adapter, expected.adapter, `adapter for ${where}`);
    assert.equal(leaf.model_name, expected.model_name, `model_name for ${where}`);
    assert.deepEqual(leaf.pricing, expected.pricing, `pricing for ${where}`);
  }
});

test("selecting the agent leaf moves the mechanical tier and nothing else", () => {
  const policy = shipped();
  const overrides = { "gemini-flash": "flash-agsdk-worker" };
  for (const [context, expected] of GOLDEN_ROUTES) {
    const decision = pickModel(context, policy, overrides);
    const leaf = getModel(policy, decision.modelId);
    const where = `${context.phase}/${context.task_type}@retry${context.retry_count}`;
    if (expected === V024_OPUS) {
      // The premium tier is named concretely by its rules, so a selection on
      // the mechanical slot cannot reach it. This is the assertion that would
      // catch a slot accidentally wired to every rule.
      assert.equal(leaf.adapter, "builtin-anthropic", `${where} must stay on Opus`);
      assert.equal(decision.selection, undefined, `${where} carries no selection`);
    } else {
      assert.equal(decision.modelId, "flash-agsdk-worker", where);
      assert.equal(leaf.adapter, "antigravity-worker", where);
      // Same model, same published rates — what changed is how it is reached.
      assert.equal(leaf.model_name, V024_FLASH.model_name, `${where} model_name`);
      assert.deepEqual(leaf.pricing, V024_FLASH.pricing, `${where} pricing`);
    }
  }
});

test("the decision records which slot resolved, to what, and whether the run asked", () => {
  const policy = shipped();

  const inherited = pickModel(ctx("tests", "test_unit"), policy);
  assert.deepEqual(inherited.selection, {
    slot: "gemini-flash",
    chosen: "flash-completion",
    overridden: false,
  });

  const asked = pickModel(ctx("tests", "test_unit"), policy, {
    "gemini-flash": "flash-agsdk-worker",
  });
  assert.deepEqual(asked.selection, {
    slot: "gemini-flash",
    chosen: "flash-agsdk-worker",
    overridden: true,
  });

  // Selecting the leaf that was already the default is still a deliberate act,
  // and is recorded as one. Otherwise a run that pinned the cheap tier on
  // purpose would be indistinguishable from one that never thought about it.
  const pinned = pickModel(ctx("tests", "test_unit"), policy, {
    "gemini-flash": "flash-completion",
  });
  assert.deepEqual(pinned.selection, {
    slot: "gemini-flash",
    chosen: "flash-completion",
    overridden: true,
  });
});

test("a policy with no slots resolves without consulting them", () => {
  // opus-only predates slots entirely. Its rules name a concrete leaf, so
  // resolution has to be a pass-through that leaves no trace behind — which is
  // what keeps every policy written before this change working untouched.
  const policy = loadPolicy({ policyName: "opus-only" });
  assert.equal(policy.select, undefined);
  const decision = pickModel(ctx("codegen", "dto"), policy);
  assert.equal(getModel(policy, decision.modelId).adapter, "builtin-anthropic");
  assert.equal(decision.selection, undefined);
});

test("the slot spec parses pairs, and treats unset and empty identically", () => {
  // Unset and empty must agree: which of the two a user ends up with depends on
  // whether the plugin route or the clone route installed the server, and the
  // routing outcome cannot depend on that.
  assert.deepEqual(parseSelectOverrides(undefined), {});
  assert.deepEqual(parseSelectOverrides(""), {});
  assert.deepEqual(parseSelectOverrides("   "), {});

  assert.deepEqual(parseSelectOverrides("gemini-flash=flash-agsdk-worker"), {
    "gemini-flash": "flash-agsdk-worker",
  });
  assert.deepEqual(parseSelectOverrides(" a=1 , b=2 "), { a: "1", b: "2" });
});

test("a malformed slot spec is refused, and the message quotes the offending text", () => {
  for (const bad of ["gemini-flash", "=flash-agsdk-worker", "gemini-flash="]) {
    assert.throws(
      () => parseSelectOverrides(bad),
      (err) => {
        assert.match(err.message, /Invalid select spec/);
        // Naming the exact fragment matters: the spec is comma-separated, so
        // "one of your pairs is wrong" would leave the user hunting.
        assert.ok(
          err.message.includes(bad.trim()),
          `message should quote '${bad}': ${err.message}`,
        );
        return true;
      },
      `'${bad}' should be rejected`,
    );
  }
});

test("choices are checked against the policy before the run, naming the legal values", () => {
  const policy = shipped();

  assert.throws(
    () => validateSelectOverrides(policy, { "no-such-slot": "flash-completion" }),
    (err) => {
      assert.match(err.message, /no such slot/);
      assert.match(err.message, /gemini-flash/); // lists what IS available
      return true;
    },
  );

  assert.throws(
    () => validateSelectOverrides(policy, { "gemini-flash": "flash-agsdk-wroker" }),
    (err) => {
      // The commonest failure is a typo, so the message has to show the real
      // spellings rather than only rejecting the wrong one.
      assert.match(err.message, /flash-completion/);
      assert.match(err.message, /flash-agsdk-worker/);
      return true;
    },
  );

  // The happy path is silent.
  validateSelectOverrides(policy, { "gemini-flash": "flash-agsdk-worker" });
  validateSelectOverrides(policy, {});
});

test("an unvalidated bad choice is refused at routing, not silently defaulted", () => {
  // Reachable only if a caller skipped validateSelectOverrides. Falling back to
  // the default here would produce a run that quietly used the cheap tier while
  // its operator believed they had asked for the agent — numbers labelled as
  // the wrong thing, which is worse than a crash.
  const policy = shipped();
  assert.throws(
    () => resolveNamed(policy, "gemini-flash", { "gemini-flash": "not-a-leaf" }),
    /not one of that slot's options/,
  );
});

test("a what-if simulation prices the tier this install would actually dispatch to", () => {
  const policy = shipped();
  const events = [
    {
      phase: "tests",
      task_type: "test_unit",
      module: "cross",
      retry_count: 0,
      input_tokens: 1_000_000,
      input_tokens_cached: 0,
      output_tokens: 0,
    },
  ];

  const asDefault = simulatePolicyCost(events, policy);
  assert.deepEqual(Object.keys(asDefault.per_model), ["flash-completion"]);

  const asAgent = simulatePolicyCost(events, policy, {
    "gemini-flash": "flash-agsdk-worker",
  });
  assert.deepEqual(Object.keys(asAgent.per_model), ["flash-agsdk-worker"]);

  // Same rates on both leaves, so a simulation that only swaps the door must
  // report the same money. If these ever diverge, one of the two pricing
  // blocks in the policy was edited without the other.
  assert.equal(asAgent.total_cost_usd, asDefault.total_cost_usd);
});

test("the shipped policy declares the agent leaf with everything the worker needs", () => {
  const policy = shipped();
  const leaf = getModel(policy, "flash-agsdk-worker");
  assert.equal(leaf.adapter, "antigravity-worker");
  // A worker session has no natural end, so an abandonment deadline is not
  // optional the way it is for a completion call.
  assert.equal(typeof leaf.worker_timeout_sec, "number");
  assert.ok(leaf.worker_timeout_sec > 0);
  // The doubling loop raises a ceiling WE chose; an agent session sets its own,
  // so declaring one here would describe a knob that does not exist.
  assert.equal(leaf.max_output_tokens_absolute, undefined);
  // The Antigravity SDK signs with Application Default Credentials and has no
  // API-key door, so naming a key env var would be a promise nothing keeps.
  assert.equal(leaf.auth, undefined);
});

/*
 * Reachability — which leaves pre-flight is allowed to touch.
 *
 * Pre-flight constructs an adapter for every model in the policy, on purpose:
 * adapter constructors are where a missing project id or a missing worker
 * script is supposed to fail, before any money is spent. That strictness is
 * correct for a policy whose leaves are all reachable, and wrong the moment a
 * policy holds two ways of reaching one tier — the option this run did NOT
 * choose cannot be dispatched to, so its prerequisites are not this run's
 * problem, and halting on them would ground every default install of
 * opus-plus-flash on a machine that has no Python.
 *
 * These tests are the guard on that: the losing option is excluded, and
 * nothing else ever is.
 */

test("with no selection made, the option the run cannot reach is excluded from pre-flight", () => {
  // The regression this function exists for. Before it, adding the agent leaf
  // to the shipped policy made every existing user's pre-flight construct an
  // AntigravityWorkerAdapter and halt on the absent virtualenv — a blocking
  // failure about a tier they never asked for and will never dispatch to.
  const policy = shipped();
  const unreachable = unreachableModelIds(policy);
  assert.deepEqual([...unreachable], ["flash-agsdk-worker"]);
});

test("selecting the agent flips which option is excluded", () => {
  const policy = shipped();
  const unreachable = unreachableModelIds(policy, { "gemini-flash": "flash-agsdk-worker" });
  assert.deepEqual([...unreachable], ["flash-completion"]);
});

test("a leaf the rules name directly is never excluded", () => {
  // Opus is not behind a slot, so no selection can make it unreachable. If it
  // ever were excluded, pre-flight would stop checking the credential that
  // every premium phase depends on.
  for (const overrides of [{}, { "gemini-flash": "flash-agsdk-worker" }]) {
    const unreachable = unreachableModelIds(shipped(), overrides);
    assert.equal(unreachable.has("opus"), false);
  }
});

test("a policy with no slots excludes nothing", () => {
  // Every policy written before slots existed. An empty set here is what keeps
  // pre-flight behaving for them exactly as it did.
  const policy = loadPolicy({ policyName: "opus-only" });
  assert.deepEqual([...unreachableModelIds(policy)], []);
  assert.deepEqual([...unreachableModelIds(policy, { "gemini-flash": "flash-agsdk-worker" })], []);
});

test("every leaf the shipped policy declares is either reachable or the loser of a slot", () => {
  // The exclusion has to stay narrow. If a future edit widened it, a real leaf
  // could drop out of pre-flight silently and its missing credential would
  // surface mid-run instead — this counts the leaves and pins the arithmetic.
  const policy = shipped();
  const unreachable = unreachableModelIds(policy);
  const reachable = policy.models.filter((m) => !unreachable.has(m.id));
  assert.equal(policy.models.length, reachable.length + unreachable.size);
  // One slot with two options means exactly one loser, whatever else the
  // policy grows later.
  assert.equal(unreachable.size, 1);
});
