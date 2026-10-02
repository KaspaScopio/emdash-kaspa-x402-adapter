// Appended to the pinned RC2 facilitator suite. The HTTP app runs pinned EmDash main.
let emdashHttpApp: Awaited<ReturnType<typeof startEmDashHttpProof>>;
let emdashHttpListener: Awaited<ReturnType<typeof listenLoopback>>;
let emdashHttpFacilitator: DirectModeFacilitator;
let emdashHttpServer: DirectModeServer;
let emdashHttpTerms: ExactPaymentRequirements;
let emdashHttpCalls: Array<{ path: string; body?: any; result: any }> = [];
let emdashHttpBaseline: { posts: number; revisions: number };

async function emdashHttpPayment(title: string) {
  const body = JSON.stringify({ data: { title } });
  const url = emdashHttpApp.url + "/_emdash/api/content/posts";
  const request = new Request(url, { method: "POST", headers: emdashHttpApp.headers, body });
  const hash = await rc2ProofRequestHash(request);
  const payment = makeStandardExactPayment(emdashHttpServer);
  expect(payment.accepted).toEqual(emdashHttpTerms);
  if (payment.payload.type !== "exact-transaction") throw new Error("Wrong fixture");
  payment.payload.requestHash = hash;
  payment.payload.authorization = fakeExactAuthorization(emdashHttpTerms, hash);
  payment.extensions = {
    "payment-identifier": paymentIdentifierExtension({ required: true, id: "exact_" + hash }),
  };
  const headers = { ...emdashHttpApp.headers, "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payment) };
  const send = (customHeaders = headers) => fetch(url, {
    method: "POST", headers: customHeaders, body, signal: AbortSignal.timeout(30000),
  });
  return { body, url, hash, payment, headers, send };
}
async function emdashHttpRead(response: Response) {
  return {
    status: response.status, body: await response.text(),
    paymentResponse: response.headers.get("PAYMENT-RESPONSE"),
    contentType: response.headers.get("content-type"),
  };
}
function emdashHttpRows(delta: number) {
  expect(emdashHttpApp.rows()).toEqual({
    posts: emdashHttpBaseline.posts + delta,
    revisions: emdashHttpBaseline.revisions,
  });
}
async function emdashHttpAssertFlow(attempts: number, actions: number) {
  const state = await emdashHttpApp.control();
  expect(state.actionRuns).toBe(actions);
  const settles = emdashHttpCalls.filter((call) => call.path === "/settle");
  expect(settles).toHaveLength(attempts);
  expect(emdashHttpCalls.filter((call) => call.path === "/verify")).toHaveLength(0);
  expect(emdashHttpCalls.every((call) => ["/settle", "/supported"].includes(call.path))).toBe(true);
  for (const call of settles) {
    expect(call.body.paymentRequirements).toEqual(emdashHttpTerms);
    expect(call.result).toMatchObject({ success: true, transaction: EXACT_TX_ID });
  }
  expect(state.settlements).toHaveLength(attempts);
  if (attempts === 2) {
    expect(settles[1].body).toEqual(settles[0].body);
    expect(settles[1].result).toEqual(settles[0].result);
    expect(state.settlements[1]).toEqual(state.settlements[0]);
  }
  const actionIndex = state.events.indexOf("action:start");
  if (actions) {
    expect(actionIndex).toBeGreaterThan(state.events.indexOf("settle:success"));
    expect(state.events.indexOf("settle:success")).toBeGreaterThanOrEqual(0);
  }
  return state;
}

describe("real EmDash/Astro HTTP boundary against RC2", () => {
  beforeAll(async () => {
    const initial = makeFacilitator();
    emdashHttpFacilitator = initial.facilitator;
    emdashHttpServer = initial.server;
    emdashHttpTerms = structuredClone(initial.server.buildPaymentRequired({
      resource: RESOURCE, scheme: "exact",
    }).accepts[0]) as ExactPaymentRequirements;
    emdashHttpListener = await listenLoopback(async (request, response) => {
      const path = new URL(request.url!, "http://127.0.0.1").pathname;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      const body = raw.length ? JSON.parse(raw.toString()) : undefined;
      const result = await handleFacilitatorRequest(emdashHttpFacilitator, {
        method: request.method!, path, ...(body ? { body } : {}),
      });
      emdashHttpCalls.push({ path, body: structuredClone(body), result: structuredClone(result.body) });
      response.writeHead(result.status, { "content-type": "application/json", ...result.headers });
      response.end(JSON.stringify(result.body));
    });
    try {
      emdashHttpApp = await startEmDashHttpProof(emdashHttpTerms, emdashHttpListener.url);
    } catch (error) { await emdashHttpListener.close(); emdashHttpListener = undefined!; throw error; }
  }, 120000);
  beforeEach(async () => {
    const fresh = makeFacilitator();
    emdashHttpFacilitator = fresh.facilitator;
    emdashHttpServer = fresh.server;
    emdashHttpCalls = [];
    await emdashHttpApp.control("reset");
    emdashHttpBaseline = emdashHttpApp.rows();
  });
  afterAll(async () => {
    if (emdashHttpApp) await emdashHttpApp.close();
    if (emdashHttpListener) await emdashHttpListener.close();
  });

  it("returns an authoritative 402 without entering the real CMS action", async () => {
    const payment = await emdashHttpPayment("unpaid");
    const response = await payment.send(emdashHttpApp.headers);
    expect(response.status).toBe(402);
    expect(decodePaymentRequiredHeader(response.headers.get("PAYMENT-REQUIRED")!).accepts)
      .toEqual([emdashHttpTerms]);
    emdashHttpRows(0);
    expect((await emdashHttpApp.control()).actionRuns).toBe(0);
    expect(emdashHttpCalls.filter((call) => call.path === "/settle")).toHaveLength(0);
  }, 30000);

  it("replays two identical paid HTTP requests as one real post", async () => {
    const payment = await emdashHttpPayment("sequential");
    const first = await emdashHttpRead(await payment.send());
    const second = await emdashHttpRead(await payment.send());
    expect(first.status).toBe(201);
    expect(second).toEqual(first);
    const json = JSON.parse(first.body);
    expect(json.data.item.data.title).toBe("sequential");
    expect(json.data.item.id).toBeTruthy();
    const persisted = emdashHttpApp.post(json.data.item.id);
    expect(persisted).toMatchObject({
      id: json.data.item.id, title: "sequential", status: "draft",
    });
    expect(persisted.author_id).toBeTruthy();
    const state = await emdashHttpAssertFlow(2, 1);
    expect(decodePaymentResponseHeader(first.paymentResponse!)).toEqual(state.settlements[0]);
    emdashHttpRows(1);
    console.log("HTTP sequential: settlement equal; action=1; posts=+1; revisions=unchanged");
  }, 30000);

  it("coalesces concurrent HTTP requests while real CMS work is held", async () => {
    await emdashHttpApp.control("reset", { hold: "1" });
    const payment = await emdashHttpPayment("concurrent");
    const first = payment.send();
    const second = payment.send();
    try {
      const deadline = Date.now() + 10000;
      for (;;) {
        const state = await emdashHttpApp.control();
        if (state.actionRuns === 1 && state.coordinating === 2) break;
        if (Date.now() > deadline) throw new Error("Concurrent owner/waiter not observed");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      emdashHttpRows(0);
      await emdashHttpAssertFlow(2, 1);
    } finally { await emdashHttpApp.control("release"); }
    const responses = await Promise.all([first.then(emdashHttpRead), second.then(emdashHttpRead)]);
    expect(responses[0].status).toBe(201);
    expect(responses[1]).toEqual(responses[0]);
    emdashHttpRows(1);
    console.log("HTTP concurrent: owner+waiter observed; action=1; posts=+1; revisions=unchanged");
  }, 30000);

  it("rejects a changed tenant through real RC2 settlement without a second CMS write", async () => {
    const payment = await emdashHttpPayment("request binding");
    expect((await payment.send()).status).toBe(201);
    const failed = await payment.send({ ...payment.headers, "x-tenant": "another-tenant" });
    expect(failed.status).toBe(500);
    const state = await emdashHttpApp.control();
    expect(state.actionRuns).toBe(1);
    expect(state.settlements).toHaveLength(2);
    expect(state.settlements[1]).toMatchObject({
      success: false, errorReason: "invalid_transaction_state",
    });
    const settles = emdashHttpCalls.filter((call) => call.path === "/settle");
    expect(settles).toHaveLength(2);
    expect(settles[0].body.requestHash).toBe(payment.hash);
    const changedRequest = new Request(payment.url, {
      method: "POST", body: payment.body,
      headers: { ...payment.headers, "x-tenant": "another-tenant" },
    });
    expect(settles[1].body.requestHash).toBe(await rc2ProofRequestHash(changedRequest));
    expect(settles[1].body.requestHash).not.toBe(payment.hash);
    expect(settles[1].body.paymentPayload).toEqual(settles[0].body.paymentPayload);
    expect(settles[1].body.paymentRequirements).toEqual(emdashHttpTerms);
    expect(emdashHttpCalls.filter((call) => call.path === "/verify")).toHaveLength(0);
    emdashHttpRows(1);
  }, 30000);

  it("rejects client-modified requirements before settlement and CMS work", async () => {
    const payment = await emdashHttpPayment("tampered terms");
    payment.payment.accepted.amount = "1";
    const response = await payment.send({
      ...payment.headers, "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payment.payment),
    });
    expect(response.status).toBe(500);
    expect((await emdashHttpApp.control()).actionRuns).toBe(0);
    expect(emdashHttpCalls.filter((call) => call.path === "/settle")).toHaveLength(0);
    emdashHttpRows(0);
  }, 30000);

  it("retains an uncertain failure after actual content commit and never automatically repeats it", async () => {
    await emdashHttpApp.control("reset", { mode: "uncertain" });
    const payment = await emdashHttpPayment("committed but lost");
    expect((await payment.send()).status).toBe(500);
    emdashHttpRows(1);
    expect((await payment.send()).status).toBe(500);
    emdashHttpRows(1);
    const state = await emdashHttpAssertFlow(2, 1);
    expect(state.events.filter((event: string) => event === "action:response:201")).toHaveLength(1);
  }, 30000);

  it("negative control: gate-only creates two real posts for the same settlement", async () => {
    await emdashHttpApp.control("reset", { mode: "gate-only" });
    const payment = await emdashHttpPayment("gate alone");
    const first = await emdashHttpRead(await payment.send());
    const second = await emdashHttpRead(await payment.send());
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(JSON.parse(second.body).data.item.id).not.toBe(JSON.parse(first.body).data.item.id);
    await emdashHttpAssertFlow(2, 2);
    emdashHttpRows(2);
    console.log("HTTP gate-only negative control: same settlement; action=2; posts=+2");
  }, 30000);

  it("negative control: replacing the local coordinator permits a second real write", async () => {
    const payment = await emdashHttpPayment("lost local state");
    expect((await payment.send()).status).toBe(201);
    await emdashHttpApp.control("replace-coordinator");
    expect((await payment.send()).status).toBe(201);
    await emdashHttpAssertFlow(2, 2);
    emdashHttpRows(2);
  }, 30000);
});
