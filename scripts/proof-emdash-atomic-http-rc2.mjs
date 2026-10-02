import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const expected = "cdcfff99573bab3e6425a9fe5d082c9558658b54";
const adapter = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supplied = process.env.EMDASH_ATOMIC_PROOF_SOURCE;
if (!supplied) throw new Error(
  "Set EMDASH_ATOMIC_PROOF_SOURCE to the local atomic-runtime prototype; it is not published upstream.");
const emdash = resolve(supplied);
const git = (args) => execFileSync("git", args, { cwd: emdash, encoding: "utf8" }).trim();
if (git(["rev-parse", "HEAD"]) !== expected) throw new Error("Unexpected EmDash prototype commit");
if (git(["status", "--porcelain"])) throw new Error("EmDash prototype must be clean");
git(["diff", "HEAD", "--exit-code"]);
const manifest = JSON.parse(readFileSync(join(emdash, "package.json"), "utf8"));
const pinnedPnpm = manifest.packageManager.split("@")[1].split("+")[0];
const pnpm = execFileSync("pnpm", ["--version"], { cwd: emdash, encoding: "utf8" }).trim();
if (pnpm !== pinnedPnpm) throw new Error("Use pnpm@" + pinnedPnpm);
function run(command, args, cwd) {
  console.log("> " + [command, ...args].join(" "));
  const result = spawnSync(command, args, { cwd, stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, EMDASH_ATOMIC_PROOF_SOURCE: emdash } });
  if (result.status !== 0) throw new Error(command + " failed: " + result.status);
}
run("pnpm", ["install", "--frozen-lockfile"], emdash);
run("pnpm", ["build"], emdash);
run(process.execPath, ["scripts/proof-facilitator-rc2.mjs", "--emdash-atomic-http"], adapter);
console.log("Atomic runtime HTTP proof passed at " + expected);
