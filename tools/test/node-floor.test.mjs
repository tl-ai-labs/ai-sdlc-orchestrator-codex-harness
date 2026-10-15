/**
 * One Node floor for the whole repo: every package.json declares the same engines.node, CI runs that major, and no
 * locked package needs a newer Node than the floor promises.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGES = ["package.json", "plugin/mcp/model-dispatch/package.json", "plugin/policy-console/package.json"];
const LOCKFILES = PACKAGES.map((path) => path.replace(/package\.json$/, "package-lock.json"));
const WORKFLOW = ".github/workflows/test.yml";

const readJson = (path) => JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8"));

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// Upper bounds are ignored here; admits() checks them.
function rangeFloor(range) {
  const floors = parseRange(range).map((comparators) =>
    comparators
      .filter(({ op }) => op === ">=" || op === ">")
      .reduce((low, { version }) => (compare(version, low) > 0 ? version : low), [0, 0, 0]),
  );
  return floors.reduce((low, floor) => (compare(floor, low) < 0 ? floor : low));
}

function admits(range, version) {
  const holds = { ">=": (c) => c >= 0, ">": (c) => c > 0, "<": (c) => c < 0, "<=": (c) => c <= 0 };
  return parseRange(range).some((comparators) =>
    comparators.every(({ op, version: bound }) => holds[op](compare(version, bound))),
  );
}

function parseRange(range) {
  return String(range).split("||").map((alternative) => {
    const hyphen = alternative.trim().match(/^(\S+)\s+-\s+(\S+)$/);
    if (hyphen) return [...comparatorsFor(">=", hyphen[1]), ...comparatorsFor("<=", hyphen[2])];
    const tokens = alternative.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1").split(/\s+/).filter(Boolean);
    return tokens.flatMap((token) => {
      const m = token.match(/^(>=|<=|>|<|=|\^|~)?(.*)$/);
      return comparatorsFor(m[1] ?? "", m[2]);
    });
  });
}

// Partial versions (`20`, `4.x`) expand the way node-semver expands them.
function comparatorsFor(op, text) {
  const m = text.match(/^v?(\d+|[x*])?(?:\.(\d+|[x*]))?(?:\.(\d+|[x*]))?(?:[-+][\w.-]*)?$/i);
  if (!m) throw new Error(`cannot read the version "${text}"`);
  const given = [];
  for (const part of m.slice(1)) {
    if (part === undefined || /^[x*]$/i.test(part)) break;
    given.push(Number(part));
  }
  const low = [...given, 0, 0, 0].slice(0, 3);
  const bump = (index) => [...given.slice(0, index), given[index] + 1, 0, 0, 0].slice(0, 3);
  const exact = given.length === 3;
  const any = [];
  const none = [{ op: "<", version: [0, 0, 0] }];
  if (given.length === 0) return op === ">" || op === "<" ? none : any;
  switch (op) {
    case ">=":
      return [{ op: ">=", version: low }];
    case ">":
      return exact ? [{ op: ">", version: low }] : [{ op: ">=", version: bump(given.length - 1) }];
    case "<":
      return [{ op: "<", version: low }];
    case "<=":
      return exact ? [{ op: "<=", version: low }] : [{ op: "<", version: bump(given.length - 1) }];
    case "~":
      return [{ op: ">=", version: low }, { op: "<", version: bump(Math.min(given.length - 1, 1)) }];
    case "^": {
      const first = given.findIndex((part) => part !== 0);
      const at = first === -1 ? given.length - 1 : first;
      return [{ op: ">=", version: low }, { op: "<", version: bump(at) }];
    }
    default:
      if (exact) return [{ op: ">=", version: low }, { op: "<=", version: low }];
      return [{ op: ">=", version: low }, { op: "<", version: bump(given.length - 1) }];
  }
}

function nodeRange(engines) {
  if (Array.isArray(engines)) return engines.find((entry) => /^node\b/.test(entry))?.replace(/^node\s*/, "");
  return engines?.node;
}

// A `${{ matrix.<key> }}` that names no matrix value is kept as written, so the CI test fails on it.
function ciNodeVersions(workflow) {
  const versions = [];
  for (const job of Object.values(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      const value = step.with?.["node-version"];
      if (value === undefined) continue;
      const key = String(value).match(/^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/)?.[1];
      const matrix = job.strategy?.matrix ?? {};
      const resolved = key
        ? [matrix[key], ...(Array.isArray(matrix.include) ? matrix.include : []).map((entry) => entry?.[key])]
            .flat()
            .filter((entry) => entry !== undefined && entry !== null)
        : [value];
      versions.push(...(resolved.length ? resolved : [value]).map(String));
    }
  }
  return versions;
}

test("rangeFloor reads the range shapes the lockfiles use", () => {
  assert.deepEqual(rangeFloor(">=20"), [20, 0, 0]);
  assert.deepEqual(rangeFloor(">= 14.6"), [14, 6, 0]);
  assert.deepEqual(rangeFloor(">=22.19.0"), [22, 19, 0]);
  assert.deepEqual(rangeFloor("^12.20.0 || ^14.13.1 || >=16.0.0"), [12, 20, 0]);
  assert.deepEqual(rangeFloor("4.x || >=6.0.0"), [4, 0, 0]);
  assert.deepEqual(rangeFloor("*"), [0, 0, 0]);
  assert.deepEqual(rangeFloor(">=18 <23"), [18, 0, 0]);
  assert.deepEqual(rangeFloor(">20"), [21, 0, 0]);
  assert.deepEqual(rangeFloor("20.6.0 - 22"), [20, 6, 0]);
});

test("admits checks the floor itself against every comparator of a range", () => {
  const floor = [20, 0, 0];
  for (const range of [
    ">=20", ">= 14.6", "^12.20.0 || ^14.13.1 || >=16.0.0", "^12.20 || >= 14.13", "4.x || >=6.0.0", "*", ">=18 <23",
    "20", "20.x", "^20", "~20", "<=20", "18 - 20", ">=0.10.0", ">=20.0.0-0",
  ]) {
    assert.ok(admits(range, floor), `${range} must admit 20.0.0`);
  }
  for (const range of [
    ">=22.19.0", ">20", "20.6.0 - 22", "^18.18.0 || ^20.9.0 || >=21.1.0", ">=18 <20", "^18", "~20.1", "<20", "18.x",
  ]) {
    assert.ok(!admits(range, floor), `${range} must not admit 20.0.0`);
  }
});

test("ciNodeVersions reads node-version from a step, from the job's matrix and from its include entries", () => {
  const workflow = parseYaml(
    [
      "jobs:",
      "  plain:",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - uses: actions/setup-node@v4",
      "        with: { node-version: 20 }",
      "  matrix:",
      "    strategy:",
      "      matrix:",
      "        os: [ubuntu-latest]",
      "        node: [20, '22.x']",
      "        include: [{ node: 24 }, { os: macos-latest }]",
      "    steps:",
      "      - uses: actions/setup-node@v4",
      "        with: { node-version: '${{ matrix.node }}' }",
      "  scalar:",
      "    strategy: { matrix: { node: 18 } }",
      "    steps:",
      "      - with: { node-version: '${{ matrix.node }}' }",
      "  unresolved:",
      "    steps:",
      "      - with: { node-version: '${{ matrix.missing }}' }",
    ].join("\n"),
  );
  assert.deepEqual(ciNodeVersions(workflow), ["20", "20", "22.x", "24", "18", "${{ matrix.missing }}"]);
});

test("every package.json declares the same Node floor", () => {
  const declared = PACKAGES.map((path) => [path, readJson(path).engines?.node]);
  for (const [path, range] of declared) assert.ok(range, `${path} declares no engines.node`);
  assert.deepEqual(
    [...new Set(declared.map(([, range]) => range))],
    [declared[0][1]],
    `engines.node differs: ${declared.map(([path, range]) => `${path} ${range}`).join(", ")}`,
  );
});

test("CI runs the Node major the floor declares", () => {
  const floor = rangeFloor(readJson("package.json").engines.node);
  const versions = ciNodeVersions(parseYaml(readFileSync(join(REPO_ROOT, WORKFLOW), "utf8")));
  assert.ok(versions.length > 0, `${WORKFLOW} sets no node-version`);
  const majors = versions.map((version) => Number(String(version).match(/^v?(\d+)/)?.[1]));
  assert.equal(Math.min(...majors), floor[0], `${WORKFLOW} runs Node ${versions.join(", ")}; the floor is ${floor[0]}`);
});

test("no locked package needs a newer Node than the declared floor", () => {
  const declared = readJson("package.json").engines.node;
  const floor = rangeFloor(declared);
  const problems = [];
  for (const lock of LOCKFILES) {
    for (const [path, entry] of Object.entries(readJson(lock).packages ?? {})) {
      const range = nodeRange(entry.engines);
      if (range && !admits(range, floor)) {
        const needs = `needs node ${range}, which ${floor.join(".")} does not satisfy`;
        problems.push(`${lock}: ${path || "(root)"} ${entry.version} ${needs}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
