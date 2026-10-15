/**
 * Preloaded by `npm test` (node --test --import) and imported by every test that runs codex, gcloud or the setup
 * wizard, so a file run on its own is covered too. It puts stand-in-bin/ (codex, gcloud) and stand-in-npm/ first on
 * PATH and points CODEX_HOME at a marked temporary directory. A child process reuses that directory through
 * MMO_TEST_CODEX_HOME instead of making its own.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(fileURLToPath(import.meta.url), "..");
export const STAND_IN_BIN = join(here, "stand-in-bin");
export const STAND_IN_NPM = join(here, "stand-in-npm");
export const SANDBOX_MARKER = ".mmo-test-sandbox";

export function makeCodexHome(parent) {
  const codexHome = join(parent, ".codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, SANDBOX_MARKER), "");
  return codexHome;
}

export function isSandboxCodexHome(dir) {
  return typeof dir === "string" && dir !== "" && existsSync(join(dir, SANDBOX_MARKER));
}

/** `pathValue` with the stand-in directories first, once each; every other entry keeps its place. */
export function withStandIns(pathValue) {
  const first = [STAND_IN_BIN, STAND_IN_NPM];
  const rest = String(pathValue ?? "").split(delimiter).filter((dir) => dir && !first.includes(dir));
  return [...first, ...rest].join(delimiter);
}

process.env.PATH = withStandIns(process.env.PATH);
const inherited = process.env.MMO_TEST_CODEX_HOME;
if (!isSandboxCodexHome(inherited) || process.env.CODEX_HOME !== inherited) {
  const root = mkdtempSync(join(tmpdir(), "mmo-test-codex-home-"));
  process.env.CODEX_HOME = process.env.MMO_TEST_CODEX_HOME = makeCodexHome(root);
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
}
