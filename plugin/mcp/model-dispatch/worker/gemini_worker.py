"""gemini_worker.py — one subprocess per delegated call, launched by the MCP
server's AntigravityWorkerAdapter. Runs Gemini as an AGENT via
`google-antigravity`: given a task and a working directory, explores the
directory, runs shell commands, and edits files itself.

Only the Gemini path is served; the SDK's Anthropic path returns tool results
as `assistant` messages, which the Anthropic API rejects with 400.

Contract:
  --task-file PATH   task description
  --model NAME       SDK model id (supplied by the policy leaf; no worker default)
  --region NAME      OPTIONAL Vertex location. When given it WINS over
                     GOOGLE_CLOUD_LOCATION (see LOCATION precedence below).
  --workdir PATH     the only directory the worker may act in
  --out-dir PATH     usage sidecar + SDK save dir
  --usage-file PATH  sidecar this worker WRITES (see _project_tool_call for shape)
  --thinking LEVEL   HIGH|MEDIUM|LOW|NONE
  --timeout SECONDS  hard cap on resolve() (default 540)

Cost is NOT computed here. Token counts are recorded raw; dollars applied by
the server against the policy leaf's rates.
"""
from __future__ import annotations

import argparse
import asyncio
import inspect
import json
import os
import sys

import google.antigravity as ag
from google.antigravity import types
from google.antigravity.hooks import policy

# SDK identity, recorded into every sidecar. Wrapped because the dist name
# can be absent in an editable install — degrade to "unknown", never fail
# the call over evidence.
try:
    from importlib.metadata import version as _dist_version
    SDK_VERSION = _dist_version("google-antigravity")
except Exception:
    SDK_VERSION = "unknown"
SDK_NAME = "google-antigravity"

# NO DEFAULTS for project or region. A default project silently bills someone
# else; a default region silently sends tokens to the wrong place.
#
# REGION PRECEDENCE: --region > GOOGLE_CLOUD_LOCATION > hard error. The flag
# outranks the env because the policy leaf declares the region and the
# manifest records it — if the env could win, the receipt and the actual call
# could disagree with no artifact contradicting either. Some models are served
# `global` only and return 404 elsewhere, so this matters concretely.
PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT")
LOCATION = os.environ.get("GOOGLE_CLOUD_LOCATION")


async def _maybe(v):
    # ChatResponse methods may be sync or awaitable across SDK versions.
    return await v if inspect.isawaitable(v) else v


# Prior value of 50 was binding on live delegated calls (some sat exactly at 50
# with receipts reading as complete). resp.resolve() drains the whole stream
# before _drain iterates, so the cap saves no allocation — only bounds runaway.
TOOL_CALL_CAP = 1000

# Per-arg character ceiling. A create_file call carries an entire file body;
# what landed is on disk. The receipt needs the SHAPE (which tool, path,
# command), not the payload.
ARG_VALUE_CAP = 2000


async def _drain(gen, cap=TOOL_CALL_CAP):
    # .tool_calls is an ASYNC GENERATOR (not a property). Returns
    # (items, truncated); a list at the cap must SAY it hit the cap, or a
    # count of 1000 reads as a measurement when it's really "1000 or more".
    out = []
    truncated = False
    try:
        async for item in gen:
            out.append(item)
            if len(out) >= cap:
                truncated = True
                break
    except Exception:
        pass
    return out, truncated


def _project_tool_call(tc):
    """One ToolCall reduced to what a reader needs.

    A bare `tool_call_count` cannot answer "which files did it touch" or
    "what commands did it run"; the projection can.

    Every arg value is stringified and clipped at ARG_VALUE_CAP so the
    consumer never has to type-switch and a file body can't blow up the
    receipt. `args_clipped` marks it, mirroring `tool_calls_truncated` at
    list level.
    """
    d = tc.model_dump(mode="json") if hasattr(tc, "model_dump") else dict(tc)
    args, clipped = {}, False
    for k, v in (d.get("args") or {}).items():
        s = v if isinstance(v, str) else json.dumps(v, default=str)
        if len(s) > ARG_VALUE_CAP:
            s, clipped = s[:ARG_VALUE_CAP], True
        args[k] = s
    return {
        "name": d.get("name"),
        "args": args,
        "canonical_path": d.get("canonical_path"),
        "args_clipped": clipped,
    }


def _thinking_level(name):
    name = (name or "NONE").upper()
    if name in ("", "NONE"):
        return None
    # getattr, not a module-level dict — referencing an unknown ThinkingLevel
    # member at import time would crash the whole worker.
    level = getattr(types.ThinkingLevel, name, None)
    if level is None:
        raise SystemExit(f"gemini_worker: unknown --thinking level {name!r}")
    return level


async def run(args):
    with open(args.task_file, encoding="utf-8") as f:
        task = f.read()

    thinking = _thinking_level(args.thinking)
    opts = types.GeminiModelOptions(thinking_level=thinking) if thinking else None

    # Bound ONCE and used for endpoint, agent config, and sidecar so region
    # in the call and region in the receipt cannot drift.
    location = args.region or LOCATION
    if not location:
        raise SystemExit(
            "gemini_worker: no Vertex region. Pass --region (the policy leaf's "
            "`region:`) or set GOOGLE_CLOUD_LOCATION. This worker pins no "
            "default because a wrong region is a silent billing and 404 hazard."
        )
    if not PROJECT:
        raise SystemExit(
            "gemini_worker: no Vertex project. Set GOOGLE_CLOUD_PROJECT to the "
            "project your application default credentials are authorised for. "
            "This worker pins no default because a wrong project bills the "
            "wrong account."
        )
    os.environ["GOOGLE_CLOUD_PROJECT"] = PROJECT
    os.environ["GOOGLE_CLOUD_LOCATION"] = location

    cfg = ag.LocalAgentConfig(
        model=types.ModelTarget(
            name=args.model, types=[types.ModelType.TEXT],
            endpoint=types.VertexEndpoint(
                project=PROJECT, location=location, options=opts),
        ),
        vertex=True, project=PROJECT, location=location,
        policies=[policy.allow_all()],
        workspaces=[args.workdir],
        save_dir=os.path.join(args.out_dir, "_gemini_worker_save"),
    )

    text, usage, tool_calls, tool_calls_truncated = "", None, [], False
    async with ag.Agent(cfg) as agent:
        resp = await _maybe(agent.chat(task))
        await asyncio.wait_for(_maybe(resp.resolve()), timeout=args.timeout)
        try:
            text = await _maybe(resp.text())
        except Exception as e:  # never lose usage over a text error
            text = f"<worker text() error: {type(e).__name__}: {e}>"
        tool_calls, tool_calls_truncated = await _drain(resp.tool_calls)
        u = await _maybe(resp.usage_metadata)
        usage = u.model_dump() if hasattr(u, "model_dump") else (dict(u) if u else None)

    # cost_usd deliberately absent — priced by the server, never here.
    with open(args.usage_file, "w", encoding="utf-8") as f:
        json.dump({
            "model": args.model,
            "thinking": (args.thinking or "NONE").upper(),
            "sdk": SDK_NAME,
            "sdk_version": SDK_VERSION,
            "vertex_project": PROJECT,
            "vertex_location": location,
            "usage": usage,
            "tool_call_count": len(tool_calls),
            "tool_calls_truncated": tool_calls_truncated,
            "tool_calls": [_project_tool_call(tc) for tc in tool_calls],
            "text": text,
        }, f, indent=2)

    print(text)  # caller reads the reply on stdout


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--task-file", required=True)
    p.add_argument("--model", required=True)
    # Optional; when passed it WINS over GOOGLE_CLOUD_LOCATION.
    p.add_argument("--region", default=None)
    p.add_argument("--workdir", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--usage-file", required=True)
    p.add_argument("--thinking", default="NONE")
    p.add_argument("--timeout", type=int, default=540)
    args = p.parse_args()
    try:
        asyncio.run(run(args))
    except Exception as e:
        print(f"gemini_worker failed: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
