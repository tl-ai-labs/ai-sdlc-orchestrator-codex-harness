/**
 * The write hook's decision for one Codex tool call. plugin/codex/hooks/write-contract-check.mjs reads the call from
 * stdin and replies with what decideCall returns; the rule order is in docs/architecture.md §7.
 */
import { lstatSync, mkdirSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { abandonCommand } from "./contract-commands.mjs";
import { CREATABLE_WHEN_ABSENT, firstMatch, hardcodedHit } from "./off-limits.mjs";
import {
  CONTRACT_REL_PATH, DECISIONS_REL_PATH, FROZEN_FILE, LOCK_FILE, appendRegular, contractTampered, gitRoot, liveLock,
  readContractBytes, readLock,
} from "./contract-lock.mjs";
import { isRunId } from "./run-id.mjs";
import { MAX_DEPTH, scanShell } from "./shell-scan.mjs";

export const WIRED_BY_RUN_FLAG = "--wired-by=run";

const SCOPE_IS_THE_PERSONS =
  "A wider scope is the person's decision, for a new run with its own Gate 0: stop and tell the person which path is needed and why.";

/** A held project whose run is over (a killed session never closes its lock) is freed by the person, with this. */
const endingIsThePersons = (runId, root) =>
  `If run ${runId} is no longer running, ending it is the person's decision: ${abandonCommand(runId, root)}`;

/** A refusal a live run causes, with the command that ends the run when its id is known. */
const endable = (message, runId, root) => (runId && root ? `${message} ${endingIsThePersons(runId, root)}` : message);

const CROSS_PROJECT = "Cross-project writes are refused: a brownfield run writes only inside the repo whose contract it holds.";

// ── what a call writes ──────────────────────────────────────────────────────

/** `*** Add File:` / `Update File:` / `Delete File:` / `Move to:` headers of an apply_patch call. */
export function extractApplyPatchTargets(command) {
  if (typeof command !== "string") return [];
  const targets = [];
  const headerRe = /^\*\*\*\s*(Add File|Update File|Delete File|Move to):\s*(.+)$/gm;
  let m;
  while ((m = headerRe.exec(command)) !== null) {
    const path = m[2].trim();
    if (path) targets.push(path);
  }
  return targets;
}

// ── what a shell command writes ────────────────────────────────────────────

/**
 * The text a call carries: a Bash `command` string, or an argv array quoted back into one shell line; for
 * `apply_patch`, its `command` or its `input`.
 */
export function callCommand(call) {
  const input = call?.tool_input;
  const patch = call?.tool_name === "apply_patch";
  for (const c of patch ? [input?.command, input?.input] : [input?.command]) {
    if (typeof c === "string") return c;
    if (Array.isArray(c) && c.length > 0 && c.every((a) => typeof a === "string")) {
      return patch ? c.join("\n") : c.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    }
  }
  return null;
}

let lastScan = { raw: null, effects: [] };
function effects(raw) {
  if (typeof raw !== "string") return [];
  if (lastScan.raw !== raw) lastScan = { raw, effects: scanShell(raw) };
  return lastScan.effects;
}

/** Device files a redirect writes to without touching the project (`2>/dev/null`). */
const DEVICE_RE = /^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/;

/**
 * Write targets of a shell command: redirects, `tee`, `touch`, each file a `cp`/`mv` lands on, and the file headers of
 * an `apply_patch` run through the shell (Codex applies it itself and hands the hook a Bash call). The command is
 * split as the shell splits it (plugin/scripts/lib/shell-scan.mjs); a form the scan misses is allowed. With `cwd`, an
 * existing folder named as a `cp`/`mv` destination or source is seen as one.
 */
export function extractBashTargets(command, cwd = null) {
  return bashWriteTargets(command, cwd).files.filter((t) => !DEVICE_RE.test(t));
}

/** Folders a `cp`/`mv` copies a whole directory into without the hook listing its files: judged as any file inside. */
export function extractBashFolders(command, cwd = null) {
  return bashWriteTargets(command, cwd).folders;
}

/** The file headers of an `apply_patch` run through the shell: literal paths, not shell words. */
export function shellPatchTargets(command) {
  return effects(command).filter((e) => e.kind === "patch").flatMap((e) => extractApplyPatchTargets(e.text));
}

const CP_RECURSIVE_RE = /^-[A-Za-z]*[rRa]|^--(?:recursive|archive)$/;
/** A folder copy past this many entries is judged as its destination folder alone. */
const MAX_LISTED = 1000;
const folderish = (w) => w.endsWith("/") || /(?:^|\/)\.\.?$/.test(w);
const under = (dir, name) => `${dir === "/" ? "" : dir.replace(/\/+$/, "")}/${name}`;

/** Files under the folder `dir` (links not followed), as paths relative to it, or null past `limit` entries or unreadable. */
function listFiles(dir, limit = MAX_LISTED) {
  const out = [];
  let seen = 0;
  const walk = (abs, rel) => {
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      if (++seen > limit) return false;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!e.isDirectory()) out.push(r);
      else if (!walk(join(abs, e.name), r)) return false;
    }
    return true;
  };
  return walk(dir, "") ? out : null;
}

/**
 * Where one `cp`/`mv` writes. A destination that ends in `/`, is an existing folder or takes several sources receives
 * `<dest>/<source name>`; `dir/.` copies the folder's contents, and `dir/` may do either (BSD and GNU differ), so both
 * places are judged. A folder source's own files are listed and judged one by one; one the hook cannot list goes to
 * `folders`.
 */
function copyTargets(tool, flags, args, cwd) {
  if (args.length < 2) return { files: args, folders: [] };
  const recursive = tool === "mv" || flags.some((a) => CP_RECURSIVE_RE.test(a));
  const dest = args[args.length - 1];
  const sources = args.slice(0, -1);
  const into = sources.length > 1 || folderish(dest) || (!!cwd && isLiteralWord(dest) && isDir(joinRaw(cwd, dest)));
  const files = [];
  const folders = [];
  for (const src of sources) {
    const contents = /(?:^|\/)\.\.?\/*$/.test(src);
    const slash = !contents && src.endsWith("/");
    const name = basename(src.replace(/\/+$/, ""));
    const lands = !into || contents ? [dest] : slash ? [dest, under(dest, name)] : [under(dest, name)];
    const literal = isLiteralWord(src);
    const srcAbs = cwd ? joinRaw(cwd, src) : null;
    const folder = contents || slash || (literal && !!srcAbs && isDir(srcAbs));
    if (!folder && (literal || !recursive)) { files.push(...lands); continue; }
    const listed = folder && literal && srcAbs && isDir(srcAbs) ? listFiles(srcAbs) : null;
    if (listed) {
      for (const at of lands) files.push(...listed.map((f) => under(at, f)));
      continue;
    }
    folders.push(...lands);
    if (!folder) files.push(...lands);
  }
  return { files, folders };
}

function bashWriteTargets(raw, cwd = null) {
  const files = [];
  const folders = [];
  for (const e of effects(raw)) {
    if (e.kind === "patch") files.push(...extractApplyPatchTargets(e.text));
    else if (e.kind === "write" && !e.tight) files.push(e.path);
    else if (e.kind === "copy") {
      const copied = copyTargets(e.tool, e.flags, e.args, cwd);
      files.push(...copied.files);
      folders.push(...copied.folders);
    }
  }
  return { files, folders };
}

/**
 * Redirects written with no space before the operator (`echo hi>.env`). Unquoted code such as `x=$(f)>y` reads the
 * same way, so these are judged against the always-off-limits list and the guarded set only.
 */
export function extractBashTightRedirects(raw) {
  return effects(raw).filter((e) => e.kind === "write" && e.tight && !DEVICE_RE.test(e.path)).map((e) => e.path);
}

/** Whether a shell command nests text past what the scan reads, so what it writes is unknown. */
export const unreadShell = (raw) => effects(raw).some((e) => e.kind === "unread");

const UNREAD_MESSAGE =
  `The command nests command substitutions or shells more than ${MAX_DEPTH} levels deep, past what the write hook ` +
  `reads, so the hook cannot tell what it writes. Split it into simpler commands and try again.`;

/** Paths a shell command removes or moves away: `rm`/`unlink`/`git rm` arguments and `mv` sources. */
export function extractBashRemovals(raw) {
  return effects(raw).filter((e) => e.kind === "remove").map((e) => e.path);
}

/** Every write target the call names. A structured `file_path` is accepted for tools that carry one. */
export function extractTargets(call, cwd = call?.cwd ?? null) {
  if (call?.tool_name === "apply_patch") return extractApplyPatchTargets(callCommand(call));
  if (call?.tool_name === "Bash") return extractBashTargets(callCommand(call), cwd);
  const structured = call?.tool_input?.file_path ?? call?.tool_input?.path ?? call?.input?.file_path;
  return typeof structured === "string" && structured.length > 0 ? [structured] : [];
}

export function extractFolderTargets(call, cwd = call?.cwd ?? null) {
  return call?.tool_name === "Bash" ? extractBashFolders(callCommand(call), cwd) : [];
}

export function extractNarrowTargets(call, cwd = call?.cwd ?? null, strict = extractTargets(call, cwd)) {
  if (call?.tool_name !== "Bash") return [];
  const full = new Set(strict);
  return extractBashTightRedirects(callCommand(call)).filter((t) => !full.has(t));
}

export function extractRemovals(call) {
  return call?.tool_name === "Bash" ? extractBashRemovals(callCommand(call)) : [];
}

// ── paths through links ────────────────────────────────────────────────────

const names = (p) => p.split(sep === "\\" ? /[\\/]/ : "/").filter(Boolean);
const MAX_LINK_HOPS = 64;
const toPosix = (p) => p.split(sep).join("/");
/** `target` against `cwd` with its `..` kept for realPath. */
export const joinRaw = (cwd, target) => (isAbsolute(target) ? target : `${cwd.replace(/[\\/]+$/, "")}${sep}${target}`);

/**
 * A path with every link in it resolved, the last name included, also where the link's target does not exist yet: a
 * write through a dangling link creates the file the link names. A `..` applies to the folder reached so far, links
 * already followed, as the kernel applies it; `resolve()` would drop `l/..` before `l` is followed.
 */
export function realPath(p) {
  const given = isAbsolute(p) ? p : joinRaw(process.cwd(), p);
  const root = parse(given).root;
  let cur = root;
  let pending = names(given.slice(root.length));
  for (let hops = 0; pending.length > 0;) {
    const name = pending.shift();
    if (name === ".") continue;
    if (name === "..") { cur = dirname(cur); continue; }
    const next = join(cur, name);
    let link = null;
    try { if (lstatSync(next).isSymbolicLink()) link = readlinkSync(next); } catch { /* not there yet */ }
    if (link === null) { cur = next; continue; }
    if (++hops > MAX_LINK_HOPS) return resolve(given);
    if (isAbsolute(link)) cur = parse(link).root;
    pending = [...names(isAbsolute(link) ? link.slice(cur.length) : link), ...pending];
  }
  return cur;
}

const relPosix = (from, to) => toPosix(relative(from, to));
const outsideRel = (r) => r === ".." || r.startsWith("../") || isAbsolute(r);
const sameFolder = (a, b) => !!a && !!b && realPath(a) === realPath(b);

/**
 * `abs` relative to `root`, or null when outside. A second look with links resolved on both sides, because Codex gives
 * the session folder in its resolved form (/private/tmp/… on macOS) while a write path arrives as written (/tmp/…).
 */
export function insidePath(root, abs) {
  const asWritten = relPosix(root, abs);
  if (!outsideRel(asWritten)) return asWritten;
  const resolved = relPosix(realPath(root), realPath(abs));
  return outsideRel(resolved) ? null : resolved;
}

/** The paths a write is judged by inside `root`, as written and as resolved; `leaves` when the resolved one is outside. */
export function judgedPaths(root, abs) {
  const asWritten = insidePath(root, abs);
  const real = realPath(abs);
  const resolved = relPosix(realPath(root), real);
  if (outsideRel(resolved)) return { paths: asWritten ? [asWritten] : [], leaves: true, real };
  return { paths: [...new Set([asWritten ?? resolved, resolved])], leaves: false, real };
}

// ── a project's contract state ─────────────────────────────────────────────

/**
 * The contract state of the git project at `root`, or null when it has no contract and no live lock.
 * `binds`: active, and its run's lock (when it has one) not ended.
 */
export function projectState(root) {
  const live = liveLock(root);
  const bytes = readContractBytes(root);
  if (!live && !bytes) return null;
  let contract = null;
  try { contract = JSON.parse(bytes?.toString("utf8") ?? "null"); } catch { contract = null; }
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) contract = null;
  const runId = isRunId(contract?.run_id) ? contract.run_id : null;
  const lock = runId ? readLock(root, runId) : null;
  const binds = contract?.active === true && !lock?.ended_at;
  return { root, live, lock, contract, runId, binds, tampered: contractTampered(root, live) };
}

const RUN_RECORDS = [LOCK_FILE, FROZEN_FILE, "provenance.json"];
const RUN_RECORD_FOLDERS = ["skills", "backups"];

/**
 * The guarded file or folder `rel` names (compared without case), or null: the contract, and inside the run's own
 * folder the records the plugin keeps for it. With `containing`, a path that holds one of them (`rm -r .sdlc/runs/r1`).
 */
export function guardedHit(rel, runId, { containing = false } = {}) {
  const r = rel.toLowerCase().replace(/\/+$/, "");
  for (const g of guardedPaths(runId)) {
    if (r === g || r.startsWith(`${g}/`)) return g;
    if (containing && (r === "" || r === "." || g.startsWith(`${r}/`))) return g;
  }
  return null;
}

function guardedPaths(runId) {
  const guarded = [CONTRACT_REL_PATH];
  if (isRunId(runId)) {
    const base = `.sdlc/runs/${runId.toLowerCase()}`;
    guarded.push(...RUN_RECORDS.map((f) => `${base}/${f}`), ...RUN_RECORD_FOLDERS.map((f) => `${base}/${f}`));
  }
  return guarded;
}

// ── shell words the shell expands ──────────────────────────────────────────

const MAX_FORMS = 64;

/** The `{a,b}` alternatives of a word, or null past MAX_FORMS. A `{x..y}` range stands for any text. */
function expandBraces(word) {
  const out = [];
  const go = (w) => {
    if (out.length > MAX_FORMS) return;
    for (let i = w.indexOf("{"); i !== -1; i = w.indexOf("{", i + 1)) {
      let depth = 0;
      const commas = [];
      for (let j = i; j < w.length; j++) {
        if (w[j] === "{") depth++;
        else if (w[j] === "," && depth === 1) commas.push(j);
        else if (w[j] === "}" && --depth === 0) {
          if (!commas.length) break;
          const cuts = [i, ...commas, j];
          for (let k = 0; k + 1 < cuts.length; k++) go(w.slice(0, i) + w.slice(cuts[k] + 1, cuts[k + 1]) + w.slice(j + 1));
          return;
        }
      }
    }
    out.push(w.replace(/\{[^{}]*\.\.[^{}]*\}/g, "*"));
  };
  go(word);
  return out.length > MAX_FORMS ? null : out;
}

/**
 * The paths a shell word may name once the shell expands it: quotes and backslashes dropped, braces expanded, a
 * leading `~`, `$HOME` or `$TMPDIR` filled in, globs kept. Any other `$` or a backtick makes the rest unknown: the
 * form is `<prefix>/**`, cut at the last `/` before it, with `open` set. Without `open`, such forms are left out.
 */
export function wordForms(word, { open = true } = {}) {
  let w = String(word).replace(/\\(.)/g, "$1").replace(/['"]/g, "");
  w = w.replace(/^~(?=\/|$)/, () => homedir());
  w = w.replace(/^\$(?:\{(HOME|TMPDIR)\}|(HOME|TMPDIR)(?![A-Za-z0-9_]))/, (m, a, b) => {
    const v = process.env[a ?? b];
    return v && isAbsolute(v) ? v.replace(/\/+$/, "") : m;
  });
  const alts = expandBraces(w) ?? [`${w.slice(0, w.indexOf("{"))}$`];
  const forms = [];
  for (const f of alts) {
    const i = f.search(/[$`]/);
    if (i === -1) forms.push({ path: f, open: false });
    else if (open) {
      const cut = f.lastIndexOf("/", i);
      forms.push({ path: cut === -1 ? "**" : `${f.slice(0, cut)}/**`, open: true });
    }
  }
  return forms;
}

const GLOB_CHARS = /[*?[]/;

/** One name of a shell glob as a regex, without regard to case. A class it cannot read takes any name. */
function nameRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[" && glob.indexOf("]", i + 2) !== -1) {
      const close = glob.indexOf("]", i + 2);
      let body = glob.slice(i + 1, close);
      const negate = body[0] === "!" || body[0] === "^";
      if (negate) body = body.slice(1);
      re += `[${negate ? "^" : ""}${body.replace(/[\\\]]/g, "\\$&")}]`;
      i = close;
    } else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  try { return new RegExp(`^${re}$`, "i"); } catch { return /^/; }
}

const nameMatches = (glob, name) => (GLOB_CHARS.test(glob) ? nameRegex(glob).test(name) : glob === name);

/**
 * Whether a path pattern (names, `**` for any run of them) can name `target`, something below it, or with
 * `containing` a folder that holds it. Leading dots get no special case, so `*` takes `.sdlc` as GLOB_DOTS would.
 */
function reaches(pattern, target, containing) {
  const go = (i, j) => {
    if (i === pattern.length) return j === target.length || containing;
    if (j === target.length) return true;
    if (pattern[i] === "**") return go(i + 1, j) || go(i, j + 1);
    return nameMatches(pattern[i], target[j]) && go(i + 1, j + 1);
  };
  return go(0, 0);
}

/**
 * The guarded record a shell word that is not a literal path may reach, `{g, st, open}`, or null. A removal is judged
 * under a live lock as well as a binding contract; `containing` also takes a folder that holds a record.
 */
function guardedReach(word, cwd, sessionRoot, session, { containing = false, removal = false, open = true } = {}) {
  for (const form of wordForms(word, { open })) {
    const abs = joinRaw(cwd, form.path);
    const states = statesFor(abs, sessionRoot, session);
    if (session && !states.includes(session)) states.push(session);
    const patterns = [...new Set([resolve(abs), realPath(abs)])].map((p) => names(p.toLowerCase()));
    for (const st of states) {
      if (!st.binds && !(removal && st.live)) continue;
      if (!removal && st.contract?.strict === false && !st.lock) continue;
      const runId = st.binds ? st.runId : st.live?.run_id;
      for (const root of new Set([st.root, realPath(st.root)])) {
        for (const g of guardedPaths(runId)) {
          const target = names(`${root}/${g}`.toLowerCase());
          if (patterns.some((p) => reaches(p, target, containing))) return { g, st, open: form.open };
        }
      }
    }
  }
  return null;
}

/** The refusal of a removal that would take a record a live run keeps. */
const removalRefusal = (target, g, runId, root) =>
  `${target} would remove or move ${g}, which run ${runId ?? "?"} keeps while it is live. ` +
  `${runId ? endingIsThePersons(runId, root) : "Ending a run is the person's decision."} Stop and tell the person.`;

function reachRefusal(target, hit, removal) {
  const runId = (hit.st.binds ? hit.st.runId : hit.st.live?.run_id) ?? null;
  const what = `${hit.g}, which run ${runId ?? "?"} keeps while it is live`;
  const deny = hit.open
    ? `${target} names a path the hook cannot read before the shell expands it (a variable or a command substitution), ` +
      `and it may reach ${what}. Write the path out in full and try again.`
    : removal
      ? removalRefusal(target, hit.g, runId, hit.st.root)
      : `${target} may expand to ${what} (the write contract, or the run's lock, frozen copy, rendered skills, ` +
        `provenance or backups). ${SCOPE_IS_THE_PERSONS}`;
  return { deny, rule: hit.g, state: hit.st };
}

const statusOf = (st) => ({ root: st.root, run_id: st.runId ?? st.live?.run_id ?? null, binds: st.binds });

/** A word that names one path as it stands: no `~` or `=` expansion, variable, command substitution, glob or quote left. */
export const isLiteralWord = (w) => typeof w === "string" && w.length > 0 && !/^[~=]/.test(w) && !/[$`*?[\]{}\\'"]/.test(w);

const absent = (p) => { try { lstatSync(p); return false; } catch (e) { return e?.code === "ENOENT"; } };

/**
 * Whether a missing `.env`-family fixture may be created at `target`, with nothing at it now. Only where the hook knows
 * the folder the write lands in: an `apply_patch` Add File, whose paths Codex resolves against the payload's `cwd`, or
 * a shell target that is a literal absolute path once its quotes are resolved. A relative shell path may land
 * elsewhere: the shell tool's `workdir` is not in the payload, and a `cd` can hide inside a quoted `sh -c '…'`.
 */
function mayCreateWhenAbsent(call, target, cwd) {
  if (!isLiteralWord(target)) return false;
  if (call?.tool_name === "apply_patch") {
    return addFileTargets(callCommand(call)).includes(target) && absent(joinRaw(cwd, target));
  }
  return call?.tool_name === "Bash" && isAbsolute(target) && absent(target);
}

function addFileTargets(command) {
  if (typeof command !== "string") return [];
  return [...command.matchAll(/^\*\*\*\s*Add File:\s*(.+)$/gm)].map((m) => m[1].trim()).filter(Boolean);
}

/** The always-off-limits pattern `path` hits, or null. With no binding contract a missing `.env`-family fixture may be created. */
function hardRefusal(path, binds, mayCreate) {
  const hit = hardcodedHit(path);
  if (!hit) return null;
  if (!binds && mayCreate && CREATABLE_WHEN_ABSENT.includes(path.slice(path.lastIndexOf("/") + 1).toLowerCase())) return null;
  return hit;
}

const hardMessage = (target, hit, runId) =>
  `${target} matches always-off-limits pattern "${hit}"${runId ? ` (run ${runId})` : ""}: secrets, Codex's own config, ` +
  `git's store and the conductor's skills are never written or removed by a tool call, with or without a contract. ` +
  `Stop and tell the person which file and why.`;

/** Stands for any file of a folder copied in whole: no pattern names it, and every `*` or `**` takes it. */
const ANY_FILE = "\u0000";
/** Names in a folder that the always-off-limits list refuses by name alone (`.codex/config.toml`). */
const HARD_FILE_NAMES = ["config.toml", "auth.json"];

/** hardRefusal for a path, and for a `folder` also for any file in it. */
function hardFor(path, binds, mayCreate, folder) {
  const hit = hardRefusal(path, binds, mayCreate);
  if (hit || !folder) return hit;
  const base = path.replace(/\/+$/, "");
  return [ANY_FILE, ...HARD_FILE_NAMES].map((n) => hardcodedHit(base ? `${base}/${n}` : n)).find(Boolean) ?? null;
}

/** One binding or non-binding project's answer for one path inside it; a `folder` is judged as any file in it too. */
function verdict(st, rel, mayCreate, narrow, folder = false) {
  const c = st.contract;
  const runId = st.runId;
  const file = folder ? (rel ? `${rel}/${ANY_FILE}` : ANY_FILE) : rel;
  const shown = folder ? `${rel || "."}/ (a folder copied in whole)` : rel;
  if (st.binds) {
    const g = guardedHit(rel, runId, { containing: folder });
    if (g) {
      if (c.strict === false && !st.lock) return { warn: `${shown} is the run's own write contract. Allowed because contract.strict = false.` };
      return {
        deny: `${shown} is run ${runId ?? "?"}'s write contract or a record the plugin keeps for it (its lock, frozen copy, ` +
          `rendered skills, provenance or backups), which a live run does not change. ${SCOPE_IS_THE_PERSONS}`,
        rule: g,
      };
    }
  }
  const hard = hardFor(rel, st.binds, mayCreate, folder);
  if (hard) return { deny: hardMessage(shown, hard, runId), rule: hard };
  if (!st.binds || narrow) return {};
  if (runId && file.startsWith(`.sdlc/runs/${runId}/`)) return {};
  const off = firstMatch(file, c.off_limits, { ci: true });
  if (off) {
    if (c.strict === false) return { warn: `${shown} matches off-limits pattern "${off}". Allowed because contract.strict = false.` };
    const deny = `${shown} matches off-limits pattern "${off}" (run ${runId ?? "?"}). ${SCOPE_IS_THE_PERSONS}`;
    return { deny: endable(deny, runId, st.root), rule: off };
  }
  if (firstMatch(file, c.allowlist)) return {};
  if (c.strict === false) return { warn: `${shown} is not in the confirmed allowlist. Allowed because contract.strict = false.` };
  const other = /^\.sdlc\/runs\/([^/]+)\//.exec(file)?.[1];
  if (other && runId && other !== runId) {
    return {
      deny: `${shown} is in run ${other}'s folder, but run ${runId} still holds this project's write contract. ` +
        `${endingIsThePersons(runId, st.root)} Stop and tell the person.`,
    };
  }
  return { deny: endable(`${shown} is not in the confirmed allowlist for run ${runId ?? "?"}. ${SCOPE_IS_THE_PERSONS}`, runId, st.root) };
}

function decide(st, abs, target, mayCreate, narrow, folder = false) {
  if (st.tampered) return { deny: st.tampered, rule: "tampered" };
  const { paths, leaves, real } = judgedPaths(st.root, abs);
  if (leaves) {
    if (st.binds && !narrow) {
      const deny = `${target} leads OUTSIDE the contract's repo root (${st.root}) through a link. ${CROSS_PROJECT}`;
      return { deny: endable(deny, st.runId, st.root) };
    }
    const hit = hardFor(toPosix(real), st.binds, mayCreate, folder);
    if (hit) return { deny: hardMessage(target, hit), rule: hit };
  }
  const warns = [];
  for (const rel of paths) {
    const v = verdict(st, rel, mayCreate, narrow, folder);
    if (v.deny) return { ...v, rel };
    if (v.warn) warns.push(v.warn);
  }
  return { warns, rel: paths[0] };
}

// ── one call ────────────────────────────────────────────────────────────────

function statesFor(abs, sessionRoot, session) {
  const roots = [];
  for (const r of [gitRoot(dirname(abs)), gitRoot(dirname(realPath(abs)))]) {
    if (r && !roots.some((x) => sameFolder(x, r))) roots.push(r);
  }
  const states = roots.map((r) => (sameFolder(r, sessionRoot) ? session : projectState(r)));
  // A target in a nested git project inside the session's project answers to the session's contract as well.
  if (session && !roots.some((r) => sameFolder(r, sessionRoot)) && insidePath(sessionRoot, abs) !== null) states.push(session);
  return states.filter(Boolean);
}

/**
 * `narrow`: a target the scan is unsure of, judged by the always-off-limits list, the guarded set and tampering only.
 * `folder`: a folder a whole directory is copied into, judged as the folder and as any file in it. `shellWord`: the
 * target is a word the shell expands, not a literal path, so a glob or variable in it is judged against the guarded set.
 */
function checkWrite(target, cwd, sessionRoot, session, { mayCreate = false, narrow = false, folder = false, shellWord = false } = {}) {
  const abs = joinRaw(cwd, target);
  if (!narrow && session && (session.binds || session.tampered) && insidePath(sessionRoot, abs) === null) {
    if (session.tampered) return { deny: session.tampered, rule: "tampered", state: session };
    const deny = `${abs} resolves OUTSIDE the calling session's contracted repo (${sessionRoot}). ${CROSS_PROJECT}`;
    return { deny: endable(deny, session.runId, sessionRoot), state: session };
  }
  if (shellWord && !isLiteralWord(target)) {
    const hit = guardedReach(target, cwd, sessionRoot, session, { containing: folder, open: !narrow });
    if (hit) return reachRefusal(target, hit, false);
  }
  const deciding = statesFor(abs, sessionRoot, session);
  if (deciding.length === 0) {
    for (const p of new Set([toPosix(resolve(abs)), toPosix(realPath(abs))])) {
      const hit = hardFor(p, false, mayCreate, folder);
      if (hit) return { deny: hardMessage(target, hit), rule: hit, root: gitRoot(dirname(abs)) ?? sessionRoot };
    }
    return { bound: [] };
  }
  const warns = [];
  const bound = [];
  for (const st of deciding) {
    const v = decide(st, abs, target, mayCreate, narrow, folder);
    if (v.deny) return { ...v, state: st };
    warns.push(...v.warns);
    if (st.binds) bound.push({ ...statusOf(st), target, abs, rel: v.rel });
  }
  return { warns, bound };
}

/** A refusal, or `{bound}`: each binding contract the removal falls under, for the provenance snapshot. */
function checkRemoval(target, cwd, sessionRoot, session) {
  if (!isLiteralWord(target)) {
    const hit = guardedReach(target, cwd, sessionRoot, session, { containing: true, removal: true });
    if (hit) return reachRefusal(target, hit, true);
  }
  const abs = joinRaw(cwd, target);
  const candidates = statesFor(abs, sessionRoot, session);
  if (session && !candidates.includes(session)) candidates.push(session);
  const bound = [];
  for (const st of candidates) {
    const runId = st.binds ? st.runId : st.live?.run_id;
    if (!st.binds && !st.live) continue;
    for (const rel of judgedPaths(st.root, abs).paths) {
      const g = guardedHit(rel, runId, { containing: true });
      if (g) {
        return { deny: removalRefusal(target, g, runId, st.root), rule: g, state: st };
      }
    }
    if (st.binds && insidePath(st.root, abs) !== null) bound.push({ ...statusOf(st), target, abs });
  }
  const hard = hardRemoval(target, cwd);
  if (hard) {
    const st = candidates.find((s) => s.binds || s.live) ?? null;
    return { deny: hardMessage(target, hard.hit, st ? statusOf(st).run_id : null), rule: hard.hit, state: st, root: hard.root ?? sessionRoot };
  }
  return { bound };
}

/** Folders a glob in a removal is tried as: one of them anywhere on the path holds always-off-limits files. */
const HARD_FOLDERS = [".git", ".agents", ".codex"];
/** Names a glob in a removal is tried as: each is, or holds, an always-off-limits file. */
const HARD_NAMES = [...HARD_FOLDERS, ".env", ".env.local", ".mcp.json", ...HARD_FILE_NAMES];

/** A name the glob matches, each `*`, `?` and class filled in, or null. */
function sampleName(glob) {
  let s = "";
  for (let i = 0; i < glob.length; i++) {
    const close = glob[i] === "[" ? glob.indexOf("]", i + 2) : -1;
    if (glob[i] === "*" || glob[i] === "?") s += "x";
    else if (close !== -1) {
      const body = glob.slice(i + 1, close);
      s += body[0] === "!" || body[0] === "^" ? "_" : body[0];
      i = close;
    } else s += glob[i];
  }
  return nameRegex(glob).test(s) ? s : null;
}

function listNames(dir) {
  try { return readdirSync(dir).slice(0, MAX_LISTED); } catch { return []; }
}

/**
 * The names a glob name is tried as: each of `names` it matches, each always-off-limits name in the folder `inside`
 * it matches, and one name of its own (`.env.p*` as `.env.px`). A glob takes a dot name only when it starts with a
 * dot, as the shell's globbing does.
 */
function globNames(glob, names, inside = null) {
  const re = nameRegex(glob);
  const takes = (n) => (glob.startsWith(".") || !n.startsWith(".")) && re.test(n);
  const hard = (n) => n.startsWith(".") && (!!hardcodedHit(n) || HARD_FOLDERS.includes(n.toLowerCase()));
  const present = inside && glob.startsWith(".") ? listNames(inside).filter(hard) : [];
  return [...new Set([...names, ...present].filter(takes).concat(sampleName(glob) ?? []))];
}

/**
 * The paths a removal word may name, for the always-off-limits list; a variable or substitution is left out. A glob
 * folder on the way takes the first of HARD_FOLDERS it matches, since one is enough for a hit.
 */
function removalForms(word, cwd) {
  if (isLiteralWord(word)) return [word];
  const out = [];
  for (const { path } of wordForms(word, { open: false })) {
    const parts = path.split("/");
    const last = parts.pop();
    if (!GLOB_CHARS.test(path)) { out.push(path); continue; }
    const dirs = parts.map((p) => (GLOB_CHARS.test(p) ? globNames(p, HARD_FOLDERS)[0] ?? p : p));
    const prefix = path.slice(0, path.length - last.length);
    const inside = parts.some((p) => GLOB_CHARS.test(p)) ? null : joinRaw(cwd, prefix || ".");
    const lasts = GLOB_CHARS.test(last) ? globNames(last, HARD_NAMES, inside) : [last];
    for (const n of lasts) out.push([...dirs, n].join("/"));
  }
  return out;
}

/** The always-off-limits pattern a removal hits, by the name itself or a file in the folder it removes, or null. */
function hardRemoval(target, cwd) {
  for (const form of removalForms(target, cwd)) {
    const abs = joinRaw(cwd, form);
    // rm takes the name it is given, not what a link of that name points to.
    const at = join(realPath(dirname(abs)), basename(abs));
    const root = gitRoot(dirname(at));
    const rels = root ? [relPosix(root, abs), relPosix(realPath(root), at)].filter((r) => !outsideRel(r)) : [];
    for (const p of rels.length ? rels : [toPosix(at)]) {
      const hit = hardFor(p, true, false, true);
      if (hit) return { hit, root };
    }
  }
  return null;
}

/**
 * The hook's answer for one tool call: `{ decision, reason, warnings, record, bound, folders, unsure, removed }`.
 * `record` is where the decision log row goes, or null (no binding contract, and for a refusal no `.sdlc/` folder to
 * write into). `bound` lists each allowed write a binding contract judged, `folders` each folder a whole directory is
 * copied into under one, `unsure` each redirect with no space before the `>` under one, and `removed` each path a shell
 * removal names under one.
 */
export function decideCall(call, { wiredBy = "plugin" } = {}) {
  const cwd = typeof call?.cwd === "string" && call.cwd ? call.cwd : process.cwd();
  const sessionRoot = gitRoot(cwd);
  const session = sessionRoot ? projectState(sessionRoot) : null;
  const toolName = typeof call?.tool_name === "string" ? call.tool_name : null;
  // One scan of a shell command: a folder copy lists the folder's files.
  const shell = toolName === "Bash" ? bashWriteTargets(callCommand(call), cwd) : null;
  const targets = shell ? shell.files.filter((t) => !DEVICE_RE.test(t)) : extractTargets(call, cwd);
  const folderTargets = shell?.folders ?? [];
  const patched = new Set(shell ? shellPatchTargets(callCommand(call)) : []);
  const row = (decision, extra) => ({ decision, tool_name: toolName, wired_by: wiredBy, ...extra });

  const warnings = [];
  const bound = [];
  const folders = [];
  const removed = [];
  let refusal = shell && unreadShell(callCommand(call))
    ? { deny: UNREAD_MESSAGE, rule: "unread", state: session, root: sessionRoot, target: null }
    : null;
  for (const target of refusal ? [] : targets) {
    const v = checkWrite(target, cwd, sessionRoot, session, {
      mayCreate: mayCreateWhenAbsent(call, target, cwd), shellWord: !!shell && !patched.has(target),
    });
    if (v.deny) { refusal = { ...v, target }; break; }
    warnings.push(...v.warns ?? []);
    bound.push(...v.bound);
  }
  if (!refusal) {
    for (const target of folderTargets) {
      const v = checkWrite(target, cwd, sessionRoot, session, { folder: true, shellWord: true });
      if (v.deny) { refusal = { ...v, target }; break; }
      warnings.push(...v.warns ?? []);
      folders.push(...v.bound);
    }
  }
  const unsure = [];
  if (!refusal) {
    for (const target of extractNarrowTargets(call, cwd, targets)) {
      const v = checkWrite(target, cwd, sessionRoot, session, {
        mayCreate: mayCreateWhenAbsent(call, target, cwd), narrow: true, shellWord: true,
      });
      if (v.deny) { refusal = { ...v, target }; break; }
      unsure.push(...v.bound);
    }
  }
  if (!refusal) {
    for (const target of extractRemovals(call)) {
      const v = checkRemoval(target, cwd, sessionRoot, session);
      if (v.deny) { refusal = { ...v, target }; break; }
      removed.push(...v.bound);
    }
  }

  if (refusal) {
    const st = refusal.state;
    const root = st?.root ?? refusal.root ?? null;
    const keep = !!root && (!!st?.binds || !!st?.live || isDir(join(root, ".sdlc")));
    return {
      decision: "deny",
      reason: refusal.deny,
      warnings,
      bound: [],
      folders: [],
      unsure: [],
      removed: [],
      record: keep ? {
        root,
        row: row("deny", {
          reason: refusal.deny, path: refusal.rel ?? refusal.target, run_id: st ? statusOf(st).run_id : null,
          matched_rule: refusal.rule ?? null,
        }),
      } : null,
    };
  }

  const binding = session?.binds ? statusOf(session) : bound[0] ?? folders[0] ?? null;
  const named = targets.length + folderTargets.length;
  return {
    decision: "allow",
    reason: null,
    warnings,
    bound,
    folders,
    unsure,
    removed,
    record: binding ? {
      root: binding.root,
      row: row("allow", {
        reason: named ? `${named} target(s) cleared` : "no write target in this call",
        path: bound[0]?.rel ?? folders[0]?.rel ?? null,
        run_id: binding.run_id,
      }),
    } : null,
  };
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** Appends a decision row under an existing `.sdlc/`. Best effort: a failure never changes the decision. */
export function recordDecision(record, now = new Date()) {
  if (!record?.root || !isDir(join(record.root, ".sdlc"))) return false;
  try {
    mkdirSync(join(record.root, ".sdlc", "local"), { recursive: true });
    return appendRegular(join(record.root, DECISIONS_REL_PATH), JSON.stringify({ ts: now.toISOString(), ...record.row }) + "\n");
  } catch {
    return false;
  }
}
