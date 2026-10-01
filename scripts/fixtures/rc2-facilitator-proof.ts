// Appended to the pinned upstream facilitator suite to reuse its exact-payment fixture.
// Chain/verifier adapters and replay storage remain test-only.
type Rc2ProofPage = {
  status: number;
  body: string;
  headers: Record<string, string>;
  settlement: unknown;
};

function rc2ProofDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function rc2ProofRequestHash(request: Request) {
  return sha256Hex(
    stableStringify({
      method: request.method,
      url: request.url,
      body: await request.clone().text(),
      tenant: request.headers.get("x-tenant"),
    }),
  );
}

async function makeRc2AdapterProof() {
  const { facilitator, server } = makeFacilitator();
  const paymentPayload = makeStandardExactPayment(server);
  const authoritative = structuredClone(
    server.buildPaymentRequired({
      resource: RESOURCE,
      scheme: "exact",
    }).accepts[0],
  ) as ExactPaymentRequirements;
  expect(paymentPayload.accepted).toEqual(authoritative);
  const hash = await rc2ProofRequestHash(new Request(RESOURCE.url));
  if (paymentPayload.payload.type !== "exact-transaction")
    throw new Error("expected RC2 standard-native exact fixture");
  paymentPayload.payload.requestHash = hash;
  paymentPayload.payload.authorization = fakeExactAuthorization(
    authoritative,
    hash,
  );
  paymentPayload.extensions = {
    "payment-identifier": paymentIdentifierExtension({
      required: true,
      id: `exact_${hash}`,
    }),
  };
  const paths: string[] = [];
  const settlementInputs: Record<string, unknown>[] = [];
  const settlements: Record<string, unknown>[] = [];
  const fetchBridge = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    const response = await handleFacilitatorRequest(facilitator, {
      method: init?.method ?? "GET",
      path: url.pathname,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    return Response.json(response.body, {
      status: response.status,
      headers: response.headers,
    });
  };
  const baseTransport = createFacilitatorHttpTransport(
    "https://facilitator.example.test",
    fetchBridge as typeof fetch,
  );
  const transport = {
    supported: () => baseTransport.supported(),
    async settle(input: Record<string, unknown>) {
      settlementInputs.push(structuredClone(input));
      const result = await baseTransport.settle(input);
      settlements.push(structuredClone(result));
      return result;
    },
  };
  const backend = createExperimentalKaspaFacilitatorBackend({
    transport,
    paymentRequirementsProvider: () => structuredClone(authoritative),
    requestHashProvider: ({ request }) => rc2ProofRequestHash(request),
  });
  const context = {
    price: { amount: authoritative.amount, asset: "KAS" },
    payTo: authoritative.payTo,
    network: authoritative.network,
    scheme: authoritative.scheme,
    maxTimeoutSeconds: authoritative.maxTimeoutSeconds,
  };
  const coordinator = new StrictTestCoordinator<Rc2ProofPage>();
  const execute = createExperimentalPaidActionExecutor({
    backend,
    replayCoordinator: coordinator,
    operationId: "rc2-proof:premium-page",
  });
  const signature = encodePaymentSignatureHeader(paymentPayload);
  const request = (header = signature) =>
    new Request(RESOURCE.url, {
      headers: { "PAYMENT-SIGNATURE": header },
    });
  let actionRuns = 0;
  const action = async (enforcement: {
    settlement?: unknown;
    responseHeaders: Record<string, string>;
  }) => {
    actionRuns += 1;
    expect(enforcement.settlement).toMatchObject({ success: true });
    return {
      status: 200,
      body: "protected-result",
      settlement: structuredClone(enforcement.settlement),
      headers: { "content-type": "text/plain", ...enforcement.responseHeaders },
    };
  };
  const run = (candidate = request()) => execute(candidate, context, action);
  const assertFlow = (attempts: number) => {
    expect(paths.filter((path) => path === "/supported")).toHaveLength(
      attempts,
    );
    expect(paths.filter((path) => path === "/settle")).toHaveLength(attempts);
    expect(paths.filter((path) => path === "/verify")).toHaveLength(0);
    expect(paths).toHaveLength(attempts * 2);
    expect(settlementInputs).toHaveLength(attempts);
    expect(settlementInputs[0]).toMatchObject({
      paymentRequirements: authoritative,
      requestHash: hash,
    });
  };
  return {
    backend,
    context,
    execute,
    coordinator,
    paymentPayload,
    signature,
    request,
    action,
    run,
    transport,
    settlements,
    settlementInputs,
    paths,
    assertFlow,
    actionRuns: () => actionRuns,
  };
}

describe("external adapter RC2 protected-action proof", () => {
  it("replays completed results, settlement and headers after two identical settlements", async () => {
    const proof = await makeRc2AdapterProof();
    const first = await proof.run();
    const second = await proof.run();
    expect(first).toMatchObject({ status: 200, body: "protected-result" });
    expect(second).toEqual(first);
    expect(proof.settlements[0]).toMatchObject({
      success: true,
      network: "kaspa:testnet-10",
    });
    expect(proof.settlements[1]).toEqual(proof.settlements[0]);
    expect(proof.settlementInputs[1]).toEqual(proof.settlementInputs[0]);
    expect(proof.actionRuns()).toBe(1);
    proof.assertFlow(2);
    if (first instanceof Response || second instanceof Response)
      throw new Error("expected stored pages");
    const firstResponse = new Response(first.body, {
      status: first.status,
      headers: first.headers,
    });
    const secondResponse = new Response(second.body, {
      status: second.status,
      headers: second.headers,
    });
    expect(await firstResponse.text()).toBe("protected-result");
    expect(await secondResponse.text()).toBe("protected-result");
    expect(secondResponse.headers.get("PAYMENT-RESPONSE")).toBe(
      firstResponse.headers.get("PAYMENT-RESPONSE"),
    );
    expect(
      decodePaymentResponseHeader(
        secondResponse.headers.get("PAYMENT-RESPONSE")!,
      ),
    ).toEqual(proof.settlements[0]);
  });

  it("coalesces concurrent retries while the action is pending", async () => {
    const proof = await makeRc2AdapterProof();
    const started = rc2ProofDeferred<void>();
    const release = rc2ProofDeferred<void>();
    const bothCoordinating = rc2ProofDeferred<void>();
    const originalRunOnce = proof.coordinator.runOnce.bind(proof.coordinator);
    proof.coordinator.runOnce = (key, callback) => {
      const result = originalRunOnce(key, callback);
      if (proof.coordinator.keys.length === 2) bothCoordinating.resolve();
      return result;
    };
    let callbackRuns = 0;
    const action = async (result: Parameters<typeof proof.action>[0]) => {
      callbackRuns += 1;
      started.resolve();
      await release.promise;
      return proof.action(result);
    };
    const first = proof.execute(proof.request(), proof.context, action);
    const second = proof.execute(proof.request(), proof.context, action);
    await Promise.all([started.promise, bothCoordinating.promise]);
    expect(proof.settlements).toHaveLength(2);
    expect(callbackRuns).toBe(1);
    release.resolve();
    expect(await first).toEqual(await second);
    expect(proof.actionRuns()).toBe(1);
    expect(proof.settlements[1]).toEqual(proof.settlements[0]);
    proof.assertFlow(2);
  });

  it("uses the same action identity for differently encoded valid payment JSON", async () => {
    const proof = await makeRc2AdapterProof();
    const variant = Buffer.from(
      JSON.stringify(proof.paymentPayload, null, 1),
    ).toString("base64");
    expect(variant).not.toBe(proof.signature);
    expect(await proof.run(proof.request(variant))).toEqual(await proof.run());
    expect(proof.actionRuns()).toBe(1);
    expect(proof.settlements[1]).toEqual(proof.settlements[0]);
    proof.assertFlow(2);
  });

  it("returns 402 without work and rejects a conflicting request hash after settlement", async () => {
    const proof = await makeRc2AdapterProof();
    const unpaid = await proof.execute(
      new Request(RESOURCE.url),
      proof.context,
      proof.action,
    );
    expect(unpaid).toBeInstanceOf(Response);
    expect((unpaid as Response).status).toBe(402);
    const requirements = decodePaymentRequiredHeader(
      (unpaid as Response).headers.get("PAYMENT-REQUIRED")!,
    );
    expect(requirements.accepts[0]).toEqual(proof.paymentPayload.accepted);
    expect(proof.actionRuns()).toBe(0);
    expect(proof.settlements).toHaveLength(0);
    await proof.run();
    const conflicting = new Request(proof.request(), {
      headers: {
        "PAYMENT-SIGNATURE": proof.signature,
        "x-tenant": "different",
      },
    });
    await expect(proof.run(conflicting)).rejects.toThrow(
      "invalid_transaction_state",
    );
    expect(proof.actionRuns()).toBe(1);
    expect(proof.settlements[1]).toMatchObject({ success: false });
    expect(proof.paths).not.toContain("/verify");
  });

  it("keeps an uncertain protected failure closed across settled retries", async () => {
    const proof = await makeRc2AdapterProof();
    let attempts = 0;
    const uncertain = async () => {
      attempts += 1;
      throw new Error("possible side effect");
    };
    await expect(
      proof.execute(proof.request(), proof.context, uncertain),
    ).rejects.toThrow("possible side effect");
    await expect(
      proof.execute(proof.request(), proof.context, uncertain),
    ).rejects.toThrow("possible side effect");
    expect(attempts).toBe(1);
    expect(proof.settlements[1]).toEqual(proof.settlements[0]);
    proof.assertFlow(2);
  });

  it("keeps identity stable if the caller mutates headers during settlement", async () => {
    const proof = await makeRc2AdapterProof();
    const settled = rc2ProofDeferred<void>();
    const release = rc2ProofDeferred<void>();
    const originalSettle = proof.transport.settle;
    proof.transport.settle = async (input) => {
      const result = await originalSettle(input);
      if (proof.settlements.length === 1) {
        settled.resolve();
        await release.promise;
      }
      return result;
    };
    const candidate = proof.request();
    const first = proof.run(candidate);
    await settled.promise;
    candidate.headers.set("PAYMENT-SIGNATURE", "local-mutation");
    release.resolve();
    expect(await first).toEqual(await proof.run());
    expect(proof.actionRuns()).toBe(1);
    expect(proof.settlements[1]).toEqual(proof.settlements[0]);
    proof.assertFlow(2);
  });

  it("demonstrates that an enforce-only host runs work twice", async () => {
    const proof = await makeRc2AdapterProof();
    for (let i = 0; i < 2; i++) {
      const result = await proof.backend.enforce(
        proof.request(),
        proof.context,
      );
      if (result instanceof Response)
        throw new Error("expected successful gate");
      await proof.action(result);
    }
    expect(proof.settlements[1]).toEqual(proof.settlements[0]);
    expect(proof.actionRuns()).toBe(2);
    proof.assertFlow(2);
  });

  it("demonstrates that losing local coordinator state permits a second action", async () => {
    const proof = await makeRc2AdapterProof();
    const first = await proof.run();
    const restartedHost = createExperimentalPaidActionExecutor({
      backend: proof.backend,
      replayCoordinator: new StrictTestCoordinator<Rc2ProofPage>(),
      operationId: "rc2-proof:premium-page",
    });
    expect(
      await restartedHost(proof.request(), proof.context, proof.action),
    ).toEqual(first);
    expect(proof.actionRuns()).toBe(2);
    expect(proof.settlements[1]).toEqual(proof.settlements[0]);
    proof.assertFlow(2);
  });
});
