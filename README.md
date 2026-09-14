# EmDash Kaspa x402 backend

![CI](https://github.com/KaspaScopio/emdash-kaspa-x402-adapter/actions/workflows/ci.yml/badge.svg)

A small community adapter that lets EmDash use a Kaspa x402 `DirectModeServer` as an external payment backend.

> **Status:** experimental, Testnet-10 validated. Mainnet is disabled by default and has not been approved for production use.

This repository is maintained by KaspaScopio. It is not an official EmDash or Kaspa project.

## Upstream status

The adapter itself is implemented and TN10-validated, but the full Astro configuration shown below depends on a **pending EmDash extension for pluggable x402 backends and statically injected backend options**. As of 2026-09-14, those changes are not present on EmDash upstream `main`.

We are publishing the adapter first so maintainers can review the approach before we propose upstream changes. For now, the example below depends on our prototype EmDash extension and is not supported by stock `@emdash-cms/x402` yet.

The npm package is intentionally marked `private` for now; public source review does not imply an npm release.

## What is validated

- EmDash external backend loading through Astro/Vite static imports.
- Kaspa `exact` payments on `kaspa:testnet-10`.
- HTTP flow: `402 → payment → verify/settle → 200`.
- Identical-payment replay returns the same settlement without re-running protected work.
- Real TN10 settlement observed on-chain.

Latest maintained proof transaction:
`340712f53d687c89e294ca4df807be0d599acba64c6052caa90013f357b34956`

## Compatibility

See [`COMPATIBILITY.md`](./COMPATIBILITY.md) for the tested runtime matrix, including Node, Astro, Cloudflare workerd, generic browser bundling, and TN10 live proof status.

## Safety boundary

The package deliberately does **not** construct a production `DirectModeServer` for you. Stores, chain providers, verifiers, finality policy, keys, and deployment security remain application responsibilities.

## Astro configuration

```js
import { defineConfig } from "astro/config";
import { x402 } from "@emdash-cms/x402";

export default defineConfig({
  integrations: [
    x402({
      payTo: "kaspatest:...",
      network: "kaspa:testnet-10",
      defaultPrice: "0.1",
      maxTimeoutSeconds: 600,
      evm: false,
      backend: {
        module: "@kaspascopio/emdash-kaspa-x402",
        export: "createKaspaX402Backend",
        imports: {
          serverFactory: {
            module: "./src/kaspa-x402-server.ts",
            export: "createKaspaServer",
          },
        },
        options: { serverOptions: { deployment: "tn10" } },
      },
    }),
  ],
});
```
The injected `serverFactory` may return a server directly or a promise. It is resolved lazily once, on the first enforced request. The returned object must expose `handlePaidRequest()` compatible with Kaspa x402 `DirectModeServer`.

`createKaspaX402BackendFromServer(server, options)` remains available when an application already owns a server instance.

## Local validation

```bash
npm ci
npm test
npm run typecheck
npm run build
```

These checks use only public npm dependencies.

## Testnet proof

With a funded TN10 key file at `~/.kaspa-test/tn10.key` and the Kaspa WASM module available, run:

```bash
npm run proof:tn10
```

The proof uses real Testnet-10 funds. It does not print the private key.

## Mainnet

Mainnet is rejected unless `allowMainnet: true` is explicitly passed to the backend factory. Treat that switch as an engineering guardrail, not as a statement that this adapter is production-ready.

## Technical review

Feedback is very welcome, especially on whether this overlaps planned work, how the server lifecycle should be handled, replay/idempotency expectations, and which pieces (if any) would be better upstream in EmDash or Kaspa x402.

Current review threads:

- EmDash architecture discussion: https://github.com/emdash-cms/emdash/discussions/3110
- Kaspa x402 integration review: https://github.com/elldeeone/kaspa-x402/issues/15

## License

MIT. See `LICENSE`.
