# Durable creation of EmDash content

This local design experiment tests whether an EmDash content write and its
replay result can commit together. It is a proposal for a framework boundary,
not a production coordinator or a replacement for the paid HTTP proof.

The database probe passes 10/10 cases with the real exported
`handleContentCreate(db, collection, body)`, Kysely and file-backed SQLite.
It runs independent Node processes, kills them at controlled checkpoints
and reads actual `ec_posts` rows and replay records after each outcome.

## Reproduce the database probe

Use Node 22 and a clean, built EmDash checkout at
`913cb1bb9b7f08c3ff0d258b4420e53835b6a58e`. This is the HTTP proof's source
pin. The script checks HEAD and cleanliness; run the full HTTP proof to build
the pinned workspace before using it. Install adapter dependencies with
`npm ci`.

The following command preserves a built EmDash checkout and prints its path.

```sh
KEEP_EMDASH_HTTP_PROOF=1 npm run proof:emdash-http-rc2
```

Set the source path to the `emdash` directory inside that printed checkout.

```sh
EMDASH_HTTP_PROOF_SOURCE=/path/to/printed-checkout/emdash \
KEEP_EMDASH_DURABILITY_PROOF=1 npm run proof:durable-content-sqlite
```

A previously built checkout at the same pin also works. The database probe
creates a fresh schema through EmDash's development setup endpoint, closes
the HTTP server, then copies that empty database for each case. No content
request or payment is sent during setup. Omit `KEEP_EMDASH_DURABILITY_PROOF`
to remove the probe databases after the run.

## Observed outcomes

Each worker opens its own database connection. The atomic variant inserts
the unique execution identity as its first statement in a real transaction,
passes that same transaction to EmDash's handler, and stores the JSON result
before committing. The handler's nested `withTransaction(trx, ...)` joins
the outer transaction. The replay variant reads the stored response and
does not invoke the handler.

The probe records actual handler invocations through worker IPC. Its cases
check the following outcomes.

| Case | Content rows | Replay records | Total handler invocations |
| --- | ---: | ---: | ---: |
| Retry in a new process | 1 | 1 | 1 |
| Two overlapping processes | 1 | 1 | 1 |
| Kill after claim, then retry | 1 | 1 | 1 |
| Kill after handler write, before result, then retry | 1 | 1 | 2 |
| Kill after result, before commit, then retry | 1 | 1 | 2 |
| Kill after commit, before acknowledgement, then retry | 1 | 1 | 1 |
| Throw after handler write, then retry | 1 | 1 | 2 |
| Conflicting binding, then a distinct identity | 2 | 2 | 2 |
| Separate-commit crash control, then retry | 2 | 1 | 2 |
| Separate-commit concurrent control | 2 | 1 | 2 |

In the three pre-commit SIGKILL cases, both tables are empty before the retry.
After a completed commit, the retry returns the same saved JSON, including
content ID. A reused identity with a different fingerprint is rejected
before invoking the handler.

The separate-commit controls use the same shared SQLite ledger but let the
CMS transaction finish before writing the replay record. Both reproduce
duplicate content. A shared ledger alone does not close that interval.
Removing the outer transaction in a disposable regression run makes the
post-write SIGKILL case fail: one content row survives where zero is required.

## Boundary required in EmDash

Main was inspected at `9d4962125370ca03b43179232740da47409f4088`.
The route, runtime creation method, transaction helper and x402 contract are
unchanged from the proof pin. Other main changes, including slug handling,
are outside this executed probe.

The current call chain establishes where integration must occur.

- `packages/x402/src/types.ts`: `X402Enforcer.enforce()` returns a response
  or enforcement result and leaves protected work to the caller.
- `packages/core/src/astro/routes/api/content/[collection]/index.ts`:
  POST checks permissions, parses input, calls the runtime and invalidates
  cache after success.
- `packages/core/src/emdash-runtime.ts`: `handleContentCreate()` runs
  beforeSave hooks, normalization and validation, calls the database handler,
  refreshes media usage and schedules afterSave hooks.
- `packages/core/src/api/handlers/content.ts`: `handleContentCreate()`
  wraps content and related database writes with `withTransaction()`.
- `packages/core/src/database/transaction.ts`: an existing transaction is
  reused; unsupported transactions fall back to separate statements.
- `packages/core/src/db/node-sqlite-compat.ts`: WAL uses
  `synchronous = NORMAL`; this probe tests process crashes, not power loss.

An arbitrary `next()` callback cannot be made atomic by opening a transaction
in an adapter. The current runtime captures its own database connection;
the transaction must reach the content handler and its repositories.

## Proposed contract

Add an optional content-operation entry point in the framework/host while
preserving ordinary creation. The first implementation targets transactional
database content writes. Treat HTTP rendering, plugins and other external
effects as separate capabilities.

For every request, authenticate and authorize before looking up a replay.
The resource server continues to derive requirements and request binding,
and settlement must succeed before the content transaction starts.
Do not hold a database write lock while contacting the facilitator.

The host supplies an operation namespace, authenticated tenant and actor,
stable operation identity, request fingerprint and validated settlement.
Bind the fingerprint to authoritative terms, method, target, exact body,
actor and payment identity. Reject a reused identity with different binding.
A client idempotency key alone is insufficient. Version the identity format
and define a migration policy; the current adapter v2 key stays unchanged.

Use a unique database identity to serialize competing writers. Within one
real transaction, claim identity, execute the database-only content work,
save the immutable result and commit. Keep content ID, response status/body,
safe response headers and validated settlement metadata for replay.
Exclude session credentials and Set-Cookie. Bound stored result size before
commit, and retain a tombstone if result storage is ever pruned.

Require the content operation to use the supplied transaction throughout.
A handler failure returned as `ApiResult` must abort the outer transaction;
returning an unsuccessful result from a transaction callback would otherwise
permit partial writes to commit. Avoid mutating a shared runtime's database
connection for the duration of a request.

If commit acknowledgement is lost, retry by the same operation identity
and read the durable result. Do not rerun the handler merely because the
caller received an error. Retry a database-only operation only after the
database has established rollback or a new atomic claim can safely proceed.

Reject unsupported transaction capabilities before protected work. The
existing D1 fallback is unsuitable for this multi-statement guarantee.
D1 needs a separately designed atomic batch or different storage boundary.
PostgreSQL and libSQL need their own real-database parity and failure tests.

## Hooks, media usage and cache

BeforeSave hooks can perform effects outside the content transaction.
The initial contract must require pure/replay-safe preparation or reject
incompatible hooks explicitly; silently skipping hooks changes CMS behavior.

Write durable afterSave, media refresh and cache invalidation events in an
outbox in the content transaction. Dispatch after commit, using a stable
event ID. Outbox delivery is at least once. External consumers need their
own idempotency boundary; an outbox alone does not guarantee one delivery.

## Evidence limits and implementation steps

The probe invokes the database handler directly. It does not exercise the
full runtime's normalization/validation pipeline, HTTP authorization,
plugins, media usage, cache invalidation, settlement or a funded TN10 payment.
Those remain separate from the 54-case paid HTTP proof on PR #5.

Identity and fingerprint are explicit fixture strings. Production identity
derivation, settlement validation, schema migration, retention, transaction
capability detection and outbox processing are proposed work, not implemented
by this probe. The replay table is test infrastructure outside EmDash's schema.

All processes use one local SQLite file. No multi-host database, D1, libSQL,
PostgreSQL, power-loss recovery or production durability claim is tested.
After a rollback, the callback can be invoked again. The observed guarantee
is one committed database effect per identity with a replayable result.

Implement in a separate framework change: introduce the operation contract
and forward-only replay/outbox migrations, thread the transaction through
database creation, define hook capability handling, then add runtime and HTTP
failure tests. Preserve uncoordinated routes unless the host opts into the
new contract. Add parity tests before advertising another database dialect.
Keep the adapter and this design experimental until those boundaries exist.
