import { encodePaymentRequiredHeader } from "@kaspa-x402/core";
import { createKaspaX402BackendFromServer } from "../dist/index.js";

const payTo = "kaspatest:ppakk4efunamcdw5uqglluwam94r747ftxdcyw423rx8rdyx9w4r78eljka3q";
const resourceUrl = "https://worker.example/premium";
const accepted = {
  scheme: "exact",
  network: "kaspa:testnet-10",
  amount: "20000000",
  asset: "KAS",
  payTo,
  maxTimeoutSeconds: 60,
  extra: {
    binding: "kaspa-exact-v2",
    profile: "additive",
    finality: "accepted",
    transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
    payToScriptPublicKey: "0000aa207b6b5729e4fbbc35d4e011fff1ddd96a3f57c9599b823aaa88cc71b4862baa3f87",
    templateId: "kaspa-x402-kip10-additive-v1",
    headId: "90".repeat(32),
    headVersion: "0",
    expectedHeadOutpoint: { index: 0, txid: "71".repeat(32) },
    headAmount: "100000000",
    headScriptPublicKey: "0000aa207b6b5729e4fbbc35d4e011fff1ddd96a3f57c9599b823aaa88cc71b4862baa3f87",
    headRedeemScript: "632056b328b30c8bf5839e24058747879408bdb36241dc9c2e7c619faa12b2920967ac67b9bfb9c388b9c2048096980094b9bea268",
    additiveThresholdSompi: "10000000",
    challengeId: "91".repeat(32),
    challengeExpiresAt: "2099-01-01T00:00:00.000Z",
    paymentOutputIndex: 0,
    assetKind: "native",
    assetDecimals: 8,
  },
};

const required = encodePaymentRequiredHeader({
  x402Version: 2,
  resource: { url: resourceUrl, description: "workerd smoke" },
  accepts: [accepted],
});

const backend = createKaspaX402BackendFromServer({
  async handlePaidRequest() {
    return { status: 402, headers: { "PAYMENT-REQUIRED": required } };
  },
});
export default {
  async fetch() {
    const result = await backend.enforce(new Request(resourceUrl), {
      price: "0.2",
      payTo,
      network: "kaspa:testnet-10",
      scheme: "exact",
      maxTimeoutSeconds: 60,
      description: "workerd smoke",
    });

    if (!(result instanceof Response) || result.status !== 402) {
      return new Response(JSON.stringify({ ok: false, reason: "bad status" }), { status: 500 });
    }
    if (!result.headers.get("PAYMENT-REQUIRED")) {
      return new Response(JSON.stringify({ ok: false, reason: "missing challenge" }), { status: 500 });
    }
    return Response.json({ ok: true, runtime: "workerd", status: 402 });
  },
};
