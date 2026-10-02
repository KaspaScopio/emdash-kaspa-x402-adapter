# Atomic runtime HTTP experiment

This experimental proof connects the real EmDash/Astro content-create POST route
to the opt-in SQLite atomic runtime boundary, through the real RC2 facilitator HTTP
handler. It extends the process-only runtime proof with paid HTTP retries and
resource-server SIGKILL/restarts. It is not a stock EmDash feature or a production
deployment recipe.

## Pinned inputs and reproduction

- Kaspa x402: `v1.0.0-rc.2`, commit
  `724c5fff22de500fcf729c43b59d25036fbffa9c`.
- EmDash atomic runtime prototype: [fork draft PR #1](https://github.com/KaspaScopio/emdash/pull/1),
  branch `experiment/atomic-content-runtime`, commit
  `cdcfff99573bab3e6425a9fe5d082c9558658b54`, in `KaspaScopio/emdash`.
  Its base is upstream commit `9d4962125370ca03b43179232740da47409f4088`;
  this proof does not establish compatibility with later upstream main commits.
  The prototype is not an approved or published upstream EmDash feature.
- Node.js 22.16+ with `node:sqlite`, and EmDash's pinned pnpm version.

From a clean adapter checkout, run:

```sh
npm run proof:emdash-atomic-http-rc2
```

The wrapper clones `https://github.com/KaspaScopio/emdash.git`, checks out the exact
prototype commit, verifies HEAD and cleanliness, installs with its frozen lockfile
and builds EmDash. Optionally set EMDASH_ATOMIC_PROOF_SOURCE to an existing clean
checkout of that exact commit; its source and build are never removed by the wrapper.
The RC2 runner clones a fresh upstream checkout, verifies its
commit, tag and package versions, runs npm ci in both repositories, builds the
facilitator, then runs the upstream facilitator suite with the proof cases appended.
An optional KASPA_X402_SOURCE_DIR supplies a Git clone cache; the checkout still
comes from the pinned Git commit, not that cache's working-tree contents.

Set KEEP_EMDASH_ATOMIC_HTTP_PROOF=1 and KEEP_KASPA_X402_RC2_PROOF=1 to retain SQLite,
worker PID/checkpoint evidence, server logs and the generated upstream test file.

For the separate EmDash runtime regression, run from its checkout:

```sh
pnpm --filter emdash exec vitest run \
  tests/integration/runtime/atomic-content-create.test.ts \
  --exclude 'tests/integration/.servers/**'
```

The exclusion prevents Vitest discovering duplicate copies through node_modules
symlinks in retained HTTP fixtures; that regression should contain 18 tests.

## Host boundary and observations

The proof uses experimental host middleware backed by the adapter's payment gate,
not EmDash's stock x402 enforcer. A source review of upstream main at
`7ccf600696520b8cd2de0ca30aa92b02c982cb01` confirms that X402Enforcer.enforce()
still returns a gate result and leaves protected work to its caller. That stock
enforcer calls verifyPayment followed by settlePayment; the no-/verify observation
below applies to this experimental adapter flow. No execution against that latest
upstream commit is claimed.

The resource server supplies authoritative fixed PaymentRequirements and derives
requestHash from method, complete URL, original body bytes, authorization header
and tenant hint. The configured tenant is fixed by the host; a conflicting hint is
rejected. Every paid attempt uses /settle directly; no /verify endpoint is called.

The ordinary EmDash route still checks current permissions, parses the body and
sets authorId/actor. The host redirects only that request's handleContentCreate call
to handleContentCreateOnce. It removes undefined authorId, locale, translationOf and
actor markers introduced by the route; nested client input remains strict JSON.
The original HTTP bytes remain in the binding. An unprojected negative case
reproduces the otherwise-valid POST returning INVALID_INPUT/400 without creating
content, documenting why the bridge needs this projection.

The durable identity contains a fixed namespace, configured tenant, authenticated
actor and a hash of requestHash, settlement transaction/network and payment output
index. Payment JSON whitespace/key order and incidental headers cannot split the
settled output identity. The binding also captures server terms, settlement and
host policy. A changed binding fails closed.

The fixture instruments the real runtime creation pipeline and delegates unchanged
calls to the real SQLite driver. IPC checkpoints observe actual claim, content,
saved-result, outbox and COMMIT boundaries. Counters are observations only; SQLite's
ledger/transaction provides coordination. The facilitator stays alive while a new
Astro process reuses the exact TCP port, database, PAT and paid request.

| HTTP worker cut | State after SIGKILL | Identical retry |
| --- | --- | --- |
| Settlement through before COMMIT | No committed operation/content/outbox | One committed creation |
| After COMMIT, before HTTP response | One operation/content/outbox and saved result | Saved result; no pipeline entry |

Sequential and concurrent paid requests compare complete facilitator input/results,
HTTP status/body/payment headers, actual pipeline/write counts and independent
SQLite rows. Other cases cover invalid authentication, permission changes before
replay, client-selected terms, failed settlement, mismatched tenants, changed body
and binding, missing saved results, and separate paid operations. The separate
payment case extends the standard test verifier with a second synthetic transaction;
the baseline retry/crash cases retain RC2's standard exact-payment fixture.

An enforce-only negative control creates two real posts after restart despite equal
settlements. Removing a saved replay result is fault injection only; the host never
clears failed or uncertain operation records.

## Limits

The result is one committed database creation per bound operation. A rolled-back
pipeline may execute again after a crash. Arbitrary external effects, hooks, cache
invalidation and full HTTP processing do not acquire an exactly-once guarantee.
Outbox delivery remains host-owned and at least once; this HTTP proof leaves it
pending. The separate runtime process proof exercises delivery/deduplication.
Settlement precedes the route's content validation and permission checks; an
already-settled attempt can still receive 400/403. Refund policy and production
placement of those checks are outside this experiment.

DirectModeFacilitator and handleFacilitatorRequest are real RC2 implementations.
Their chain provider, address codec and signature/transaction verification are
RC2 test fixtures. This is not live-chain cryptographic or TN10 confirmation evidence.
The facilitator's test replay store remains in memory and is not restarted.
SQLite recovery from process SIGKILL is covered; power loss, multiple HTTP hosts,
other dialects and production replay retention/recovery policies are not established.
Keep the integration experimental.

## Recorded local validation

- Combined RC2 facilitator suite and proofs: 69/69, including 25 atomic HTTP cases.
- Adapter suite: 90/90; typecheck and build passed; npm audit --omit=dev found zero
  production vulnerabilities; git diff --check passed.
- Separate EmDash atomic runtime regression: 18/18 in one test file, excluding
  retained fixture dependency symlinks.
- HTTP evidence: 13 distinct worker PIDs and 12 observed SIGKILL terminations,
  including all nine injected cut points and three additional restart cases.
- Independent final SQLite inspection: 21 posts, 19 durable operation records and
  19 outbox records. The two extra posts belong to the enforce-only negative
  control. One operation has its saved result deliberately cleared by the
  fail-closed fault case. No outbox record points to missing content.
- The generated final HTTP test fixture matches the reviewed source exactly;
  the cloned upstream has only its facilitator test file changed by the runner.

The default command was also run without either source override: it cloned both
public repositories, checked the pins, completed frozen install/full EmDash build
and passed all 69 cases. These observations apply to the pinned inputs and the
test fixtures described above.
