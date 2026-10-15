import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCodexHome, withStandIns } from "./stand-ins.mjs";

// The setup wizard decides its verdict from these; a test states its own instead of inheriting the developer's shell.
const SCRUBBED = [
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GEMINI_BACKEND",
  "GEMINI_WORKER_PYTHON",
  "MMO_SELECT",
  "MMO_STAND_IN_LOGIN",
];

/**
 * One test's own temporary HOME and CODEX_HOME (marked for the codex stand-in), with the stand-ins first on PATH.
 * `calls()` lists what the stand-ins were asked; `config()` reads the sandbox's config.toml.
 */
export function codexSandbox(extraEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), "mmo-setup-home-"));
  const codexHome = makeCodexHome(home);
  const env = { ...process.env, HOME: home, CODEX_HOME: codexHome, PATH: withStandIns(process.env.PATH) };
  for (const name of SCRUBBED) delete env[name];
  Object.assign(env, extraEnv);
  const read = (name) => {
    const path = join(codexHome, name);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  };
  return {
    home,
    codexHome,
    env,
    calls: () => read("stand-in-calls.log").split("\n").filter(Boolean),
    config: () => read("config.toml"),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}
