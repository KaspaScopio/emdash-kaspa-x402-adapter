# Experimental facilitator-backed EmDash design

Status: experimental. The backend and action executor are source-only prototypes;
neither is a package export. No production coordinator or stock EmDash integration
is provided. The public direct-server adapter API remains unchanged.

## Ownership and payment flow

The resource server owns route policy, price, recipient, timeout, authoritative
PaymentRequirements and the independently derived request hash. The facilitator
owns capability discovery and settlement. Client `accepted` terms are an untrusted
lookup hint, never the requirements authority.

The backend snapshots its Request and context before asynchronous work. It checks
`/supported` for x402 v2, exact, the selected network and an advertised settle mode,
considering every matching entry. Other advertised protocol versions are tolerated.

An unpaid request obtains requirements from the deployment provider and returns
402 with PAYMENT-REQUIRED. A paid request validates its signature, recovers the
authoritative requirements, compares them in full, derives the server request hash
and calls `/settle` directly. There is no separate `/verify` request.

Protected work waits for successful settlement. The backend validates the response
schema and matches network and amount to the authoritative terms. Supplied Kaspa
request-hash, output-index, profile, encoding and finality metadata must also match. This detects
inconsistent responses; it does not independently prove chain settlement or remove
the deployment's trust in its facilitator.

Discovery, requirements, decoding, transport or settlement failures stop before
protected work. There are no automatic transport retries. Mainnet is disabled
unless explicitly enabled.

## Host action boundary

`enforce()` only returns a payment gate. Work performed after each successful gate
can execute twice even when the facilitator returns the same settlement.
`createExperimentalPaidActionExecutor({ backend, replayCoordinator, operationId })`
wraps the actual operation and uses `runOnce(key, action)` for paid results.

All protected side effects must be inside that callback. Any enforcement Response
passes through without action execution; thrown enforcement errors propagate.
Successful unpaid/skipped results run directly. The executor snapshots Request and
context independently for enforcement, key derivation and the protected callback.
The callback receives (enforcement, { request, context }); use that captured input
instead of closing over mutable caller objects. It does not merge headers
or serialize action results; the callback must return a record that the coordinator
can durably reconstruct.

## Default identity policy

The default policy requires a stable deployment-owned `operationId`. Two different
host operations must have different namespaces even if they share a route. A custom
`replayKeyProvider` replaces this policy and owns equivalent identity validation.

The lowercase SHA-256 key hashes UTF-8 stable JSON for this ordered tuple:

`["emdash-kaspa-x402:protected-action-replay:v2", operationId, method, url, canonicalPayment, network, transaction, context, headers, bodyHash]`

Object keys are sorted; array order is preserved. canonicalPayment is the validated
PAYMENT-SIGNATURE decoded and re-encoded by core's canonical encoder. This coalesces
JSON whitespace and object-key-order variants of the same valid payment. Transaction
hex is lowercase. Network must match context. Missing or invalid payment/transaction
identity fails closed.

Context is the captured backend context. Headers are the Request-normalized
name/value pairs sorted by name, excluding PAYMENT-SIGNATURE. bodyHash is SHA-256 of
the exact body bytes. These inputs separate different bodies, tenants/authentication
headers and route policies. The supplied Request must be cloneable and unread.

This is a conservative policy: changed incidental headers, URLs, context, body bytes
or payment fields create different identities. It is not a universal "one action
per transaction" guarantee. A deployment needing semantic equivalence across such
changes must provide a canonical, authoritative operation policy. Do not remove
tenant/body/policy binding merely to increase cache hits. This key does not replace
the request hash authenticated during settlement.

The v2 identity is incompatible with the earlier experimental v1 key. Deployments
must not discard existing replay records to migrate a live system; migration and
retention are deployment responsibilities. No supported production migration is
claimed by this source-only experiment.

## Coordinator contract

The deployment must reserve ownership atomically before calling action, coordinate
all participating workers, make retries wait, persist completion before returning,
and retain uncertain errors and crashes after possible side effects. Lock expiry
must never automatically authorize another attempt. Retention must cover the
payment replay window; reconciliation or transactional coupling is needed for
cross-system side effects.

Only `tests/helpers/replay-coordinator.ts` implements a coordinator here. Its
process-local state is explicitly test-only. It reserves a pending promise before
invoking user code and retains uncertain failures, but proves neither distributed
durability nor crash recovery. Losing that state permits another action execution.

## Reproducible RC2 evidence

`npm run proof:facilitator-rc2` clones and pins
`724c5fff22de500fcf729c43b59d25036fbffa9c`, checks the dereferenced
`v1.0.0-rc.2` tag and core/server/facilitator package versions, then injects
`scripts/fixtures/rc2-facilitator-proof.ts` into the upstream facilitator suite.

It uses the real DirectModeServer, DirectModeFacilitator and router with RC2's
standard-native exact fixture. Requirements come from a separate call to the
fixture server's `buildPaymentRequired()`, independently of the client-submitted
`accepted` object. This does not prove construction without a local server.
The request hash is derived from method, URL, body and tenant. The bridge
records routes and verifies that no /verify request occurs. Stored page records
include settlement and response headers, and materialize fresh Responses.

The 36 upstream tests plus eight proof cases pass 44/44. Adapter tests pass 90/90.
The proof covers sequential/concurrent retries, payment JSON recoding, mutation
during settlement, 402/conflicting replay gating and retained uncertain failures.
Two negative controls demonstrate duplicate work with an enforce-only host and
after losing the local coordinator.

The bridge is in memory; chain, address and cryptographic verifier adapters come
from the upstream test fixture. The action is a measured callback, not a deployed
EmDash action. This is protocol/host-boundary evidence, not a funded TN10 proof.

Current stock EmDash exposes an enforce gate and leaves protected rendering/work
outside it. Production action-once needs a host/framework boundary plus durable
coordination. The additional [EmDash/Astro HTTP proof](EMDASH_HTTP_PROOF.md)
exercises that boundary around the real content-create endpoint with SQLite;
it retains the simulated-chain and process-local-coordinator limits. Keep this PR experimental, as requested in
[upstream issue #15](https://github.com/elldeeone/kaspa-x402/issues/15#issuecomment-5926474763).
