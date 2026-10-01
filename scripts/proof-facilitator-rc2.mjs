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
    throw new Error(
      `RC2 source mismatch: expected ${EXPECTED_REF}, got ${actualRef}`,
    );
  }

  const taggedRef = execFileSync("git", ["rev-parse", "v1.0.0-rc.2^{commit}"], {
    cwd: upstream,
    encoding: "utf8",
  }).trim();
  if (taggedRef !== EXPECTED_REF)
    throw new Error("RC2 tag does not resolve to the pinned commit");
  for (const name of ["core", "server", "facilitator"]) {
    const manifest = JSON.parse(
      readFileSync(join(upstream, "packages", name, "package.json"), "utf8"),
    );
    if (manifest.version !== "1.0.0-rc.2")
      throw new Error(`Unexpected ${name} version: ${manifest.version}`);
  }

  run("npm", ["ci", "--silent"], adapterRoot);
  run("npm", ["ci", "--silent"], upstream);

  const testFile = join(
    upstream,
    "packages/facilitator/test/facilitator.test.ts",
  );
  let sourceText = readFileSync(testFile, "utf8");
  const adapterBackend = pathToFileURL(
    join(adapterRoot, "src/experimental/facilitator-backend.ts"),
  ).href;
  const replayBoundary = pathToFileURL(
    join(adapterRoot, "src/experimental/protected-action-replay.ts"),
  ).href;
  const coordinator = pathToFileURL(
    join(adapterRoot, "tests/helpers/replay-coordinator.ts"),
  ).href;
  const importAnchor = 'import { describe, expect, it, vi } from "vitest";';
  if (!sourceText.includes(importAnchor))
    throw new Error("RC2 facilitator test import anchor changed");
  sourceText = sourceText.replace(
    importAnchor,
    `${importAnchor}\nimport { encodePaymentSignatureHeader, decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@kaspa-x402/core";\n` +
      `import { createExperimentalKaspaFacilitatorBackend, createFacilitatorHttpTransport } from ${JSON.stringify(adapterBackend)};\n` +
      `import { createExperimentalPaidActionExecutor } from ${JSON.stringify(replayBoundary)};\n` +
      `import { StrictTestCoordinator } from ${JSON.stringify(coordinator)};`,
  );

  sourceText +=
    "\n" +
    readFileSync(
      join(adapterRoot, "scripts/fixtures/rc2-facilitator-proof.ts"),
      "utf8",
    );
  writeFileSync(testFile, sourceText);

  run(
    "npm",
    ["--workspace", "@kaspa-x402/facilitator", "run", "build"],
    upstream,
  );
  run(
    "npm",
    ["--workspace", "@kaspa-x402/facilitator", "run", "test:self"],
    upstream,
  );
  console.log(`RC2 facilitator replay proof passed at ${EXPECTED_REF}.`);
} finally {
  if (process.env.KEEP_KASPA_X402_RC2_PROOF !== "1")
    rmSync(scratch, { recursive: true, force: true });
  else console.log(`Kept proof workspace: ${scratch}`);
}
