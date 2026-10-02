import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";

export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [react(), emdash({
    database: sqlite({ url: process.env.EMDASH_TEST_DB }),
    storage: local({ directory: process.env.EMDASH_TEST_UPLOADS }),
  })],
  devToolbar: { enabled: false },
  vite: {
    resolve: { alias: { "@kaspa-x402/core": "__ADAPTER_ROOT__/node_modules/@kaspa-x402/core/dist/index.js" } },
    server: { fs: { strict: false } },
    // The renderer imports Astro virtual options and must run through Vite SSR.
    ssr: { noExternal: ["@astrojs/react"] },
  },
});
