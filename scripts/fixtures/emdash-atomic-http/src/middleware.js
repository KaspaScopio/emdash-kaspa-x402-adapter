import { readFileSync } from "node:fs";
import { defineMiddleware } from "astro:middleware";
import { EmDashRuntime } from "emdash/internal/plugin-test-runtime";
import { sha256Hex, stableStringify, decodePaymentSignatureHeader } from "@kaspa-x402/core";
import { createExperimentalKaspaFacilitatorBackend,
  createFacilitatorHttpTransport } from "__ADAPTER_ROOT__/src/experimental/facilitator-backend.ts";
import { atomicHttpRequestHash } from "../binding.mjs";
import { state, checkpoint } from "../state.mjs";
const terms = JSON.parse(readFileSync(process.env.RC2_PROOF_TERMS, "utf8"));
const context = {
  price: { amount: terms.amount, asset: "KAS" }, payTo: terms.payTo,
  network: terms.network, scheme: terms.scheme,
  maxTimeoutSeconds: terms.maxTimeoutSeconds,
};
const transport = createFacilitatorHttpTransport(process.env.RC2_PROOF_FACILITATOR);
const backend = createExperimentalKaspaFacilitatorBackend({
  transport, allowedMethods: ["POST"],
  paymentRequirementsProvider: () => structuredClone(terms),
  requestHashProvider: ({ request }) => atomicHttpRequestHash(request),
});
const marker = Symbol.for("rc2.atomic-http.pipeline-observed");
if (!EmDashRuntime.prototype[marker]) {
  const create = EmDashRuntime.prototype.createContent;
  if (typeof create !== "function") throw new Error("Missing real content pipeline");
  EmDashRuntime.prototype.createContent = async function (...args) {
    if (state.scope.getStore()) {
      state.pipelineRuns += 1;
      await checkpoint("action-started");
    }
    return Reflect.apply(create, this, args);
  };
  EmDashRuntime.prototype[marker] = true;
}
export const onRequest = defineMiddleware(async (astro, next) => {
  if (astro.url.pathname === "/_proof/control") {
    if (astro.request.headers.get("x-proof-secret") !== process.env.RC2_PROOF_SECRET)
      return new Response(null, { status: 403 });
    if (astro.url.searchParams.get("command") === "reset") {
      if (state.waiters.length) throw new Error("Cannot reset a held operation");
      state.events = []; state.pipelineRuns = 0; state.contentWrites = 0;
      state.mode = astro.url.searchParams.get("mode") ?? "atomic";
      state.pauses = new Set((astro.url.searchParams.get("pauses") ?? "").split(",").filter(Boolean));
    }
    return Response.json({
      pipelineRuns: state.pipelineRuns, contentWrites: state.contentWrites,
      events: state.events, mode: state.mode,
    });
  }
  if (astro.request.method !== "POST" ||
      astro.url.pathname !== "/_emdash/api/content/posts") return next();
  if (astro.request.headers.get("x-tenant") !== "proof-tenant")
    return Response.json({ error: "wrong_tenant" }, { status: 403 });
  try {
    const enforcement = await backend.enforce(astro.request, context);
    if (enforcement instanceof Response) return enforcement;
    if (!enforcement.paid || !enforcement.settlement?.success)
      throw new Error("Successful upfront settlement required");
    return await state.scope.run({ paid: true }, async () => {
      await checkpoint("settled", { settlement: enforcement.settlement });
      const original = astro.locals.emdash;
      const requestHash = await atomicHttpRequestHash(astro.request);
      const payment = decodePaymentSignatureHeader(astro.request.headers.get("PAYMENT-SIGNATURE"));
      // One settled output for this authorized request; header encoding/extra extensions cannot split it.
      const key = sha256Hex(stableStringify({
        requestHash, transaction: enforcement.settlement.transaction.toLowerCase(),
        network: enforcement.settlement.network, outputIndex: payment.payload.paymentOutputIndex,
      }));
      const binding = sha256Hex(stableStringify({
        requestHash, requirements: terms, settlement: enforcement.settlement,
        policy: state.mode === "changed-binding" ? "changed" : "normal",
      }));
      astro.locals.emdash = {
        ...original,
        handleContentCreate: async (collection, routeBody) => {
          if (state.mode === "gate-only")
            return original.handleContentCreate(collection, routeBody);
          const body = { ...routeBody };
          if (state.mode !== "unprojected") {
            // Remove only absence markers introduced by the authenticated EmDash route.
            // Nested client data remains strict JSON; binding retains the original HTTP bytes.
            for (const name of ["authorId", "locale", "translationOf", "actor"])
              if (body[name] === undefined) delete body[name];
          }
          return original.handleContentCreateOnce(collection, body, {
            namespace: "cms:posts:create", tenant: "proof-tenant",
            actorId: astro.locals.user.id, key, binding,
          });
        },
      };
      const response = await next();
      await checkpoint("response-ready", { status: response.status });
      for (const [name, value] of Object.entries(enforcement.responseHeaders))
        response.headers.set(name, value);
      return response;
    });
  } catch (error) {
    console.error(error);
    return Response.json({ error: "payment_or_action_failed" }, { status: 500 });
  }
});
