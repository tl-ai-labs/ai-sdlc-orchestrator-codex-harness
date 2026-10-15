import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  envelopeInstruction,
  readEnvelope,
  STRICT_RESULT_ENVELOPE,
  strictSchemaProblems,
} from "../dist/adapters/strictSchema.js";

const obj = (properties, extra = {}) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
  ...extra,
});

const ACCEPTED = [
  ["a flat object", obj({ ok: { type: "boolean" } })],
  ["the result envelope", STRICT_RESULT_ENVELOPE],
  ["an object with no properties at all", obj({})],
  ["nested objects", obj({ meta: obj({ owner: { type: "string" }, depth: obj({ n: { type: "integer" } }) }) })],
  [
    "an array of objects with properties",
    obj({ packets: { type: "array", items: obj({ id: { type: "string" }, files: { type: "array", items: { type: "string" } } }), minItems: 1 } }),
  ],
  ["anyOf whose branches are strict", obj({ choice: { anyOf: [obj({ a: { type: "string" } }), { type: "null" }] } })],
  ["a nullable type list", obj({ note: { type: ["string", "null"] } })],
  [
    "the keywords strict mode documents",
    obj({
      level: { type: "string", enum: ["low", "high"], description: "how much" },
      kind: { type: "string", const: "plan", title: "Kind" },
      when: { type: "string", format: "date-time" },
      slug: { type: "string", pattern: "^[a-z-]+$" },
      score: { type: "number", minimum: 0, maximum: 1, multipleOf: 0.5 },
    }),
  ],
];

for (const mode of ["greenfield", "brownfield"]) {
  ACCEPTED.push([
    `the shipped ${mode} plan schema`,
    JSON.parse(readFileSync(new URL(`../../../config/schemas/plan-packets.${mode}.json`, import.meta.url), "utf8")),
  ]);
}

for (const [name, schema] of ACCEPTED) {
  test(`strict mode accepts ${name}`, () => {
    assert.deepEqual(strictSchemaProblems(schema), []);
  });
}

const REFUSED = [
  [
    "the live brownfield plan schema: array items that are an object without properties",
    {
      type: "object",
      properties: { packets: { type: "array", items: { type: "object" } } },
      required: ["packets"],
      additionalProperties: false,
    },
    "schema.properties.packets.items.properties: is required for object schemas",
  ],
  ["the adapter's default {type: object}", { type: "object" }, "schema.properties: is required for object schemas"],
  ["a root object without additionalProperties: false", { type: "object", properties: {}, required: [] }, "schema.additionalProperties: must be false"],
  [
    "a nested object that allows extra properties",
    obj({ meta: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } }),
    "schema.properties.meta.additionalProperties: must be false",
  ],
  [
    "a nested object with an optional property",
    obj({ meta: { ...obj({ a: { type: "string" }, b: { type: "string" } }), required: ["a"] } }),
    "schema.properties.meta.required: missing b",
  ],
  ["an object with no required list", { ...obj({ a: { type: "string" } }), required: undefined }, "schema.required: must list every property"],
  ["required naming a key that is not a property", { ...obj({ a: { type: "string" } }), required: ["a", "z"] }, "schema.required: names z, not a property"],
  ["an array with no items", obj({ list: { type: "array" } }), "schema.properties.list.items: an array needs one items schema"],
  ["tuple items", obj({ pair: { type: "array", items: [{ type: "string" }] } }), "schema.properties.pair.items: an array needs one items schema"],
  [
    "an array of objects whose items allow extra properties",
    obj({ rows: { type: "array", items: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } } }),
    "schema.properties.rows.items.additionalProperties: must be false",
  ],
  [
    "an anyOf branch that is a loose object",
    obj({ choice: { anyOf: [{ type: "string" }, { type: "object" }] } }),
    "schema.properties.choice.anyOf[1].properties: is required for object schemas",
  ],
  ["anyOf beside a type", obj({ choice: { type: "string", anyOf: [{ type: "string" }] } }), "schema.properties.choice: anyOf beside type"],
  ["an anyOf root", { anyOf: [obj({ a: { type: "string" } })] }, 'schema: the root must be {"type": "object"}'],
  ["an array root", { type: "array", items: { type: "string" } }, 'schema: the root must be {"type": "object"}'],
  ["a non-object root", null, 'schema: the root must be {"type": "object"}'],
  ["a property with no type", obj({ any: { description: "anything" } }), "schema.properties.any.type: missing or not one strict mode accepts"],
  ["an unknown type", obj({ when: { type: "datetime" } }), "schema.properties.when.type: missing or not one strict mode accepts"],
  ["minLength", obj({ name: { type: "string", minLength: 1 } }), "schema.properties.name.minLength: keyword not accepted"],
  ["default", obj({ name: { type: "string", default: "x" } }), "schema.properties.name.default: keyword not accepted"],
  ["allOf", obj({ x: { type: "object", allOf: [] } }), "schema.properties.x.allOf: keyword not accepted"],
  ["$defs", { ...obj({ x: { type: "string" } }), $defs: {} }, "schema.$defs: keyword not accepted"],
  ["patternProperties", obj({}, { patternProperties: {} }), "schema.patternProperties: keyword not accepted"],
  ["a keyword for another type", obj({ n: { type: "integer", pattern: "^1$" } }), "schema.properties.n.pattern: keyword not accepted"],
  ["a format strict mode does not list", obj({ link: { type: "string", format: "uri" } }), "schema.properties.link.format: uri is not accepted"],
  ["the free-text marker", { __free_text__: true }, 'schema: the root must be {"type": "object"}'],
];

for (const [name, schema, problem] of REFUSED) {
  test(`strict mode refuses ${name}`, () => {
    const problems = strictSchemaProblems(schema);
    assert.ok(problems.includes(problem), `expected "${problem}" among ${JSON.stringify(problems)}`);
  });
}

/** `levels` objects nested one inside the next, the root counted. */
const nested = (levels) => {
  let node = obj({ leaf: { type: "string" } });
  for (let i = 1; i < levels; i++) node = obj({ inner: node });
  return node;
};

test("strict mode's documented limits: 10 levels of nesting, 5000 properties, 1000 enum values", () => {
  assert.deepEqual(strictSchemaProblems(nested(10)), []);
  assert.ok(strictSchemaProblems(nested(11)).includes("schema: nests 11 objects and arrays deep, past strict mode's 10"));
  const arrays = obj({ a: { type: "array", items: { type: "array", items: nested(9) } } });
  assert.ok(strictSchemaProblems(arrays).some((p) => p.startsWith("schema: nests 12 objects and arrays deep")), "an array is a level too");

  const wide = (n) => obj(Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, { type: "string" }])));
  assert.deepEqual(strictSchemaProblems(wide(5000)), []);
  assert.ok(strictSchemaProblems(obj({ a: wide(2500), b: wide(2500) })).includes("schema: has 5002 properties, past strict mode's 5000"));

  const values = (n) => Array.from({ length: n }, (_, i) => `v${i}`);
  assert.deepEqual(strictSchemaProblems(obj({ e: { type: "string", enum: values(1000) } })), []);
  assert.ok(strictSchemaProblems(obj({ e: { type: "string", enum: values(600) }, f: { anyOf: [{ type: "string", enum: values(401) }, { type: "null" }] } }))
    .includes("schema: has 1001 enum values, past strict mode's 1000"));
});

test("the envelope instruction carries the packet's schema", () => {
  const schema = { type: "object", properties: { packets: { type: "array", items: { type: "object" } } } };
  const text = envelopeInstruction(schema);
  assert.match(text, /`result_json`/);
  assert.ok(text.includes(JSON.stringify(schema, null, 2)));
});

test("readEnvelope returns the value inside result_json", () => {
  assert.deepEqual(readEnvelope(JSON.stringify({ result_json: JSON.stringify({ packets: [{ id: "p1" }] }) })), {
    packets: [{ id: "p1" }],
  });
  assert.deepEqual(readEnvelope(JSON.stringify({ result_json: "[1,2]" })), [1, 2]);
});

test("readEnvelope wraps unparseable result_json as raw, the way an unparseable final message is wrapped", () => {
  assert.deepEqual(readEnvelope(JSON.stringify({ result_json: "half {" })), { raw: "half {" });
  assert.deepEqual(readEnvelope("not json"), { raw: "not json" });
});

test("readEnvelope reads a message that is not an envelope as it would unenveloped", () => {
  assert.deepEqual(readEnvelope(JSON.stringify({ ok: true })), { ok: true });
  assert.deepEqual(readEnvelope(JSON.stringify({ result_json: 5 })), { result_json: 5 });
});
