/**
 * The two doors into Gemini, behind one interface. GeminiFlashAdapter owns
 * everything model-agnostic (doubling loop, prompt assembly, JSON-schema mode,
 * telemetry); this module owns request signing and endpoint choice.
 *
 *   api-key    — Google AI Studio. API key in an env var.
 *   vertex-adc — Vertex AI. Application Default Credentials; bills a project.
 *
 * Both run on `@google/genai`. Backend selection is a pure function so the
 * precedence rules are unit-testable without touching process state.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { GoogleGenAI } from "@google/genai";
import { log } from "../log.js";

// ─── backend selection (pure; unit-tested) ────────────────────────────

export type GeminiBackend = "api-key" | "vertex-adc";

export interface BackendSelectionInput {
  /** process.env (or a fixture in tests). */
  env: Record<string, string | undefined>;
  /** The env var the policy names for the API key (auth.env, default GEMINI_API_KEY). */
  keyEnvName: string;
  /** Whether a default gcloud ADC file exists on this machine. */
  adcFileExists: boolean;
}

export interface BackendChoice {
  backend: GeminiBackend;
  /** Human-readable trail for logs and error messages. */
  reason: string;
}

/**
 * Precedence:
 *   1. GEMINI_BACKEND=vertex|api-key — explicit override.
 *   2. Policy's API-key env var set → api-key. A key is a deliberate local
 *      decision; ADC is often ambient machine state.
 *   3. Any Vertex signal (GOOGLE_APPLICATION_CREDENTIALS, ADC file, or
 *      GOOGLE_CLOUD_PROJECT) → vertex-adc.
 *   4. Nothing → throw, naming both doors.
 */
export function selectGeminiBackend(input: BackendSelectionInput): BackendChoice {
  const { env, keyEnvName, adcFileExists } = input;
  const choice = resolveGeminiBackend(input);
  // Logged on every call; this is a pure function, so no run-scoped dedup state.
  log("info", "api.gemini.backend", {
    backend: choice.backend,
    reason: choice.reason,
    project: env.GOOGLE_CLOUD_PROJECT,
    adc_file_present: adcFileExists,
  });
  return choice;

  function resolveGeminiBackend(input: BackendSelectionInput): BackendChoice {
    const override = env.GEMINI_BACKEND?.trim().toLowerCase();
    if (override) {
      if (override === "vertex") return { backend: "vertex-adc", reason: "GEMINI_BACKEND=vertex" };
      if (override === "api-key") return { backend: "api-key", reason: "GEMINI_BACKEND=api-key" };
      throw new Error(
        `GEMINI_BACKEND='${env.GEMINI_BACKEND}' is not a recognized value. Use 'vertex' or 'api-key', ` +
          `or unset it to let credentials decide.`,
      );
    }

    if (env[keyEnvName]) return { backend: "api-key", reason: `${keyEnvName} is set` };

    if (env.GOOGLE_APPLICATION_CREDENTIALS) {
      return { backend: "vertex-adc", reason: "GOOGLE_APPLICATION_CREDENTIALS is set" };
    }
    if (adcFileExists) {
      return { backend: "vertex-adc", reason: "gcloud ADC file present" };
    }
    if (env.GOOGLE_CLOUD_PROJECT) {
      return { backend: "vertex-adc", reason: "GOOGLE_CLOUD_PROJECT is set" };
    }

    // Keep aligned with verify-setup.mjs's `gemini-credentials` warning
    // (synced by hand — that script runs pre-build).
    throw new Error(
      `No Gemini credentials found. Either authenticate to Vertex AI with ` +
        `\`gcloud auth application-default login\` (no key; the project is read from ` +
        `GOOGLE_CLOUD_PROJECT, or from the ADC file's quota project), or export ` +
        `${keyEnvName}=... for the AI Studio path (https://aistudio.google.com/app/apikey).`,
    );
  }
}

/** Default location of the ADC file `gcloud auth application-default login` writes. */
export function defaultAdcPath(home: string = homedir()): string {
  return join(home, ".config", "gcloud", "application_default_credentials.json");
}

/**
 * GOOGLE_CLOUD_PROJECT → the project inside the credentials file.
 * Undefined when nothing resolves: generateContent still works (SDK runs its
 * own resolution against gcloud config and the metadata server), but explicit
 * cache creation is skipped because the cache name embeds the project.
 */
export function resolveGcpProject(
  env: Record<string, string | undefined>,
  adcPath: string = defaultAdcPath(),
): string | undefined {
  if (env.GOOGLE_CLOUD_PROJECT) return env.GOOGLE_CLOUD_PROJECT;
  const candidate = env.GOOGLE_APPLICATION_CREDENTIALS ?? adcPath;
  try {
    const parsed = JSON.parse(readFileSync(candidate, "utf8"));
    // User ADC records quota_project_id; service-account files record project_id.
    return parsed.quota_project_id ?? parsed.project_id ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Region for Vertex calls. Defaults to `global` — a pricing default, not
 * latency: Vertex bills regional endpoints +10% on every token class for
 * Gemini 3+ (effective 2026-07-01), and the policy YAMLs pin the flat global
 * rates. Overriding with GOOGLE_CLOUD_LOCATION applies the surcharge to the
 * reported cost — see applyVertexSurcharge.
 */
export function resolveGcpLocation(env: Record<string, string | undefined>): string {
  return env.GOOGLE_CLOUD_LOCATION ?? "global";
}

// Vertex regional surcharge — Gemini 3+ non-global endpoints, effective
// 2026-07-01. https://cloud.google.com/vertex-ai/generative-ai/pricing
export const VERTEX_NONGLOBAL_SURCHARGE = 1.1;
export const VERTEX_NONGLOBAL_EFFECTIVE = "2026-07-01";

/** A Vertex location bills the surcharge unless it is the flat "global" endpoint. */
export function isVertexNonGlobal(location: string): boolean {
  return Boolean(location) && location.trim().toLowerCase() !== "global";
}

/**
 * Gemini 3+ only (2.5 has no regional premium). Family digit rather than
 * allow-list, so a new 3.x/4.x id surcharges by default — over-reporting is
 * the safe direction, under-reporting is not.
 */
export function vertexSurchargeApplies(modelName: string): boolean {
  const m = modelName.trim().toLowerCase();
  if (!m.startsWith("gemini-")) return false;
  const major = Number(m.slice("gemini-".length).match(/^(\d+)/)?.[1]);
  return Number.isFinite(major) && major >= 3;
}

/**
 * Pinned rates on AI Studio and Vertex's global endpoint (every default run);
 * x1.10 on a pinned regional endpoint.
 */
export function applyVertexSurcharge<T extends { input: number; input_cached: number; output: number }>(
  pricing: T,
  opts: { backend: GeminiBackend; location: string; modelName: string },
): T {
  const surcharged =
    opts.backend === "vertex-adc" &&
    isVertexNonGlobal(opts.location) &&
    vertexSurchargeApplies(opts.modelName);
  if (!surcharged) return pricing;
  const k = VERTEX_NONGLOBAL_SURCHARGE;
  return {
    ...pricing,
    input: pricing.input * k,
    input_cached: pricing.input_cached * k,
    output: pricing.output * k,
  };
}

/**
 * Google bills reasoning at the output rate. `thoughtsTokenCount` is a
 * SIBLING of `candidatesTokenCount`, not a subset (contrast
 * `cachedContentTokenCount`, which IS a subset of `promptTokenCount` — the
 * two fields look alike and behave oppositely). Billed output = sum.
 */
export function billedOutputTokens(usage: Record<string, number | undefined>): number {
  return (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
}

// ─── the transport interface ──────────────────────────────────────────

export interface GenerateArgs {
  modelName: string;
  prompt: string;
  generationConfig: Record<string, unknown>;
  /** Server-side cache resource name from createCache; omit on cache miss. */
  cachedContentName?: string;
}

export interface GenerateOutcome {
  text: string;
  /** Vendor usageMetadata verbatim: promptTokenCount / candidatesTokenCount / cachedContentTokenCount. */
  usage: Record<string, number | undefined>;
  finishReason?: string;
}

export interface GeminiTransport {
  readonly backend: GeminiBackend;
  /** "global" or a region name; empty on the AI Studio path. Cost depends on it. */
  readonly location: string;
  /** Create an explicit context cache; undefined → adapter inlines the header. */
  createCache(
    modelName: string,
    displayName: string,
    headerText: string,
    ttlSeconds: number,
  ): Promise<string | undefined>;
  generate(args: GenerateArgs): Promise<GenerateOutcome>;
}

// ─── the shared implementation behind both doors ──────────────────────

/**
 * Shared request/response handling. The two doors differ only in client
 * construction and how the caches API addresses a model.
 */
abstract class GenAiTransport implements GeminiTransport {
  abstract readonly backend: GeminiBackend;
  abstract readonly location: string;
  protected readonly ai: GoogleGenAI;

  protected constructor(ai: GoogleGenAI) {
    this.ai = ai;
  }

  /**
   * Model name for the caches API. Vertex needs a fully-qualified resource
   * path (project + location); AI Studio takes bare `models/<name>`.
   * Undefined → cache cannot be addressed.
   */
  protected abstract cacheModelId(modelName: string): string | undefined;

  async createCache(
    modelName: string,
    displayName: string,
    headerText: string,
    ttlSeconds: number,
  ): Promise<string | undefined> {
    const model = this.cacheModelId(modelName);
    if (!model) return undefined;
    const created = await this.ai.caches.create({
      model,
      config: {
        displayName,
        contents: [{ role: "user", parts: [{ text: headerText }] }],
        ttl: `${ttlSeconds}s`,
      },
    });
    log("debug", "api.gemini.cache.create", {
      cache_context: displayName,
      token_count: undefined,
      ttl: ttlSeconds,
    });
    return created?.name;
  }

  async generate(args: GenerateArgs): Promise<GenerateOutcome> {
    log("debug", "api.gemini.request", {
      model_name: args.modelName,
      transport: this.backend,
      cached_content: args.cachedContentName,
      max_output_tokens: (args.generationConfig as any)?.maxOutputTokens,
      thinking_budget: (args.generationConfig as any)?.thinkingConfig?.thinkingBudget,
    });
    if (args.cachedContentName) {
      log("debug", "api.gemini.cache.hit", { cache_context: args.cachedContentName });
    }
    const resp = await this.ai.models.generateContent({
      model: args.modelName,
      contents: [{ role: "user", parts: [{ text: args.prompt }] }],
      config: {
        ...(args.generationConfig as Record<string, unknown>),
        ...(args.cachedContentName ? { cachedContent: args.cachedContentName } : {}),
      },
    });
    const finishReason = resp.candidates?.[0]?.finishReason
      ? String(resp.candidates[0].finishReason)
      : undefined;
    log("debug", "api.gemini.response", {
      model_name: args.modelName,
      transport: this.backend,
      finish_reason: finishReason,
      usage: JSON.stringify(resp.usageMetadata ?? {}),
      http_status: 200,
    });
    return {
      // `text` is "" (not undefined) when the model returned no text —
      // happens when the output cap is spent entirely on thinking.
      text: resp.text ?? "",
      usage: (resp.usageMetadata ?? {}) as Record<string, number | undefined>,
      finishReason,
    };
  }
}

// ─── door 1: AI Studio API key ────────────────────────────────────────

export class ApiKeyTransport extends GenAiTransport {
  readonly backend: GeminiBackend = "api-key";
  // AI Studio has no regional endpoints.
  readonly location = "";

  constructor(apiKey: string) {
    super(new GoogleGenAI({ apiKey }));
  }

  protected cacheModelId(modelName: string): string {
    return `models/${modelName}`;
  }
}

// ─── door 2: Vertex AI with Application Default Credentials ───────────

export class VertexAdcTransport extends GenAiTransport {
  readonly backend: GeminiBackend = "vertex-adc";
  readonly location: string;
  private readonly project?: string;

  constructor(env: Record<string, string | undefined> = process.env) {
    const project = resolveGcpProject(env);
    const location = resolveGcpLocation(env);
    // Only pass project when resolved, so the SDK can fall back to its own
    // resolution (gcloud config, metadata server).
    super(
      new GoogleGenAI({
        vertexai: true,
        ...(project ? { project } : {}),
        location,
      }),
    );
    this.project = project;
    this.location = location;
  }

  protected cacheModelId(modelName: string): string | undefined {
    if (!this.project) return undefined;
    return `projects/${this.project}/locations/${this.location}/publishers/google/models/${modelName}`;
  }
}

// ─── construction helper used by GeminiFlashAdapter ───────────────────

export function buildGeminiTransport(
  keyEnvName: string,
  env: Record<string, string | undefined> = process.env,
): { transport: GeminiTransport; choice: BackendChoice } {
  const choice = selectGeminiBackend({
    env,
    keyEnvName,
    adcFileExists: existsSync(defaultAdcPath()),
  });
  const transport =
    choice.backend === "api-key"
      ? new ApiKeyTransport(env[keyEnvName]!)
      : new VertexAdcTransport(env);
  return { transport, choice };
}
