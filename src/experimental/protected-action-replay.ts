import {
  decodePaymentSignatureHeader,
  encodePaymentSignatureHeader,
} from "@kaspa-x402/core";
import type {
  EnforceResult,
  X402Backend,
  X402BackendContext,
} from "../index.js";

/**
 * Deployment-owned durable storage and atomic coordination across processes.
 * Elect one owner before invoking action; concurrent retries wait for it.
 * Persist completion before returning, and retain uncertain failures/crashes.
 * Never release an uncertain key automatically. Recovery is deployment policy.
 * Retention must cover the payment replay window. Results must be reconstructable.
 * A process-local cache does not satisfy this contract.
 */
export interface ProtectedActionReplayCoordinator<T> {
  runOnce(key: string, action: () => Promise<T>): Promise<T>;
}

export interface ProtectedActionInput {
  /** Independent captured input; use this instead of closing over the original Request. */
  request: Request;
  context: X402BackendContext;
}

export interface ProtectedActionReplayKeyContext {
  /** Snapshot captured before enforcement; independent of the backend's Request. */
  request: Request;
  context: X402BackendContext;
  enforcement: EnforceResult;
}

/** Bind the paid operation consistently across all participating instances. */
export type ProtectedActionReplayKeyProvider = (
  input: ProtectedActionReplayKeyContext,
) => string | Promise<string>;

export interface ExperimentalPaidActionExecutorOptions<T> {
  backend: X402Backend;
  replayCoordinator: ProtectedActionReplayCoordinator<T>;
  /** Stable deployment namespace for this action; required by the default policy. */
  operationId?: string;
  /** Replaces the default policy and owns equivalent identity validation. */
  replayKeyProvider?: ProtectedActionReplayKeyProvider;
}

/** Prototype host boundary; not exported by the package or production-ready. */
export function createExperimentalPaidActionExecutor<T>(
  options: ExperimentalPaidActionExecutorOptions<T>,
) {
  const { backend, replayCoordinator, replayKeyProvider, operationId } =
    options;
  if (
    !replayKeyProvider &&
    (typeof operationId !== "string" || !operationId.trim())
  ) {
    throw new Error("Paid action replay requires a stable operationId");
  }

  return async (
    request: Request,
    context: X402BackendContext,
    action: (
      enforcement: EnforceResult,
      input: ProtectedActionInput,
    ) => T | Promise<T>,
  ): Promise<Response | T> => {
    // Separate copies keep caller/provider mutations out of the key policy.
    const backendRequest = request.clone();
    const identityRequest = request.clone();
    const backendContext = structuredClone(context);
    const identityContext = structuredClone(context);
    const actionInput = {
      request: request.clone(),
      context: structuredClone(context),
    };
    const enforcement = await backend.enforce(backendRequest, backendContext);
    if (enforcement instanceof Response) return enforcement;
    if (!enforcement.paid) return action(enforcement, actionInput);

    const keyContext = {
      request: identityRequest,
      context: identityContext,
      enforcement,
    };
    const key = replayKeyProvider
      ? await replayKeyProvider(keyContext)
      : await defaultReplayKey(keyContext, operationId!);
    if (typeof key !== "string" || !key.trim()) {
      throw new Error("Paid action replay requires a non-empty replay key");
    }
    return replayCoordinator.runOnce(key, async () =>
      action(enforcement, actionInput),
    );
  };
}

async function defaultReplayKey(
  { request, context, enforcement }: ProtectedActionReplayKeyContext,
  operationId: string,
): Promise<string> {
  const settlement = enforcement.settlement;
  const record =
    settlement && typeof settlement === "object"
      ? (settlement as Record<string, unknown>)
      : undefined;
  const transaction = record?.transaction;
  const network = record?.network;
  const signature = request.headers.get("PAYMENT-SIGNATURE");
  if (
    !request.method ||
    !request.url ||
    !signature ||
    typeof transaction !== "string" ||
    !/^[0-9a-fA-F]{64}$/.test(transaction) ||
    typeof network !== "string" ||
    network !== context.network
  ) {
    throw new Error(
      "Paid action replay requires method, URL, PAYMENT-SIGNATURE and settlement transaction/network",
    );
  }
  // Decode and re-encode validated JSON so whitespace/key order cannot split a payment.
  const payment = encodePaymentSignatureHeader(
    decodePaymentSignatureHeader(signature),
  );
  const headers = [...request.headers.entries()]
    .filter(([name]) => name !== "payment-signature")
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const bodyHash = await sha256(await request.arrayBuffer());
  return sha256(
    new TextEncoder().encode(
      stableJson([
        "emdash-kaspa-x402:protected-action-replay:v2",
        operationId,
        request.method,
        request.url,
        payment,
        network,
        transaction.toLowerCase(),
        context,
        headers,
        bodyHash,
      ]),
    ),
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

async function sha256(bytes: BufferSource): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
