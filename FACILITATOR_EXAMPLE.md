# Small EmDash facilitator example

This branch contains a deliberately small facilitator-backed EmDash experiment. It is not exported by the package and does not depend on the unpublished `@kaspa-x402/facilitator` package.

It targets the public upstream facilitator shape at `elldeeone/kaspa-x402` revision `25893d68fc650cf307339619c8460b8814eba6c5`:

- `GET /supported`
- `POST /verify`
- `POST /settle`
- exact payments require a resource-server-derived `requestHash`

The direct `DirectModeServer.handlePaidRequest()` backend remains the reference path.

A local interoperability smoke against the built upstream `DirectModeFacilitator` and `handleFacilitatorRequest()` at that exact revision confirmed that this experiment's `/supported`, `/verify`, and `/settle` request shapes are accepted without using wallet keys, RPC, or a live network. The smoke was intentionally kept out of the committed suite because it depends on a sibling upstream checkout.

## The concrete missing piece

For EmDash, `/supported` is sufficient to answer “can this facilitator handle exact payments on TN10?”, but it does not provide the full dynamic `PaymentRequirements` needed to issue the initial x402 `402` challenge.
Those requirements can contain server-authoritative dynamic state, so the resource server must also recover the same authoritative requirements when the client returns with `PAYMENT-SIGNATURE`. Treating the client's `accepted` object as the authority would weaken that boundary.

The example isolates this requirement behind `paymentRequirementsProvider`. It is intentionally not an answer to how the upstream API should expose or persist that state.

## Example flow

1. Validate EmDash route terms; mainnet remains disabled by default.
2. Call `/supported` and require x402 v2 + `exact` + the requested Kaspa network, with both `verify` and `settle` advertised in `extra.modes`.
3. Obtain full authoritative requirements from `paymentRequirementsProvider`.
4. Unpaid: return those requirements in `PAYMENT-REQUIRED`.
5. Paid: recover authoritative requirements again and require exact equality with the signed `accepted` terms.
6. Derive `requestHash` independently through `requestHashProvider`.
7. Call `/verify`; only a valid result may proceed to `/settle`.
8. Return `PAYMENT-RESPONSE` only after successful settlement.
## Question for upstream

The example leaves one intentionally explicit seam:

> What is the intended source of authoritative `PaymentRequirements` for a remote framework integration?

Two possible shapes would both fit the experiment:

- the facilitator eventually exposes a small requirements/challenge operation; or
- the resource server owns requirement construction/recovery through shared public helpers and deployment state.

The example does not prefer one until the maintainer confirms the intended boundary.

## Safety and scope

This is testnet-oriented experimental code. It is not part of the package export, does not enable mainnet, does not publish anything to npm, and does not claim production readiness.

## Replay finding from the current upstream facilitator

The current upstream facilitator documents `/settle` as using the same replay,
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
- `/verify` transport failure cannot fall through to `/settle`.
- `/settle` transport failure is treated as an uncertain outcome; the adapter does not blindly issue a second settlement request.

This is deliberately conservative. Any future retry policy should depend on an explicit facilitator idempotency/recovery contract rather than generic HTTP retry behavior.

## Real upstream-router interoperability

A disposable local harness was also run against Kaspa x402 upstream commit
`25893d68fc650cf307339619c8460b8814eba6c5` using the real
`DirectModeFacilitator` and `handleFacilitatorRequest()` implementation.

Validated end to end:

- `/supported` advertises executable `exact` TN10 capability only when the server kind includes `extra.modes` for `verify` and `settle`;
- the experimental HTTP transport interoperates with the real `/supported`, `/verify`, and `/settle` routes;
- the full experimental EmDash backend produces the initial `402`, accepts a matching `PAYMENT-SIGNATURE`, derives its own `requestHash`, then reaches the real facilitator router for verification and settlement;
- the test server observed exactly one verification call and one settlement call.

The harness used an in-memory stub behind the real facilitator router, so this is protocol-boundary evidence rather than a funded TN10 settlement proof. No unpublished facilitator dependency was added to this package and the harness is not shipped.
