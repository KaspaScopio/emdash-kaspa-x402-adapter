import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  validateSettlementResponse,
} from "@kaspa-x402/core";

import type {
  EnforceResult,
  Price,
  X402Backend,
  X402BackendContext,
} from "../index.js";

const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";
const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";

type JsonRecord = Record<string, unknown>;

export interface FacilitatorSupportedKind extends JsonRecord {
  x402Version: number;
  scheme: string;
  network: string;
  extra?: JsonRecord;
}
export interface FacilitatorSupportedResponse extends JsonRecord {
  kinds: FacilitatorSupportedKind[];
  extensions: string[];
  signers: Record<string, string[]>;
}

export interface FacilitatorVerifyResponse extends JsonRecord {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface FacilitatorSettleResponse extends JsonRecord {
  success: boolean;
  transaction: string;
  errorReason?: string;
  network?: string;
  amount?: string;
  payer?: string;
  extensions?: JsonRecord;
}

export interface FacilitatorTransport {
  supported(): Promise<FacilitatorSupportedResponse>;
  verify(input: JsonRecord): Promise<FacilitatorVerifyResponse>;
  settle(input: JsonRecord): Promise<FacilitatorSettleResponse>;
}
export interface AuthoritativeRequirementsContext {
  request: Request;
  context: X402BackendContext;
  /** Untrusted lookup hint only; the provider remains authoritative. */
  submittedRequirements?: JsonRecord;
}

export type PaymentRequirementsProvider = (
  input: AuthoritativeRequirementsContext,
) => Promise<JsonRecord> | JsonRecord;

export type RequestHashProvider = (
  input: AuthoritativeRequirementsContext,
) => Promise<string> | string;

export interface ExperimentalFacilitatorBackendOptions {
  transport: FacilitatorTransport;
  paymentRequirementsProvider: PaymentRequirementsProvider;
  requestHashProvider: RequestHashProvider;
  allowMainnet?: boolean;
  allowedMethods?: readonly string[];
}

interface ResolvedTerms {
  amount: string;
  payTo: string;
  network: "kaspa:testnet-10" | "kaspa:mainnet";
  scheme: "exact";
  maxTimeoutSeconds: number;
}
export function createExperimentalKaspaFacilitatorBackend(
  options: ExperimentalFacilitatorBackendOptions,
): X402Backend {
  const allowedMethods = new Set(
    (options.allowedMethods ?? ["GET", "HEAD"]).map((method) =>
      method.toUpperCase(),
    ),
  );

  return {
    async enforce(request, context) {
      if (!allowedMethods.has(request.method.toUpperCase())) {
        return jsonResponse(
          405,
          { error: "method_not_allowed" },
          { Allow: [...allowedMethods].join(", ") },
        );
      }

      const terms = resolveTerms(context, options.allowMainnet);
      await assertFacilitatorSupports(options.transport, terms);
      const paymentHeader = request.headers.get(PAYMENT_SIGNATURE_HEADER);
      let paymentPayload: ReturnType<typeof decodePaymentSignatureHeader> | undefined;
      if (paymentHeader) {
        try {
          paymentPayload = decodePaymentSignatureHeader(paymentHeader);
        } catch {
          throw new Error("Kaspa x402 PAYMENT-SIGNATURE is invalid");
        }
      }
      const submittedRequirements = paymentPayload?.accepted as
        | unknown as JsonRecord
        | undefined;
      const paymentRequirements = await resolveAuthoritativeRequirements(
        options.paymentRequirementsProvider,
        request,
        context,
        terms,
        submittedRequirements,
      );
      if (!paymentPayload) {
        const challenge = {
          x402Version: 2,
          resource: resourceInfo(request, context),
          accepts: [paymentRequirements],
        };
        return new Response(JSON.stringify({ error: "payment_required" }), {
          status: 402,
          headers: {
            "content-type": "application/json",
            [PAYMENT_REQUIRED_HEADER]: encodePaymentRequiredHeader(
              challenge as Parameters<typeof encodePaymentRequiredHeader>[0],
            ),
          },
        });
      }

      if (!sameJson(paymentPayload.accepted, paymentRequirements)) {
        throw new Error(
          "Kaspa x402 payment terms do not match authoritative requirements",
        );
      }
      const requestHash = await options.requestHashProvider({ request, context });
      if (!/^[0-9a-fA-F]{64}$/.test(requestHash)) {
        throw new Error(
          "Kaspa x402 exact facilitator requestHash must be 32-byte hex",
        );
      }

      const facilitatorRequest: JsonRecord = {
        x402Version: 2,
        paymentPayload: paymentPayload as unknown as JsonRecord,
        paymentRequirements,
        resource: resourceInfo(request, context),
        requestHash: requestHash.toLowerCase(),
      };
      const verification = await options.transport.verify(facilitatorRequest);
      if (!verification.isValid) {
        throw new Error(
          `Kaspa x402 facilitator rejected payment: ${verification.invalidReason ?? "invalid"}`,
        );
      }

      const settlement = await options.transport.settle(facilitatorRequest);
      if (!settlement.success) {
        throw new Error(
          `Kaspa x402 facilitator settlement failed: ${settlement.errorReason ?? "unknown"}`,
        );
      }
      return {
        paid: true,
        skipped: false,
        payer: verification.payer ?? settlement.payer,
        settlement,
        responseHeaders: {
          [PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(
            settlement as Parameters<typeof encodePaymentResponseHeader>[0],
          ),
        },
      } satisfies EnforceResult;
    },

    hasPayment(request) {
      return request.headers.has(PAYMENT_SIGNATURE_HEADER);
    },
  };
}

function resourceInfo(request: Request, context: X402BackendContext): JsonRecord {
  return {
    url: request.url,
    ...(context.description ? { description: context.description } : {}),
    ...(context.mimeType ? { mimeType: context.mimeType } : {}),
  };
}
async function assertFacilitatorSupports(
  transport: FacilitatorTransport,
  terms: ResolvedTerms,
): Promise<void> {
  const supported = await transport.supported();
  const match = supported.kinds.find(
    (kind) =>
      kind.x402Version === 2 &&
      kind.scheme === terms.scheme &&
      kind.network === terms.network,
  );
  if (!match) {
    throw new Error(
      `Kaspa x402 facilitator does not support ${terms.scheme} on ${terms.network}`,
    );
  }
  const modes = match.extra?.modes;
  if (
    !Array.isArray(modes) ||
    !modes.includes("verify") ||
    !modes.includes("settle")
  ) {
    throw new Error(
      `Kaspa x402 facilitator does not advertise verify+settle for ${terms.scheme} on ${terms.network}`,
    );
  }
}

async function resolveAuthoritativeRequirements(
  provider: PaymentRequirementsProvider,
  request: Request,
  context: X402BackendContext,
  terms: ResolvedTerms,
  submittedRequirements?: JsonRecord,
): Promise<JsonRecord> {
  const requirements = await provider({
    request,
    context,
    ...(submittedRequirements ? { submittedRequirements } : {}),
  });
  assertRequirementsMatch(requirements, terms);
  return requirements;
}
function assertRequirementsMatch(
  requirements: JsonRecord,
  terms: ResolvedTerms,
): void {
  if (
    requirements.scheme !== terms.scheme ||
    requirements.network !== terms.network ||
    requirements.amount !== terms.amount ||
    requirements.asset !== "KAS" ||
    requirements.payTo !== terms.payTo ||
    requirements.maxTimeoutSeconds !== terms.maxTimeoutSeconds
  ) {
    throw new Error(
      "Kaspa x402 authoritative requirements do not match EmDash terms",
    );
  }
  if (!isRecord(requirements.extra)) {
    throw new Error("Kaspa x402 authoritative requirements require extra metadata");
  }
}

function resolveTerms(
  context: X402BackendContext,
  allowMainnet = false,
): ResolvedTerms {
  if (
    context.network !== "kaspa:testnet-10" &&
    context.network !== "kaspa:mainnet"
  ) {
    throw new Error(`unsupported Kaspa x402 network: ${context.network}`);
  }
  if (context.network === "kaspa:mainnet" && !allowMainnet) {
    throw new Error("Kaspa x402 mainnet is disabled");
  }
  if (context.scheme !== "exact") {
    throw new Error(`unsupported Kaspa x402 scheme: ${context.scheme}`);
  }
  if (
    !Number.isSafeInteger(context.maxTimeoutSeconds) ||
    context.maxTimeoutSeconds <= 0
  ) {
    throw new Error("Kaspa x402 timeout must be a positive integer");
  }
  if (!context.payTo.trim()) {
    throw new Error("Kaspa x402 payTo must not be empty");
  }
  return {
    amount: priceToSompi(context.price),
    payTo: context.payTo,
    network: context.network,
    scheme: "exact",
    maxTimeoutSeconds: context.maxTimeoutSeconds,
  };
}
function priceToSompi(price: Price): string {
  if (typeof price === "object") {
    if (price.asset !== "KAS" || !/^[1-9][0-9]*$/.test(price.amount)) {
      throw new Error("Kaspa x402 atomic price must be positive KAS sompi");
    }
    return price.amount;
  }
  if (typeof price === "string" && price.startsWith("$")) {
    throw new Error("Kaspa x402 does not accept fiat prices");
  }
  const value = typeof price === "number" ? String(price) : price;
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,8}))?$/.exec(value);
  if (!match) {
    throw new Error("Kaspa x402 KAS price must have at most 8 decimals");
  }
  const whole = BigInt(match[1] ?? "0");
  const fraction = (match[2] ?? "").padEnd(8, "0");
  const sompi = whole * 100_000_000n + BigInt(fraction || "0");
  if (sompi <= 0n) throw new Error("Kaspa x402 price must be positive");
  return sompi.toString();
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}
export function createFacilitatorHttpTransport(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): FacilitatorTransport {
  const root = baseUrl.replace(/\/$/, "");
  return {
    async supported() {
      return supportedResponse(
        await readJson(await fetchImpl(`${root}/supported`, { method: "GET" })),
      );
    },
    async verify(input) {
      return verifyResponse(
        await readJson(await fetchImpl(`${root}/verify`, jsonPost(input))),
      );
    },
    async settle(input) {
      return settleResponse(
        await readJson(await fetchImpl(`${root}/settle`, jsonPost(input))),
      );
    },
  };
}

function jsonPost(body: JsonRecord): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error(
      `Kaspa x402 facilitator HTTP ${response.status} ${response.statusText}`,
    );
  }
  return response.json();
}

function supportedResponse(value: unknown): FacilitatorSupportedResponse {
  if (!isRecord(value) || !Array.isArray(value.kinds)) {
    throw new Error("Kaspa x402 facilitator returned invalid /supported JSON");
  }
  if (
    !Array.isArray(value.extensions) ||
    !value.extensions.every((entry) => typeof entry === "string") ||
    !isRecord(value.signers) ||
    !Object.values(value.signers).every(
      (entries) =>
        Array.isArray(entries) &&
        entries.every((entry) => typeof entry === "string"),
    )
  ) {
    throw new Error("Kaspa x402 facilitator returned invalid /supported JSON");
  }
  for (const kind of value.kinds) {
    if (
      !isRecord(kind) ||
      kind.x402Version !== 2 ||
      typeof kind.scheme !== "string" ||
      typeof kind.network !== "string" ||
      (kind.extra !== undefined && !isRecord(kind.extra))
    ) {
      throw new Error("Kaspa x402 facilitator returned invalid /supported JSON");
    }
  }
  return value as FacilitatorSupportedResponse;
}

function verifyResponse(value: unknown): FacilitatorVerifyResponse {
  if (!isRecord(value) || typeof value.isValid !== "boolean") {
    throw new Error("Kaspa x402 facilitator returned invalid /verify JSON");
  }
  if (
    (value.invalidReason !== undefined && typeof value.invalidReason !== "string") ||
    (value.payer !== undefined && typeof value.payer !== "string") ||
    (value.extra !== undefined && !isRecord(value.extra))
  ) {
    throw new Error("Kaspa x402 facilitator returned invalid /verify JSON");
  }
  return value as FacilitatorVerifyResponse;
}

function settleResponse(value: unknown): FacilitatorSettleResponse {
  const result = validateSettlementResponse(value);
  if (!result.ok) {
    throw new Error("Kaspa x402 facilitator returned invalid /settle JSON");
  }
  return result.value as FacilitatorSettleResponse;
}
