/**
 * Log-line redaction. TypeScript port of the pattern registry in
 * plugin/scripts/dispatch-sanitize.mjs — that file is ESM under
 * plugin/scripts/ and this compiles into the MCP server, so the two layers
 * cannot share one copy (§3). tools/test/logging.test.mjs runs the same
 * fixture strings against both and asserts identical findings.
 *
 * Different job from dispatch-sanitize.mjs: that one blocks a dispatch
 * outright when a secret-shaped string is found. This one never blocks —
 * a log line always gets written — it just replaces the match so the
 * secret itself never reaches disk or stderr.
 */

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: "pem-private-key",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY-----[\s\S]{40,}?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY-----/g,
  },
  {
    name: "aws-access-key-id",
    re: /\b(?:AKIA|ABIA|ASIA|AIDA|AGPA|AROA|AIPA|ANPA|ANVA|A3T[A-Z0-9])[A-Z0-9]{16}\b/g,
  },
  {
    name: "aws-secret-access-key-assignment",
    re: /\bAWS_SECRET_ACCESS_KEY\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}["']?/g,
  },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: "github-fine-grained-pat", re: /\bgithub_pat_[A-Za-z0-9_]{82,}\b/g },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
  { name: "google-oauth-token", re: /\bya29\.[0-9A-Za-z\-_]{40,}\b/g },
  { name: "anthropic-api-key", re: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9\-_]{80,}\b/g },
  { name: "openai-api-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b/g },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  {
    name: "stripe-secret-key",
    re: /\brk_(?:live|test)_[A-Za-z0-9]{20,}\b|\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
  },
  { name: "authorization-bearer", re: /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._-]{30,}\b/gi },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    name: "anthropic-key-assignment",
    re: /\bANTHROPIC_API_KEY\s*[:=]\s*["']?sk-ant-[A-Za-z0-9\-_]{20,}["']?/g,
  },
  {
    name: "sensitive-env-assignment",
    re: /\b(?:GEMINI_API_KEY|GOOGLE_API_KEY|GITHUB_TOKEN|SLACK_TOKEN|SLACK_BOT_TOKEN|STRIPE_SECRET_KEY|DATABASE_URL|DATABASE_PASSWORD|DB_PASSWORD|POSTGRES_PASSWORD|MYSQL_PASSWORD|REDIS_PASSWORD|SMTP_PASSWORD|JWT_SECRET|SESSION_SECRET|COOKIE_SECRET|ENCRYPTION_KEY|PRIVATE_KEY|SECRET_KEY)\s*[:=]\s*["']?[^\s"'`]{8,}["']?/g,
  },
];

/** Names of patterns that matched, for tests comparing against dispatch-sanitize.mjs's scan(). */
export function findPatternNames(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const found: string[] = [];
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) found.push(name);
  }
  return found;
}

/** Replace every secret-shaped match with a placeholder. Never throws, never partial-leaks. */
export function redactText(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;
  let out = text;
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, `[redacted:${name}]`);
  }
  return out;
}
