# EmDash Kaspa x402 backend

Private integration package that connects `@emdash-cms/x402` to a Kaspa x402 `DirectModeServer`-compatible server.

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
        options: {
          serverOptions: { deployment: "tn10" },
        },
      },
    }),
  ],
});
```

The injected `serverFactory` may return a server directly or a promise. It is resolved lazily once, on the first enforced request. The returned object must expose a `handlePaidRequest()` method compatible with Kaspa x402 `DirectModeServer`.

`createKaspaX402BackendFromServer(server, options)` remains available when an application already owns a server instance.

Mainnet stays disabled unless `allowMainnet: true` is explicitly passed to the backend factory.
