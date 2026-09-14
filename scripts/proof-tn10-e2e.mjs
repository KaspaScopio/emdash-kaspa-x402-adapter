#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ADAPTER_ROOT = path.resolve(import.meta.dirname, "..");
const KASPA_ROOT = path.resolve(ADAPTER_ROOT, "../kaspa-x402");
const BASE_PROOF = path.join(KASPA_ROOT, "scripts/live-adapter-reference.mjs");
const RUNTIME_PROOF = path.join(KASPA_ROOT, "scripts/.emdash-adapter-tn10-runtime.mjs");
const ADAPTER_DIST = path.join(ADAPTER_ROOT, "dist/index.js");
const DEFAULT_SDK = path.join(os.homedir(), "kaspa-x402-lab/node_modules/kaspa-x402/vendor/kaspa-wasm-2.0.1/kaspa.js");
const DEFAULT_RPC = "wss://vector-10.kaspa.green/kaspa/testnet-10/wrpc/borsh";

const keyFile = path.resolve(process.argv[2] || path.join(os.homedir(), ".kaspa-test/tn10.key"));
if (!fs.existsSync(keyFile)) throw new Error(`TN10 key file not found: ${keyFile}`);
if (!fs.existsSync(BASE_PROOF)) throw new Error(`Kaspa live proof not found: ${BASE_PROOF}`);
if (!fs.existsSync(ADAPTER_DIST)) throw new Error("adapter dist missing; run npm run build first");
const adapterImport = `import { createKaspaX402BackendFromServer } from ${JSON.stringify(pathToFileURL(ADAPTER_DIST).href)};\n`;
let source = fs.readFileSync(BASE_PROOF, "utf8");

const importMarker = 'import { sanitizeProofOutputText } from "./proof-output-security.mjs";\n';
if (!source.includes(importMarker)) throw new Error("live proof import marker changed");
source = source.replace(importMarker, importMarker + adapterImport);

const websocketMarker = '  globalThis.WebSocket = sdkRequire("websocket").w3cwebsocket;\n';
if (!source.includes(websocketMarker)) throw new Error("live proof websocket marker changed");
source = source.replace(
  websocketMarker,
  '  const repoRequire = createRequire(path.join(REPO_ROOT, "package.json"));\n' +
    '  globalThis.WebSocket = repoRequire("websocket").w3cwebsocket;\n',
);

const nobleMarker = '  const { schnorr } = sdkRequire("@noble/curves/secp256k1.js");\n';
if (!source.includes(nobleMarker)) throw new Error("live proof noble marker changed");
source = source.replace(nobleMarker, '  const { schnorr } = repoRequire("@noble/curves/secp256k1.js");\n');
const timeoutMarker = "      confirmationThreshold: CONFIRMATION_THRESHOLD,\n";
if (!source.includes(timeoutMarker)) throw new Error("live proof timeout marker changed");
source = source.replace(timeoutMarker, timeoutMarker + "      maxTimeoutSeconds: 600,\n");
const proofMarker = "    const report = {\n      node:";
if (!source.includes(proofMarker)) throw new Error("live proof report marker changed");
const proofBlock = String.raw`
    let adapterHandlerExecutions = 0;
    const countingServer = {
      handlePaidRequest(request, handler) {
        return standardServer.handlePaidRequest(request, async () => {
          adapterHandlerExecutions += 1;
          return handler();
        });
      },
    };
    const backend = createKaspaX402BackendFromServer(countingServer);
    const adapterUrl = "https://live.kaspa-x402.local/emdash-adapter/e2e";
    const adapterContext = {
      price: "0.1",
      payTo: serverPayoutAddress,
      network: context.network,
      scheme: "exact",
      maxTimeoutSeconds: 600,
      description: "EmDash Kaspa x402 TN10 E2E",
      mimeType: "application/json",
    };
`;
const proofRun = String.raw`
    const unpaidResult = await backend.enforce(new Request(adapterUrl), adapterContext);
    if (!(unpaidResult instanceof Response) || unpaidResult.status !== 402)
      throw new Error("adapter unpaid request did not return HTTP 402");
    const required = unpaidResult.headers.get(PAYMENT_REQUIRED_HEADER);
    if (!required) throw new Error("adapter 402 missing PAYMENT-REQUIRED");
    const payment = await client.createPayment(required, {
      url: adapterUrl,
      paymentIdentifier: "emdash_adapter_tn10_e2e_" + Date.now(),
    });
    const signature = encodePaymentSignatureHeader(payment.paymentPayload);
    const paidRequest = new Request(adapterUrl, {
      headers: { [PAYMENT_SIGNATURE_HEADER]: signature },
    });
    const paidResult = await backend.enforce(paidRequest, adapterContext);
    if (paidResult instanceof Response) {
      const detail = await paidResult.clone().text().catch(() => "");
      throw new Error("adapter paid request returned HTTP " + paidResult.status + ": " + detail.slice(0, 1000));
    }
    if (!paidResult.paid) throw new Error("adapter paid request did not unlock");
    const responseHeader = paidResult.responseHeaders?.[PAYMENT_RESPONSE_HEADER];
    if (!responseHeader) throw new Error("adapter paid result missing PAYMENT-RESPONSE");
    const settlement = decodePaymentResponseHeader(responseHeader);
    await client.applySettlement(payment, settlement);
`;
const proofReplay = String.raw`
    const replayResult = await backend.enforce(paidRequest, adapterContext);
    if (replayResult instanceof Response || !replayResult.paid)
      throw new Error("adapter identical replay did not remain successful");
    const replayHeader = replayResult.responseHeaders?.[PAYMENT_RESPONSE_HEADER];
    const replaySettlement = replayHeader ? decodePaymentResponseHeader(replayHeader) : null;
    if (!replaySettlement || replaySettlement.transaction !== settlement.transaction)
      throw new Error("adapter identical replay returned a different settlement");
    return {
      mode: "emdash-adapter-tn10-e2e",
      network: context.network,
      fundingAddress,
      serverPayoutAddress,
      http: { unpaid: 402, paid: 200, replay: 200 },
      handlerExecutions: adapterHandlerExecutions,
      transaction: settlement.transaction,
      amount: settlement.amount,
      settlementSuccess: settlement.success,
      replaySameTransaction: replaySettlement.transaction === settlement.transaction,
    };
`;
source = source.replace(proofMarker, proofBlock + proofRun + proofReplay + "\n" + proofMarker);
fs.writeFileSync(RUNTIME_PROOF, source, { mode: 0o600 });
const sdkPath = process.env.KASPA_X402_KASPA_WASM_MODULE || DEFAULT_SDK;
const rpcUrl = process.env.KASPA_X402_RPC_URL || DEFAULT_RPC;
const providedDataDir = process.env.KASPA_X402_DATA_DIR || "";
const dataDir = providedDataDir || fs.mkdtempSync(path.join(os.tmpdir(), "emdash-kaspa-x402-e2e-"));

try {
  process.env.KASPA_X402_KASPA_WASM_MODULE = sdkPath;
  const runtime = await import(`${pathToFileURL(RUNTIME_PROOF).href}?t=${Date.now()}`);
  const result = await runtime.runLiveProof({
    network: "kaspa:testnet-10",
    rpcUrl,
    fundingWallet: `wallet-key:${keyFile}`,
    dataDir,
    timeoutDaa: process.env.KASPA_X402_TIMEOUT_DAA || "1800",
    requiredFlows: [],
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  fs.rmSync(RUNTIME_PROOF, { force: true });
  if (!providedDataDir) fs.rmSync(dataDir, { recursive: true, force: true });
}
