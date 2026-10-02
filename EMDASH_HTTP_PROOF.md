# EmDash/Astro HTTP proof against RC2

This is an experimental host integration proof. It protects the real
EmDash content-create HTTP endpoint with the adapter's experimental
facilitator backend and paid-action executor.

## Run

Requires Node.js >=22.16, Git, npm, and pnpm 11.9.0 (the EmDash-pinned version).

```sh
npm run proof:emdash-http-rc2
```

The script clones and builds these exact sources:

- EmDash main snapshot: `913cb1bb9b7f08c3ff0d258b4420e53835b6a58e`.
- Kaspa x402 `v1.0.0-rc.2`: `724c5fff22de500fcf729c43b59d25036fbffa9c`.

EmDash dependencies use its frozen pnpm lockfile. RC2 and adapter dependencies
use `npm ci`. The script validates the commits, RC2 tag and package versions.
A supplied `EMDASH_HTTP_PROOF_SOURCE` must be a clean checkout at the pinned
commit; it is still installed and built. `KASPA_X402_SOURCE_DIR` supplies a local
clone source; the RC2 runner creates a separate detached checkout from it.
Set `KEEP_EMDASH_HTTP_PROOF=1` and `KEEP_KASPA_X402_RC2_PROOF=1` to preserve
fixtures, SQLite databases, server logs and the injected upstream test file.

## What runs

Verified result: 54/54 cases (36 upstream, eight adapter proof cases and ten
real HTTP cases). The adapter suite separately passes 90/90, typecheck, build
and production dependency audit. The separate `emdash-http-proof` CI job runs
`npm run proof:emdash-http-rc2` on pull requests and main pushes with pnpm 11.9.0.

The fixture keeps the React renderer inside Vite SSR so its Astro virtual
options are resolved with the workspace packages.

Astro binds its own port and reports it over a nonce-checked parent/child IPC
channel. The parent sends no setup request before that readiness message;
there is no provisional port to release and reuse. A regression case claims
any released provisional reservation and verifies setup never reaches it.

Two loopback HTTP servers run. One serves the real RC2
`DirectModeFacilitator` through `handleFacilitatorRequest`; the other runs
Astro with the pinned EmDash integration and SQLite.

The EmDash development-only setup endpoint creates a test admin and PAT.
Requests use the real EmDash authentication, permissions, schema validation,
runtime and content-create handler. PAT authentication intentionally skips the
session CSRF check; the proof does not exercise cookie/session CSRF protection.
A dedicated case confirms the PAT exemption without X-EmDash-Request.
Application middleware
wraps `next()` for `POST /_emdash/api/content/posts`. The action executes
only after successful settlement. This fixture passes an ordinary Astro
request to `next()`; it does not mutate that request during enforcement.
It stores response bytes, status and headers and reconstructs a fresh
Response for each retry, so both response bodies can be consumed independently.

Requirements come from an independently built RC2 server policy, written into
the resource server's startup configuration. The submitted payment cannot
change them. The resource server derives the request hash from method, URL,
body and tenant. Recorded facilitator traffic must have no `/verify` calls.

The ten HTTP cases assert:

1. Unpaid 402 uses authoritative requirements and creates no content.
2. Sequential identical payments return the same 201 body, content ID and
   payment response, have equal settlements, and create one SQLite row.
3. Concurrent identical payments observe an owner and waiter before releasing
   the action, obtain equal settlements and create one SQLite row.
4. Changed tenant is rejected by RC2 settlement and cannot add another row.
5. Client-modified requirements cannot reach settlement or the CMS action.
6. An injected failure after the real CMS write stays uncertain: two 500
   responses, one action and one row.
7. Negative control: enforcement without coordination creates two rows for
   the same settlement.
8. Negative control: replacing the local coordinator permits a second row.
9. PAT authentication works without the session CSRF header, as EmDash intends.
10. Startup uses the child's bound address and never contacts a listener that
    claims a released provisional port.

SQL reads also verify the returned content ID, title and author. The current
create handler does not create an initial revision; the revision count is
asserted unchanged. The gate's rejected-payment exceptions are mapped to a
generic 500 by this fixture. Defining production HTTP error mapping is outside
this proof.

## Limits

The chain, address and signature-verifier adapters are RC2 test fixtures.
There is no funded TN10 transaction or independent on-chain verification.
The coordinator is explicitly the process-local `StrictTestCoordinator`.
The negative controls demonstrate that it supplies no restart or multi-host
durability. SQLite persists CMS content here; it does not coordinate replay.

This is an Astro development server and a buffered JSON-response boundary.
It does not establish deployment readiness, streaming support, crash recovery,
distributed coordination or exactly-once external plugin side effects.
EmDash's stock `@emdash-cms/x402` enforcer is not modified or substituted into
this path: the host supplies the additional experimental boundary.
The default key still binds all non-payment headers; incidental header changes
can deliberately produce another action identity. This proves action-once
for identical retries while the same coordinator retains their state.
