import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
} from "@kaspa-x402/core";
import { describe, expect, it, vi } from "vitest";

import {
  createExperimentalKaspaFacilitatorBackend,
  createFacilitatorHttpTransport,
  type FacilitatorSettleResponse,
  type FacilitatorTransport,
  type RequestHashProvider,
} from "../src/experimental/facilitator-backend.js";
import { createExperimentalPaidActionExecutor } from "../src/experimental/protected-action-replay.js";

import {
  resourceUrl,
  payTo,
  requestHash,
  requirements,
  context,
  paymentHeader,
} from "./helpers/payment-fixture.js";

function transport(overrides: Partial<FacilitatorTransport> = {}) {
  const base: FacilitatorTransport = {
    supported: vi.fn(async () => ({
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: "kaspa:testnet-10",
          extra: { modes: ["settle"] },
        },
      ],
      extensions: [],
      signers: {},
    })),
    settle: vi.fn(async () => ({
      success: true,
      transaction: "aa".repeat(32),
      network: "kaspa:testnet-10",
      amount: "20000000",
      payer: "kaspatest:payer",
    })),
  };
  return { ...base, ...overrides };
}

function backend(mockTransport = transport()) {
  return createExperimentalKaspaFacilitatorBackend({
    transport: mockTransport,
    paymentRequirementsProvider: async () => requirements,
    requestHashProvider: async () => requestHash,
  });
}

describe("experimental facilitator-backed EmDash example", () => {
  it.each(["challenge", "settlement failure"])(
    "does not execute protected work after a real backend %s",
    async (failure) => {
      const mockTransport = transport({
        settle: vi.fn(async () => ({
          success: false,
          transaction: "",
          errorReason: "settlement_failed",
        })),
      });
      const runOnce = vi.fn(async () => {
        throw new Error("unexpected coordination");
      });
      const execute = createExperimentalPaidActionExecutor<string>({
        operationId: "test:premium",
        backend: backend(mockTransport),
        replayCoordinator: { runOnce },
      });
      const action = vi.fn(async () => "protected");
      const request = new Request(
        resourceUrl,
        failure === "challenge"
          ? {}
          : {
              headers: { "PAYMENT-SIGNATURE": paymentHeader() },
            },
      );
      const result = execute(request, context, action);
      if (failure === "challenge") {
        await expect(result).resolves.toMatchObject({ status: 402 });
      } else {
        await expect(result).rejects.toThrow("settlement_failed");
      }
      expect(action).not.toHaveBeenCalled();
      expect(runOnce).not.toHaveBeenCalled();
    },
  );

  it("builds the unpaid 402 from authoritative payment requirements", async () => {
    const mockTransport = transport();
    const result = await backend(mockTransport).enforce(
      new Request(resourceUrl),
      context,
    );
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(402);
    const decoded = decodePaymentRequiredHeader(
      response.headers.get("PAYMENT-REQUIRED")!,
    );
    expect(decoded.accepts).toEqual([requirements]);
    expect(mockTransport.settle).not.toHaveBeenCalled();
  });

  it("sends authoritative requirements and the independently derived requestHash to settle", async () => {
    const mockTransport = transport();
    const derivedHash = "AB".repeat(32);
    const requestHashProvider = vi.fn<RequestHashProvider>(
      async () => derivedHash,
    );
    const candidate = createExperimentalKaspaFacilitatorBackend({
      transport: mockTransport,
      paymentRequirementsProvider: async () => requirements,
      requestHashProvider,
    });
    const request = new Request(resourceUrl, {
      headers: { "PAYMENT-SIGNATURE": paymentHeader() },
    });
    const result = await candidate.enforce(request, context);

    expect(result).not.toBeInstanceOf(Response);
    expect(mockTransport.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        x402Version: 2,
        requestHash: derivedHash.toLowerCase(),
        paymentRequirements: requirements,
        paymentPayload: expect.objectContaining({
          payload: expect.objectContaining({ requestHash }),
        }),
        resource: {
          url: resourceUrl,
          description: context.description,
          mimeType: context.mimeType,
        },
      }),
    );
    expect(requestHashProvider).toHaveBeenCalledWith({
      request: expect.any(Request),
      context,
    });
    expect(requestHashProvider.mock.calls[0]?.[0].request.url).toBe(
      request.url,
    );
    expect(mockTransport.settle).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ paid: true, payer: "kaspatest:payer" });
    if (result instanceof Response || !result.responseHeaders) {
      throw new Error("expected paid facilitator result with response headers");
    }
    const settlement = decodePaymentResponseHeader(
      result.responseHeaders["PAYMENT-RESPONSE"]!,
    );
    expect(settlement).toMatchObject({
      success: true,
      transaction: "aa".repeat(32),
      network: "kaspa:testnet-10",
    });
  });

  it("waits for successful settlement before allowing protected work", async () => {
    let resolvePending!: (value: FacilitatorSettleResponse) => void;
    const pending = new Promise<FacilitatorSettleResponse>((resolve) => {
      resolvePending = resolve;
    });
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const mockTransport = transport({
      settle: vi.fn(() => {
        resolveStarted();
        return pending;
      }),
    });
    const protectedWork = vi.fn();
    const request = new Request(resourceUrl, {
      headers: { "PAYMENT-SIGNATURE": paymentHeader() },
    });
    const enforcement = backend(mockTransport)
      .enforce(request, context)
      .then((result) => {
        if (!(result instanceof Response) && result.paid) protectedWork();
        return result;
      });

    await started;
    expect(protectedWork).not.toHaveBeenCalled();
    resolvePending({
      success: true,
      transaction: "aa".repeat(32),
      network: "kaspa:testnet-10",
      amount: "20000000",
      payer: "kaspatest:settled-payer",
    });
    await expect(enforcement).resolves.toMatchObject({
      paid: true,
      payer: "kaspatest:settled-payer",
    });
    expect(protectedWork).toHaveBeenCalledTimes(1);
  });

  it("rejects a payment whose accepted requirements are not authoritative", async () => {
    const mockTransport = transport();
    const request = new Request(resourceUrl, {
      headers: {
        "PAYMENT-SIGNATURE": paymentHeader({ maxTimeoutSeconds: 61 }),
      },
    });

    await expect(
      backend(mockTransport).enforce(request, context),
    ).rejects.toThrow("authoritative requirements");
    expect(mockTransport.settle).not.toHaveBeenCalled();
  });
  it("fails closed when exact TN10 omits the settle capability", async () => {
    const mockTransport = transport({
      supported: vi.fn(async () => ({
        kinds: [
          {
            x402Version: 2,
            scheme: "exact",
            network: "kaspa:testnet-10",
            extra: { modes: ["verify"] },
          },
        ],
        extensions: [],
        signers: {},
      })),
    });

    await expect(
      backend(mockTransport).enforce(new Request(resourceUrl), context),
    ).rejects.toThrow("does not advertise settle");
    expect(mockTransport.settle).not.toHaveBeenCalled();
  });

  it("fails closed when the facilitator does not advertise exact TN10", async () => {
    const mockTransport = transport({
      supported: vi.fn(async () => ({
        kinds: [],
        extensions: [],
        signers: {},
      })),
    });

    await expect(
      backend(mockTransport).enforce(new Request(resourceUrl), context),
    ).rejects.toThrow("does not support exact");
  });

  it("rejects an invalid resource-server requestHash before settlement", async () => {
    const mockTransport = transport();
    const candidate = createExperimentalKaspaFacilitatorBackend({
      transport: mockTransport,
      paymentRequirementsProvider: async () => requirements,
      requestHashProvider: async () => "not-a-hash",
    });
    const request = new Request(resourceUrl, {
      headers: { "PAYMENT-SIGNATURE": paymentHeader() },
    });

    await expect(candidate.enforce(request, context)).rejects.toThrow(
      "requestHash must be 32-byte hex",
    );
    expect(mockTransport.settle).not.toHaveBeenCalled();
  });
  it("keeps mainnet disabled by default", async () => {
    const candidate = backend();
    await expect(
      candidate.enforce(new Request(resourceUrl), {
        ...context,
        network: "kaspa:mainnet" as const,
      }),
    ).rejects.toThrow("mainnet is disabled");
  });

  it("does not report paid when settlement fails", async () => {
    const mockTransport = transport({
      settle: vi.fn(async () => ({
        success: false,
        transaction: "",
        errorReason: "settlement_failed",
      })),
    });
    const request = new Request(resourceUrl, {
      headers: { "PAYMENT-SIGNATURE": paymentHeader() },
    });

    await expect(
      backend(mockTransport).enforce(request, context),
    ).rejects.toThrow("settlement_failed");
  });
});

describe("experimental facilitator HTTP transport", () => {
  it("uses only the upstream /supported and /settle routes", async () => {
    const fetchSpy = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/supported")) {
          return Response.json({ kinds: [], extensions: [], signers: {} });
        }
        if (url.endsWith("/settle")) {
          expect(init?.method).toBe("POST");
          return Response.json({
            success: true,
            transaction: "aa".repeat(32),
            network: "kaspa:testnet-10",
            amount: "20000000",
          });
        }
        return new Response(null, { status: 404 });
      },
    );

    const client = createFacilitatorHttpTransport(
      "https://facilitator.example/",
      fetchSpy as unknown as typeof fetch,
    );
    await client.supported();
    await client.settle({ example: "settle" });

    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      "https://facilitator.example/supported",
      { method: "GET" },
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "https://facilitator.example/settle",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ example: "settle" }),
      },
    );
  });
});

describe("facilitator replay semantics", () => {
  it("allows an identical completed retry to reach idempotent settlement again", async () => {
    const mockTransport = transport();
    const candidate = backend(mockTransport);
    const paidRequest = new Request(resourceUrl, {
      headers: { "PAYMENT-SIGNATURE": paymentHeader() },
    });

    const first = await candidate.enforce(paidRequest, context);
    const second = await candidate.enforce(paidRequest, context);
    expect(first).not.toBeInstanceOf(Response);
    expect(second).not.toBeInstanceOf(Response);
    expect(mockTransport.settle).toHaveBeenCalledTimes(2);
    expect(vi.mocked(mockTransport.settle).mock.calls[1]).toEqual(
      vi.mocked(mockTransport.settle).mock.calls[0],
    );
    if (first instanceof Response || second instanceof Response) {
      throw new Error("expected paid facilitator results");
    }
    expect(second.settlement).toEqual(first.settlement);
    expect(second.responseHeaders).toEqual(first.responseHeaders);
  });

  it("rejects conflicting replay evidence through settlement", async () => {
    const settle = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        transaction: "aa".repeat(32),
        network: "kaspa:testnet-10",
        amount: "20000000",
      })
      .mockResolvedValueOnce({
        success: false,
        transaction: "",
        errorReason: "invalid_transaction_state",
      });
    const mockTransport = transport({ settle });
    const conflictingHash = "ab".repeat(32);
    const candidate = createExperimentalKaspaFacilitatorBackend({
      transport: mockTransport,
      paymentRequirementsProvider: async () => requirements,
      requestHashProvider: vi
        .fn()
        .mockResolvedValueOnce(requestHash)
        .mockResolvedValueOnce(conflictingHash),
    });
    const paidRequest = new Request(resourceUrl, {
      headers: { "PAYMENT-SIGNATURE": paymentHeader() },
    });

    await expect(
      candidate.enforce(paidRequest, context),
    ).resolves.toMatchObject({
      paid: true,
    });
    await expect(candidate.enforce(paidRequest, context)).rejects.toThrow(
      "invalid_transaction_state",
    );
    expect(settle).toHaveBeenCalledTimes(2);
    expect(settle).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ requestHash }),
    );
    expect(settle).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        requestHash: conflictingHash,
      }),
    );
    expect(settle.mock.calls[1]?.[0].paymentPayload).toEqual(
      settle.mock.calls[0]?.[0].paymentPayload,
    );
  });
});

describe("experimental facilitator failure boundaries", () => {
  it("fails closed when /supported is unavailable", async () => {
    const supported = vi.fn(async () => {
      throw new Error("facilitator unavailable");
    });
    const mockTransport = transport({ supported });

    await expect(
      backend(mockTransport).enforce(new Request(resourceUrl), context),
    ).rejects.toThrow("facilitator unavailable");
    expect(supported).toHaveBeenCalledTimes(1);
    expect(mockTransport.settle).not.toHaveBeenCalled();
  });

  it("does not blindly retry an uncertain settlement failure", async () => {
    const settle = vi.fn(async () => {
      throw new DOMException("settlement timed out", "AbortError");
    });
    const mockTransport = transport({ settle });
    const request = new Request(resourceUrl, {
      headers: { "PAYMENT-SIGNATURE": paymentHeader() },
    });

    await expect(
      backend(mockTransport).enforce(request, context),
    ).rejects.toThrow("settlement timed out");
    expect(settle).toHaveBeenCalledTimes(1);
  });
});

describe("facilitator response validation", () => {
  it("rejects malformed /supported JSON", async () => {
    const client = createFacilitatorHttpTransport(
      "https://facilitator.example",
      vi.fn(async () =>
        Response.json({ kinds: "not-an-array" }),
      ) as unknown as typeof fetch,
    );
    await expect(client.supported()).rejects.toThrow("invalid /supported JSON");
  });

  it("rejects malformed /settle JSON", async () => {
    const client = createFacilitatorHttpTransport(
      "https://facilitator.example",
      vi.fn(async () =>
        Response.json({ success: true }),
      ) as unknown as typeof fetch,
    );
    await expect(client.settle({ example: true })).rejects.toThrow(
      "invalid /settle JSON",
    );
  });
});

describe("facilitator response shape details", () => {
  it("rejects malformed signer lists from /supported", async () => {
    const client = createFacilitatorHttpTransport(
      "https://facilitator.example",
      vi.fn(async () =>
        Response.json({ kinds: [], extensions: [], signers: { exact: "bad" } }),
      ) as unknown as typeof fetch,
    );
    await expect(client.supported()).rejects.toThrow("invalid /supported JSON");
  });
});

describe("facilitator boundary regressions", () => {
  it("accepts settle in a later matching capability entry", async () => {
    const mock = transport({
      supported: async () => ({
        kinds: ["verify", "settle"].map((mode) => ({
          x402Version: 2,
          scheme: "exact",
          network: context.network,
          extra: { modes: [mode] },
        })),
        extensions: [],
        signers: {},
      }),
    });
    expect(
      await backend(mock).enforce(new Request(resourceUrl), context),
    ).toMatchObject({ status: 402 });
  });

  it("allows other advertised versions alongside a supported v2 entry", async () => {
    const client = createFacilitatorHttpTransport(
      "https://facilitator.example",
      async () =>
        Response.json({
          kinds: [1, 2].map((x402Version) => ({
            x402Version,
            scheme: "exact",
            network: context.network,
            extra: { modes: ["settle"] },
          })),
          extensions: [],
          signers: {},
        }),
    );
    expect(
      await backend(client).enforce(new Request(resourceUrl), context),
    ).toMatchObject({ status: 402 });
  });

  it.each([
    { network: "kaspa:mainnet" },
    { amount: "1" },
    { network: undefined },
    { amount: undefined },
    { transaction: "" },
  ])(
    "stops protected work for settlement terms mismatch %j",
    async (overrides) => {
      const mock = transport({
        settle: async () => ({
          success: true,
          transaction: "aa".repeat(32),
          network: context.network,
          amount: requirements.amount,
          ...overrides,
        }),
      });
      const execute = createExperimentalPaidActionExecutor({
        operationId: "cms:premium",
        backend: backend(mock),
        replayCoordinator: { runOnce: async (_key, action) => action() },
      });
      const action = vi.fn(async () => "protected");
      await expect(
        execute(
          new Request(resourceUrl, {
            headers: { "PAYMENT-SIGNATURE": paymentHeader() },
          }),
          context,
          action,
        ),
      ).rejects.toThrow("settlement does not match");
      expect(action).not.toHaveBeenCalled();
    },
  );

  it.each([
    { requestHash: "ab".repeat(32) },
    { paymentOutputIndex: 1 },
    { exactProfile: "additive" },
  ])("rejects conflicting settlement metadata %j", async (metadata) => {
    const mock = transport({
      settle: async () => ({
        success: true,
        transaction: "aa".repeat(32),
        network: context.network,
        amount: requirements.amount,
        extensions: {
          kaspa: {
            requestHash,
            paymentOutputIndex: 0,
            exactProfile: "standard-native",
            transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
            finality: "accepted",
            ...metadata,
          },
        },
      }),
    });
    await expect(
      backend(mock).enforce(
        new Request(resourceUrl, {
          headers: { "PAYMENT-SIGNATURE": paymentHeader() },
        }),
        context,
      ),
    ).rejects.toThrow();
  });

  it.each([
    { amount: "10000000" },
    { extra: { ...requirements.extra, finality: "confirmed" } },
  ])("rejects client requirements changes %j", async (overrides) => {
    const mock = transport();
    await expect(
      backend(mock).enforce(
        new Request(resourceUrl, {
          headers: { "PAYMENT-SIGNATURE": paymentHeader(overrides) },
        }),
        context,
      ),
    ).rejects.toThrow("authoritative requirements");
    expect(mock.settle).not.toHaveBeenCalled();
  });

  it("isolates the submitted lookup hint from the decoded payment", async () => {
    const mock = transport();
    const candidate = createExperimentalKaspaFacilitatorBackend({
      transport: mock,
      paymentRequirementsProvider: ({ submittedRequirements }) => {
        if (submittedRequirements) submittedRequirements.amount = "1";
        return requirements;
      },
      requestHashProvider: () => requestHash,
    });
    expect(
      await candidate.enforce(
        new Request(resourceUrl, {
          headers: { "PAYMENT-SIGNATURE": paymentHeader() },
        }),
        context,
      ),
    ).toMatchObject({ paid: true });
    expect(mock.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentPayload: expect.objectContaining({ accepted: requirements }),
      }),
    );
  });

  it("captures request and terms before capability discovery awaits", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const mock = transport();
    const supported = mock.supported;
    mock.supported = async () => {
      entered();
      await pending;
      return supported();
    };
    const candidate = new Request(resourceUrl, {
      headers: { "PAYMENT-SIGNATURE": paymentHeader() },
    });
    const terms = { ...context };
    const result = backend(mock).enforce(candidate, terms);
    await started;
    candidate.headers.set("PAYMENT-SIGNATURE", "changed");
    terms.description = "changed";
    release();
    expect(await result).toMatchObject({ paid: true });
    expect(mock.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: expect.objectContaining({ description: context.description }),
      }),
    );
  });
});

it("rejects supplied finality below the authoritative confirmed requirement", async () => {
  const confirmed = {
    ...requirements,
    extra: { ...requirements.extra, finality: "confirmed" },
  };
  const candidate = createExperimentalKaspaFacilitatorBackend({
    transport: transport({
      settle: async () => ({
        success: true,
        transaction: "aa".repeat(32),
        network: context.network,
        amount: requirements.amount,
        extensions: { kaspa: { finality: "accepted" } },
      }),
    }),
    paymentRequirementsProvider: () => confirmed,
    requestHashProvider: () => requestHash,
  });
  await expect(
    candidate.enforce(
      new Request(resourceUrl, {
        headers: {
          "PAYMENT-SIGNATURE": paymentHeader({ extra: confirmed.extra }),
        },
      }),
      context,
    ),
  ).rejects.toThrow("settlement metadata does not match");
});

it("accepts equivalent hexadecimal casing in supplied request hash metadata", async () => {
  const hash = "ab".repeat(32);
  const candidate = createExperimentalKaspaFacilitatorBackend({
    transport: transport({
      settle: async () => ({
        success: true,
        transaction: "aa".repeat(32),
        network: context.network,
        amount: requirements.amount,
        extensions: { kaspa: { requestHash: hash.toUpperCase() } },
      }),
    }),
    paymentRequirementsProvider: () => requirements,
    requestHashProvider: () => hash,
  });
  expect(
    await candidate.enforce(
      new Request(resourceUrl, {
        headers: { "PAYMENT-SIGNATURE": paymentHeader() },
      }),
      context,
    ),
  ).toMatchObject({ paid: true });
});
