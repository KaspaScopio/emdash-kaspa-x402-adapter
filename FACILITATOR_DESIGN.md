# Experimental facilitator-backed EmDash design

Status: experimental design plus a small isolated example. This does not change the production adapter API and does not add `@kaspa-x402/facilitator` as a dependency.

## Goal

Provide an optional EmDash backend that talks to a Kaspa x402 facilitator over HTTP while preserving the existing EmDash backend contract and keeping direct `DirectModeServer.handlePaidRequest()` integration valid.

## Boundary

EmDash remains responsible for route policy, price, resource URL, method and timeout. The facilitator is responsible for capability discovery and settlement.

The resource server must derive its own request hash for exact payments. It must not trust a request hash supplied by the payment artifact.

## Proposed components

1. `createKaspaFacilitatorBackend(options)` implementing the same structural `X402Backend` contract.
2. A small transport interface for `supported()` and `settle()` so HTTP details are testable independently.
3. A future capability cache with bounded lifetime and fail-closed refresh behavior. The current isolated example deliberately calls `/supported` for each request and does not implement this cache yet.
4. Explicit settlement authentication supplied by the deployment, never embedded in public adapter configuration.

## Request flow

Unpaid request:

1. Validate EmDash terms locally and keep mainnet disabled unless explicitly allowed.
2. Check `/supported` capabilities. A future production backend may cache them with bounded lifetime and fail-closed refresh behavior; the current example does not.
3. If the required Kaspa scheme/network is unsupported, fail before protected work.
4. Return the normal x402 `402` challenge expected by EmDash.

Paid request:

1. Decode and validate `PAYMENT-SIGNATURE` against the EmDash terms.
2. Derive the resource request hash locally.
3. Call `/settle` with payment payload, requirements, resource metadata and the derived hash. Settlement is the upfront payment gate.
4. Only after successful settlement may protected work run.
5. Return `PAYMENT-RESPONSE` from the successful settlement response.

No protected callback may be executed twice for an identical completed retry. The 2026-10-01 RC2 integration probe showed that the current `enforce()`-only boundary cannot guarantee this: settlement is idempotent, but a caller that executes protected work after each successful gate runs that work twice. Facilitator support therefore remains blocked on a framework-level replay mechanism or a backend boundary that wraps the protected action.

## Failure and recovery rules

- `/supported` failure must not silently widen capability.
- `/settle` failure must not trigger protected work.
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

## Replay-safe framework boundary

The RC2 probe narrows the missing integration primitive to the framework side. The
payment gate cannot make arbitrary page/action work replay-safe after it returns.
A future EmDash integration should therefore expose a wrapper around the protected
operation, conceptually `executePaid(request, options, action)`, rather than trying
to solve action replay inside `enforce()`.

Required semantics:

1. Derive the authoritative payment requirements and resource request hash before settlement.
2. Settle using the facilitator's normal idempotent RC2 path.
3. Use a durable replay key bound to the payment/request identity, not a process-local cache.
4. Elect one owner for the protected action; concurrent identical retries wait for that owner.
5. Persist the completed protected response before releasing waiters.
6. Completed identical retries return the stored response and settlement without running the action again.
7. If the action fails, persist an explicit failure policy/state; never silently convert an uncertain execution into a fresh action run.
8. Expiry/retention must be at least as strict as the payment replay window and deployment policy.

The storage/locking primitive belongs to the framework/application deployment (or to
an explicitly shared durable adapter supplied by it). The remote facilitator cannot
persist an arbitrary EmDash page/action response because it does not execute that
work. This also means an in-memory `Map` would only make a single-process demo look
correct and is not an acceptable production fix.
