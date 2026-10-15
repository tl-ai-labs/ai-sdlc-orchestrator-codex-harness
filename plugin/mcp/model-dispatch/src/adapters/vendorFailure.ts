/**
 * A failed vendor call, described by the vendor SDK's own fields rather than
 * its wording, and the billing rule each adapter applies to it.
 */

/** Node/undici codes of a request that never left this machine, so nothing reached the vendor to bill. */
export const NEVER_SENT_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
  "EAI_AGAIN",
]);

export interface VendorFailure {
  error_status?: number;
  error_code?: string;
  retry_after_ms?: number;
}

/**
 * The HTTP status on the SDK's error (@google/genai ApiError, openai
 * APIError), the connection code on the error or its `cause`, and the delay
 * a google.rpc.RetryInfo entry in a JSON error body asks for.
 */
export function describeVendorFailure(err: any): VendorFailure {
  const out: VendorFailure = {};
  if (typeof err?.status === "number") out.error_status = err.status;
  const code = err?.cause?.code ?? err?.code;
  if (typeof code === "string") out.error_code = code;
  let body: any;
  try {
    body = JSON.parse(err?.message ?? "");
  } catch {
    body = undefined;
  }
  const details = Array.isArray(body?.error?.details) ? body.error.details : [];
  const info = details.find((d: any) => typeof d?.["@type"] === "string" && d["@type"].endsWith("google.rpc.RetryInfo"));
  // A protobuf Duration in JSON: seconds with an "s" suffix ("7s", "0.5s").
  const m = typeof info?.retryDelay === "string" ? /^(\d+(?:\.\d+)?)s$/.exec(info.retryDelay) : null;
  if (m) out.retry_after_ms = Math.round(Number(m[1]) * 1000);
  return out;
}

export function neverSent(f: VendorFailure): boolean {
  return f.error_code !== undefined && NEVER_SENT_CODES.has(f.error_code);
}

export function answeredWithError(f: VendorFailure): boolean {
  return f.error_status !== undefined && f.error_status !== 200;
}
