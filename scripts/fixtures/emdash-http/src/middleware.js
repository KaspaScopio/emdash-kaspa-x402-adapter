import { readFileSync } from "node:fs";
import { defineMiddleware } from "astro:middleware";
import {
  createExperimentalKaspaFacilitatorBackend,
  createFacilitatorHttpTransport,
} from "__ADAPTER_ROOT__/src/experimental/facilitator-backend.ts";
import { createExperimentalPaidActionExecutor } from "__ADAPTER_ROOT__/src/experimental/protected-action-replay.ts";
import { StrictTestCoordinator } from "__ADAPTER_ROOT__/tests/helpers/replay-coordinator.ts";
import { sha256Hex, stableStringify } from "@kaspa-x402/core";

const terms = JSON.parse(readFileSync(process.env.RC2_PROOF_TERMS, "utf8"));
const context = {
  price: { amount: terms.amount, asset: "KAS" }, payTo: terms.payTo,
  network: terms.network, scheme: terms.scheme,
  maxTimeoutSeconds: terms.maxTimeoutSeconds,
};
const baseTransport = createFacilitatorHttpTransport(process.env.RC2_PROOF_FACILITATOR);
const state = {
  actionRuns: 0, coordinating: 0, settlements: [], events: [],
  mode: "coordinated", hold: false, release: undefined,
};
const transport = {
  supported: () => baseTransport.supported(),
  async settle(input) {
    state.events.push("settle:start");
    const result = await baseTransport.settle(input);
    state.settlements.push(structuredClone(result));
    state.events.push(result.success ? "settle:success" : "settle:failure");
    return result;
  },
};
const backend = createExperimentalKaspaFacilitatorBackend({
  transport, allowedMethods: ["POST"],
  paymentRequirementsProvider: () => structuredClone(terms),
  requestHashProvider: async ({ request }) => sha256Hex(stableStringify({
    method: request.method, url: request.url,
    body: await request.clone().text(), tenant: request.headers.get("x-tenant"),
  })),
});
function boundary() {
  const coordinator = new StrictTestCoordinator();
  return createExperimentalPaidActionExecutor({
    backend, operationId: "emdash-http-proof:content-create:posts",
    replayCoordinator: {
      runOnce(key, action) {
        state.coordinating += 1;
        return coordinator.runOnce(key, action);
      },
    },
  });
}
let execute = boundary();

export const onRequest = defineMiddleware(async (astro, next) => {
  if (astro.url.pathname === "/_proof/control") {
    if (astro.request.headers.get("x-proof-secret") !== process.env.RC2_PROOF_SECRET)
      return new Response(null, { status: 403 });
    const command = astro.url.searchParams.get("command");
    if (command === "reset") {
      if (state.release) throw new Error("Cannot reset a pending action");
      state.actionRuns = 0; state.coordinating = 0;
      state.settlements = []; state.events = [];
      state.mode = astro.url.searchParams.get("mode") ?? "coordinated";
      state.hold = astro.url.searchParams.get("hold") === "1";
      execute = boundary();
    }
    if (command === "release") { state.hold = false; state.release?.(); }
    if (command === "replace-coordinator") execute = boundary();
    return Response.json({
      actionRuns: state.actionRuns, coordinating: state.coordinating,
      settlements: state.settlements, events: state.events,
    });
  }
  if (astro.request.method !== "POST" ||
      astro.url.pathname !== "/_emdash/api/content/posts") return next();

  async function action(enforcement) {
    if (!enforcement.paid || !enforcement.settlement?.success)
      throw new Error("Protected CMS work requires successful settlement");
    state.actionRuns += 1;
    state.events.push("action:start");
    if (state.hold) {
      await new Promise((resolve) => { state.release = resolve; });
      state.release = undefined;
    }
    const response = await next();
    const stored = {
      status: response.status,
      headers: [...response.headers, ...Object.entries(enforcement.responseHeaders)],
      body: new Uint8Array(await response.arrayBuffer()),
    };
    state.events.push("action:response:" + response.status);
    if (state.mode === "uncertain")
      throw new Error("Injected loss after real CMS write");
    return stored;
  }
  try {
    let result;
    if (state.mode === "gate-only") {
      const enforcement = await backend.enforce(astro.request, context);
      result = enforcement instanceof Response ? enforcement : await action(enforcement);
    } else {
      result = await execute(astro.request, context, action);
    }
    if (result instanceof Response) return result;
    return new Response(result.body.slice(), {
      status: result.status, headers: result.headers,
    });
  } catch {
    return Response.json({ error: "payment_or_action_failed" }, { status: 500 });
  }
});
