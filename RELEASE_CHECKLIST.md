# Release 0.1.0 checklist

This checklist prepares a future `0.1.0` source/npm release. It is not an authorization to publish.

## Upstream alignment

- [ ] EmDash maintainers confirm the desired pluggable-backend boundary.
- [x] Kaspa x402 maintainer confirmed `DirectModeServer.handlePaidRequest()` as the intended public direct-integration seam (issue #15).
- [ ] Resolve any remaining requested API/lifecycle/replay changes before tagging.
- [x] Lazy initialization recovers after failure or cancellation and remains single-flight under concurrency.
- [x] Durable-state, shared-lock, replay, and recovery deployment requirements are documented.

## Compatibility and safety

- [x] Node.js 22 install/test/typecheck/build pass from a clean checkout.
- [x] Astro/Vite SSR integration validated.
- [x] Cloudflare workerd runtime smoke validated.
- [x] TN10 paid settlement and replay validated on-chain.
- [x] Mainnet remains disabled by default.
- [x] Malformed payment signatures fail closed.
- [x] Repository secret scan is clean.
- [x] Production npm audit reports no known vulnerabilities.

## Release mechanics

- [ ] Decide whether npm publication is appropriate; keep `private: true` until then.
- [ ] Confirm final supported `@kaspa-x402/core` version/range.
- [ ] Run `npm ci && npm test && npm run typecheck && npm run build` on the release commit.
- [ ] Run `npm audit --omit=dev` and inspect `npm pack --dry-run` contents.
- [ ] Run one final funded TN10 proof and record the transaction id.
- [ ] Re-run repository/history secret scan.
- [ ] Update compatibility matrix and README proof transaction.
- [ ] Create signed/annotated `v0.1.0` tag only after review approval.
- [ ] Publish npm package only as a separate explicit action.

## Not part of 0.1.0

- Mainnet enablement or production-readiness claims.
- Bundling a production `DirectModeServer` or private-key management into this adapter.
- Wire-format/schema changes to Kaspa x402.
