import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@kaspa-x402/core";
import { describe, expect, it, vi } from "vitest";

import {
  createExperimentalKaspaFacilitatorBackend,
  createFacilitatorHttpTransport,
  type FacilitatorTransport,
} from "../src/experimental/facilitator-backend.js";

const resourceUrl = "https://cms.example/premium";
const payTo =
  "kaspatest:ppakk4efunamcdw5uqglluwam94r747ftxdcyw423rx8rdyx9w4r78eljka3q";
const requestHash = "99".repeat(32);
const requirements = {
  scheme: "exact",
  network: "kaspa:testnet-10",
  amount: "20000000",
  asset: "KAS",
  payTo,
  maxTimeoutSeconds: 60,
  extra: {
    binding: "kaspa-exact-v2",
    profile: "standard-native",
    finality: "accepted",
    transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
    payToScriptPublicKey:
      "0000aa207b6b5729e4fbbc35d4e011fff1ddd96a3f57c9599b823aaa88cc71b4862baa3f87",
  },
} as const;

const context = {
  price: "0.2",
  payTo,
  network: "kaspa:testnet-10" as const,
  scheme: "exact",
  maxTimeoutSeconds: 60,
  description: "Premium",
  mimeType: "text/html",
};

function paymentHeader(overrides = {}) {
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: { ...requirements, ...overrides },
    payload: {
      type: "exact-transaction",
      profile: "standard-native",
      payerAddress:
        "kaspatest:qzvfczmkedtrju0aexl0x8kqds6kpueyn4hwnewc83tky4vkup0k7mkzgqdwu",
      transaction: "{}",
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      paymentOutputIndex: 0,
      requestHash,
      authorization: {
        version: "kaspa-x402-exact-request-authorization-v1",
        inputIndex: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        digest: "ce".repeat(32),
        signature: "eb".repeat(64),
      },
    },
  });
}

function transport(overrides: Partial<FacilitatorTransport> = {}) {
  const base: FacilitatorTransport = {
    supported: vi.fn(async () => ({
      kinds: [{
        x402Version: 2,
        scheme: "exact",
        network: "kaspa:testnet-10",
        extra: { modes: ["verify", "settle"] },
      }],
      extensions: [],
      signers: {},
    })),
    verify: vi.fn(async () => ({ isValid: true, payer: "kaspatest:payer" })),
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
  it("builds the unpaid 402 from authoritative payment requirements", async () => {
    const result = await backend().enforce(new Request(resourceUrl), context);
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(402);
    const decoded = decodePaymentRequiredHeader(
      response.headers.get("PAYMENT-REQUIRED")!,
    );
    expect(decoded.accepts).toEqual([requirements]);
  });

  it("sends the independently derived requestHash to verify and settle", async () => {
    const mockTransport = transport();
    const request = new Request(resourceUrl, {
      headers: { "PAYMENT-SIGNATURE": paymentHeader() },
    });
    const result = await backend(mockTransport).enforce(request, context);

    expect(result).not.toBeInstanceOf(Response);
    expect(mockTransport.verify).toHaveBeenCalledWith(
      expect.objectContaining({ requestHash, paymentRequirements: requirements }),
    );
    expect(mockTransport.settle).toHaveBeenCalledWith(
      expect.objectContaining({ requestHash, paymentRequirements: requirements }),
    );
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
  it("does not settle when facilitator verification fails", async () => {
    const mockTransport = transport({
      verify: vi.fn(async () => ({ isValid: false, invalidReason: "bad_payment" })),
    });
    const request = new Request(resourceUrl, {
      headers: { "PAYMENT-SIGNATURE": paymentHeader() },
    });

    await expect(backend(mockTransport).enforce(request, context)).rejects.toThrow(
      "bad_payment",
    );
    expect(mockTransport.settle).not.toHaveBeenCalled();
  });

  it("rejects a payment whose accepted requirements are not authoritative", async () => {
    const mockTransport = transport();
    const request = new Request(resourceUrl, {
      headers: { "PAYMENT-SIGNATURE": paymentHeader({ maxTimeoutSeconds: 61 }) },
    });

    await expect(backend(mockTransport).enforce(request, context)).rejects.toThrow(
      "authoritative requirements",
    );
    expect(mockTransport.verify).not.toHaveBeenCalled();
    expect(mockTransport.settle).not.toHaveBeenCalled();
  });
  it("fails closed when exact TN10 omits the settle capability", async () => {
    const mockTransport = transport({
      supported: vi.fn(async () => ({
        kinds: [{
          x402Version: 2,
          scheme: "exact",
          network: "kaspa:testnet-10",
          extra: { modes: ["verify"] },
        }],
        extensions: [],
        signers: {},
      })),
    });

    await expect(
      backend(mockTransport).enforce(new Request(resourceUrl), context),
    ).rejects.toThrow("does not advertise verify+settle");
    expect(mockTransport.verify).not.toHaveBeenCalled();
    expect(mockTransport.settle).not.toHaveBeenCalled();
  });

  it("fails closed when the facilitator does not advertise exact TN10", async () => {
    const mockTransport = transport({
      supported: vi.fn(async () => ({ kinds: [], extensions: [], signers: {} })),
    });

    await expect(
      backend(mockTransport).enforce(new Request(resourceUrl), context),
    ).rejects.toThrow("does not support exact");
  });

  it("rejects an invalid resource-server requestHash before verify", async () => {
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
    expect(mockTransport.verify).not.toHaveBeenCalled();
  });
  it("keeps mainnet disabled by default", async () => {
    const candidate = backend();
    await expect(
      candidate.enforce(
        new Request(resourceUrl),
        { ...context, network: "kaspa:mainnet" as const },
      ),
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

    await expect(backend(mockTransport).enforce(request, context)).rejects.toThrow(
      "settlement_failed",
    );
  });
});

describe("experimental facilitator HTTP transport", () => {
  it("uses the upstream /supported, /verify and /settle routes", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/supported")) {
        return Response.json({ kinds: [], extensions: [], signers: {} });
      }
      if (url.endsWith("/verify")) {
        expect(init?.method).toBe("POST");
        return Response.json({ isValid: true });
      }
      if (url.endsWith("/settle")) {
        expect(init?.method).toBe("POST");
        return Response.json({ success: true, transaction: "aa".repeat(32) });
      }
      return new Response(null, { status: 404 });
    });

    const client = createFacilitatorHttpTransport(
      "https://facilitator.example/",
      fetchSpy as unknown as typeof fetch,
    );
    await client.supported();
    await client.verify({ example: "verify" });
    await client.settle({ example: "settle" });

    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      "https://facilitator.example/supported",
      { method: "GET" },
    );
    expect(fetchSpy.mock.calls[1]?.[0]).toBe("https://facilitator.example/verify");
    expect(fetchSpy.mock.calls[2]?.[0]).toBe("https://facilitator.example/settle");
  });
});


describe("facilitator replay semantics", () => {
  it("stops before settlement when verification rejects conflicting replay evidence", async () => {
    const mockTransport = transport({
      verify: vi.fn(async () => ({
        isValid: false,
        invalidReason: "invalid_transaction_state",
      })),
    });
    const candidate = backend(mockTransport);
    const paidRequest = new Request(resourceUrl, {
      headers: { "PAYMENT-SIGNATURE": paymentHeader() },
    });

    await expect(candidate.enforce(paidRequest, context)).rejects.toThrow(
      "invalid_transaction_state",
    );
    expect(mockTransport.settle).not.toHaveBeenCalled();
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
    expect(mockTransport.verify).not.toHaveBeenCalled();
    expect(mockTransport.settle).not.toHaveBeenCalled();
  });

  it("does not retry verification transport failures", async () => {
    const verify = vi.fn(async () => {
      throw new Error("verify transport failed");
    });
    const mockTransport = transport({ verify });
    const request = new Request(resourceUrl, {
      headers: { "PAYMENT-SIGNATURE": paymentHeader() },
    });

    await expect(backend(mockTransport).enforce(request, context)).rejects.toThrow(
      "verify transport failed",
    );
    expect(verify).toHaveBeenCalledTimes(1);
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

    await expect(backend(mockTransport).enforce(request, context)).rejects.toThrow(
      "settlement timed out",
    );
    expect(mockTransport.verify).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
  });
});


describe("facilitator response validation", () => {
  it("rejects malformed /supported JSON", async () => {
    const client = createFacilitatorHttpTransport(
      "https://facilitator.example",
      vi.fn(async () => Response.json({ kinds: "not-an-array" })) as unknown as typeof fetch,
    );
    await expect(client.supported()).rejects.toThrow("invalid /supported JSON");
  });

  it("rejects malformed /verify JSON", async () => {
    const client = createFacilitatorHttpTransport(
      "https://facilitator.example",
      vi.fn(async () => Response.json({ isValid: "yes" })) as unknown as typeof fetch,
    );
    await expect(client.verify({ example: true })).rejects.toThrow("invalid /verify JSON");
  });

  it("rejects malformed /settle JSON", async () => {
    const client = createFacilitatorHttpTransport(
      "https://facilitator.example",
      vi.fn(async () => Response.json({ success: true })) as unknown as typeof fetch,
    );
    await expect(client.settle({ example: true })).rejects.toThrow("invalid /settle JSON");
  });
});
