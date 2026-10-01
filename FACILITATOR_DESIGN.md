# Experimental facilitator-backed EmDash design

Status: experimental design plus a small isolated example and prototype framework boundary. Not production-ready. This does not change the production adapter API and does not add `@kaspa-x402/facilitator` as a dependency.

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

No protected callback may be executed twice for an identical completed retry. The 2026-10-01 RC2 integration probe showed that the current `enforce()`-only boundary cannot guarantee this: settlement is idempotent, but a caller that executes protected work after each successful gate runs that work twice. The experimental action wrapper below prototypes the missing framework boundary; production support still requires deployment-owned durable coordination and recovery.

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
`src/experimental/protected-action-replay.ts` now provides
`createExperimentalPaidActionExecutor({ backend, replayCoordinator, replayKeyProvider? })`.
It returns `executePaid(request, context, action)`, wrapping the actual protected
operation while leaving `enforce()` and all public package exports unchanged.

Every invocation calls `backend.enforce()` first, including completed retries.
Any returned `Response` passes through unchanged without action execution. Thrown
enforcement/settlement errors propagate without action execution. Paid results go
through `replayCoordinator.runOnce(key, action)`; successful unpaid/skipped results
run the action directly. The action receives the enforcement result so its durable
return value can include settlement metadata and response headers. The wrapper
does not serialize results or merge headers on the application's behalf.

The default key is the lowercase SHA-256 hex digest of UTF-8 JSON encoding of the
fixed-order tuple
`["emdash-kaspa-x402:protected-action-replay:v1", request.method, request.url, PAYMENT-SIGNATURE, enforcement.settlement.transaction]`.
JSON string escaping makes field boundaries unambiguous; values are used exactly
as exposed by `Request`. Missing, empty or non-string inputs fail closed before
coordination or protected work. The default therefore requires structured settlement
metadata; a backend exposing only a settlement header needs a deployment key provider.

`replayKeyProvider({ request, context, enforcement })` can synchronously or
asynchronously replace this policy with a stronger/shared operation identity. It
must return a non-empty stable key and own equivalent identity validation. The
default covers identical retries, not semantic equivalence across differently
encoded payment signatures, changed URLs or different operations sharing a route.
Deployments needing tenant/action namespaces, body binding or canonical payment
identity must supply those through their key policy. This replay key is separate
from the authoritative request hash validated during settlement.

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

The caller-supplied `ProtectedActionReplayCoordinator<T>` is a contract, not a
storage implementation. It must durably and atomically coordinate all processes,
including preserving an uncertain state if a worker crashes after a possible side
effect but before persisting its result. Lock expiry alone must never authorize
another attempt. Cross-system side effects need explicit reconciliation or a
transactional application design; this wrapper cannot provide that itself.

Strict test-only coordination demonstrates sequential/concurrent identical retries,
distinct identities, settlement gating and retained uncertain action failures. It
does not establish crash safety or distributed durability. No production in-memory
coordinator is provided. PR #5 remains experimental and not production-ready;
development checks pin `@kaspa-x402/core` exactly to `1.0.0-rc.2`.


### RC2 proof of the wrapper

The wrapper is exercised by unit/concurrency tests and by a reproducible disposable
RC2 integration proof. `npm run proof:facilitator-rc2` checks out exact upstream
commit `724c5fff22de500fcf729c43b59d25036fbffa9c`, runs the real
`DirectModeFacilitator` and router, submits the identical paid request twice, and
asserts both settlement responses are equal while the protected action runs once.
The upstream facilitator suite plus the injected proof passes 37/37. The proof uses
a test-only in-memory coordinator; it validates the boundary, not production
durability.
