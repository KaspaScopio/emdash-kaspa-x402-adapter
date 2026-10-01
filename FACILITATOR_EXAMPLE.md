# Experimental facilitator example

This source-only example follows Kaspa x402 RC2's upfront flow and prototypes the
additional host boundary needed to replay a protected result. It is experimental,
not exported by the package and not a stock EmDash integration. The development
dependency on `@kaspa-x402/core` is pinned to `1.0.0-rc.2`.

## Flow

1. Validate the resource server's route terms and discover /supported capabilities.
2. Obtain authoritative PaymentRequirements from paymentRequirementsProvider.
3. Without payment, return those requirements in a 402 PAYMENT-REQUIRED challenge.
4. With payment, require full equality with the authoritative accepted terms.
5. Derive requestHash independently from the resource server's request/policy.
6. Call /settle directly and validate its successful result against those terms.
7. Run the protected callback through the deployment's replay coordinator.

There is no separate /verify call. The facilitator does not supply a challenge
endpoint here. For standard-native fixed-price payments, requirements stay with the
resource server; upstream plans a shared helper after v1. A provider must construct
or retrieve trusted requirements and use client input only as an untrusted lookup
hint. The initial challenge and paid retry must resolve the same authoritative terms.

## Host integration sketch

The host supplies backend, context, request, durableCoordinator and the protected
operation. This is not an Astro configuration supported by stock EmDash.

```ts
import { createExperimentalPaidActionExecutor } from "./src/experimental/protected-action-replay.js";

type StoredPage = {
  status: number;
  body: string;
  headers: Record<string, string>;
  settlement: unknown;
};

const executePaid = createExperimentalPaidActionExecutor<StoredPage>({
  backend,
  replayCoordinator: durableCoordinator,
  operationId: "my-cms:premium-article:v1",
});

const result = await executePaid(
  request,
  context,
  async (enforcement, input) => ({
    status: 200,
    body: await runProtectedEmDashAction(input.request),
    headers: { "content-type": "text/html", ...enforcement.responseHeaders },
    settlement: enforcement.settlement,
  }),
);

return result instanceof Response
  ? result
  : new Response(result.body, {
      status: result.status,
      headers: result.headers,
    });
```

Keep side effects inside the callback and use its captured input.request/context,
rather than closing over the original mutable request. Store serializable data and materialize a
fresh Response per retry; a consumed Response stream is not a durable replay record.
The host must use the same stable operationId across its workers and a different one
for distinct actions. Do not use a random per-request identifier.

The default policy snapshots request/context before enforcement and binds method,
URL, canonical validated payment, settlement network/transaction, context, all other
headers and exact body bytes. Valid payment JSON whitespace/key-order variants
coalesce. Changed tenants, bodies or host action namespaces remain distinct.

All non-payment headers are bound conservatively, including incidental headers.
Deployments needing a narrower semantic policy can supply replayKeyProvider, which
receives an independent captured Request/context and the enforcement result. That
policy must preserve the operation's authoritative identity and tenant/body binding.
It owns validation when replacing the default. See [the design](FACILITATOR_DESIGN.md)
for the exact v2 tuple and the consequences of changing identity versions.

The backend matches successful settlement network and amount against route terms,
and checks supplied request-hash/output/profile/encoding/finality metadata. This is consistency
checking of a trusted facilitator response, not independent chain verification.

## Durable coordination remains deployment work

ProtectedActionReplayCoordinator is an interface, not a production storage adapter.
It must elect one owner before invoking the callback, coordinate workers, persist
results before releasing retries, retain uncertain failures/crashes and cover the
payment replay window. Neither automatic lock expiry nor deleting failed entries
may authorize another action attempt.

The test-only coordinator shares those local ownership/failure semantics but uses
a Map. It cannot survive a process restart. The RC2 proof explicitly demonstrates
that losing its state causes a second action execution even though settlement stays
idempotent. No production action-once or recovery guarantee is implied.

Stock EmDash's enforce API is a payment gate and does not receive the actual protected
callback. Settlement replay cannot prevent work outside that gate from running again.
The example therefore still requires a host/framework integration boundary.

## Execute the evidence

```bash
npm ci
npm test
npm run typecheck
npm run build
npm audit --omit=dev
git diff --check
npm run proof:facilitator-rc2
```

The script checks the exact upstream commit
`724c5fff22de500fcf729c43b59d25036fbffa9c`, the dereferenced v1.0.0-rc.2 tag
and package versions. KASPA_X402_SOURCE_DIR may point to an existing git checkout;
the script clones its committed source into a disposable checkout, ignoring local
source modifications, and still pins RC2. KEEP_KASPA_X402_RC2_PROOF=1 retains it.

The injected fixture is readable at scripts/fixtures/rc2-facilitator-proof.ts.
Its eight cases test:

- equal settlement, one action and replayed settlement/headers for completed retries;
- concurrent identical retries with the action held in flight;
- differently encoded valid payment JSON;
- an initial 402 and an actual RC2 rejection for conflicting request identity;
- retained uncertain action failure across retries;
- caller header mutation while settlement is pending;
- duplicate action execution when the host uses only enforce;
- duplicate action execution after losing local coordinator state.

Expected results: upstream suite plus proof 44/44; adapter suite 90/90. Positive
retry cases execute one action. Negative controls intentionally observe two.

The facilitator, router and server are real RC2 code. The fetch bridge is in memory;
the standard-native exact fixture uses simulated chain, address and signature
verification adapters. Requirements come from the fixture server's
`buildPaymentRequired()`, independently of the client-submitted `accepted` object.
Construction without a local server is not demonstrated. The requestHash is derived
from method, URL, body and tenant. No wallet/RPC or funded transaction is exercised; the protected operation is a callback counter and stored
page record, not an actual EmDash action.

These results support the experimental same-settlement/action-once boundary within
a retained coordinator and stable operation identity. They do not establish
distributed durability, crash recovery, mainnet safety or stock EmDash compatibility.
