let atomicApp: Awaited<ReturnType<typeof startAtomicHttpProof>>;
let atomicListener: Awaited<ReturnType<typeof listenLoopback>>;
let atomicFacilitator: DirectModeFacilitator;
let atomicServer: DirectModeServer;
let atomicTerms: ExactPaymentRequirements;
let atomicCalls: Array<{ path: string; body: any; result: any }> = [];
let atomicBaseline: ReturnType<typeof atomicApp.rows>;
async function atomicPayment(title: string, transactionId = EXACT_TX_ID) {
  const body = JSON.stringify({ data: { title } });
  const url = atomicApp.url + "/_emdash/api/content/posts";
  const hash = await atomicHttpRequestHash(new Request(url,
    { method: "POST", headers: atomicApp.headers, body }));
  const payment = makeStandardExactPayment(atomicServer);
  expect(payment.accepted).toEqual(atomicTerms);
  if (payment.payload.type !== "exact-transaction") throw new Error("Wrong RC2 fixture");
  payment.payload.requestHash = hash;
  payment.payload.authorization = fakeExactAuthorization(atomicTerms, hash);
  if (transactionId !== EXACT_TX_ID) {
    // Supplemental independent-payment fixture, not the baseline standard RC2 artifact.
    payment.payload.transaction = '{"transaction":"signed-kip10-exact-second"}';
    payment.payload.authorization.digest = exactRequestAuthorizationDigest({
      network: atomicTerms.network, profile: "standard-native", transactionId,
      paymentOutputIndex: 0, amount: atomicTerms.amount, payTo: atomicTerms.payTo,
      payToScriptPublicKey: atomicTerms.extra.payToScriptPublicKey!,
      paymentRequirementsHash: sha256Hex(stableStringify(atomicTerms)),
      requestHash: hash, inputIndex: 0, expiresAt: payment.payload.authorization.expiresAt,
    });
  }
  payment.extensions = {
    "payment-identifier": paymentIdentifierExtension({ required: true, id: "exact_" + hash }),
  };
  const headers = { ...atomicApp.headers, "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payment) };
  return {
    body, hash, url, headers, payment,
    send: (customHeaders = headers, customBody = body) => fetch(url, {
      method: "POST", headers: customHeaders, body: customBody, signal: AbortSignal.timeout(90000),
    }),
  };
}
async function atomicRead(response: Response) {
  return { status: response.status, body: await response.text(),
    payment: response.headers.get("PAYMENT-RESPONSE"),
    contentType: response.headers.get("content-type") };
}
function atomicRows(delta: number) {
  expect(atomicApp.rows()).toEqual({
    posts: atomicBaseline.posts + delta, operations: atomicBaseline.operations + delta,
    effects: atomicBaseline.effects + delta, revisions: atomicBaseline.revisions,
  });
}
describe("real EmDash atomic HTTP boundary against RC2", () => {
  beforeAll(async () => {
    const initial = makeFacilitator();
    atomicFacilitator = initial.facilitator; atomicServer = initial.server;
    atomicTerms = structuredClone(atomicServer.buildPaymentRequired({
      resource: RESOURCE, scheme: "exact",
    }).accepts[0]) as ExactPaymentRequirements;
    atomicListener = await listenLoopback(async (request, response) => {
      const path = new URL(request.url!, "http://127.0.0.1").pathname;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      const body = raw.length ? JSON.parse(raw.toString()) : undefined;
      const result = await handleFacilitatorRequest(atomicFacilitator, {
        method: request.method!, path, ...(body ? { body } : {}),
      });
      atomicCalls.push({ path, body: structuredClone(body), result: structuredClone(result.body) });
      response.writeHead(result.status, { "content-type": "application/json", ...result.headers });
      response.end(JSON.stringify(result.body));
    });
    try { atomicApp = await startAtomicHttpProof(atomicTerms, atomicListener.url); }
    catch (error) { await atomicListener.close(); atomicListener = undefined!; throw error; }
  }, 180000);
  beforeEach(async () => {
    const fresh = makeFacilitator();
    atomicFacilitator = fresh.facilitator; atomicServer = fresh.server; atomicCalls = [];
    await atomicApp.control("reset");
    atomicBaseline = atomicApp.rows();
  }, 30000);
  afterAll(async () => {
    if (atomicApp) await atomicApp.close();
    if (atomicListener) await atomicListener.close();
  }, 30000);
  it("reproduces valid route input rejected by an unprojected atomic bridge", async () => {
    await atomicApp.control("reset", { mode: "unprojected" });
    const payment = await atomicPayment("valid HTTP JSON");
    const response = await atomicRead(await payment.send());
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe("INVALID_INPUT");
    expect(response.body).toContain("JSON input");
    expect((await atomicApp.control()).pipelineRuns).toBe(0);
    atomicRows(0);
    expect(atomicCalls.filter((call) => call.path === "/settle")).toHaveLength(1);
    console.log("REPRODUCED: normal POST -> INVALID_INPUT/400; pipeline=0; no DB changes");
  }, 90000);

  it("returns server-owned requirements and performs no action for an unpaid 402", async () => {
    const payment = await atomicPayment("unpaid");
    const response = await payment.send(atomicApp.headers);
    expect(response.status).toBe(402);
    expect(decodePaymentRequiredHeader(response.headers.get("PAYMENT-REQUIRED")!).accepts)
      .toEqual([atomicTerms]);
    atomicRows(0);
    expect((await atomicApp.control()).pipelineRuns).toBe(0);
    expect(atomicCalls.filter((call) => call.path === "/settle")).toHaveLength(0);
  }, 90000);
  it("replays identical sequential requests with one real pipeline and committed creation", async () => {
    const payment = await atomicPayment("sequential atomic");
    const first = await atomicRead(await payment.send());
    const second = await atomicRead(await payment.send());
    expect(first.status).toBe(201); expect(second).toEqual(first);
    atomicRows(1);
    const state = await atomicApp.control();
    expect(state.pipelineRuns).toBe(1); expect(state.contentWrites).toBe(1);
    const item = JSON.parse(first.body).data.item;
    expect(atomicApp.post(item.id)).toMatchObject({
      id: item.id, title: "sequential atomic", author_id: item.authorId,
    });
    atomicAssertSettlements(2);
    expect(decodePaymentResponseHeader(first.payment!)).toEqual(atomicSettles()[0].result);
    const names = state.events.map((event: any) => event.name);
    expect(names.indexOf("settled")).toBeLessThan(names.indexOf("action-started"));
    expect(names.indexOf("committed")).toBeLessThan(names.indexOf("response-ready"));
    console.log("ATOMIC HTTP sequential: settlement equal; pipeline=1; committed post=1");
  }, 90000);
  it("serializes two concurrently settled identical HTTP requests in real SQLite", async () => {
    await atomicApp.control("reset", { pauses: "settled" });
    const payment = await atomicPayment("concurrent atomic");
    const offset = atomicApp.events.length;
    const first = atomicCapture(payment.send()), second = atomicCapture(payment.send());
    try {
      await atomicApp.waitStage("settled", offset, 2);
      atomicRows(0); atomicAssertSettlements(2);
    } finally { atomicApp.release(); }
    const replies = await Promise.all([first, second]);
    for (const reply of replies) expect(reply.error).toBeUndefined();
    expect(replies[0].response!.status).toBe(201);
    expect(replies[1].response).toEqual(replies[0].response);
    atomicRows(1);
    expect((await atomicApp.control()).pipelineRuns).toBe(1);
    expect((await atomicApp.control()).contentWrites).toBe(1);
  }, 90000);
  it("rejects a failed request-bound settlement before running any CMS work", async () => {
    const payment = await atomicPayment("original signed body");
    const response = await payment.send(payment.headers,
      JSON.stringify({ data: { title: "tampered body" } }));
    expect(response.status).toBe(500);
    const settlements = atomicSettles();
    expect(settlements).toHaveLength(1);
    expect(settlements[0].result.success).toBe(false);
    expect((await atomicApp.control()).pipelineRuns).toBe(0); atomicRows(0);
  }, 90000);
  it("rejects client-selected payment requirements instead of passing them to settle", async () => {
    const payment = await atomicPayment("cheap injected terms");
    const altered = structuredClone(payment.payment);
    altered.accepted.amount = "1";
    const response = await payment.send({
      ...payment.headers, "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(altered),
    });
    expect(response.status).toBe(500);
    expect(atomicSettles()).toHaveLength(0); atomicRows(0);
    expect((await atomicApp.control()).pipelineRuns).toBe(0);
  }, 90000);
  it("does not let a client tenant hint select a second durable operation", async () => {
    const payment = await atomicPayment("tenant binding");
    expect((await payment.send({ ...payment.headers, "x-tenant": "other" })).status).toBe(403);
    atomicRows(0); expect(atomicSettles()).toHaveLength(0);
    expect((await atomicApp.control()).pipelineRuns).toBe(0);
  }, 90000);
  it("rejects an invalid PAT before settlement or content work", async () => {
    const original = await atomicPayment("unauthenticated request");
    const headers = { ...atomicApp.headers, authorization: "Bearer invalid-token" };
    const hash = await atomicHttpRequestHash(new Request(original.url,
      { method: "POST", headers, body: original.body }));
    const payment = structuredClone(original.payment);
    if (payment.payload.type !== "exact-transaction") throw new Error("Wrong fixture");
    payment.payload.requestHash = hash;
    payment.payload.authorization = fakeExactAuthorization(atomicTerms, hash);
    payment.extensions = { "payment-identifier":
      paymentIdentifierExtension({ required: true, id: "exact_" + hash }) };
    const response = await original.send({
      ...headers, "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payment),
    });
    expect(response.status).toBe(401);
    expect(atomicSettles()).toHaveLength(0); atomicRows(0);
    expect((await atomicApp.control()).pipelineRuns).toBe(0);
  }, 90000);
  it("retains committed replay across a resource-server restart", async () => {
    const payment = await atomicPayment("restart replay");
    const first = await atomicRead(await payment.send());
    expect(first.status).toBe(201); atomicRows(1);
    const oldPid = atomicApp.workers.at(-1), oldUrl = atomicApp.url;
    await atomicApp.restart();
    expect(atomicApp.workers.at(-1)).not.toBe(oldPid); expect(atomicApp.url).toBe(oldUrl);
    const second = await atomicRead(await payment.send());
    expect(second).toEqual(first); atomicRows(1); atomicAssertSettlements(2);
    expect((await atomicApp.control()).pipelineRuns).toBe(0);
    expect((await atomicApp.control()).contentWrites).toBe(0);
  }, 180000);
  it("does not replay committed content for a different, unpaid request body", async () => {
    const payment = await atomicPayment("committed original");
    expect((await payment.send()).status).toBe(201);
    const response = await payment.send(payment.headers,
      JSON.stringify({ data: { title: "different request" } }));
    expect(response.status).toBe(500); atomicRows(1);
    expect((await atomicApp.control()).pipelineRuns).toBe(1);
    expect(atomicSettles()[1].result.success).toBe(false);
  }, 90000);
  it("does not split a settled output when payment JSON encoding changes", async () => {
    const payment = await atomicPayment("header encoding");
    const first = await atomicRead(await payment.send());
    const reordered = Object.fromEntries(Object.entries(payment.payment).reverse());
    const signature = Buffer.from(JSON.stringify(reordered, null, 2)).toString("base64");
    expect(signature).not.toBe(payment.headers["PAYMENT-SIGNATURE"]);
    const second = await atomicRead(await payment.send({
      ...payment.headers, "PAYMENT-SIGNATURE": signature, "x-ignored-proof-header": "extra",
    }));
    expect(first.status).toBe(201); expect(second).toEqual(first); atomicRows(1);
    expect((await atomicApp.control()).pipelineRuns).toBe(1);
    expect(atomicSettles()).toHaveLength(2);
    expect(atomicSettles()[1].result).toEqual(atomicSettles()[0].result);
  }, 90000);
  it("fails closed when a committed operation loses its replay result", async () => {
    const payment = await atomicPayment("lost saved result");
    const first = await atomicRead(await payment.send());
    expect(first.status).toBe(201);
    atomicApp.clearReplayResult(JSON.parse(first.body).data.item.id);
    const retry = await atomicRead(await payment.send());
    expect(retry.status).toBe(500);
    expect(JSON.parse(retry.body).error.code).toBe("CONTENT_CREATE_ERROR");
    atomicRows(1); atomicAssertSettlements(2);
    expect((await atomicApp.control()).pipelineRuns).toBe(1);
    expect((await atomicApp.control()).contentWrites).toBe(1);
  }, 90000);
  it("rejects a changed host policy binding without repeating the committed action", async () => {
    const payment = await atomicPayment("binding conflict");
    expect((await payment.send()).status).toBe(201);
    await atomicApp.control("reset", { mode: "changed-binding" });
    const retry = await atomicRead(await payment.send());
    expect(retry.status).toBe(409);
    expect(JSON.parse(retry.body).error.code).toBe("CONFLICT");
    atomicRows(1); atomicAssertSettlements(2);
    expect((await atomicApp.control()).pipelineRuns).toBe(0);
  }, 90000);
  it("keeps two independently settled requests in distinct durable operations", async () => {
    const alternate = "78".repeat(32);
    const fresh = makeFacilitator({ exactTransactionVerifier: {
      verifyExactPayment(request) {
        return {
          transactionId: request.transaction === EXACT_TRANSACTION_ARTIFACT ? EXACT_TX_ID : alternate,
          paymentOutput: { amount: request.amount, scriptPublicKey: request.payToScriptPublicKey },
          finality: "accepted", payerAddress: "kaspatest:refund",
          requestAuthorization: fakeAuthorizationEvidence(request.authorization),
        };
      },
    } });
    // The standard chain fixture always returns EXACT_TX_ID; extend both fake
    // adapters consistently for this supplemental second-payment case.
    fresh.chain.sendTransaction = async (transaction) => {
      const transactionId = transaction === EXACT_TRANSACTION_ARTIFACT ? EXACT_TX_ID : alternate;
      return { transactionId, evidence: acceptedChainEvidence(transactionId), finality: "accepted" };
    };
    atomicFacilitator = fresh.facilitator; atomicServer = fresh.server;
    const firstPayment = await atomicPayment("independent first");
    const secondPayment = await atomicPayment("independent second", alternate);
    const first = await atomicRead(await firstPayment.send());
    const second = await atomicRead(await secondPayment.send());
    expect(first.status).toBe(201); expect(second.status).toBe(201); atomicRows(2);
    expect(JSON.parse(first.body).data.item.id).not.toBe(JSON.parse(second.body).data.item.id);
    expect(atomicSettles().map((call) => call.result.transaction)).toEqual([EXACT_TX_ID, alternate]);
    expect((await atomicApp.control()).pipelineRuns).toBe(2);
    expect((await atomicApp.control()).contentWrites).toBe(2);
  }, 90000);
  it("rechecks EmDash permissions before returning a committed replay after restart", async () => {
    const payment = await atomicPayment("permission revocation");
    const first = await atomicRead(await payment.send());
    expect(first.status).toBe(201);
    const actorId = JSON.parse(first.body).data.item.authorId;
    const originalRole = atomicApp.userRole(actorId, 10); // ROLE_SUBSCRIBER
    try {
      await atomicApp.restart();
      const denied = await atomicRead(await payment.send());
      expect(denied.status).toBe(403);
      atomicRows(1);
      expect((await atomicApp.control()).pipelineRuns).toBe(0);
      atomicAssertSettlements(2);
    } finally { atomicApp.userRole(actorId, originalRole); }
  }, 180000);
  for (const stage of [
    "settled", "claimed", "action-started", "content-written",
    "replay-written", "outbox-written", "before-commit", "committed", "response-ready",
  ]) {
    it("survives real HTTP worker SIGKILL at " + stage, async () => {
      await atomicApp.control("reset", { pauses: stage });
      const payment = await atomicPayment("crash at " + stage);
      const offset = atomicApp.events.length;
      const oldPid = atomicApp.workers.at(-1), oldUrl = atomicApp.url;
      const pending = atomicCapture(payment.send());
      await atomicApp.waitStage(stage, offset);
      expect(atomicApp.events.slice(offset).some((event: any) => event.name === "settled")).toBe(true);
      atomicAssertSettlements(1);
      await atomicApp.kill();
      const interrupted = await pending;
      expect(interrupted.error).toBeTruthy(); expect(interrupted.response).toBeUndefined();
      const committed = ["committed", "response-ready"].includes(stage);
      atomicRows(committed ? 1 : 0);
      // Ledger ordering is checked against the persisted new content, not insertion order.
      const savedResults = atomicApp.ledger().filter((row: any) => row.result)
        .map((row: any) => JSON.parse(row.result));
      await atomicApp.restart();
      expect(atomicApp.workers.at(-1)).not.toBe(oldPid); expect(atomicApp.url).toBe(oldUrl);
      const retry = await atomicRead(await payment.send());
      expect(retry.status).toBe(201); atomicRows(1); atomicAssertSettlements(2);
      expect(JSON.parse(retry.body).data.item.data.title).toBe("crash at " + stage);
      const stats = await atomicApp.control();
      expect(stats.pipelineRuns).toBe(committed ? 0 : 1);
      expect(stats.contentWrites).toBe(committed ? 0 : 1);
      if (committed)
        expect(savedResults).toContainEqual(JSON.parse(retry.body));
      expect(decodePaymentResponseHeader(retry.payment!)).toEqual(atomicSettles()[0].result);
      const writes = atomicApp.events.slice(offset).filter((event: any) => event.name === "content-written");
      expect(writes.length).toBe(["content-written","replay-written","outbox-written","before-commit"]
        .includes(stage) ? 2 : 1);
      console.log("HTTP SIGKILL " + stage + ": retry=201; committed post=1; retry pipeline=" + stats.pipelineRuns);
    }, 180000);
  }
  it("negative control: a payment gate without the atomic boundary duplicates after restart", async () => {
    await atomicApp.control("reset", { mode: "gate-only" });
    const offset = atomicApp.events.length;
    const payment = await atomicPayment("gate-only duplicate");
    const first = await atomicRead(await payment.send());
    expect(first.status).toBe(201);
    await atomicApp.restart();
    await atomicApp.control("reset", { mode: "gate-only" });
    const second = await atomicRead(await payment.send());
    expect(second.status).toBe(201);
    expect(JSON.parse(second.body).data.item.id).not.toBe(JSON.parse(first.body).data.item.id);
    const rows = atomicApp.rows();
    expect(rows).toEqual({ ...atomicBaseline, posts: atomicBaseline.posts + 2 });
    atomicAssertSettlements(2);
    expect((await atomicApp.control()).pipelineRuns).toBe(1);
    expect(atomicApp.events.slice(offset).filter((event: any) => event.name === "action-started")).toHaveLength(2);
    expect(atomicApp.events.slice(offset).filter((event: any) => event.name === "content-written")).toHaveLength(2);
    console.log("NEGATIVE CONTROL: same settlement + enforce-only -> two real posts");
  }, 180000);
});
function atomicSettles() { return atomicCalls.filter((call) => call.path === "/settle"); }
function atomicAssertSettlements(attempts: number) {
  const settlements = atomicSettles();
  expect(settlements).toHaveLength(attempts);
  expect(atomicCalls.some((call) => call.path === "/verify")).toBe(false);
  expect(atomicCalls.every((call) => ["/supported", "/settle"].includes(call.path))).toBe(true);
  for (const call of settlements) {
    expect(call.body.paymentRequirements).toEqual(atomicTerms);
    expect(call.result).toMatchObject({
      success: true, transaction: EXACT_TX_ID, network: atomicTerms.network,
      amount: atomicTerms.amount, extensions: { kaspa: {
        requestHash: call.body.requestHash, paymentOutputIndex: 0,
        exactProfile: "standard-native", finality: "accepted",
        transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      } },
    });
  }
  if (attempts === 2) {
    expect(settlements[1].body).toEqual(settlements[0].body);
    expect(settlements[1].result).toEqual(settlements[0].result);
  }
}
async function atomicCapture(promise: Promise<Response>) {
  try { return { response: await atomicRead(await promise), error: undefined }; }
  catch (error) { return { response: undefined, error }; }
}
