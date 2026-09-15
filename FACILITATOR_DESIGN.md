# Experimental facilitator-backed EmDash design

Status: experimental design plus a small isolated example. This does not change the production adapter API and does not add `@kaspa-x402/facilitator` as a dependency.

## Goal

Provide an optional EmDash backend that talks to a Kaspa x402 facilitator over HTTP while preserving the existing EmDash backend contract and keeping direct `DirectModeServer.handlePaidRequest()` integration valid.

## Boundary

EmDash remains responsible for route policy, price, resource URL, method and timeout. The facilitator is responsible for capability discovery, payment verification and settlement.

The resource server must derive its own request hash for exact payments. It must not trust a request hash supplied by the payment artifact.

## Proposed components

1. `createKaspaFacilitatorBackend(options)` implementing the same structural `X402Backend` contract.
2. A small transport interface for `supported()`, `verify()` and `settle()` so HTTP details are testable independently.
3. A capability cache with bounded lifetime and fail-closed refresh behavior.
4. Explicit settlement authentication supplied by the deployment, never embedded in public adapter configuration.

## Request flow

Unpaid request:

1. Validate EmDash terms locally and keep mainnet disabled unless explicitly allowed.
2. Check cached `/supported` capabilities; refresh when stale.
3. If the required Kaspa scheme/network is unsupported, fail before protected work.
4. Return the normal x402 `402` challenge expected by EmDash.

Paid request:

1. Decode and validate `PAYMENT-SIGNATURE` against the EmDash terms.
2. Derive the resource request hash locally.
3. Call `/verify` with payment payload, requirements, resource metadata and the derived hash.
4. Only after successful verification, call `/settle` using authenticated facilitator transport.
5. Return `PAYMENT-RESPONSE` only after a successful settlement response.

No protected callback may be executed twice for an identical completed retry. Replay and idempotency semantics must remain consistent with the direct-mode path.

## Failure and recovery rules

- `/supported` failure must not silently widen capability.
- `/verify` failure must not trigger settlement or protected work.
- `/settle` timeout or cancellation is an uncertain outcome: do not assume failure and retry blindly.
- Transport retries need idempotency/replay evidence from the facilitator contract.
- A facilitator URL, credentials and trust domain belong to deployment configuration, not package defaults.
- Multiple EmDash instances sharing one facilitator rely on the facilitator/server durable store and coordinated locks for correctness.

## Compatibility strategy

The direct backend remains the reference path until the facilitator surface is stable and published. A facilitator backend should be additive and selectable through the same pluggable EmDash backend mechanism.

The two modes should share conformance tests for: term matching, malformed payment rejection, mainnet guardrails, replay behavior, successful settlement headers and failure/cancellation paths.

## Experimental implementation gate

Upstream explicitly invited a small facilitator example without waiting for the whole API to settle. The example in `src/experimental/` therefore stays isolated from the package export and focuses on one concrete integration gap: obtaining authoritative dynamic `PaymentRequirements` for the initial `402` and recovering the same requirements for the paid request.

The experiment still does not assume a stable facilitator package API. No npm release, mainnet enablement or upstream EmDash API change is implied.
