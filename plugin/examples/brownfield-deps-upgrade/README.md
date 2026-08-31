# Example — `deps` intent

A tiny Express app pinned to `lodash@4.17.20` — a version with a known prototype-pollution
advisory (CVE-2020-8203, patched in 4.17.21). Task: upgrade to a safe version and adapt any
code that breaks.

## What's here

```
package.json         — pinned lodash 4.17.20
src/
├── index.js         — Express app using lodash.merge for config
├── config.js        — deep-merges a default config with env overrides
└── config.spec.js   — one test verifying deep-merge behavior
```

## Try it

```bash
cd plugin/examples/brownfield-deps-upgrade
npm install
npm audit           # reports the CVE
npm test            # 1 test passes

# /mmo:brownfield  →  deps
```

## Expected outputs

- `package.json` — edited: `lodash` upgraded to a safe version (patched or a newer major)
- `src/config.js` — edited if the upgrade changed the merge API (major bumps have)
- `src/config.spec.js` — unchanged (test is the invariant)
- Test still passes; `npm audit` clean

See [intent_brief.md](intent_brief.md).
