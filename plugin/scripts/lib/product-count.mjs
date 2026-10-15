/**
 * The product's files and lines for manifest.json's `artifacts`: every file
 * under a generated code folder, or, when the code folder is the project
 * itself (brownfield), only the files the run's provenance.json lists.
 */
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Installed packages, VCS data, caches, build output, tool state and run records: never the product. */
export const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", ".sdlc", ".codex", ".agents", "dist", "build", ".venv", "venv",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", "coverage", ".nyc_output", ".next",
  ".nuxt", ".svelte-kit", ".turbo", ".cache", "target", ".gradle", ".terraform", "vendor", "Pods",
]);

export const LOCKFILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "Cargo.lock",
  "poetry.lock", "Pipfile.lock", "uv.lock", "composer.lock", "Gemfile.lock", "go.sum", "Podfile.lock",
]);

const errCode = (e) => e?.code ?? e?.message ?? String(e);
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const within = (dir, p) => {
  const r = relative(dir, p);
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
};

/** Newlines + 1, read in chunks so a large file is never held whole. */
function linesOf(path, onSkip) {
  let fd;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(1 << 16);
    let n = 0;
    let got;
    while ((got = readSync(fd, buf, 0, buf.length, null)) > 0) for (let i = 0; i < got; i++) if (buf[i] === 10) n++;
    return n + 1;
  } catch (e) {
    onSkip(path, errCode(e));
    return 0;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
  }
}

/** Every regular file under `codeDir`; symlinks inside it are never followed, and an unreadable entry goes to `onSkip`. */
export function countProduct(codeDir, { onSkip = () => {} } = {}) {
  let files = 0;
  let loc = 0;
  const entered = new Set();
  const walk = (dir, st) => {
    const id = `${st.dev}:${st.ino}`;
    if (entered.has(id)) return;
    entered.add(id);
    let names;
    try {
      names = readdirSync(dir);
    } catch (e) {
      onSkip(dir, errCode(e));
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let s;
      try {
        s = lstatSync(full, { bigint: true });
      } catch (e) {
        onSkip(full, errCode(e));
        continue;
      }
      if (s.isDirectory()) {
        if (!SKIP_DIRS.has(name) && !existsSync(join(full, "pyvenv.cfg"))) walk(full, s);
      } else if (s.isFile() && !LOCKFILES.has(name)) {
        files++;
        loc += linesOf(full, onSkip);
      }
    }
  };
  let root;
  try {
    root = lstatSync(real(codeDir), { bigint: true });
  } catch {
    root = undefined;
  }
  if (root?.isDirectory()) walk(real(codeDir), root);
  return { files, loc };
}

/** The listed files that are the product: under `codeDir`, outside the skipped folders, not a lockfile, still on disk. */
export function countFiles(paths, codeDir, { onSkip = () => {} } = {}) {
  const root = real(codeDir);
  let files = 0;
  let loc = 0;
  for (const p of new Set(paths)) {
    const at = join(real(dirname(p)), basename(p));
    const rel = relative(root, at);
    if (rel === "" || !within(root, at)) continue;
    const parts = rel.split(sep);
    if (parts.slice(0, -1).some((x) => SKIP_DIRS.has(x)) || LOCKFILES.has(parts[parts.length - 1])) continue;
    let s;
    try {
      s = lstatSync(at);
    } catch (e) {
      if (e?.code !== "ENOENT") onSkip(p, errCode(e));
      continue;
    }
    if (s.isFile()) {
      files++;
      loc += linesOf(at, onSkip);
    }
  }
  return { files, loc };
}

function provenanceFiles(path, projectRoot) {
  let prov;
  try {
    prov = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
  if (!Array.isArray(prov?.files_touched)) return undefined;
  return prov.files_touched.filter((f) => typeof f?.path === "string").map((f) => resolve(projectRoot, f.path));
}

/**
 * `{counts, note}`: counts is `{files, loc}` or undefined, and note says why
 * counts are left out or which paths could not be read. A code folder that is
 * a repository, holds the run folder, or has a provenance record is the
 * project itself, so only the files the run wrote are counted there.
 */
export function productCounts({ codeDir, runDir, projectRoot }) {
  const skipped = [];
  const onSkip = (p, why) => skipped.push(`${relative(codeDir, p) || "."} (${why})`);
  const provPath = join(runDir, "provenance.json");
  const isProject = existsSync(join(codeDir, ".git")) || existsSync(provPath) || within(real(codeDir), real(runDir));
  let counts;
  if (isProject) {
    const listed = provenanceFiles(provPath, projectRoot);
    if (!listed) {
      return {
        counts: undefined,
        note: `file counts left out: the code directory ${codeDir} is the project itself, and no files_touched list in ${provPath} says which files this run wrote`,
      };
    }
    counts = countFiles(listed, codeDir, { onSkip });
  } else {
    counts = countProduct(codeDir, { onSkip });
  }
  const note = skipped.length
    ? `${skipped.length} path(s) could not be read and are left out of the file counts: ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? ", …" : ""}`
    : null;
  return { counts, note };
}
