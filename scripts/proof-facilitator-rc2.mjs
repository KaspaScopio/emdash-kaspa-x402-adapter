import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_REF = "724c5fff22de500fcf729c43b59d25036fbffa9c";
const UPSTREAM_URL = "https://github.com/elldeeone/kaspa-x402.git";
const adapterRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "emdash-kaspa-x402-rc2-"));
const upstream = join(scratch, "kaspa-x402");
const source = process.env.KASPA_X402_SOURCE_DIR;

function run(command, args, cwd) {
  const rendered = [command, ...args].join(" ");
  console.log(`> ${rendered}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`${rendered} failed with exit code ${result.status}`);
  }
}

try {
  if (source) {
    run("git", ["clone", "--quiet", "--shared", resolve(source), upstream]);
  } else {
    run("git", ["clone", "--quiet", UPSTREAM_URL, upstream]);
  }
  run("git", ["checkout", "--quiet", "--detach", EXPECTED_REF], upstream);
  const actualRef = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: upstream,
    encoding: "utf8",
  }).trim();
  if (actualRef !== EXPECTED_REF) {
    throw new Error(`RC2 source mismatch: expected ${EXPECTED_REF}, got ${actualRef}`);
  }

  run("npm", ["ci", "--silent"], adapterRoot);
  run("npm", ["ci", "--silent"], upstream);

  const testFile = join(upstream, "packages/facilitator/test/facilitator.test.ts");
  let sourceText = readFileSync(testFile, "utf8");
  const adapterBackend = pathToFileURL(join(adapterRoot, "src/experimental/facilitator-backend.ts")).href;
  const replayBoundary = pathToFileURL(join(adapterRoot, "src/experimental/protected-action-replay.ts")).href;
  const importAnchor = 'import { describe, expect, it, vi } from "vitest";';
  if (!sourceText.includes(importAnchor)) throw new Error("RC2 facilitator test import anchor changed");
  sourceText = sourceText.replace(
    importAnchor,
    `${importAnchor}\nimport { encodePaymentSignatureHeader } from "@kaspa-x402/core";\n` +
      `import { createExperimentalKaspaFacilitatorBackend, createFacilitatorHttpTransport } from ${JSON.stringify(adapterBackend)};\n` +
      `import { createExperimentalPaidActionExecutor } from ${JSON.stringify(replayBoundary)};`,
  );

  sourceText += `\n\ndescribe("external EmDash facilitator RC2 replay proof", () => {\n` +
`  it("returns the same settlement and executes the protected action once", async () => {\n` +
`    const { facilitator, server } = makeFacilitator();\n` +
`    const paymentPayload = makeStandardExactPayment(server);\n` +
`    const accepted = paymentPayload.accepted as ExactPaymentRequirements;\n` +
`    const fetchBridge = async (input: RequestInfo | URL, init?: RequestInit) => {\n` +
`      const url = new URL(String(input));\n` +
`      const body = init?.body ? JSON.parse(String(init.body)) : undefined;\n` +
`      const response = await handleFacilitatorRequest(facilitator, {\n` +
`        method: init?.method ?? "GET", path: url.pathname,\n` +
`        ...(body !== undefined ? { body } : {}),\n` +
`      });\n` +
`      return Response.json(response.body, { status: response.status, headers: response.headers });\n` +
`    };\n` +
`    const baseTransport = createFacilitatorHttpTransport("https://facilitator.example.test", fetchBridge as typeof fetch);\n` +
`    const settlements: unknown[] = [];\n` +
`    const transport = {\n` +
`      supported: () => baseTransport.supported(),\n` +
`      async settle(input: Record<string, unknown>) {\n` +
`        const result = await baseTransport.settle(input); settlements.push(result); return result;\n` +
`      },\n` +
`    };\n` +
`    const backend = createExperimentalKaspaFacilitatorBackend({\n` +
`      transport,\n` +
`      paymentRequirementsProvider: async () => accepted as unknown as Record<string, unknown>,\n` +
`      requestHashProvider: async () => REQUEST_HASH,\n` +
`    });\n` +
`    const context = { price: { amount: accepted.amount, asset: "KAS" }, payTo: accepted.payTo, network: accepted.network, scheme: accepted.scheme, maxTimeoutSeconds: accepted.maxTimeoutSeconds };\n` +
`    const completed = new Map<string, string>();\n` +
`    const inFlight = new Map<string, Promise<string>>();\n` +
`    const replayCoordinator = { async runOnce(key: string, action: () => Promise<string>) {\n` +
`      if (completed.has(key)) return completed.get(key)!;\n` +
`      const existing = inFlight.get(key); if (existing) return existing;\n` +
`      const promise = action().then((value) => { completed.set(key, value); inFlight.delete(key); return value; });\n` +
`      inFlight.set(key, promise); return promise;\n` +
`    } };\n` +
`    const execute = createExperimentalPaidActionExecutor({ backend, replayCoordinator });\n` +
`    const signature = encodePaymentSignatureHeader(paymentPayload);\n` +
`    let actionRuns = 0;\n` +
`    const runRequest = () => execute(new Request(RESOURCE.url, { headers: { "PAYMENT-SIGNATURE": signature } }), context, async () => { actionRuns += 1; return "protected-result"; });\n` +
`    const first = await runRequest(); const second = await runRequest();\n` +
`    expect(first).toBe("protected-result"); expect(second).toBe(first);\n` +
`    expect(settlements).toHaveLength(2); expect(settlements[1]).toEqual(settlements[0]);\n` +
`    expect(actionRuns).toBe(1);\n` +
`  });\n` +
`});\n`;
  writeFileSync(testFile, sourceText);

  run("npm", ["--workspace", "@kaspa-x402/facilitator", "run", "build"], upstream);
  run("npm", ["--workspace", "@kaspa-x402/facilitator", "run", "test:self"], upstream);
  console.log(`RC2 facilitator replay proof passed at ${EXPECTED_REF}.`);
} finally {
  if (process.env.KEEP_KASPA_X402_RC2_PROOF !== "1") rmSync(scratch, { recursive: true, force: true });
  else console.log(`Kept proof workspace: ${scratch}`);
}
