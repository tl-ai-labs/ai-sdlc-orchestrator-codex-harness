/**
 * OpenAI strict structured output, which `codex exec --output-schema` sends: the root is an object, every object
 * lists `properties`, sets `additionalProperties: false` and requires each property, and only the keywords below
 * pass. A keyword missing from these lists counts as refused, so a schema this file cannot vouch for is enveloped.
 */

type Node = Record<string, unknown>;

const TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
const FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "ipv4", "ipv6", "uuid"]);
const NUMBER_KEYWORDS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"];
const KEYWORDS: Record<string, readonly string[]> = {
  string: ["pattern", "format"],
  number: NUMBER_KEYWORDS,
  integer: NUMBER_KEYWORDS,
  boolean: [],
  null: [],
  object: ["properties", "required", "additionalProperties"],
  array: ["items", "minItems", "maxItems"],
};
const ANY_TYPE_KEYWORDS = ["type", "description", "title", "enum", "const"];
const ANNOTATIONS = new Set(["description", "title"]);
// OpenAI's documented strict-mode limits. Past one the API refuses the request outright.
const MAX_NESTING = 10;
const MAX_PROPERTIES = 5000;
const MAX_ENUM_VALUES = 1000;

/** Sent in place of a schema strict mode would refuse; the packet's value travels JSON-encoded inside it. */
export const STRICT_RESULT_ENVELOPE = {
  type: "object",
  properties: { result_json: { type: "string" } },
  required: ["result_json"],
  additionalProperties: false,
} as const;

/** Each reason strict mode would refuse `schema`, as `path: reason`. Empty means it can be sent as it is. */
export function strictSchemaProblems(schema: unknown): string[] {
  const problems: string[] = [];
  if (!isNode(schema) || schema.type !== "object") {
    problems.push('schema: the root must be {"type": "object"}');
    if (!isNode(schema)) return problems;
  }
  check(schema, "schema", problems);
  const size = { depth: 0, properties: 0, enums: 0 };
  measure(schema, 0, size);
  if (size.depth > MAX_NESTING) problems.push(`schema: nests ${size.depth} objects and arrays deep, past strict mode's ${MAX_NESTING}`);
  if (size.properties > MAX_PROPERTIES) problems.push(`schema: has ${size.properties} properties, past strict mode's ${MAX_PROPERTIES}`);
  if (size.enums > MAX_ENUM_VALUES) problems.push(`schema: has ${size.enums} enum values, past strict mode's ${MAX_ENUM_VALUES}`);
  return problems;
}

/** Each object or array level counts toward the nesting limit; anyOf branches share their parent's level. */
function measure(node: unknown, level: number, size: { depth: number; properties: number; enums: number }): void {
  if (!isNode(node)) return;
  const types: unknown[] = typeof node.type === "string" ? [node.type] : Array.isArray(node.type) ? node.type : [];
  const here = types.includes("object") || types.includes("array") ? level + 1 : level;
  size.depth = Math.max(size.depth, here);
  if (Array.isArray(node.enum)) size.enums += node.enum.length;
  if (isNode(node.properties)) {
    size.properties += Object.keys(node.properties).length;
    for (const child of Object.values(node.properties)) measure(child, here, size);
  }
  if (isNode(node.items)) measure(node.items, here, size);
  if (Array.isArray(node.anyOf)) for (const branch of node.anyOf) measure(branch, level, size);
}

function check(node: unknown, path: string, problems: string[]): void {
  if (!isNode(node)) {
    problems.push(`${path}: not a schema object`);
    return;
  }
  if ("anyOf" in node) {
    const beside = Object.keys(node).filter((k) => k !== "anyOf" && !ANNOTATIONS.has(k));
    if (beside.length) problems.push(`${path}: anyOf beside ${beside.join(", ")}`);
    if (!Array.isArray(node.anyOf) || node.anyOf.length === 0) {
      problems.push(`${path}.anyOf: not a non-empty list`);
      return;
    }
    node.anyOf.forEach((branch, i) => check(branch, `${path}.anyOf[${i}]`, problems));
    return;
  }

  const declared: unknown[] = typeof node.type === "string" ? [node.type] : Array.isArray(node.type) ? node.type : [];
  if (declared.length === 0 || !declared.every((t) => typeof t === "string" && TYPES.has(t))) {
    problems.push(`${path}.type: missing or not one strict mode accepts`);
    return;
  }
  const types = declared as string[];
  const allowed = new Set([...ANY_TYPE_KEYWORDS, ...types.flatMap((t) => KEYWORDS[t])]);
  for (const key of Object.keys(node)) {
    if (!allowed.has(key)) problems.push(`${path}.${key}: keyword not accepted`);
  }
  if ("format" in node && !FORMATS.has(node.format as string)) {
    problems.push(`${path}.format: ${String(node.format)} is not accepted`);
  }
  if (types.includes("object")) checkObject(node, path, problems);
  if (types.includes("array")) {
    if (isNode(node.items)) check(node.items, `${path}.items`, problems);
    else problems.push(`${path}.items: an array needs one items schema`);
  }
}

function checkObject(node: Node, path: string, problems: string[]): void {
  if (node.additionalProperties !== false) problems.push(`${path}.additionalProperties: must be false`);
  if (!isNode(node.properties)) {
    problems.push(`${path}.properties: is required for object schemas`);
    return;
  }
  const keys = Object.keys(node.properties);
  if (!Array.isArray(node.required)) {
    problems.push(`${path}.required: must list every property`);
  } else {
    const required = node.required;
    const missing = keys.filter((k) => !required.includes(k));
    const strays = required.filter((k) => typeof k !== "string" || !keys.includes(k));
    if (missing.length) problems.push(`${path}.required: missing ${missing.join(", ")}`);
    if (strays.length) problems.push(`${path}.required: names ${strays.join(", ")}, not a property`);
  }
  for (const key of keys) check(node.properties[key], `${path}.properties.${key}`, problems);
}

/** Appended to the prompt when the envelope is sent, so the model knows what goes inside `result_json`. */
export function envelopeInstruction(schema: unknown): string {
  return [
    "### Output envelope",
    "Your reply is held to a JSON object with one string field, `result_json`. Put the JSON value this task asks",
    "for into `result_json`, encoded as a JSON string. That value must conform to this schema:",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
  ].join("\n");
}

export function jsonOrRaw(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** The value inside `result_json`. A message that is not an envelope reads as it would unenveloped. */
export function readEnvelope(message: string): unknown {
  const outer = jsonOrRaw(message);
  if (!isNode(outer) || typeof outer.result_json !== "string") return outer;
  return jsonOrRaw(outer.result_json);
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
