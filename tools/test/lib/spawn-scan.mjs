/**
 * The source scan behind tools/test/offline.test.mjs. It reads call text with regexes and balanced brackets, not a
 * parser; a false positive is fixed by routing the call through codexSandbox() or withStandIns(). It does not follow a
 * command or script path built at run time, passed through an object property, or reached through require().
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";

const SPAWNER_NAMES = "spawnSync|spawn|execFileSync|execFile|execSync|exec|fork";
const SPAWNERS = new RegExp(`(?<![\\w$])(?:[A-Za-z_$][\\w$]*\\.)?(${SPAWNER_NAMES})\\s*\\(`, "g");
const SPAWNER_DEFAULT = new RegExp(`^(?:${SPAWNER_NAMES})\\b`);
const DIRECT_COMMAND = /(?<![.\w$])[A-Za-z_$][\w$]*\s*\(\s*(["'`])(?<what>codex|gcloud)\1\s*[,)]/g;
const MEMBER_COMMAND = new RegExp(
  `(?<![\\w$])[A-Za-z_$][\\w$]*\\.(?:${SPAWNER_NAMES})\\s*\\(\\s*(["'\`])(?<what>codex|gcloud)\\1\\s*[,)]`,
  "g",
);
const SHELL_COMMAND = /(?<![\w$])(?:[A-Za-z_$][\w$]*\.)?(?:execSync|exec)\s*\(\s*(["'`])(?<what>codex|gcloud)\s/g;
const SHELL_LINE = /^\s*(codex|gcloud)\s+\S/;
const STRING_LITERAL = /^(["'`])((?:\\.|(?!\1)[^\\\n])*)\1$/;
const EXPORTED_FUNCTION = /export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g;
const DEFAULT_BINARY = /(?:\?\?|\|\||(?<![=!<>])=)\s*(["'`])(codex|gcloud)\1/;
const COMMAND_VALUE = /^(?:(["'`])(codex|gcloud)\1|[^]*(?:\?\?|\|\|)\s*(["'`])(codex|gcloud)\3)$/;
// A script that names a `--codex-bin` (or `--gcloud-bin`) option, quoted or in its usage text, honours it.
const REDIRECT_FLAG = /(["'`])(?:--)?((?:codex|gcloud)-bin)\1|--((?:codex|gcloud)-bin)=/g;
const MAIN_GUARD = /process\.argv\[1\][^;{]{0,200}import\.meta\.url|import\.meta\.url[^;{]{0,200}process\.argv\[1\]/;
const CHILD_PROCESS = /(?:from|require\s*\()\s*(["'])(?:node:)?child_process\1/;
const STATIC_IMPORT = /(?:from|import)\s*(["'])([^"']+)\1/g;
const DYNAMIC_IMPORT = /(?<![\w$.])import\s*\(/g;
const TOKEN = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1|(?<![.\w$])([A-Za-z_$][\w$]*)/g;
// An identifier that is not a property access; a spread (`...env`) still counts.
const IDENTIFIER = /(["'`])(?:\\.|(?!\1)[^\\\n])*\1|(?<![\w$])(?<![^.]\.)([A-Za-z_$][\w$]*)/g;
const DECLARATION = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?![=>])/g;
const FUNCTION_KEYWORD = /(?<![\w$.])function\b\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(/g;
const ARROW_NAME = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?$/;
const DEFAULTED = /^([A-Za-z_$][\w$]*)\s*(?::\s*[A-Za-z_$][\w$]*\s*)?=(?![=>])\s*([^]*)$/;
const IMPORT_ALIAS = /\b([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/g;
const NAMESPACE_IMPORT = /import\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g;
const NOT_GIVEN = /^(?:undefined|void\s+0)$/;
const PATH_SET = /\bPATH\b["'`]?\]?\s*(?::|=(?!=))(?!\s*(["'`])\1)/;
const PROCESS_PATH = /(?<![.\w$])process\.env\s*(?:\.\s*PATH\b|\[\s*(["'`])PATH\1\s*\])\s*=(?!=)/g;

const escape = (name) => name.replace(/\$/g, "\\$");

// Brackets inside string literals are counted too; call text in these tests rarely holds one.
export function callText(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

function statementEnd(source, from) {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (--depth < 0) return i;
    } else if (ch === ";" && depth === 0) return i;
  }
  return source.length;
}

function listParts(list) {
  const parts = [];
  let depth = 0;
  let start = 1;
  for (let i = 1; i < list.length - 1; i++) {
    const ch = list[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(list.slice(start, list.length - 1));
  return parts.map((part) => part.trim()).filter(Boolean);
}

// Object keys are skipped: `{ PATH: dirs }` names `dirs`, not a variable called PATH.
function identifiersIn(text) {
  const names = new Map();
  for (const m of text.matchAll(IDENTIFIER)) {
    if (m[2] === undefined || names.has(m[2])) continue;
    const end = m.index + m[2].length;
    let before = m.index - 1;
    while (before >= 0 && /\s/.test(text[before])) before--;
    const isKey = /^\s*:/.test(text.slice(end, end + 40)) && (text[before] === "{" || text[before] === ",");
    if (!isKey) names.set(m[2], m.index);
  }
  return names;
}

const isDefinition = (source, index) => /function\s*\*?\s*$/.test(source.slice(Math.max(0, index - 40), index));

function declarations(source) {
  const found = new Map();
  for (const m of source.matchAll(DECLARATION)) {
    const start = m.index + m[0].length;
    const span = { at: m.index, start, end: statementEnd(source, start) };
    found.set(m[1], [...(found.get(m[1]) ?? []), span]);
  }
  return found;
}

function blocks(source) {
  const spans = [];
  const open = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "{") open.push(i);
    else if (source[i] === "}" && open.length) spans.push({ start: open.pop(), end: i + 1 });
  }
  return spans;
}

function openingBracket(source, close) {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    const ch = source[i];
    if (ch === ")" || ch === "]" || ch === "}") depth++;
    else if ((ch === "(" || ch === "[" || ch === "{") && --depth === 0) return i;
  }
  return -1;
}

function functionScopes(source) {
  const scopes = [];
  for (const m of source.matchAll(FUNCTION_KEYWORD)) {
    const open = m.index + m[0].length - 1;
    const params = callText(source, open);
    const body = open + params.length + /^\s*/.exec(source.slice(open + params.length))[0].length;
    if (source[body] !== "{") continue;
    const end = body + callText(source, body).length;
    scopes.push({ name: m[1] ?? null, params: new Set(identifiersIn(params).keys()), head: open, start: body, end });
  }
  for (const m of source.matchAll(/=>/g)) {
    let close = m.index - 1;
    while (close >= 0 && /\s/.test(source[close])) close--;
    let from = close;
    if (source[close] === ")") from = openingBracket(source, close);
    else while (from > 0 && /[\w$]/.test(source[from - 1])) from--;
    if (from < 0) continue;
    const params = source.slice(from, close + 1);
    const name = ARROW_NAME.exec(source.slice(Math.max(0, from - 80), from))?.[1] ?? null;
    let start = m.index + 2;
    while (/\s/.test(source[start] ?? "")) start++;
    const end = source[start] === "{" ? start + callText(source, start).length : statementEnd(source, start);
    scopes.push({ name, params: new Set(identifiersIn(params).keys()), head: from, start, end });
  }
  return scopes;
}

const pathSegments = (value) => value.split("/").filter((s) => s && s !== ".");

// `..` is kept: findScript resolves it against the test file's own folder.
function rawSegments(text, consts) {
  return [...text.matchAll(TOKEN)].flatMap((m) => (m[3] === undefined ? pathSegments(m[2]) : consts.get(m[3]) ?? []));
}

function containsRun(haystack, needle) {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((seg, j) => haystack[i + j] === seg)) return true;
  }
  return false;
}

// The last two segments are enough when the rest of the path comes from a const the scan cannot read.
function namesScript(segs, scriptSegs) {
  return containsRun(segs, scriptSegs) || (scriptSegs.length > 2 && containsRun(segs, scriptSegs.slice(-2)));
}

// The command and its arguments, without the options object, so an env value that names a script is not a run of it.
function commandArgs(text, method) {
  const parts = listParts(text);
  return (/^exec(?:Sync)?$/.test(method) ? parts.slice(0, 1) : parts.slice(0, 2))
    .filter((part) => !part.startsWith("{"))
    .join(", ");
}

// null when no default reaches codex or gcloud; else the option `keys` or the `position`al parameter a caller passes.
function overridesOf(source, open, reaches) {
  const signature = callText(source, open);
  const bodyOpen = source.indexOf("{", open + signature.length);
  const body = bodyOpen < 0 ? "" : callText(source, bodyOpen);
  const viaBinary = DEFAULT_BINARY.test(signature);
  const keys = [];
  let position = null;
  listParts(signature).forEach((part, index) => {
    const destructured = part.startsWith("{");
    for (const pair of destructured ? listParts(callText(part, 0)) : [part]) {
      const m = DEFAULTED.exec(pair);
      if (!m) continue;
      const [, name, value] = m;
      const fallback = value.trim();
      const runsTool = new RegExp(`(?<![.\\w$])${escape(name)}\\s*\\(\\s*(["'\`])(?:codex|gcloud)\\1`);
      const reached =
        DEFAULT_BINARY.test(`= ${fallback}`) ||
        (SPAWNER_DEFAULT.test(fallback) && (viaBinary || runsTool.test(body))) ||
        (/^[A-Za-z_$][\w$]*$/.test(fallback) && reaches(fallback));
      if (!reached) continue;
      if (destructured) keys.push(name);
      else position ??= { index, param: name };
    }
  });
  return keys.length || position ? { keys, position } : null;
}

// `runsOnImport` lists the scripts with no main-module guard, which run as soon as anything imports them.
export function outsideToolUsers(repoRoot) {
  const modules = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "dist", "test", "examples", ".venv"].includes(entry.name)) continue;
        walk(full);
      } else if (entry.name.endsWith(".mjs")) {
        modules.push({ path: relative(repoRoot, full).split(sep).join("/"), source: readFileSync(full, "utf8") });
      }
    }
  };
  walk(join(repoRoot, "plugin"));
  walk(join(repoRoot, "tools"));

  const scripts = [];
  const runsOnImport = [];
  const flags = {};
  for (const { path, source } of modules) {
    const byName = [DIRECT_COMMAND, MEMBER_COMMAND, SHELL_COMMAND].some((re) => [...source.matchAll(re)].length);
    const byDefault = DEFAULT_BINARY.test(source) && CHILD_PROCESS.test(source);
    if (!byName && !byDefault) continue;
    scripts.push(path);
    if (!MAIN_GUARD.test(source)) runsOnImport.push(path);
    const redirects = new Set([...source.matchAll(REDIRECT_FLAG)].map((m) => `--${m[2] ?? m[3]}`));
    if (redirects.size) flags[path] = [...redirects];
  }

  const found = new Map();
  for (const mod of modules) {
    mod.decls = declarations(mod.source);
    mod.aliases = new Map([...mod.source.matchAll(IMPORT_ALIAS)].map((m) => [m[2], m[1]]));
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const mod of modules) {
      const known = (name) => found.has(mod.aliases.get(name) ?? name);
      const reaches = (name) =>
        known(name) ||
        (mod.decls.get(name) ?? []).some(({ start, end }) => [...identifiersIn(mod.source.slice(start, end)).keys()].some(known));
      for (const m of mod.source.matchAll(EXPORTED_FUNCTION)) {
        if (found.has(m[1])) continue;
        const overrides = overridesOf(mod.source, m.index + m[0].length - 1, reaches);
        if (overrides) {
          found.set(m[1], overrides);
          grew = true;
        }
      }
    }
  }
  const params = {};
  const positional = {};
  for (const [name, { keys, position }] of found) {
    if (keys.length) params[name] = keys;
    if (position) positional[name] = position;
  }
  return { root: repoRoot, scripts, runsOnImport, functions: [...found.keys()], flags, params, positional };
}

// `standIns` holds the absolute paths whose import applies the stand-ins: stand-ins.mjs and sandbox.mjs.
export function unsandboxedCalls(source, { file, standIns, users }) {
  const problems = [];
  const specifiers = [...source.matchAll(STATIC_IMPORT)].filter((m) => m[2].startsWith("."));
  const importsStandIns = specifiers.some((m) => standIns.includes(resolve(dirname(file), m[2])));
  const fileRel = users.root ? relative(users.root, file).split(sep).join("/") : "";
  const anchors = fileRel && !fileRel.startsWith("..") ? [posix.dirname(fileRel), fileRel] : [];
  const scriptSegments = users.scripts.map((path) => path.split("/"));
  const findScript = (raw) => {
    const segs = raw.filter((s) => s !== "..");
    const named = users.scripts.find((_, i) => namesScript(segs, scriptSegments[i]));
    if (named) return named;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] !== ".." || raw[i - 1] === "..") continue;
      for (const anchor of anchors) {
        for (let j = i + 1; j <= raw.length; j++) {
          const hit = posix.join(anchor, ...raw.slice(i, j));
          if (users.scripts.includes(hit)) return hit;
        }
      }
    }
    return undefined;
  };

  const decls = declarations(source);
  const consts = new Map();
  const bound = new Map();
  const commands = new Map();
  const shellLines = new Map();
  const toolLine = (text) => {
    const named = text.replace(/^\s*\$\{\s*([A-Za-z_$][\w$]*)\s*\}/, (all, name) => commands.get(name) ?? all);
    return SHELL_LINE.exec(named)?.[1];
  };
  for (const m of source.matchAll(DECLARATION)) {
    const start = m.index + m[0].length;
    const value = source.slice(start, statementEnd(source, start)).trim();
    const segs = rawSegments(value, consts);
    if (segs.length) consts.set(m[1], segs);
    const hit = findScript(segs);
    if (hit) bound.set(m[1], hit);
    const command = COMMAND_VALUE.exec(value);
    if (command) commands.set(m[1], command[2] ?? command[4]);
    const literal = STRING_LITERAL.exec(value);
    const shell = literal && toolLine(literal[2]);
    if (shell) shellLines.set(m[1], shell);
  }
  const boundIn = (text) => [...bound].find(([name]) => new RegExp(`(?<![.\\w$])${escape(name)}\\b`).test(text))?.[1];
  const shellCommandIn = (text) => {
    for (const t of text.matchAll(TOKEN)) {
      const tool = t[2] !== undefined ? toolLine(t[2]) : shellLines.get(t[3]);
      if (tool) return tool;
    }
    return undefined;
  };
  const sandboxes = [...source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*codexSandbox\s*\(/g)].map((m) => m[1]);
  const line = (index) => source.slice(0, index).split("\n").length;

  const calls = [];
  const addCall = (index, open, fields) => {
    const text = callText(source, open);
    calls.push({ index, end: open + text.length, text, wizard: false, ...fields });
  };
  for (const re of [DIRECT_COMMAND, MEMBER_COMMAND, SHELL_COMMAND]) {
    for (const m of source.matchAll(re)) addCall(m.index, source.indexOf("(", m.index), { what: m.groups.what });
  }
  if (commands.size) {
    const names = [...commands.keys()].map(escape).join("|");
    for (const re of [
      new RegExp(`(?<![.\\w$])(?!(?:if|while|switch|for|return|typeof)\\b)[A-Za-z_$][\\w$]*\\s*\\(\\s*(${names})\\s*[,)]`, "g"),
      new RegExp(`(?<![\\w$])[A-Za-z_$][\\w$]*\\.(?:${SPAWNER_NAMES})\\s*\\(\\s*(${names})\\s*[,)]`, "g"),
      new RegExp(`(?<![\\w$])(?:[A-Za-z_$][\\w$]*\\.)?(?:execSync|exec)\\s*\\(\\s*\`\\$\\{\\s*(${names})\\s*\\}\\s`, "g"),
    ]) {
      for (const m of source.matchAll(re)) addCall(m.index, source.indexOf("(", m.index), { what: commands.get(m[1]) });
    }
  }
  const aliases = [...source.matchAll(IMPORT_ALIAS)];
  const namespaces = [...source.matchAll(NAMESPACE_IMPORT)].map((m) => escape(m[1]));
  const viaNamespace = namespaces.length ? `(?:(?:${namespaces.join("|")})\\s*\\.\\s*)?` : "";
  for (const name of users.functions) {
    const keys = users.params?.[name] ?? [];
    const position = users.positional?.[name] ?? null;
    const locals = [name, ...aliases.filter((m) => m[1] === name).map((m) => m[2])].map(escape);
    for (const m of source.matchAll(new RegExp(`(?<![.\\w$])${viaNamespace}(?:${locals.join("|")})\\s*\\(`, "g"))) {
      if (isDefinition(source, m.index)) continue;
      const open = m.index + m[0].length - 1;
      const text = callText(source, open);
      const given = listParts(text)[position?.index];
      const injected =
        keys.some((key) => new RegExp(`(?<![.\\w$])${escape(key)}\\b(?!\\s*:\\s*(?:undefined|void\\s+0)\\b)`).test(text)) ||
        (position !== null && given !== undefined && !NOT_GIVEN.test(given)) ||
        (!keys.length && position === null && !/^\(\s*\)$/.test(text));
      if (injected) continue;
      const what = keys.length
        ? `${name}() without ${keys.join(" or ")}`
        : `${name}() with its default ${position?.param ?? "runner"}`;
      addCall(m.index, open, { what });
    }
  }
  const onImport = users.runsOnImport ?? [];
  const imported = (index, script) => {
    if (onImport.includes(script)) {
      calls.push({ index, end: index, text: "", what: `${script} on import`, wizard: script === "tools/setup.mjs", inProcess: true });
    }
  };
  for (const m of specifiers) {
    imported(m.index, relative(users.root ?? "", resolve(dirname(file), m[2])).split(sep).join("/"));
  }
  for (const m of source.matchAll(DYNAMIC_IMPORT)) {
    const text = callText(source, m.index + m[0].length - 1);
    imported(m.index, findScript(rawSegments(text, consts)) ?? boundIn(text));
  }

  const seen = new Set(calls.map((call) => call.index));
  // What a redirect flag can be given and still reach the real binary: its name, or a const that holds it.
  const realValue = ["codex", "gcloud", ...[...commands.keys()].map((name) => `\\$\\{\\s*${escape(name)}\\s*\\}`)];
  const realArg = ["[\"'`](?:codex|gcloud)", ...[...commands.keys()].map(escape)];
  for (const m of source.matchAll(SPAWNERS)) {
    const open = m.index + m[0].length - 1;
    const args = commandArgs(callText(source, open), m[1]);
    const script = findScript(rawSegments(args, consts)) ?? boundIn(args);
    if (!script) {
      const shell = seen.has(m.index) ? undefined : shellCommandIn(args);
      if (shell) addCall(m.index, open, { what: `${shell} through a shell` });
      continue;
    }
    const redirected = (users.flags?.[script] ?? []).some((flag) => {
      const toTheRealOne = new RegExp(
        `${flag}(?:=(?:${realValue.join("|")})|["'\`]\\s*,\\s*(?:${realArg.join("|")}))(?![\\w/.-])`,
      );
      return args.includes(flag) && !toTheRealOne.test(args);
    });
    addCall(m.index, open, { what: script, wizard: script === "tools/setup.mjs", redirected });
  }

  for (const call of calls) {
    const where = `line ${line(call.index)} runs ${call.what}`;
    if (!importsStandIns && !call.redirected) {
      problems.push(`${where} but the module does not import ./lib/stand-ins.mjs or ./lib/sandbox.mjs`);
    }
    if (call.wizard && call.inProcess) {
      problems.push(`${where}, inside the test process with its HOME; spawn it with a codexSandbox() env instead`);
    } else if (call.wizard && !sandboxes.some((sb) => new RegExp(`\\b${escape(sb)}\\.env\\b`).test(call.text))) {
      problems.push(`${where} without a codexSandbox() env; the wizard writes CODEX_HOME and reads HOME`);
    }
  }
  for (const n of pathSettingLines(source, calls, decls)) {
    problems.push(`line ${n} sets a PATH of its own; build it with withStandIns() so the stand-ins stay first`);
  }
  return problems;
}

function pathSettingLines(source, calls, decls) {
  if (!calls.length) return [];
  const lines = new Set();
  const lineStarts = [0];
  for (let i = source.indexOf("\n"); i >= 0; i = source.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  const mark = (from, to) => {
    lineStarts.forEach((start, n) => {
      const end = n + 1 < lineStarts.length ? lineStarts[n + 1] - 1 : source.length;
      if (end <= from || start >= to) return;
      const piece = source.slice(Math.max(start, from), Math.min(end, to));
      if (PATH_SET.test(piece) && !/\bwithStandIns\s*\(/.test(piece)) lines.add(n + 1);
    });
  };
  for (const m of source.matchAll(PROCESS_PATH)) mark(m.index, statementEnd(source, m.index));

  const blockList = blocks(source);
  const innermost = new Map();
  const blockAround = (at) => {
    if (!innermost.has(at)) {
      const around = blockList.filter((b) => b.start < at && at < b.end);
      innermost.set(at, around.reduce((best, b) => (!best || b.start > best.start ? b : best), null));
    }
    return innermost.get(at);
  };
  const inside = (span, at) => !span || (span.start <= at && at < span.end);
  const fns = functionScopes(source);
  const scopeOf = (name, at) => {
    const fn = fns
      .filter((f) => f.params.has(name) && f.head <= at && at < f.end)
      .reduce((best, f) => (!best || f.start > best.start ? f : best), null);
    const visible = (decls.get(name) ?? []).filter((d) => inside(blockAround(d.at), at) && (!fn || d.at > fn.start));
    return visible.length || !fn ? { decls: visible, fn: null } : { decls: [], fn };
  };
  const reachesAssignment = (scope, at) =>
    scope.fn ? inside(scope.fn, at) : !scope.decls.length || scope.decls.some((d) => inside(blockAround(d.at), at));
  const callsOf = (name) =>
    [...source.matchAll(new RegExp(`(?<![.\\w$])${escape(name)}\\s*\\(`, "g"))]
      .filter((m) => !isDefinition(source, m.index))
      .map((m) => {
        const open = m.index + m[0].length - 1;
        return [m.index, open + callText(source, open).length];
      });

  const followed = new Set();
  const queue = calls.filter((call) => !call.inProcess).map((call) => [call.index, call.end]);
  while (queue.length) {
    const [from, to] = queue.pop();
    if (followed.has(`${from}:${to}`)) continue;
    followed.add(`${from}:${to}`);
    mark(from, to);
    for (const [name, offset] of identifiersIn(source.slice(from, to))) {
      const scope = scopeOf(name, from + offset);
      for (const d of scope.decls) queue.push([d.start, d.end]);
      const assignment = new RegExp(
        `(?<![.\\w$])${escape(name)}\\s*(?:\\.\\s*PATH\\b|\\[\\s*(["'\`])PATH\\1\\s*\\])\\s*=(?!=)`,
        "g",
      );
      for (const m of source.matchAll(assignment)) {
        if (reachesAssignment(scope, m.index)) queue.push([m.index, statementEnd(source, m.index)]);
      }
      if (scope.fn?.name && !followed.has(scope.fn)) {
        followed.add(scope.fn);
        queue.push(...callsOf(scope.fn.name));
      }
    }
  }
  return [...lines].sort((a, b) => a - b);
}
