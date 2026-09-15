# Deployment requirements

The adapter is intentionally thin. Production correctness depends on the deployment-specific `DirectModeServer` supplied through `server` or `serverFactory`.

## Server lifecycle

`serverFactory` is initialized lazily and shared per process/isolate. Concurrent first requests share the same initialization attempt.

If initialization fails or is aborted, the failed promise is discarded. A later request may retry initialization. Successful initialization remains shared for the lifetime of that adapter instance.

This process-local sharing is an optimization, not the durability boundary.

## Durable state

Production deployments should use a durable `ServerStateStore` with the guarantees required by Kaspa x402. Replay, idempotency, payment ownership, channel state, transition attempts, and recovery state must survive process restarts.

In-memory stores are suitable only for tests and examples. A restart must not make a completed or uncertain payment appear new again.

The application that builds the `DirectModeServer` is responsible for choosing and configuring the durable store.

## Coordination across instances

If multiple processes or isolates can accept the same payment trust domain, they must use a shared `ChannelLockManager` (or an equivalent implementation of the upstream contract) in the same coordination domain as the durable store.

Process-local locks are not sufficient when the store is shared. Lock loss or expiry also does not replace durable compare-and-set, uniqueness, replay, or recovery records.

Work that mutates the same payment identifier, exact transaction, or covenant lineage must resolve to the same shared coordination key as required by Kaspa x402.

## Replay boundary

An identical completed paid retry should recover the cached response and settlement without re-running the callback passed to `handlePaidRequest()` while that response is retained. After cache expiry, replay protection still applies even if the response can no longer be replayed.

Work performed outside the `handlePaidRequest()` callback needs its own idempotency and recovery policy.

These requirements are based on the public Kaspa x402 server store/runtime-lock contracts and should be rechecked when upgrading the upstream server package.