import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_EMDASH = "913cb1bb9b7f08c3ff0d258b4420e53835b6a58e";
const adapter = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let scratch;
const supplied = process.env.EMDASH_HTTP_PROOF_SOURCE;
const emdash = supplied ? resolve(supplied)
  : join(scratch = mkdtempSync(join(tmpdir(), "emdash-rc2-http-")), "emdash");
function run(command, args, cwd) {
  console.log("> " + [command, ...args].join(" "));
  const result = spawnSync(command, args, { cwd, stdio: "inherit",
    shell: process.platform === "win32", env: { ...process.env, EMDASH_HTTP_PROOF_SOURCE: emdash } });
  if (result.status !== 0) throw new Error(command + " failed: " + result.status);
}
try {
  if (!supplied) {
    run("git", ["clone", "--quiet", "https://github.com/emdash-cms/emdash.git", emdash], adapter);
    run("git", ["checkout", "--quiet", "--detach", EXPECTED_EMDASH], emdash);
  }
  const actual = execFileSync("git", ["rev-parse", "HEAD"], { cwd: emdash, encoding: "utf8" }).trim();
  if (actual !== EXPECTED_EMDASH) throw new Error("EmDash source mismatch: " + actual);
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: emdash, encoding: "utf8" }).trim();
  if (dirty) throw new Error("The supplied EmDash checkout must be clean");
  execFileSync("git", ["diff", "HEAD", "--exit-code"], { cwd: emdash, stdio: "pipe" });
  const manifest = JSON.parse(readFileSync(join(emdash, "package.json"), "utf8"));
  const expectedPnpm = manifest.packageManager.split("@")[1].split("+")[0];
  const actualPnpm = execFileSync("pnpm", ["--version"], { cwd: emdash, encoding: "utf8" }).trim();
  if (actualPnpm !== expectedPnpm)
    throw new Error("Use the pinned EmDash package manager: pnpm@" + expectedPnpm + " (got " + actualPnpm + ")");
  run("pnpm", ["install", "--frozen-lockfile"], emdash);
  run("pnpm", ["build"], emdash);
  run(process.execPath, ["scripts/proof-facilitator-rc2.mjs", "--emdash-http"], adapter);
  console.log("Real EmDash/Astro HTTP proof passed at " + actual);
} finally {
  if (scratch) {
    if (process.env.KEEP_EMDASH_HTTP_PROOF === "1")
      console.log("Kept EmDash checkout: " + scratch);
    else rmSync(scratch, { recursive: true, force: true });
  }
}
