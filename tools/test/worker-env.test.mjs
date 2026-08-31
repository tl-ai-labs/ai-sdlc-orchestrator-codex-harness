/**
 * Python worker's PROJECT and REGION contract. The worker must have NO
 * default for either — a default project silently bills the wrong account
 * and a default region silently sends tokens to the wrong datacentre (some
 * models are `global`-only, so wrong region is also 404).
 *
 * .mjs (not .py) so `node --test` picks it up. Reads the worker source and
 * asserts precedence rules; no Python required.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKER = join(ROOT, "plugin", "mcp", "model-dispatch", "worker", "gemini_worker.py");
const source = () => readFileSync(WORKER, "utf8");

test("the worker pins no region of its own and refuses when nobody supplies one", () => {
  const src = source();
  // Asserted as ABSENCE of a default, not merely presence of a refusal: a
  // `os.environ.get("GOOGLE_CLOUD_LOCATION", "asia-south1")` reintroduced by a
  // well-meaning edit would make the refusal below unreachable and route a
  // stranger's traffic to Mumbai without anything failing.
  assert.match(
    src,
    /^LOCATION = os\.environ\.get\("GOOGLE_CLOUD_LOCATION"\)$/m,
    "the region regained a hardcoded default — it must come from the policy or the environment"
  );
  assert.match(
    src,
    /if not location:\s*\n\s*raise SystemExit\(/,
    "the worker no longer refuses to run without a region"
  );
});

test("the worker pins no project of its own and refuses when nobody supplies one", () => {
  const src = source();
  // Same shape, higher stakes: a wrong region wastes a run, a wrong project
  // bills someone else. The published worker must never name a project.
  assert.match(
    src,
    /^PROJECT = os\.environ\.get\("GOOGLE_CLOUD_PROJECT"\)$/m,
    "the project regained a hardcoded default — it must come from the environment"
  );
  assert.match(
    src,
    /if not PROJECT:\s*\n\s*raise SystemExit\(/,
    "the worker no longer refuses to run without a project"
  );
  assert.doesNotMatch(
    src,
    /ai-studies-console/,
    "the worker names a specific Google Cloud project — it must not carry one"
  );
});

test("gemini_worker accepts a --region that outranks GOOGLE_CLOUD_LOCATION", () => {
  const src = source();
  // Declared, and declared OPTIONAL. Required would remove the operator's
  // ability to retarget a one-off invocation with an export instead of editing
  // a policy; the refusal above is what covers the "neither was supplied" case.
  assert.match(
    src,
    /add_argument\("--region", default=None\)/,
    "gemini_worker no longer accepts --region"
  );
  // The precedence itself, in the one line that encodes it. `args.region or
  // LOCATION` is the whole contract: flag wins, environment is the fallback.
  assert.match(
    src,
    /location = args\.region or LOCATION/,
    "the --region flag no longer takes precedence over the environment"
  );
});

test("the worker's sidecar records the region it USED, not the one it inherited", () => {
  const src = source();
  // The exact bug that made the original defect invisible: the sidecar wrote
  // the module-level constant — the ambient GOOGLE_CLOUD_LOCATION — so the
  // receipt agreed with the environment no matter where the call actually went.
  // Asserted as ABSENCE of the constant as well as presence of the resolved
  // variable, because a receipt that can only ever echo its environment is
  // worse than no receipt: the report prices the call off `vertex_location`,
  // so a wrong value there is a dollars error presented as a measurement.
  assert.match(
    src,
    /"vertex_location": location\b/,
    "the sidecar stopped recording the resolved location"
  );
  assert.doesNotMatch(
    src,
    /"vertex_location": LOCATION\b/,
    "the sidecar records the ambient environment again, not the location actually used"
  );
});

test("the endpoint, the agent config and the sidecar all read ONE resolved region", () => {
  const src = source();
  // The failure this prevents is subtler than "wrong region": three call sites
  // each resolving independently would drift apart under a later edit, and the
  // artifact would then describe an endpoint the call never reached. Binding it
  // once and passing it is what makes the sidecar admissible as evidence.
  assert.match(
    src,
    /VertexEndpoint\([^)]*location=location/s,
    "the Vertex endpoint stopped using the resolved location"
  );
  assert.match(
    src,
    /vertex=True, project=PROJECT, location=location/,
    "the agent config stopped using the resolved location"
  );
  assert.match(
    src,
    /os\.environ\["GOOGLE_CLOUD_LOCATION"\] = location/,
    "the resolved region is no longer exported for SDK internals that read the environment"
  );
});

test("the worker pins no model — the policy leaf supplies it", () => {
  const src = source();
  // The server dispatches whatever `model_name` the selected policy leaf
  // declares. A model literal appearing in the worker would mean a run could
  // report one model in its manifest and bill another, the same class of
  // silent divergence the region cases above exist to prevent.
  assert.match(src, /add_argument\("--model", required=True\)/, "--model stopped being required");
  // Assignment specifically, so prose in the docstring may still name a model
  // as an example. What must never appear is a model id BOUND to a name the
  // code can then use as a fallback.
  assert.doesNotMatch(
    src,
    /=\s*["']gemini-[0-9]/,
    "the worker binds a Gemini model id — the policy leaf must supply it"
  );
});

test("the worker records which SDK and version actually served the call", () => {
  const src = source();
  // Without these the artifacts prove "a Gemini model answered" but not "the
  // Antigravity SDK is what reached it" — which is the whole claim this
  // adapter exists to make. Read from the installed distribution rather than a
  // constant, so an upgraded environment reports the new number by itself.
  assert.match(src, /_dist_version\("google-antigravity"\)/, "the SDK version is no longer read from the install");
  assert.match(src, /"sdk": SDK_NAME/, "the sidecar stopped naming the SDK");
  assert.match(src, /"sdk_version": SDK_VERSION/, "the sidecar stopped recording the SDK version");
});

test("the worker computes no dollar cost", () => {
  const src = source();
  // Prices live on the policy leaf and are applied by the server. A rate
  // hardcoded in the worker is a number nobody re-checks against the vendor's
  // published rates, which is how a run comes to report a confident wrong cost.
  // Matched as the QUOTED sidecar key, so the comment that explains the
  // omission may keep naming the field it is explaining.
  assert.doesNotMatch(src, /"cost_usd"/, "the worker started emitting a cost — pricing belongs to the server");
});
