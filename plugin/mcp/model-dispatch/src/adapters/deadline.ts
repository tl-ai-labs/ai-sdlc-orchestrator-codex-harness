import type { ModelConfig } from "../types.js";

/**
 * A completion or codex-cli dispatch's deadline when its leaf sets no
 * worker_timeout_sec. It sits just below driverClient's per-call timeout:
 * any lower and it cuts a doubling chain the client would have waited for;
 * at or above it, the client gives up on a call the adapter is still working on.
 */
export const DEFAULT_DISPATCH_TIMEOUT_SEC = 840;

export function dispatchTimeoutMs(config: ModelConfig): number {
  return (config.worker_timeout_sec ?? DEFAULT_DISPATCH_TIMEOUT_SEC) * 1000;
}

export interface Deadline {
  /** Aborts at the deadline, or as soon as `outer` does. */
  readonly signal: AbortSignal;
  /** True once the deadline itself fired (not `outer`). */
  readonly expired: boolean;
  clear(): void;
}

/** One signal for the whole dispatch: every attempt, and every SDK retry inside one, shares it. */
export function startDeadline(ms: number, outer?: AbortSignal): Deadline {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort(new Error(`dispatch deadline of ${ms / 1000}s reached`));
  }, ms);
  const onOuter = () => controller.abort(outer?.reason);
  if (outer?.aborted) onOuter();
  else outer?.addEventListener("abort", onOuter, { once: true });
  return {
    signal: controller.signal,
    get expired() {
      return expired;
    },
    clear() {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuter);
    },
  };
}
