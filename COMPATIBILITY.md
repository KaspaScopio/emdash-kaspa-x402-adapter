# Compatibility matrix

Validated through 2026-09-15.

| Surface | Status | Evidence |
| --- | --- | --- |
| Node.js 22 | ✅ | `npm ci`, tests, typecheck and build pass |
| `@kaspa-x402/core@0.1.0-alpha.10` | ✅ | Automated CI matrix: tests, typecheck and build |
| `@kaspa-x402/core@1.0.0-rc.1` | ✅ | Automated CI matrix: tests, typecheck and build |
| Astro 7 / Vite SSR | ✅ | Real virtual-module load; `402 + PAYMENT-REQUIRED → PAYMENT-SIGNATURE → 200 + PAYMENT-RESPONSE` |
| Cloudflare workerd | ✅ | Automated Wrangler 4.131.2 runtime smoke, compatibility date `2026-09-14`, without `nodejs_compat`; valid `PAYMENT-REQUIRED` encoded and decoded at runtime |
| Generic browser esbuild bundle | ⚠️ | `@kaspa-x402/core@0.1.0-alpha.10` imports Node `crypto`, so a plain `platform=browser` bundle fails unless the environment/tooling provides compatibility |
| Kaspa Testnet-10 live settlement | ✅ | Real paid flow, settlement and replay verified on-chain |
| Mainnet | ⛔ | Disabled by default and intentionally not validated |

## Automated runtime checks

`.github/workflows/runtime-compat.yml` verifies the declared public core range and executes the adapter inside local Cloudflare workerd on every pull request and push to `main`.

## Current live proof

Latest maintained TN10 transaction:

`340712f53d687c89e294ca4df807be0d599acba64c6052caa90013f357b34956`

Observed output: `10,000,000` sompi.
