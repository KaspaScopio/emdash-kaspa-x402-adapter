import { encodePaymentSignatureHeader } from "@kaspa-x402/core";

export const resourceUrl = "https://cms.example/premium";
export const payTo =
  "kaspatest:ppakk4efunamcdw5uqglluwam94r747ftxdcyw423rx8rdyx9w4r78eljka3q";
export const requestHash = "99".repeat(32);
export const requirements = {
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

export const context = {
  price: "0.2",
  payTo,
  network: "kaspa:testnet-10" as const,
  scheme: "exact",
  maxTimeoutSeconds: 60,
  description: "Premium",
  mimeType: "text/html",
};

export function paymentHeader(overrides = {}) {
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
