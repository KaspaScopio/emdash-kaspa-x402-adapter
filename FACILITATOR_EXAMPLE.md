# Small EmDash facilitator example

This branch contains a deliberately small facilitator-backed EmDash experiment and a prototype framework boundary for protected-action replay. It is still experimental and not production-ready. Neither is exported by the package, and neither depends on the unpublished `@kaspa-x402/facilitator` package. The development dependency on `@kaspa-x402/core` is pinned exactly to `1.0.0-rc.2`.

It targets the public upstream facilitator shape at `elldeeone/kaspa-x402` revision `25893d68fc650cf307339619c8460b8814eba6c5`:

- `GET /supported`
- `POST /verify`
- `POST /settle`
- exact payments require a resource-server-derived `requestHash`

The direct `DirectModeServer.handlePaidRequest()` backend remains the reference path.

The sections tied to revision `25893d68…` document the original experiment and are historical. The RC2 sections below supersede that earlier verify-before-settle exploration.

A local interoperability smoke against the built upstream `DirectModeFacilitator` and `handleFacilitatorRequest()` at that exact revision confirmed that this experiment's `/supported`, `/verify`, and `/settle` request shapes are accepted without using wallet keys, RPC, or a live network. The smoke was intentionally kept out of the committed suite because it depends on a sibling upstream checkout.

## The concrete missing piece

For EmDash, `/supported` is sufficient to answer “can this facilitator handle exact payments on TN10?”, but it does not provide the full dynamic `PaymentRequirements` needed to issue the initial x402 `402` challenge.
Those requirements can contain server-authoritative dynamic state, so the resource server must also recover the same authoritative requirements when the client returns with `PAYMENT-SIGNATURE`. Treating the client's `accepted` object as the authority would weaken that boundary.

The example isolates this requirement behind `paymentRequirementsProvider`. It is intentionally not an answer to how the upstream API should expose or persist that state.

## Example flow

1. Validate EmDash route terms; mainnet remains disabled by default.
2. Call `/supported` and require x402 v2 + `exact` + the requested Kaspa network, with `settle` advertised in `extra.modes`.
3. Obtain full authoritative requirements from `paymentRequirementsProvider`.
4. Unpaid: return those requirements in `PAYMENT-REQUIRED`.
5. Paid: recover authoritative requirements again and require exact equality with the signed `accepted` terms.
6. Derive `requestHash` independently through `requestHashProvider`.
7. Call `/settle` directly; successful settlement is the upfront payment gate.
8. Only then may protected work run through the caller's replay coordinator; identical completed retries return the stored protected result, including `PAYMENT-RESPONSE` if the application stored it.
## Requirements ownership (answered upstream)

The maintainer confirmed after RC2 that standard-native fixed-price requirements
stay with the resource server and should eventually use a shared construction helper.
That helper is planned after v1. The experiment therefore keeps
`paymentRequirementsProvider` as the resource-server-owned seam and does not invent
a facilitator challenge endpoint.

## Safety and scope

This is testnet-oriented experimental code. It is not part of the package export, does not enable mainnet, does not publish anything to npm, and does not claim production readiness.

## Historical replay finding before RC2 guidance

At the earlier upstream revision, the facilitator documented `/settle` as using the same replay,
idempotency and atomic commit path as direct paid requests. A disposable harness
using the real `DirectModeServer`, `DirectModeFacilitator` and router confirmed
that an **identical** completed retry remains valid: the same payment, request
hash and requirements passed `/verify` again and `/settle` returned the same
settlement result.

The upstream replay test that returns `invalid_transaction_state` changes the
request hash before the second verification. That is a conflicting reuse of the
same exact transaction, not an identical retry. The experimental adapter should
therefore preserve this distinction: identical retries may proceed to the
idempotent settlement path, while a facilitator verification failure for a
conflicting replay must stop before settlement.

This corrects the earlier, broader interpretation that verify-before-settle
could block an identical retry. No facilitator API change is required by this
finding.

## Failure boundary

The experimental transport intentionally performs no automatic retries.

- `/supported` failure is fail-closed and cannot widen capability.
- `/settle` transport failure is treated as an uncertain outcome; the adapter does not blindly issue a second settlement request.

This is deliberately conservative. Any future retry policy should depend on an explicit facilitator idempotency/recovery contract rather than generic HTTP retry behavior.

## Historical pre-RC2 router interoperability

A disposable local harness was also run against Kaspa x402 upstream commit
`25893d68fc650cf307339619c8460b8814eba6c5` using the real
`DirectModeFacilitator` and `handleFacilitatorRequest()` implementation.

Validated end to end:

- `/supported` advertises executable `exact` TN10 capability only when the server kind includes `extra.modes` for `verify` and `settle`;
- the experimental HTTP transport interoperates with the real `/supported`, `/verify`, and `/settle` routes;
- the full experimental EmDash backend produces the initial `402`, accepts a matching `PAYMENT-SIGNATURE`, derives its own `requestHash`, then reaches the real facilitator router for verification and settlement;
- the test server observed exactly one verification call and one settlement call.

The harness used an in-memory stub behind the real facilitator router, so this is protocol-boundary evidence rather than a funded TN10 settlement proof. No unpublished facilitator dependency was added to this package and the harness is not shipped.

## Requirements-construction boundary

At upstream revision `25893d68fc650cf307339619c8460b8814eba6c5`,
`@kaspa-x402/core` exports requirement types, validation and normalization, but
not a standalone public requirements constructor. Authoritative construction is
currently exposed through `DirectModeServer.buildPaymentRequired()` in
`@kaspa-x402/server`.

That means the `paymentRequirementsProvider` in this experiment represents a
real deployment boundary for a resource server that wants to use only a remote
facilitator. This observation does not prescribe whether upstream should add a
helper, add a facilitator challenge operation, or keep requirements construction
with a locally configured server.

## RC2 recheck (v1.0.0-rc.2)

Rechecked against upstream tag `v1.0.0-rc.2` at commit
`724c5fff22de500fcf729c43b59d25036fbffa9c`.

The integration boundary described above is still present in RC2:

- the facilitator router exposes `GET /supported`, `POST /verify`, and `POST /settle`;
- `/verify` and `/settle` consume a complete resource-server `paymentRequirements` object;
- exact requests additionally require the resource server to compute `requestHash` independently;
- the facilitator does not expose a requirements/challenge operation that creates the authoritative dynamic `PaymentRequirements` needed for the initial `402`.

A clean RC2 checkout passed the facilitator package suite (36/36). The adapter
experiment, typecheck and build also passed at that recheck. A router
smoke against the built RC2 facilitator also confirmed that `/requirements` and
`/challenge` are not routes (404), while `/supported`, `/verify`, and `/settle`
remain the public HTTP surface.

This does not imply that RC2 is missing functionality required by its own
contract. It confirms the narrower framework-integration question from this
experiment: a remote EmDash resource server still needs an authoritative source
for the same dynamic requirements used for the initial challenge and paid
retry. The experiment therefore continues to isolate that responsibility behind
`paymentRequirementsProvider` rather than inventing an upstream API.

## Maintainer guidance after RC2

Upstream clarified that standard-native fixed-price requirements stay with the resource server, with a shared construction helper planned after v1. PR #5 therefore remains experimental. The facilitator-backed example follows x402 upfront semantics: it calls `/settle` directly before protected work and does not make a separate `/verify` call. Identical paid retries may reach the facilitator settlement path again; correctness relies on RC2 idempotent settlement. The adapter `enforce()` method is only the payment gate, so proving that an EmDash protected action itself executes once requires an integration harness above this backend boundary.

## RC2 full-flow replay probe (2026-10-01)

A disposable integration probe was run against the exact upstream RC2 tag
`v1.0.0-rc.2` (`724c5fff22de500fcf729c43b59d25036fbffa9c`). It used the real
`DirectModeFacilitator`, real `handleFacilitatorRequest()` `/supported` and `/settle`
routes, the RC2 standard-native exact-payment fixture, and this experimental backend.
The upstream facilitator suite plus the probe passed 37/37.

The result exposes an important boundary rather than closing the task: an identical
paid retry reaches RC2 settlement idempotently and returns the same settlement, but
the current structural EmDash `enforce()` contract only gates access. If the caller
runs the protected action after each successful `enforce()`, the identical retry runs
that action a second time. The probe observed exactly two action executions for two
identical paid requests.

That first probe established the failure mode of the plain `enforce()` boundary.
Settlement idempotency alone is not sufficient to claim EmDash action idempotency.
PR #5 therefore remains experimental, and an in-process cache is not treated as a
production fix because it cannot provide correctness across processes or isolates.

## Prototype protected-action executor

`src/experimental/protected-action-replay.ts` adds the framework boundary suggested
by the probe. It leaves `src/index.ts` and package exports unchanged. The following
source-level integration sketch assumes `backend`, `context`, `request`,
`runProtectedEmDashAction` and a deployment-owned `durableCoordinator` are supplied
by the application:

```ts
import {
  createExperimentalPaidActionExecutor,
  type ProtectedActionReplayCoordinator,
} from "./src/experimental/protected-action-replay.js";

type StoredPage = {
  status: number;
  body: string;
  headers: Record<string, string>;
};

// Supplied by the deployment: durable storage plus atomic ownership across workers.
const replayCoordinator: ProtectedActionReplayCoordinator<StoredPage> = durableCoordinator;
const executePaid = createExperimentalPaidActionExecutor({ backend, replayCoordinator });

const result = await executePaid(request, context, async (enforcement) => ({
  status: 200,
  body: await runProtectedEmDashAction(request),
  headers: {
    "content-type": "text/html",
    ...enforcement.responseHeaders,
  },
}));

// Materialize a fresh Response for each request, including a replayed result.
return result instanceof Response
  ? result
  : new Response(result.body, { status: result.status, headers: result.headers });
```

The executor calls `backend.enforce()` first on every attempt. Any `Response`,
including a `402`, is returned unchanged. A settlement/enforcement exception stops
the action. A paid result invokes `replayCoordinator.runOnce(key, action)`;
successful unpaid/skipped results invoke the action directly. Keep all protected
side effects inside the callback. The coordinator must persist/reconstruct the
callback's result; a live `Response` stream is not automatically durable. Store
the desired body, status, headers and any settlement metadata in a suitable record.

The default key is SHA-256 over the UTF-8 JSON tuple
`["emdash-kaspa-x402:protected-action-replay:v1", request.method, request.url, PAYMENT-SIGNATURE, enforcement.settlement.transaction]`,
returned as lowercase hex. The fixed order and escaped JSON strings prevent field
boundary ambiguity. All four identity inputs must be non-empty strings or the paid
action fails closed. The existing direct backend does not expose structured
settlement metadata, so this default cannot be used with it without a custom key policy.

An optional `replayKeyProvider({ request, context, enforcement })` replaces the
default policy for deployments that have a stronger/shared identity. It may be
async, must return a non-empty stable key, and is responsible for validating its
identity inputs. For example, a deployment may need tenant/action namespacing,
body binding or a canonical payment identity shared across routes and workers.
The default protects identical paid retries; it does not collapse differently
encoded signatures or semantically equivalent requests. It is not a replacement
for the resource-server-derived `requestHash` used for settlement.

`ProtectedActionReplayCoordinator` must elect one owner atomically across processes,
make concurrent retries wait, persist completion before releasing results and return
the stored result to identical retries. It must retain an uncertain action failure
or crashed owner's state and fail closed until explicit recovery; dropping a failed
entry or expiring a lock must not automatically rerun possible side effects.
Retention must cover the payment replay window and deployment policy. Application
side effects and replay storage may require transactional coupling or reconciliation.

Only the tests contain a strict process-local coordinator. They prove action count
one for sequential and concurrent identical retries, action count zero for challenge
and failed settlement, separation of paid identities and no automatic rerun after
an uncertain action failure. They do not prove distributed durability or crash
recovery. No production coordinator is supplied; PR #5 remains experimental and
not production-ready.


## RC2 replay-boundary follow-up

The protected-action wrapper was then tested against the same exact RC2 commit with
the real `DirectModeFacilitator`, real `/supported` + `/settle` router and the
standard-native exact-payment fixture. The identical paid request was submitted
twice. Both RC2 settlement responses were equal and the protected action executed
exactly once. The facilitator suite plus this injected proof passed 37/37.

The proof is now reproducible with:

```bash
npm run proof:facilitator-rc2
```

Set `KASPA_X402_SOURCE_DIR` to an existing upstream checkout to avoid downloading it
again; the script clones that checkout into a disposable worktree and still checks
out the exact RC2 commit. This closes the experimental retry/action proof requested
for PR #5, but it does **not** make the integration production-ready: the proof
coordinator is test-only. A real deployment still needs durable atomic coordination
and EmDash/the host must expose the protected-action wrapper boundary.
