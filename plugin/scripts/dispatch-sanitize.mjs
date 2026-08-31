#!/usr/bin/env node
/**
 * Dispatch sanitizer. Runs on every dispatch input before it leaves the
 * machine — regex sweep for concrete secret patterns; blocks (throws in
 * library use, exits 1 in CLI use) when any is found. Per plan §19: no
 * secret ever crosses the wire to a model provider.
 *
 * Deliberately narrow. We only match patterns with very-low false-positive
 * rates (known vendor prefixes, PEM headers, explicit-assignment lines).
 * A broad "high-entropy string" detector would flag legitimate hashes and
 * IDs, would train users to bypass the check, and would produce a
 * false-sense-of-security. Narrow and precise > broad and noisy.
 *
 * Programmatic use (imported by MCP adapters):
 *   import { scan, assertSafe } from ".../dispatch-sanitize.mjs";
 *   const findings = scan(text);
 *   if (findings.length) throw new Error(formatFindings(findings));
 *
 * CLI use (for testing / auditing an input file):
 *   node dispatch-sanitize.mjs path/to/file.txt
 *   cat file.txt | node dispatch-sanitize.mjs
 *
 * CLI exits 0 (clean) or 1 (findings printed to stderr). No file content
 * is echoed — findings show only pattern name + line number + a short
 * masked preview, never the raw match.
 */

// ─── patterns ─────────────────────────────────────────────────────────
// Each entry: { name, kind, re }. `re` MUST have the /g flag so scan()
// can iterate all matches. Groups may be present but scan() ignores them.

export const PATTERNS = [
  // PEM-encoded key blocks — RSA, EC, PGP, DSA, OpenSSH, generic.
  {
    name: "pem-private-key",
    kind: "cryptographic-key",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY-----[\s\S]{40,}?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY-----/g,
  },

  // AWS access key ID — 20-char, starts with AKIA/ABIA/ASIA/AIDA/AGPA/AROA/AIPA/ANPA/ANVA.
  {
    name: "aws-access-key-id",
    kind: "aws",
    re: /\b(?:AKIA|ABIA|ASIA|AIDA|AGPA|AROA|AIPA|ANPA|ANVA|A3T[A-Z0-9])[A-Z0-9]{16}\b/g,
  },

  // AWS secret assigned in an env-var line or JSON field.
  // Explicit assignment reduces false positives on random 40-char strings.
  {
    name: "aws-secret-access-key-assignment",
    kind: "aws",
    re: /\bAWS_SECRET_ACCESS_KEY\s*[:=]\s*["']?[A-Za-z0-9\/+=]{40}["']?/g,
  },

  // GitHub tokens (personal, oauth, server-to-server, refresh, user-to-server).
  {
    name: "github-token",
    kind: "github",
    re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  },

  // GitHub fine-grained personal access token
  {
    name: "github-fine-grained-pat",
    kind: "github",
    re: /\bgithub_pat_[A-Za-z0-9_]{82,}\b/g,
  },

  // Google API key
  {
    name: "google-api-key",
    kind: "google",
    re: /\bAIza[0-9A-Za-z\-_]{35}\b/g,
  },

  // Google OAuth access / refresh tokens (ya29.* / 1//)
  {
    name: "google-oauth-token",
    kind: "google",
    re: /\bya29\.[0-9A-Za-z\-_]{40,}\b/g,
  },

  // Anthropic API key
  {
    name: "anthropic-api-key",
    kind: "anthropic",
    re: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9\-_]{80,}\b/g,
  },

  // OpenAI keys (classic + project-scoped)
  {
    name: "openai-api-key",
    kind: "openai",
    re: /\bsk-(?:proj-)?[A-Za-z0-9_\-]{40,}\b/g,
  },

  // Slack bot / user / app tokens
  {
    name: "slack-token",
    kind: "slack",
    re: /\bxox[baprs]-[A-Za-z0-9\-]{10,}\b/g,
  },

  // Stripe live/test secret keys (exclude publishable pk_)
  {
    name: "stripe-secret-key",
    kind: "stripe",
    re: /\brk_(?:live|test)_[A-Za-z0-9]{20,}\b|\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
  },

  // Bearer tokens in an Authorization header line
  {
    name: "authorization-bearer",
    kind: "http-header",
    re: /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._\-]{30,}\b/gi,
  },

  // JWT — three base64url segments separated by dots. Length gates avoid
  // matching version strings.
  {
    name: "jwt",
    kind: "token",
    re: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g,
  },

  // Anthropic bearer literal in a fetch/curl (matches the value assignment shape)
  {
    name: "anthropic-key-assignment",
    kind: "anthropic",
    re: /\bANTHROPIC_API_KEY\s*[:=]\s*["']?sk-ant-[A-Za-z0-9\-_]{20,}["']?/g,
  },

  // Explicit high-signal env assignments — the value doesn't matter, the
  // fact that a real value is present next to one of these var names does.
  {
    name: "sensitive-env-assignment",
    kind: "env-assignment",
    re: /\b(?:GEMINI_API_KEY|GOOGLE_API_KEY|GITHUB_TOKEN|SLACK_TOKEN|SLACK_BOT_TOKEN|STRIPE_SECRET_KEY|DATABASE_URL|DATABASE_PASSWORD|DB_PASSWORD|POSTGRES_PASSWORD|MYSQL_PASSWORD|REDIS_PASSWORD|SMTP_PASSWORD|JWT_SECRET|SESSION_SECRET|COOKIE_SECRET|ENCRYPTION_KEY|PRIVATE_KEY|SECRET_KEY)\s*[:=]\s*["']?[^\s"'`]{8,}["']?/g,
  },
];

// ─── helpers ──────────────────────────────────────────────────────────

/** Mask all but the first 4 and last 2 chars, min-length 8. */
function mask(s) {
  if (typeof s !== "string" || s.length < 8) return "***";
  return s.slice(0, 4) + "…" + s.slice(-2);
}

/** Line number (1-indexed) for a character offset. */
function lineFor(text, offset) {
  let ln = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") ln++;
  return ln;
}

// ─── public API ───────────────────────────────────────────────────────

/**
 * Scan a string for secret patterns. Returns an array of findings; never
 * echoes the raw match (returns a masked preview instead).
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.maxFindings=50] — stop at N findings to bound work.
 * @returns {Array<{name:string, kind:string, line:number, preview:string}>}
 */
export function scan(text, opts = {}) {
  if (typeof text !== "string" || text.length === 0) return [];
  const maxFindings = opts.maxFindings ?? 50;
  const findings = [];
  for (const { name, kind, re } of PATTERNS) {
    // Reset lastIndex — the regex is a shared module-level constant, and
    // exec() with /g maintains state.
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (findings.length >= maxFindings) return findings;
      findings.push({
        name,
        kind,
        line: lineFor(text, m.index),
        preview: mask(m[0]),
      });
    }
  }
  return findings;
}

/**
 * Throw if the text contains anything matched by scan(). Adapters call
 * this on every dispatch input before sending it to the model provider.
 *
 * @param {string} text
 * @param {object} [context] — optional { source, hint } added to the error.
 */
export function assertSafe(text, context = {}) {
  const findings = scan(text);
  if (findings.length === 0) return;
  const source = context.source ? ` in ${context.source}` : "";
  const summary = findings
    .slice(0, 5)
    .map((f) => `  · ${f.name} at line ${f.line} (${f.preview})`)
    .join("\n");
  const more = findings.length > 5 ? `\n  · …and ${findings.length - 5} more` : "";
  const err = new Error(
    `dispatch-sanitize: refused to dispatch — ${findings.length} secret-shaped ${findings.length === 1 ? "pattern" : "patterns"} detected${source}. ` +
      `Remove the secret before it leaves the machine.\n${summary}${more}`
  );
  err.name = "SanitizeBlocked";
  err.findings = findings;
  throw err;
}

// ─── CLI ──────────────────────────────────────────────────────────────

async function readAll(stream) {
  return await new Promise((resolveP, rejectP) => {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (c) => (buf += c));
    stream.on("end", () => resolveP(buf));
    stream.on("error", rejectP);
  });
}

async function cli(argv) {
  const arg = argv[2];
  let text;
  if (arg && arg !== "-") {
    const { readFile } = await import("node:fs/promises");
    text = await readFile(arg, "utf8");
  } else {
    text = await readAll(process.stdin);
  }
  const findings = scan(text);
  if (findings.length === 0) {
    console.log("clean");
    process.exit(0);
  }
  console.error(`dispatch-sanitize: ${findings.length} finding(s)`);
  for (const f of findings) {
    console.error(`  ${f.kind}/${f.name} @ line ${f.line}: ${f.preview}`);
  }
  process.exit(1);
}

// Detect direct CLI invocation vs library import.
if (import.meta.url === `file://${process.argv[1]}`) {
  cli(process.argv).catch((e) => {
    console.error(`dispatch-sanitize CLI error: ${e?.message ?? e}`);
    process.exit(2);
  });
}
