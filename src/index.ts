import {
  decodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
} from "@kaspa-x402/core";
export type Price =
  | string
  | number
  | { amount: string; asset: string; extra?: Record<string, unknown> };

export interface X402BackendContext {
  price: Price;
  payTo: string;
  network: `${string}:${string}`;
  scheme: string;
  maxTimeoutSeconds: number;
  description?: string;
  mimeType?: string;
}

export interface EnforceResult {
  paid: boolean;
  skipped: boolean;
  payer?: string;
  settlement?: unknown;
  responseHeaders: Record<string, string>;
}

export interface X402Backend {
  enforce(
    request: Request,
    context: X402BackendContext,
  ): Promise<Response | EnforceResult>;
  hasPayment(request: Request): boolean;
}

const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";
const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";

export interface KaspaServerResponse {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
}

export interface KaspaPaidRequest {
  method?: string;
  url: string;
  headers?: Headers;
  resource?: {
    url: string;
    description?: string;
    mimeType?: string;
  };
  paymentAmount?: string;
  paymentScheme?: "exact" | "batch-settlement";
}

export interface KaspaDirectModeServer {
  handlePaidRequest(
    request: KaspaPaidRequest,
    handler: () => Promise<{
      status: number;
      chargedAmount: string;
    }>,
  ): Promise<KaspaServerResponse>;
}

export interface KaspaX402BackendOptions {
  allowMainnet?: boolean;
  allowedMethods?: readonly string[];
}

export interface KaspaX402BackendFactoryOptions extends KaspaX402BackendOptions {
  server?: KaspaDirectModeServer;
  serverFactory?: (
    options?: Record<string, unknown>,
  ) => KaspaDirectModeServer | Promise<KaspaDirectModeServer>;
  serverOptions?: Record<string, unknown>;
}

export function createKaspaX402Backend(
  options: KaspaX402BackendFactoryOptions = {},
): X402Backend {
  const { server, serverFactory, serverOptions, ...backendOptions } = options;
  if ((server ? 1 : 0) + (serverFactory ? 1 : 0) !== 1) {
    throw new TypeError(
      "Kaspa x402 backend requires exactly one of server or serverFactory",
    );
  }

  let backendPromise: Promise<X402Backend> | undefined;
  const resolveBackend = (): Promise<X402Backend> => {
    if (!backendPromise) {
      const initialization = Promise.resolve(
        server ? server : serverFactory!(serverOptions),
      )
        .then((resolvedServer) =>
          createKaspaX402BackendFromServer(resolvedServer, backendOptions),
        )
        .catch((error) => {
          if (backendPromise === initialization) backendPromise = undefined;
          throw error;
        });
      backendPromise = initialization;
    }
    return backendPromise;
  };

  return {
    async enforce(request, context) {
      return (await resolveBackend()).enforce(request, context);
    },
    hasPayment(request) {
      return request.headers.has(PAYMENT_SIGNATURE_HEADER);
    },
  };
}

export function createKaspaX402BackendFromServer(
  server: KaspaDirectModeServer,
  options: KaspaX402BackendOptions = {},
): X402Backend {
  if (!server || typeof server.handlePaidRequest !== "function") {
    throw new TypeError(
      "Kaspa x402 backend requires a DirectModeServer-compatible instance",
    );
  }

  const allowedMethods = new Set(
    (options.allowedMethods ?? ["GET", "HEAD"]).map((method) =>
      method.toUpperCase(),
    ),
  );

  return {
    async enforce(
      request: Request,
      context: X402BackendContext,
    ): Promise<Response | EnforceResult> {
      if (!allowedMethods.has(request.method.toUpperCase())) {
        return jsonResponse(
          405,
          { error: "method_not_allowed" },
          { Allow: [...allowedMethods].join(", ") },
        );
      }

      const terms = resolveTerms(context, options);
      const paymentHeader = request.headers.get(PAYMENT_SIGNATURE_HEADER);
      if (paymentHeader) {
        assertSubmittedTerms(paymentHeader, terms);
      }

      const result = await server.handlePaidRequest(
        {
          method: request.method,
          url: request.url,
          headers: request.headers,
          resource: {
            url: request.url,
            ...(context.description
              ? { description: context.description }
              : {}),
            ...(context.mimeType ? { mimeType: context.mimeType } : {}),
          },
          paymentAmount: terms.amount,
          paymentScheme: terms.scheme,
        },
        async () => ({
          status: 200,
          chargedAmount: terms.amount,
        }),
      );

      if (result.status < 200 || result.status >= 300) {
        if (result.status === 402) {
          assertChallengeTerms(result.headers, terms);
        }
        return serverResponse(result);
      }

      const settlement = readHeader(
        result.headers,
        PAYMENT_RESPONSE_HEADER,
      );
      if (!paymentHeader || !settlement) {
        throw new Error(
          "Kaspa x402 server returned success without payment settlement",
        );
      }

      return {
        paid: true,
        skipped: false,
        responseHeaders: { ...result.headers },
      };
    },

    hasPayment(request: Request): boolean {
      return request.headers.has(PAYMENT_SIGNATURE_HEADER);
    },
  };
}

interface ResolvedTerms {
  amount: string;
  payTo: string;
  network: "kaspa:testnet-10" | "kaspa:mainnet";
  scheme: "exact";
  maxTimeoutSeconds: number;
}

function resolveTerms(
  context: X402BackendContext,
  options: KaspaX402BackendOptions,
): ResolvedTerms {
  if (
    context.network !== "kaspa:testnet-10" &&
    context.network !== "kaspa:mainnet"
  ) {
    throw new Error("unsupported Kaspa x402 network: " + context.network);
  }
  if (context.network === "kaspa:mainnet" && !options.allowMainnet) {
    throw new Error("Kaspa x402 mainnet is disabled");
  }
  if (context.scheme !== "exact") {
    throw new Error("unsupported Kaspa x402 scheme: " + context.scheme);
  }
  if (
    !Number.isSafeInteger(context.maxTimeoutSeconds) ||
    context.maxTimeoutSeconds <= 0
  ) {
    throw new Error("Kaspa x402 timeout must be a positive integer");
  }
  if (!context.payTo) {
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
    if (price.asset !== "KAS") {
      throw new Error("Kaspa x402 atomic prices must use the KAS asset");
    }
    if (!/^[1-9][0-9]*$/.test(price.amount)) {
      throw new Error(
        "Kaspa x402 atomic price must be a positive sompi string",
      );
    }
    return price.amount;
  }
  if (typeof price === "string" && price.startsWith("$")) {
    throw new Error(
      "Kaspa x402 does not accept fiat prices without an exchange-rate policy",
    );
  }

  const value = typeof price === "number" ? String(price) : price;
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,8}))?$/.exec(value);
  if (!match) {
    throw new Error(
      "Kaspa x402 KAS price must be a decimal with at most 8 places",
    );
  }
  const whole = BigInt(match[1] ?? "0");
  const fraction = (match[2] ?? "").padEnd(8, "0");
  const sompi = whole * 100_000_000n + BigInt(fraction || "0");
  if (sompi <= 0n) {
    throw new Error("Kaspa x402 price must be positive");
  }
  return sompi.toString();
}

function assertSubmittedTerms(
  header: string,
  expected: ResolvedTerms,
): void {
  let payload;
  try {
    payload = decodePaymentSignatureHeader(header);
  } catch {
    throw new Error("Kaspa x402 PAYMENT-SIGNATURE is invalid");
  }
  if (!matchesTerms(payload.accepted, expected)) {
    throw new Error("Kaspa x402 payment terms do not match EmDash");
  }
}

function assertChallengeTerms(
  headers: Record<string, string>,
  expected: ResolvedTerms,
): void {
  const header = readHeader(headers, PAYMENT_REQUIRED_HEADER);
  if (!header) {
    throw new Error("Kaspa x402 server returned 402 without PAYMENT-REQUIRED");
  }

  const required = decodePaymentRequiredHeader(header);
  if (!required.accepts.some((candidate) => matchesTerms(candidate, expected))) {
    throw new Error("Kaspa x402 server challenge does not match EmDash");
  }
}

function matchesTerms(
  candidate: {
    amount?: unknown;
    payTo?: unknown;
    network?: unknown;
    scheme?: unknown;
    maxTimeoutSeconds?: unknown;
  },
  expected: ResolvedTerms,
): boolean {
  return (
    candidate.amount === expected.amount &&
    candidate.payTo === expected.payTo &&
    candidate.network === expected.network &&
    candidate.scheme === expected.scheme &&
    candidate.maxTimeoutSeconds === expected.maxTimeoutSeconds

  );
}

function readHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  return Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];
}

function serverResponse(result: KaspaServerResponse): Response {
  const headers = new Headers(result.headers);
  let body: string | undefined;
  if (result.body !== undefined) {
    body =
      typeof result.body === "string"
        ? result.body
        : JSON.stringify(result.body);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
  }
  return new Response(body, { status: result.status, headers });
}

function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...extraHeaders,
    },
  });
}
