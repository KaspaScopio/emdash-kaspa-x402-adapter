# Facilitator exploration

Kaspa x402 upstream currently contains a workspace-private `@kaspa-x402/facilitator` package exposing `/supported`, `/verify`, and `/settle` around a configured `DirectModeServer`.

Upstream explicitly marks it as alpha tooling and does not publish it on npm yet. This repository therefore does **not** make it a runtime dependency or replace the validated direct-server adapter path.

## Why it is interesting

A facilitator-backed EmDash integration could move verification/settlement behind a reusable payment service and follow the broader x402 seller pattern. That could allow multiple frameworks to share the same Kaspa payment service.

The current upstream implementation also reuses the same replay, idempotency, and atomic commit path as direct mode, so direct and facilitator modes should share the same configured server state when used for the same resource.

## Current upstream surface

- `GET /supported` for capability discovery.
- `POST /verify` for read-only payment validation.
- `POST /settle` for settlement.
- Exact requests require the resource server's independently computed `requestHash`.
## Proposed EmDash direction

Keep `DirectModeServer.handlePaidRequest()` as the current supported integration boundary. Add facilitator support later as an alternative backend, not as a breaking replacement.

A future facilitator backend should discover `/supported`, preserve EmDash's expected payment terms, send independently derived request hashes, and map `/verify`/`/settle` results back to the same backend contract used today.

## Gate before implementation

Do not publish a facilitator-backed adapter until the upstream package/API is published or the maintainer confirms the intended stable boundary. Until then, experiments should live on an isolated branch and must not change the public direct-mode API.

Open questions for upstream:

1. Which facilitator client/request helpers are intended as the stable framework-integration surface after v1?
2. Should framework adapters call `/verify` then `/settle`, or is a higher-level seller helper planned?
3. What authentication mechanism is expected for settlement callers?
4. Is there a specific area of facilitator development where an external contribution would be most useful now?