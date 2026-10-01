import type {
  EnforceResult,
  X402Backend,
  X402BackendContext,
} from "../index.js";

/**
 * Deployment-owned durable storage and atomic coordination across processes.
 * For each key, elect one action owner and make concurrent retries wait. Persist
 * the completed result before returning it, and return that result on retries.
 * Persist uncertain failures (including crashes after possible side effects) and
 * fail closed: never automatically release the key for another action attempt.
 * Recovery requires an explicit deployment policy; retention must cover the
 * payment replay window. Results must be durably serializable/reconstructable.
 * A process-local cache does not satisfy this contract.
 */
export interface ProtectedActionReplayCoordinator<T> {
  runOnce(key: string, action: () => Promise<T>): Promise<T>;
}

export interface ProtectedActionReplayKeyContext {
  request: Request;
  context: X402BackendContext;
  enforcement: EnforceResult;
}

/** Must bind the paid operation consistently across all participating instances. */
export type ProtectedActionReplayKeyProvider = (
  input: ProtectedActionReplayKeyContext,
) => string | Promise<string>;

export interface ExperimentalPaidActionExecutorOptions<T> {
  backend: X402Backend;
  replayCoordinator: ProtectedActionReplayCoordinator<T>;
  /** Replaces the default key policy, including its required identity inputs. */
  replayKeyProvider?: ProtectedActionReplayKeyProvider;
}

/** Prototype framework boundary; not exported by the package or production-ready. */
export function createExperimentalPaidActionExecutor<T>(
  options: ExperimentalPaidActionExecutorOptions<T>,
) {
  return async (
    request: Request,
    context: X402BackendContext,
    action: (enforcement: EnforceResult) => T | Promise<T>,
  ): Promise<Response | T> => {
    const enforcement = await options.backend.enforce(request, context);
    if (enforcement instanceof Response) return enforcement;
    if (!enforcement.paid) return action(enforcement);

    const key = await (options.replayKeyProvider ?? defaultReplayKey)({
      request,
      context,
      enforcement,
    });
    if (typeof key !== "string" || !key.trim()) {
      throw new Error("Paid action replay requires a non-empty replay key");
    }
    return options.replayCoordinator.runOnce(key, async () => action(enforcement));
  };
}

async function defaultReplayKey({
  request,
  enforcement,
}: ProtectedActionReplayKeyContext): Promise<string> {
  const settlement = enforcement.settlement;
  const transaction = settlement && typeof settlement === "object" &&
    "transaction" in settlement ? settlement.transaction : undefined;
  const inputs = [
    request.method,
    request.url,
    request.headers.get("PAYMENT-SIGNATURE"),
    transaction,
  ];
  if (inputs.some((value) => typeof value !== "string" || !value.trim())) {
    throw new Error(
      "Paid action replay requires method, URL, PAYMENT-SIGNATURE and settlement transaction",
    );
  }
  // Fixed-order JSON strings preserve exact values and escape field boundaries.
  const canonical = JSON.stringify([
    "emdash-kaspa-x402:protected-action-replay:v1",
    ...inputs,
  ]);
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
