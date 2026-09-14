import {
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@kaspa-x402/core";
import { describe, expect, it, vi } from "vitest";

import {
  createKaspaX402BackendFromServer,
  type KaspaServerResponse,
} from "../src/index.js";

const resourceUrl = "https://cms.example/premium";
const payTo =
  "kaspatest:ppakk4efunamcdw5uqglluwam94r747ftxdcyw423rx8rdyx9w4r78eljka3q";
const accepted = {
  scheme: "exact" as const,
  network: "kaspa:testnet-10" as const,
  amount: "20000000",
  asset: "KAS" as const,
  payTo,
  maxTimeoutSeconds: 60,
  extra: {
    binding: "kaspa-exact-v2",
    profile: "additive",
    finality: "accepted",
    transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
    payToScriptPublicKey:
      "0000aa207b6b5729e4fbbc35d4e011fff1ddd96a3f57c9599b823aaa88cc71b4862baa3f87",
    templateId: "kaspa-x402-kip10-additive-v1",
    headId: "90".repeat(32),
    headVersion: "0",
    expectedHeadOutpoint: { index: 0, txid: "71".repeat(32) },
    headAmount: "100000000",
    headScriptPublicKey:
      "0000aa207b6b5729e4fbbc35d4e011fff1ddd96a3f57c9599b823aaa88cc71b4862baa3f87",
    headRedeemScript:
      "632056b328b30c8bf5839e24058747879408bdb36241dc9c2e7c619faa12b2920967ac67b9bfb9c388b9c2048096980094b9bea268",
    additiveThresholdSompi: "10000000",
    challengeId: "91".repeat(32),
    challengeExpiresAt: "2099-01-01T00:00:00.000Z",
    paymentOutputIndex: 0,
    assetKind: "native",
    assetDecimals: 8,
  },
} as const;

function requiredHeader(overrides = {}) {
  return encodePaymentRequiredHeader({
    x402Version: 2,
    resource: { url: resourceUrl, description: "Premium" },
    accepts: [{ ...accepted, ...overrides }],
  });
}
function paymentHeader(overrides = {}) {
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: { ...accepted, ...overrides },
    payload: {
      type: "exact-transaction",
      profile: "additive",
      payerAddress:
        "kaspatest:qzvfczmkedtrju0aexl0x8kqds6kpueyn4hwnewc83tky4vkup0k7mkzgqdwu",
      transaction: "{}",
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      paymentOutputIndex: 0,
      challengeId: "91".repeat(32),
      requestHash: "99".repeat(32),
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

function serverResponse(request: { headers?: Headers }): KaspaServerResponse {
  if (!request.headers?.get("PAYMENT-SIGNATURE")) {
    return {
      status: 402,
      headers: { "PAYMENT-REQUIRED": requiredHeader() },
      body: { error: "payment_required" },
    };
  }
  return {
    status: 200,
    headers: {
      "PAYMENT-RESPONSE": encodePaymentResponseHeader({
        success: true,
        transaction: "a".repeat(64),
        network: "kaspa:testnet-10",
        amount: "20000000",
      }),
    },
    body: { unlocked: true },
  };
}

function context(overrides = {}) {
  return {
    price: "0.2",
    payTo,
    network: "kaspa:testnet-10" as const,
    scheme: "exact",
    maxTimeoutSeconds: 60,
    description: "Premium",
    mimeType: "text/html",
    ...overrides,
  };
}

describe("Kaspa x402 EmDash backend", () => {
  it("returns the server's challenge for an unpaid request", async () => {
    const handlePaidRequest = vi.fn(async (request) => serverResponse(request));
    const backend = createKaspaX402BackendFromServer({ handlePaidRequest });

    const result = await backend.enforce(new Request(resourceUrl), context());

    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(402);
    expect(response.headers.get("PAYMENT-REQUIRED")).toBe(requiredHeader());
    expect(handlePaidRequest).toHaveBeenCalledOnce();
  });

  it("unlocks only after the Kaspa server returns a settlement", async () => {
    const handlePaidRequest = vi.fn(async (request) => serverResponse(request));
    const backend = createKaspaX402BackendFromServer({ handlePaidRequest });
    const request = new Request(resourceUrl, {
      headers: { "PAYMENT-SIGNATURE": paymentHeader() },
    });

    const result = await backend.enforce(request, context());

    expect(result).not.toBeInstanceOf(Response);
    expect(result).toMatchObject({
      paid: true,
      skipped: false,
    });
    if (result instanceof Response) throw new Error("unexpected response");
    expect(result.responseHeaders["PAYMENT-RESPONSE"]).toBeTruthy();
    expect(handlePaidRequest).toHaveBeenCalledOnce();
  });

  it("converts decimal KAS prices to exact sompi", async () => {
    const handlePaidRequest = vi.fn(async (request) => serverResponse(request));
    const backend = createKaspaX402BackendFromServer({ handlePaidRequest });

    await backend.enforce(new Request(resourceUrl), context());

    expect(handlePaidRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentAmount: "20000000",
        paymentScheme: "exact",
      }),
      expect.any(Function),
    );
  });

  it("rejects a payment whose terms differ from EmDash", async () => {
    const handlePaidRequest = vi.fn(async (request) => serverResponse(request));
    const backend = createKaspaX402BackendFromServer({ handlePaidRequest });
    const request = new Request(resourceUrl, {
      headers: {
        "PAYMENT-SIGNATURE": paymentHeader({ payTo: "kaspatest:other" }),
      },
    });

    await expect(backend.enforce(request, context())).rejects.toThrow(
      "payment terms do not match",
    );
    expect(handlePaidRequest).not.toHaveBeenCalled();
  });
  it("rejects fiat prices because no exchange-rate policy was configured", async () => {
    const backend = createKaspaX402BackendFromServer({
      handlePaidRequest: vi.fn(),
    });

    await expect(
      backend.enforce(new Request(resourceUrl), context({ price: "$0.20" })),
    ).rejects.toThrow("fiat prices");
  });

  it("detects payment headers without decoding them", () => {
    const backend = createKaspaX402BackendFromServer({
      handlePaidRequest: vi.fn(),
    });

    expect(
      backend.hasPayment(
        new Request(resourceUrl, {
          headers: { "payment-signature": "opaque" },
        }),
      ),
    ).toBe(true);
    expect(backend.hasPayment(new Request(resourceUrl))).toBe(false);
  });
});
