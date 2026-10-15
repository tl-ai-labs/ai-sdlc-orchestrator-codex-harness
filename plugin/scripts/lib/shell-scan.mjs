/**
 * What a shell command writes, removes and patches, read as sh, bash and zsh split it. Quoted text, comments and
 * here-document bodies are data. What the shell runs from them is read again as shell: a command substitution, the
 * string `sh -c`, `eval` or `trap` runs, the here-document or piped text a shell reads as its script, and the
 * commands whose output a shell runs (`bash -c "$(cat <<EOF …)"`, `source <(…)`).
 *
 * `scanShell` returns effects, a command's own before those of the substitutions in it: `{kind: "write", path,
 * tight}` (a redirect, `tee`, `touch`; `tight` when no blank comes before the operator), `{kind: "copy", tool,
 * flags, args}` (`cp`, `mv`, `git mv`), `{kind: "remove", path}` (`rm`, `unlink`, `git rm`, `mv` sources) and
 * `{kind: "patch", text}` (the text an `apply_patch` run through the shell is given or piped). Paths are shell
 * words with quotes and backslashes resolved; `$`, globs and braces stay in them, and a command substitution reads
 * `$*`. `{kind: "unread"}` marks text nested past MAX_DEPTH, which the scan does not read.
 */

/** Past this depth of substitutions and nested shells, the inner text is not read. */
export const MAX_DEPTH = 8;

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "mksh", "yash"]);
const RESERVED = new Set(["!", "{", "}", "if", "then", "elif", "else", "fi", "do", "done", "while", "until", "esac", "coproc"]);
const NO_COMMAND = new Set(["for", "select", "case"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

/**
 * Commands that run the words after their options as a command. `short`/`long` are the options that take a value,
 * `positional` the operands before the command, and `code` the options whose value is run as shell.
 */
const WRAPPERS = {
  sudo: { short: "ugpCDrtUTR", long: ["--user", "--group", "--prompt", "--close-from", "--chdir", "--role", "--type", "--other-user", "--host", "--command-timeout"], assigns: true },
  doas: { short: "uC" },
  env: { short: "uCSP", long: ["--unset", "--chdir", "--split-string"], assigns: true },
  nice: { short: "n", long: ["--adjustment"] },
  nohup: {},
  command: {},
  builtin: {},
  noglob: {},
  nocorrect: {},
  exec: { short: "a" },
  time: { short: "fo", long: ["--format", "--output"] },
  timeout: { short: "sk", long: ["--signal", "--kill-after"], positional: 1 },
  stdbuf: { short: "ioe", long: ["--input", "--output", "--error"] },
  caffeinate: { short: "tw" },
  xargs: { short: "ILnPsdaEJRS", long: ["--max-args", "--max-procs", "--max-chars", "--delimiter", "--arg-file", "--max-lines"] },
  setsid: {},
  flock: { short: "wEc", long: ["--timeout", "--conflict-exit-code", "--command"], positional: 1, code: ["-c", "--command"] },
  arch: { long: ["-arch", "-e", "-d"] },
  chronic: {},
  ionice: { short: "cnpPu", long: ["--class", "--classdata", "--pid", "--pgid", "--uid"] },
  unbuffer: {},
  busybox: {},
  taskset: { positional: 1 },
  chrt: { positional: 1 },
};

const REDIRECTS = ["&>>", "&>|", "&>!", "&>", ">>|", ">>!", ">>", ">|", ">!", ">&", ">", "<<<", "<<-", "<<", "<>", "<&", "<"];
const WRITES = new Set(["&>>", "&>|", "&>!", "&>", ">>|", ">>!", ">>", ">|", ">!", ">&", ">", "<>"]);
const CONTROLS = [";;&", ";;", ";&", ";|", ";", "&&", "&|", "&!", "&", "||", "|&", "|"];
/** Characters that end an unquoted word. */
const WORD_END = new Set([" ", "\t", "\r", "\n", ";", "&", "|", ")", "<", ">"]);

// ── lexing ──────────────────────────────────────────────────────────────────

/** Index of the `)` that closes the `(` at `i`, quotes skipped, or text.length. */
function balanced(text, i, open = "(", close = ")") {
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === "\\") j++;
    else if (c === "'") { const e = text.indexOf("'", j + 1); j = e === -1 ? text.length : e; }
    else if (c === '"') j = doubleEnd(text, j + 1);
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return j;
  }
  return text.length;
}

function doubleEnd(text, i) {
  for (let j = i; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === '"') return j;
  }
  return text.length;
}

/** Index of the quote that closes a `$'…'` string whose quote is at `i`. */
function ansiEnd(text, i) {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === "'") return j;
  }
  return text.length;
}

const ANSI_ESCAPES = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };

/** The text of a `$'…'` string, its escapes decoded as bash and zsh decode them. */
function ansiText(body) {
  return body.replace(/\\(?:([0-7]{1,3})|x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|c(.)|([\s\S]))/g,
    (m, oct, hex, u4, u8, ctl, ch) => {
      if (oct) return String.fromCharCode(parseInt(oct, 8) & 0xff);
      if (hex) return String.fromCharCode(parseInt(hex, 16));
      const cp = parseInt(u4 ?? u8 ?? "", 16);
      if (cp >= 0) return cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
      if (ctl) return String.fromCharCode(ctl.charCodeAt(0) & 0x1f);
      return ANSI_ESCAPES[ch] ?? (/["'\\?]/.test(ch) ? ch : m);
    });
}

function backtickEnd(text, i) {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === "`") return j;
  }
  return text.length;
}

/** A `$(`, `<(`, `>(` or `=(` body starting at `j`: lexed into ctx.subs. Returns the index of its `)`. */
function substitute(text, j, ctx, level) {
  if (level >= MAX_DEPTH) {
    ctx.unread = true;
    return balanced(text, j - 1);
  }
  const inner = lex(text, j, ")", ctx, level + 1);
  ctx.subs.push({ tokens: inner.tokens, depth: level + 1 });
  return inner.end;
}

/** A backtick substitution at `i`, its body queued in ctx.subs. Returns the index of the closing backtick. */
function backtick(text, i, ctx, level) {
  const end = backtickEnd(text, i);
  if (level < MAX_DEPTH) ctx.subs.push({ text: text.slice(i + 1, end).replace(/\\([`$\\])/g, "$1"), depth: level + 1 });
  else ctx.unread = true;
  return end;
}

/**
 * Whether the `((` at `i` is arithmetic, as bash and zsh read it: the `)` closing its second `(` is followed by `)`.
 * Otherwise it is a subshell inside a subshell, `((cmd) > f)`.
 */
const arithmetic = (text, i) => text[balanced(text, i + 1) + 1] === ")";

/** Queues the command substitutions inside arithmetic or a `${…}` expansion, which the shell runs. */
function innerSubstitutions(text, from, to, ctx, level) {
  lexDouble(text.slice(from, to), 0, ctx, level, false);
}

/**
 * A `$…` expansion at `i`: `{value, end}`, where `end` is the index after it, or null for a lone `$`. A command
 * substitution and arithmetic read `$*`, since the hook cannot know what they print.
 */
function dollar(text, i, ctx, level) {
  const n = text[i + 1];
  if (n === "(") {
    if (text[i + 2] === "(" && arithmetic(text, i + 1)) {
      const close = balanced(text, i + 2) + 1;
      innerSubstitutions(text, i + 3, close - 1, ctx, level);
      return { value: "$*", end: close + 1 };
    }
    return { value: "$*", end: substitute(text, i + 2, ctx, level) + 1 };
  }
  if (n === "{") {
    const close = balanced(text, i + 1, "{", "}");
    innerSubstitutions(text, i + 2, close, ctx, level);
    return { value: text.slice(i, close + 1), end: close + 1 };
  }
  return null;
}

/** A double-quoted string's body from `i` to its closing quote (or, with `closed` false, to the end): `{value, end}`. */
function lexDouble(text, i, ctx, level, closed = true) {
  let v = "";
  while (i < text.length) {
    const c = text[i];
    if (closed && c === '"') return { value: v, end: i };
    if (c === "\\") {
      const n = text[i + 1];
      if (n === "\n") { i += 2; continue; }
      if (n === "$" || n === "`" || n === "\\" || (closed && n === '"')) { v += n; i += 2; continue; }
      v += c;
      i++;
      continue;
    }
    if (c === "$") {
      const d = dollar(text, i, ctx, level);
      if (d) { v += d.value; i = d.end; continue; }
    }
    if (c === "`") { i = backtick(text, i, ctx, level) + 1; v += "$*"; continue; }
    v += c;
    i++;
  }
  return { value: v, end: text.length };
}

/** One shell word from `i`: `{value, raw, plain, end}`. `plain`: no quote, escape or expansion in it. */
function lexWord(text, i, ctx, level) {
  const start = i;
  let v = "";
  let plain = true;
  while (i < text.length) {
    const c = text[i];
    if ((c === "<" || c === ">" || c === "=") && i === start && text[i + 1] === "(") {
      i = substitute(text, i + 2, ctx, level) + 1;
      v += "/dev/fd/63";
      plain = false;
      continue;
    }
    if (WORD_END.has(c)) break;
    if (c === "(") {
      if (i === start || /^\(\s*\)/.test(text.slice(i, i + 64))) break;
      // A glob group, zsh qualifier or extglob (`b(a|c)`, `*(.)`, `@(x)`): any text.
      i = balanced(text, i) + 1;
      v += "*";
      plain = false;
      continue;
    }
    if (c === "\\") {
      if (text[i + 1] !== "\n") v += text[i + 1] ?? "";
      i += 2;
      plain = false;
      continue;
    }
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      const end = close === -1 ? text.length : close;
      v += text.slice(i + 1, end);
      i = end + 1;
      plain = false;
      continue;
    }
    if (c === '"' || (c === "$" && text[i + 1] === '"')) {
      const r = lexDouble(text, c === "$" ? i + 2 : i + 1, ctx, level);
      v += r.value;
      i = r.end + 1;
      plain = false;
      continue;
    }
    if (c === "$" && text[i + 1] === "'") {
      const close = ansiEnd(text, i + 1);
      v += ansiText(text.slice(i + 2, close));
      i = close + 1;
      plain = false;
      continue;
    }
    if (c === "$") {
      const d = dollar(text, i, ctx, level);
      plain = false;
      if (d) { v += d.value; i = d.end; continue; }
    }
    if (c === "`") {
      i = backtick(text, i, ctx, level) + 1;
      v += "$*";
      plain = false;
      continue;
    }
    v += c;
    i++;
  }
  return { value: v, raw: text.slice(start, Math.min(i, text.length)), plain, end: Math.min(i, text.length) };
}

/** Reads a here-document body that starts at `i`; returns the index of the newline after its delimiter line. */
function readBody(text, i, doc) {
  for (let line = i; line < text.length;) {
    const nl = text.indexOf("\n", line);
    const end = nl === -1 ? text.length : nl;
    const l = text.slice(line, end).replace(/\r$/, "");
    if ((doc.strip ? l.replace(/^\t+/, "") : l) === doc.delim) {
      doc.body = text.slice(i, line);
      return end;
    }
    line = end + 1;
  }
  doc.body = text.slice(i);
  return text.length;
}

/**
 * Tokens of `text` from `from`: words, redirects (`{t: "redir", op, tight, target, doc}`) and control operators.
 * With `stop` set to `)`, lexing ends at the `)` that closes a substitution.
 */
function lex(text, from, stop, ctx, level) {
  const tokens = [];
  const pending = [];
  let parens = 0;
  let test = false;
  let last = null;
  // Where a word is the command word, or a reserved word before it: a `[[` there opens a test.
  let commandPosition = true;
  let afterTime = false;
  const push = (tok, end) => {
    tokens.push(tok);
    last = { tok, end };
    if (tok.t !== "word") { commandPosition = tok.t === "op"; afterTime = false; }
  };
  /** The substitutions queued since `s0` that a word holds itself, not those nested inside them. */
  const own = (s0) => ctx.subs.slice(s0).filter((s) => s.depth === level + 1);
  const glued = (j) => !!last && last.end === j &&
    (last.tok.t === "word" || last.tok.v === ")" || (last.tok.t === "redir" && last.tok.target !== null));

  const redirect = (j, op, tight) => {
    const tok = { t: "redir", op, tight, target: null, doc: null, arrow: false };
    // `->` and `=>` are code arrows more often than redirects.
    if (tight && op[0] === ">" && (text[j - 1] === "-" || text[j - 1] === "=")) tok.arrow = true;
    let k = j + op.length;
    while (text[k] === " " || text[k] === "\t") k++;
    const procSubTarget = (text[k] === "<" || text[k] === ">") && text[k + 1] === "(";
    if ((k < text.length && !WORD_END.has(text[k]) && text[k] !== "(") || procSubTarget) {
      const s0 = ctx.subs.length;
      const w = lexWord(text, k, ctx, level);
      tok.subs = own(s0);
      if (op === "<<" || op === "<<-") {
        tok.doc = { delim: w.value, strip: op === "<<-", quoted: !w.plain, body: "" };
        pending.push(tok.doc);
      } else tok.target = w.value;
      k = w.end;
    }
    push(tok, k);
    return k;
  };

  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (stop === ")" && c === ")" && parens === 0) return { tokens, end: i };
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "\\" && text[i + 1] === "\n") { i += 2; continue; }
    if (c === "\n") {
      push({ t: "op", v: "\n" }, i + 1);
      i++;
      while (pending.length) i = readBody(text, i, pending.shift());
      continue;
    }
    if (c === "#") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (test && (c === "<" || c === ">" || c === "(" || c === ")" || c === "&" || c === "|")) {
      // Inside `[[ … ]]` these compare and group; nothing is redirected.
      i++;
      continue;
    }
    const procSub = (c === "<" || c === ">") && text[i + 1] === "(";
    if (c === "(" && text[i + 1] === "(" && arithmetic(text, i)) {
      const close = balanced(text, i + 1) + 1;
      innerSubstitutions(text, i + 2, close - 1, ctx, level);
      i = close + 1;
      continue;
    }
    if (c === "(") { parens++; push({ t: "op", v: "(" }, i + 1); i++; continue; }
    if (c === ")") { parens = Math.max(0, parens - 1); push({ t: "op", v: ")" }, i + 1); i++; continue; }
    if (!procSub && (c === "<" || c === ">" || (c === "&" && text[i + 1] === ">"))) {
      const op = REDIRECTS.find((o) => text.startsWith(o, i));
      i = redirect(i, op, glued(i));
      continue;
    }
    if (c === ";" || c === "&" || c === "|") {
      const op = CONTROLS.find((o) => text.startsWith(o, i));
      push({ t: "op", v: op }, i + op.length);
      i += op.length;
      continue;
    }
    const s0 = ctx.subs.length;
    const w = lexWord(text, i, ctx, level);
    if (w.end === i) { i++; continue; }
    if (/^\d+$/.test(w.raw) && (text[w.end] === "<" || text[w.end] === ">") && text[w.end + 1] !== "(") {
      const op = REDIRECTS.find((o) => text.startsWith(o, w.end));
      i = redirect(w.end, op, glued(i));
      continue;
    }
    const atCommand = commandPosition;
    if (w.plain && w.value === "[[" && atCommand) test = true;
    else if (w.plain && w.value === "]]") test = false;
    push({ t: "word", v: w.value, raw: w.raw, plain: w.plain, subs: own(s0) }, w.end);
    const timed = afterTime;
    afterTime = atCommand && w.plain && w.value === "time";
    commandPosition = atCommand && w.plain && (RESERVED.has(w.value) || afterTime || (timed && w.value === "-p"));
    i = w.end;
  }
  return { tokens, end: text.length };
}

// ── commands ────────────────────────────────────────────────────────────────

/** GNU coreutils under the names Homebrew gives them on macOS (`gcp`, `gtimeout`). */
const GNU_PREFIXED = /^g(cp|mv|rm|unlink|tee|touch|env|nice|nohup|timeout|stdbuf)$/;
const commandName = (v) => v.slice(v.lastIndexOf("/") + 1).toLowerCase().replace(GNU_PREFIXED, "$1");

/** Index of the first word past a wrapper's options and operands; the values of its `code` options go to `code`. */
function skipOptions(words, k, spec, code) {
  let positional = spec.positional ?? 0;
  const runs = (opt) => spec.code?.includes(opt);
  for (; k < words.length; k++) {
    const a = words[k].v;
    if (a === "--") return k + 1;
    if (spec.long?.includes(a)) {
      if (runs(a) && words[k + 1]) code.push(words[k + 1]);
      k++;
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1 && runs(a.slice(0, eq))) code.push({ ...words[k], v: a.slice(eq + 1) });
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      const j = [...a.slice(1)].findIndex((ch) => spec.short?.includes(ch));
      const opt = `-${a[j + 1]}`;
      if (j !== -1 && j === a.length - 2) {
        if (runs(opt) && words[k + 1]) code.push(words[k + 1]);
        k++;
      } else if (j !== -1 && runs(opt)) code.push({ ...words[k], v: a.slice(j + 2) });
      continue;
    }
    if (spec.assigns && ASSIGNMENT.test(words[k].raw)) continue;
    if (positional > 0) { positional--; continue; }
    return k;
  }
  return k;
}

/**
 * Index of the command word of a simple command, past reserved words, assignments and wrappers, or -1. A wrapper
 * option that runs its value as shell (`flock -c`) adds that word to `code`.
 */
function commandAt(words, code = []) {
  let k = 0;
  while (k < words.length) {
    const w = words[k];
    if (w.plain && RESERVED.has(w.v)) { k++; continue; }
    if (w.plain && NO_COMMAND.has(w.v)) return -1;
    if (w.plain && w.v === "function") { k += 2; continue; }
    if (ASSIGNMENT.test(w.raw)) { k++; continue; }
    const spec = Object.hasOwn(WRAPPERS, commandName(w.v)) ? WRAPPERS[commandName(w.v)] : null;
    if (!spec) break;
    k = skipOptions(words, k + 1, spec, code);
  }
  return k < words.length && !words[k].v.startsWith("-") ? k : -1;
}

/** Option words, operands and option values of an argument list; `short`/`long` name the options that take a value. */
function operands(words, short = "", long = []) {
  const flags = [];
  const ops = [];
  const values = {};
  for (let k = 0; k < words.length; k++) {
    const a = words[k].v;
    if (a === "--") { ops.push(...words.slice(k + 1).map((w) => w.v)); break; }
    if (a.startsWith("--")) {
      flags.push(a);
      const eq = a.indexOf("=");
      if (eq !== -1) values[a.slice(0, eq)] = a.slice(eq + 1);
      else if (long.includes(a)) values[a] = words[++k]?.v;
      continue;
    }
    if (a.startsWith("-")) {
      flags.push(a);
      for (let j = 1; j < a.length; j++) {
        if (!short.includes(a[j])) continue;
        values[`-${a[j]}`] = j < a.length - 1 ? a.slice(j + 1) : words[++k]?.v;
        break;
      }
      continue;
    }
    ops.push(a);
  }
  return { flags, ops, values };
}

/** How a shell invocation gets its script: `{code, at}` for `-c`, `{file, at}`, or `{stdin}`; `at` indexes `vals`. */
function shellMode(vals) {
  let dashC = false;
  let dashS = false;
  let k = 0;
  for (; k < vals.length; k++) {
    const a = vals[k];
    if (a === "--" || a === "-") { k++; break; }
    if (a.startsWith("--")) {
      if (a === "--rcfile" || a === "--init-file") k++;
      continue;
    }
    if (/^[-+][A-Za-z]/.test(a)) {
      if (a[0] === "-" && a.includes("c")) dashC = true;
      if (a[0] === "-" && a.includes("s")) dashS = true;
      if (/[oO]$/.test(a)) k++;
      continue;
    }
    break;
  }
  if (dashC) return { code: vals[k] ?? "", at: k };
  return k < vals.length && !dashS ? { file: vals[k], at: k } : { stdin: true };
}

function split(tokens) {
  const cmds = [];
  let cur = { words: [], redirs: [], pipeOut: false };
  const end = () => {
    if (cur.words.length || cur.redirs.length) cmds.push(cur);
    cur = { words: [], redirs: [], pipeOut: false };
  };
  for (const t of tokens) {
    if (t.t === "word") cur.words.push(t);
    else if (t.t === "redir") cur.redirs.push(t);
    else {
      if (t.v === "|" || t.v === "|&") cur.pipeOut = true;
      end();
    }
  }
  end();
  return cmds;
}

const PATCH_TOOLS = new Set(["apply_patch", "applypatch"]);

/** What the command a pipe feeds does with its stdin: "shell" reads it as a script, "patch" applies it, or null. */
function stdinUse(cmd) {
  if (!cmd) return null;
  const at = commandAt(cmd.words);
  const name = at === -1 ? null : commandName(cmd.words[at].v);
  if (PATCH_TOOLS.has(name)) return "patch";
  if (!SHELLS.has(name)) return null;
  return shellMode(cmd.words.slice(at + 1).map((w) => w.v)).stdin ? "shell" : null;
}

/** Patch text as apply_patch may read it: printf and zsh's echo turn a `\n` into a line break. */
function patchTexts(text) {
  const lines = text.replace(/\\n/g, "\n");
  return lines === text ? [text] : [text, lines];
}

/** Marks the substitutions written in a word or redirect: the shell runs what they print as a script. */
function runsOutput(tok) {
  for (const s of tok?.subs ?? []) s.feeds = "shell";
}

function add(out, effect) {
  if (effect.path === undefined || (typeof effect.path === "string" && effect.path.length > 0)) out.push(effect);
}

function copy(tool, words, out) {
  const { flags, ops, values } = operands(words, "tS", ["--target-directory", "--suffix"]);
  const dir = values["-t"] ?? values["--target-directory"];
  const args = dir === undefined ? ops : [...ops, dir];
  out.push({ kind: "copy", tool, flags, args });
  if (tool === "mv") for (const p of args.slice(0, -1)) add(out, { kind: "remove", path: p });
}

function git(words, out) {
  let k = 0;
  for (; k < words.length; k++) {
    const a = words[k].v;
    if (a === "-C" || a === "-c" || /^--(?:git-dir|work-tree|namespace|super-prefix|config-env)$/.test(a)) k++;
    else if (!a.startsWith("-")) break;
  }
  const sub = words[k]?.v;
  const rest = words.slice(k + 1);
  if (sub === "rm") {
    const { flags, ops } = operands(rest, "", ["--pathspec-from-file"]);
    const indexOnly = flags.some((f) => f === "--cached" || f === "--dry-run" || /^-[A-Za-z]*n/.test(f));
    if (!indexOnly) for (const p of ops) add(out, { kind: "remove", path: p });
  } else if (sub === "mv") copy("mv", rest, out);
}

function find(words, out, depth) {
  for (let k = 0; k < words.length; k++) {
    if (!/^-(?:exec|execdir|ok|okdir)$/.test(words[k].v)) continue;
    let e = k + 1;
    while (e < words.length && words[e].v !== ";" && words[e].v !== "+") e++;
    simple({ words: words.slice(k + 1, e), redirs: [] }, out, depth, null);
    k = e;
  }
}

/** One simple command's effects. `feeds`: what is done with its output: "shell" runs it as a script, "patch" applies it. */
function simple(cmd, out, depth, feeds) {
  const feedsShell = feeds === "shell";
  const { words, redirs } = cmd;
  const code = [];
  const at = commandAt(words, code);
  const name = at === -1 ? null : commandName(words[at].v);
  const args = at === -1 ? [] : words.slice(at + 1);
  const vals = args.map((w) => w.v);
  for (const r of redirs) {
    if (!WRITES.has(r.op) || r.arrow || r.target === null) continue;
    if (r.op === ">&" && /^(?:\d+-?|-|\$.*)$/.test(r.target)) continue;
    add(out, { kind: "write", path: r.target, tight: r.tight });
  }
  const docs = redirs.filter((r) => r.doc).map((r) => r.doc);
  const strings = redirs.filter((r) => r.op === "<<<" && r.target !== null).map((r) => r.target);
  if (feeds === "patch") {
    for (const text of [...docs.map((d) => d.body), ...strings, ...vals]) {
      for (const t of patchTexts(text)) out.push({ kind: "patch", text: t });
    }
  }
  if (PATCH_TOOLS.has(name)) {
    // Codex applies a shell apply_patch itself: its text is a patch, never shell.
    for (const text of [...docs.map((d) => d.body), ...strings, ...vals]) out.push({ kind: "patch", text });
    return;
  }
  const mode = name && SHELLS.has(name) ? shellMode(vals) : null;
  if (mode?.code !== undefined) visit(mode.code, out, depth + 1);
  if (mode?.at !== undefined) runsOutput(args[mode.at]);
  if (mode?.stdin || feedsShell) {
    for (const d of docs) visit(d.body, out, depth + 1);
    for (const s of strings) visit(s, out, depth + 1);
    for (const r of redirs) if (r.op === "<" || r.op === "<<<") runsOutput(r);
  } else {
    for (const d of docs) if (!d.quoted) bodySubstitutions(d.body, out, depth + 1);
  }
  if (feedsShell) for (const a of args) { visit(a.v, out, depth + 1); runsOutput(a); }
  if (name === "eval") { visit(vals.join(" "), out, depth + 1); args.forEach(runsOutput); }
  if (name === "trap" && vals[0] && !vals[0].startsWith("-")) { visit(vals[0], out, depth + 1); runsOutput(args[0]); }
  if (name === "source" || name === ".") runsOutput(args[0]);
  for (const w of code) { visit(w.v, out, depth + 1); runsOutput(w); }
  if (name === "tee") for (const p of operands(args).ops) add(out, { kind: "write", path: p, tight: false });
  else if (name === "touch") for (const p of operands(args, "rtdA", ["--reference", "--date"]).ops) add(out, { kind: "write", path: p, tight: false });
  else if (name === "cp" || name === "mv") copy(name, args, out);
  else if (name === "rm" || name === "unlink") for (const p of operands(args).ops) add(out, { kind: "remove", path: p });
  else if (name === "git") git(args, out);
  else if (name === "find") find(args, out, depth);
}

/** `feeds`: what is done with the output of the commands that do not pipe it on (a substitution a shell runs). */
function run(tokens, out, depth, feeds = null) {
  const cmds = split(tokens);
  cmds.forEach((cmd, n) => simple(cmd, out, depth, cmd.pipeOut ? stdinUse(cmds[n + 1]) : feeds));
}

/** Runs the queued substitutions, outer ones first: running one marks the substitutions inside it whose output a shell runs. */
function runSubs(ctx, out) {
  for (const s of [...ctx.subs].sort((a, b) => a.depth - b.depth)) {
    if (s.tokens) run(s.tokens, out, s.depth, s.feeds);
    else visit(s.text, out, s.depth, s.feeds);
  }
  if (ctx.unread) out.push({ kind: "unread" });
}

/** The command substitutions of an unquoted here-document body, which the shell runs before the command reads it. */
function bodySubstitutions(body, out, depth) {
  if (!body) return;
  if (depth > MAX_DEPTH) {
    if (/\$\(|`/.test(body)) out.push({ kind: "unread" });
    return;
  }
  const ctx = { subs: [] };
  lexDouble(body, 0, ctx, depth, false);
  runSubs(ctx, out);
}

function visit(text, out, depth, feeds = null) {
  if (typeof text !== "string" || !text.trim()) return;
  if (depth > MAX_DEPTH) {
    out.push({ kind: "unread" });
    return;
  }
  const ctx = { subs: [] };
  run(lex(text, 0, null, ctx, depth).tokens, out, depth, feeds);
  runSubs(ctx, out);
}

export function scanShell(command) {
  const out = [];
  visit(command, out, 0);
  return out;
}
