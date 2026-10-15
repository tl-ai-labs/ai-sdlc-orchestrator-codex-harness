/**
 * The agent door's usage depends on the Antigravity SDK version: the pin in
 * requirements.txt must name a version whose reading has been checked, and
 * setup warns when the built environment holds a different one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluate, pinnedSdkVersion, DEFAULT_POLICY } from "../../plugin/codex/verify-setup.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER = join(ROOT, "plugin", "mcp", "model-dispatch");
const REQUIREMENTS = join(SERVER, "worker", "requirements.txt");
const WORKER_PROCESS = join(SERVER, "dist", "delegation", "workerProcess.js");

const AGENT = {
  nodeMajor: 22,
  codexCli: { present: true, version: [0, 151, 0] },
  codexLogin: { loggedIn: true },
  hasNodeModules: true,
  hasDist: true,
  env: { OPENAI_API_KEY: "sk-x", GEMINI_API_KEY: "g-x", MMO_SELECT: "gemini-flash=flash-agsdk-worker" },
  vertex: { state: "credential" },
  policy: { name: DEFAULT_POLICY, selected: true, path: "/p.yaml", usesOpenAiKey: true },
};

const worker = (over) => ({ hasVenv: true, sdkImportable: true, detail: null, ...over });

test("requirements.txt pins one exact google-antigravity version", () => {
  const pin = pinnedSdkVersion(readFileSync(REQUIREMENTS, "utf8"));
  assert.match(pin ?? "", /^\d+\.\d+\.\d+$/, "a floor lets a new venv install an SDK whose usage reading nobody checked");
});

test("the pinned version is one whose usage reading is known", { skip: !existsSync(WORKER_PROCESS) && "server not built" }, async () => {
  const { AGY_USAGE_SEMANTICS } = await import(WORKER_PROCESS);
  const pin = pinnedSdkVersion(readFileSync(REQUIREMENTS, "utf8"));
  assert.ok(pin in AGY_USAGE_SEMANTICS, `raise the pin only after adding ${pin} to AGY_USAGE_SEMANTICS`);
});

test("pinnedSdkVersion reads only an exact pin", () => {
  assert.equal(pinnedSdkVersion("# c\ngoogle-antigravity==0.1.16\n"), "0.1.16");
  assert.equal(pinnedSdkVersion("google-antigravity>=0.1.7\n"), null);
  assert.equal(pinnedSdkVersion(""), null);
});

test("a worker environment on another SDK version is a warning that --fix rebuilds", () => {
  const state = evaluate({ ...AGENT, agentWorker: worker({ sdkVersion: "0.1.18", pinnedVersion: "0.1.16" }) });
  const p = state.problems.find((x) => x.id === "agent-worker-sdk-version");
  assert.ok(p, "the version mismatch must be reported");
  assert.equal(p.severity, "warning", "an unchecked version only over-reports, so it does not block");
  assert.match(p.message, /0\.1\.18/);
  assert.match(p.message, /0\.1\.16/);
  assert.match(p.fix, /--fix/);
  assert.equal(state.ok, true);
});

test("with GEMINI_WORKER_PYTHON set, the version fix names that interpreter, not --fix", () => {
  const state = evaluate({
    ...AGENT,
    agentWorker: worker({ sdkVersion: "0.1.18", pinnedVersion: "0.1.16", pythonOverride: "/opt/py/bin/python3" }),
  });
  const p = state.problems.find((x) => x.id === "agent-worker-sdk-version");
  assert.match(p.fix, /\/opt\/py\/bin\/python3 -m pip install google-antigravity==0\.1\.16/);
  assert.match(p.fix, /unset GEMINI_WORKER_PYTHON/, "--fix rebuilds the plugin's .venv, which this interpreter is not");
});

test("a worker environment on the pinned version raises no version problem", () => {
  const state = evaluate({ ...AGENT, agentWorker: worker({ sdkVersion: "0.1.16", pinnedVersion: "0.1.16" }) });
  assert.equal(state.problems.find((x) => x.id === "agent-worker-sdk-version"), undefined);
});

test("an unreadable installed version is reported against the pin", () => {
  const state = evaluate({ ...AGENT, agentWorker: worker({ sdkVersion: null, pinnedVersion: "0.1.16" }) });
  assert.match(state.problems.find((x) => x.id === "agent-worker-sdk-version").message, /version unreadable/);
});

// ── a failed session still leaves its usage behind ───────────────────

const WORKER = join(SERVER, "worker", "gemini_worker.py");

test("the worker writes its sidecar for a session that timed out or failed, before exiting non-zero", () => {
  const src = readFileSync(WORKER, "utf8");
  assert.match(src, /except asyncio\.TimeoutError:/, "a timeout must be caught inside the session, not lost with it");
  assert.match(src, /agent\.conversation\.total_usage/, "a failed session's usage comes from the conversation total");
  assert.match(src, /"status": status/, "the sidecar must say whether the session finished");
  assert.match(src, /"usage_source": usage_source/);
  const write = src.indexOf("json.dump(");
  const fail = src.indexOf("return 1", write);
  assert.ok(write > 0 && fail > write, "the sidecar is written before the failure exit");
  assert.doesNotMatch(src, /"cost_usd"/, "pricing stays on the server");
});

// The real worker, run by a real Python against a stand-in google.antigravity
// package, so the failure path is exercised without the SDK or a network.

const PYTHON = ["python3", "python"].find((p) => spawnSync(p, ["--version"]).status === 0);

const FAKE_SDK = {
  "google/__init__.py": "",
  "google/antigravity/__init__.py": `
import asyncio, os
from . import types

class LocalAgentConfig:
    def __init__(self, **kw):
        self.kw = kw

class _Conversation:
    @property
    def total_usage(self):
        if os.environ.get("FAKE_NO_TOTAL") == "1":
            raise RuntimeError("no conversation usage")
        return {"prompt_token_count": 7000, "cached_content_token_count": 0, "candidates_token_count": 40, "thoughts_token_count": 0}

class _Response:
    async def resolve(self):
        if os.environ.get("FAKE_MODE") == "raise":
            raise ValueError("400 INVALID_ARGUMENT")
        await asyncio.sleep(float(os.environ.get("FAKE_SLEEP", "0")))
    async def text(self):
        return '{"ok": true}'
    @property
    def usage_metadata(self):
        return {"prompt_token_count": 100, "cached_content_token_count": 0, "candidates_token_count": 5, "thoughts_token_count": 0}
    @property
    def tool_calls(self):
        async def gen():
            if False:
                yield None
        return gen()

class Agent:
    def __init__(self, cfg):
        self.conversation = _Conversation()
    async def __aenter__(self):
        if os.environ.get("FAKE_AENTER") == "raise":
            raise RuntimeError("could not start the session")
        return self
    async def __aexit__(self, *exc):
        if os.environ.get("FAKE_AEXIT") == "raise":
            raise RuntimeError("teardown failed")
        return False
    def chat(self, task):
        return _Response()
`,
  "google/antigravity/types.py": `
class _Any:
    def __init__(self, *a, **kw):
        pass
ModelTarget = VertexEndpoint = GeminiModelOptions = _Any
class ModelType:
    TEXT = "TEXT"
class ThinkingLevel:
    HIGH = "HIGH"
    LOW = "LOW"
`,
  "google/antigravity/hooks/__init__.py": "",
  "google/antigravity/hooks/policy.py": "def allow_all():\n    return None\n",
};

function runWorker(env) {
  const dir = mkdtempSync(join(tmpdir(), "gemini-worker-"));
  try {
    for (const [rel, text] of Object.entries(FAKE_SDK)) {
      mkdirSync(dirname(join(dir, "sdk", rel)), { recursive: true });
      writeFileSync(join(dir, "sdk", rel), text);
    }
    mkdirSync(join(dir, "work"));
    writeFileSync(join(dir, "task.md"), "do the thing");
    const usageFile = join(dir, "usage.json");
    const r = spawnSync(
      PYTHON,
      [WORKER, "--task-file", join(dir, "task.md"), "--model", "m", "--region", "global", "--workdir", join(dir, "work"),
        "--out-dir", dir, "--usage-file", usageFile, "--timeout", "1"],
      { encoding: "utf8", env: { PATH: process.env.PATH, PYTHONPATH: join(dir, "sdk"), PYTHONNOUSERSITE: "1", GOOGLE_CLOUD_PROJECT: "p", ...env } },
    );
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, sidecar: existsSync(usageFile) ? JSON.parse(readFileSync(usageFile, "utf8")) : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a finished session exits 0, prints its reply and records the response usage", { skip: !PYTHON && "no python" }, () => {
  const r = runWorker({});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"ok": true/);
  assert.equal(r.sidecar.status, "ok");
  assert.equal(r.sidecar.usage_source, "response.usage_metadata");
  assert.equal(r.sidecar.usage.prompt_token_count, 100);
});

test("a session past its deadline writes a timeout sidecar with the conversation's usage and exits 1", { skip: !PYTHON && "no python" }, () => {
  const r = runWorker({ FAKE_SLEEP: "5" });
  assert.equal(r.status, 1);
  assert.equal(r.sidecar.status, "timeout");
  assert.equal(r.sidecar.error_type, "TimeoutError");
  assert.equal(r.sidecar.usage_source, "conversation.total_usage");
  assert.equal(r.sidecar.usage.prompt_token_count, 7000);
  assert.match(r.stderr, /did not finish within 1s/);
});

test("a session the SDK fails records the error class, and says when usage could not be read", { skip: !PYTHON && "no python" }, () => {
  const r = runWorker({ FAKE_MODE: "raise", FAKE_NO_TOTAL: "1" });
  assert.equal(r.status, 1);
  assert.equal(r.sidecar.status, "error");
  assert.equal(r.sidecar.error_type, "ValueError");
  assert.equal(r.sidecar.usage, null);
  assert.match(r.sidecar.usage_error, /no conversation usage/);
});

test("a session whose teardown raises still writes its sidecar, so its usage is billed", { skip: !PYTHON && "no python" }, () => {
  const r = runWorker({ FAKE_AEXIT: "raise" });
  assert.equal(r.status, 1, "a teardown failure is not a clean finish");
  assert.equal(r.sidecar.status, "error");
  assert.equal(r.sidecar.error_type, "RuntimeError");
  assert.match(r.sidecar.error, /teardown failed/);
  assert.equal(r.sidecar.usage_source, "response.usage_metadata", "the usage read inside the session survives");
  assert.equal(r.sidecar.usage.prompt_token_count, 100);
});

test("a timed-out session whose teardown raises keeps the timeout and the conversation's usage", { skip: !PYTHON && "no python" }, () => {
  const r = runWorker({ FAKE_SLEEP: "5", FAKE_AEXIT: "raise" });
  assert.equal(r.status, 1);
  assert.equal(r.sidecar.status, "timeout");
  assert.match(r.sidecar.error, /did not finish within 1s; then the session teardown failed: RuntimeError/);
  assert.equal(r.sidecar.usage.prompt_token_count, 7000);
});

test("a session that never started leaves no sidecar", { skip: !PYTHON && "no python" }, () => {
  const r = runWorker({ FAKE_AENTER: "raise" });
  assert.equal(r.status, 1);
  assert.equal(r.sidecar, null, "nothing was sent, so the adapter books $0");
  assert.match(r.stderr, /could not start the session/);
});
