import { StrictTestCoordinator } from "./helpers/replay-coordinator.js";
import { paymentHeader } from "./helpers/payment-fixture.js";
import { describe, expect, it, vi } from "vitest";

import type {
  EnforceResult,
  X402Backend,
  X402BackendContext,
} from "../src/index.js";
import { createExperimentalPaidActionExecutor } from "../src/experimental/protected-action-replay.js";

const context: X402BackendContext = {
  price: "0.2",
  payTo: "kaspatest:payee",
  network: "kaspa:testnet-10",
  scheme: "exact",
  maxTimeoutSeconds: 60,
};

function paidResult(transaction = "aa".repeat(32)): EnforceResult {
  return {
    paid: true,
    skipped: false,
    settlement: {
      success: true,
      transaction,
      network: "kaspa:testnet-10",
      amount: "20000000",
    },
    responseHeaders: { "PAYMENT-RESPONSE": "settled" },
  };
}

function request(
  url = "https://cms.example/premium",
  signature = paymentHeader(),
): Request {
  return new Request(url, {
    headers: { "PAYMENT-SIGNATURE": signature },
  });
}

function backend(enforce: X402Backend["enforce"]): X402Backend {
  return {
    enforce,
    hasPayment(candidate) {
      return candidate.headers.has("PAYMENT-SIGNATURE");
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("experimental protected-action replay boundary", () => {
  it("returns the stored protected result for an identical completed retry", async () => {
    const coordinator = new StrictTestCoordinator<{ body: string }>();
    const paymentBackend = backend(vi.fn(async () => paidResult()));
    const execute = createExperimentalPaidActionExecutor({
      operationId: "test:premium",
      backend: paymentBackend,
      replayCoordinator: coordinator,
    });
    const action = vi.fn(async () => ({ body: "premium" }));
    const paidRequest = request();

    const first = await execute(paidRequest, context, action);
    const second = await execute(paidRequest, context, action);

    expect(first).toEqual({ body: "premium" });
    expect(second).toEqual(first);
    expect(action).toHaveBeenCalledTimes(1);
    expect(paymentBackend.enforce).toHaveBeenCalledTimes(2);
    expect(coordinator.keys).toHaveLength(2);
    expect(coordinator.keys[1]).toBe(coordinator.keys[0]);
    expect(coordinator.keys[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("coalesces concurrent identical paid retries around one action", async () => {
    const coordinator = new StrictTestCoordinator<string>();
    const paymentBackend = backend(vi.fn(async () => paidResult()));
    const execute = createExperimentalPaidActionExecutor({
      operationId: "test:premium",
      backend: paymentBackend,
      replayCoordinator: coordinator,
    });
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const started = deferred<void>();
    const bothCoordinating = deferred<void>();
    const runOnce = coordinator.runOnce.bind(coordinator);
    coordinator.runOnce = (key, callback) => {
      const result = runOnce(key, callback);
      if (coordinator.keys.length === 2) bothCoordinating.resolve();
      return result;
    };
    const action = vi.fn(async () => {
      started.resolve();
      return pending;
    });
    const paidRequest = request();

    const first = execute(paidRequest, context, action);
    const second = execute(paidRequest, context, action);
    await Promise.all([started.promise, bothCoordinating.promise]);
    expect(action).toHaveBeenCalledTimes(1);

    release("same-result");
    await expect(Promise.all([first, second])).resolves.toEqual([
      "same-result",
      "same-result",
    ]);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("runs skipped/unpaid successful work directly without replay coordination", async () => {
    const coordinator = new StrictTestCoordinator<string>();
    const paymentBackend = backend(
      vi.fn(async () => ({
        paid: false,
        skipped: true,
        responseHeaders: {},
      })),
    );
    const execute = createExperimentalPaidActionExecutor({
      operationId: "test:premium",
      backend: paymentBackend,
      replayCoordinator: coordinator,
    });
    const action = vi.fn(async () => "public-result");

    await expect(
      execute(new Request("https://cms.example/public"), context, action),
    ).resolves.toBe("public-result");
    expect(action).toHaveBeenCalledTimes(1);
    expect(coordinator.keys).toHaveLength(0);
  });

  it("does not run the protected action when enforcement returns 402", async () => {
    const coordinator = new StrictTestCoordinator<string>();
    const paymentBackend = backend(
      vi.fn(async () => new Response("payment required", { status: 402 })),
    );
    const execute = createExperimentalPaidActionExecutor({
      operationId: "test:premium",
      backend: paymentBackend,
      replayCoordinator: coordinator,
    });
    const action = vi.fn(async () => "protected");

    const result = await execute(
      new Request("https://cms.example/premium"),
      context,
      action,
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(402);
    expect(action).not.toHaveBeenCalled();
    expect(coordinator.keys).toHaveLength(0);
  });

  it("does not run the protected action when settlement/enforcement fails", async () => {
    const coordinator = new StrictTestCoordinator<string>();
    const paymentBackend = backend(
      vi.fn(async () => {
        throw new Error("settlement_failed");
      }),
    );
    const execute = createExperimentalPaidActionExecutor({
      operationId: "test:premium",
      backend: paymentBackend,
      replayCoordinator: coordinator,
    });
    const action = vi.fn(async () => "protected");

    await expect(execute(request(), context, action)).rejects.toThrow(
      "settlement_failed",
    );
    expect(action).not.toHaveBeenCalled();
    expect(coordinator.keys).toHaveLength(0);
  });

  it("does not alias different paid requests", async () => {
    const coordinator = new StrictTestCoordinator<string>();
    const paymentBackend = backend(vi.fn(async () => paidResult()));
    const execute = createExperimentalPaidActionExecutor({
      operationId: "test:premium",
      backend: paymentBackend,
      replayCoordinator: coordinator,
    });
    const action = vi.fn(async () => `result-${action.mock.calls.length}`);

    const first = await execute(
      request("https://cms.example/premium-a"),
      context,
      action,
    );
    const second = await execute(
      request("https://cms.example/premium-b"),
      context,
      action,
    );

    expect(first).toBe("result-1");
    expect(second).toBe("result-2");
    expect(action).toHaveBeenCalledTimes(2);
    expect(coordinator.keys[1]).not.toBe(coordinator.keys[0]);
  });

  it("fails closed after an uncertain protected-action failure", async () => {
    const coordinator = new StrictTestCoordinator<string>();
    const paymentBackend = backend(vi.fn(async () => paidResult()));
    const execute = createExperimentalPaidActionExecutor({
      operationId: "test:premium",
      backend: paymentBackend,
      replayCoordinator: coordinator,
    });
    const action = vi.fn(async () => {
      throw new Error("action outcome uncertain");
    });
    const paidRequest = request();

    await expect(execute(paidRequest, context, action)).rejects.toThrow(
      "action outcome uncertain",
    );
    await expect(execute(paidRequest, context, action)).rejects.toThrow(
      "action outcome uncertain",
    );
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the default paid replay identity is incomplete", async () => {
    const coordinator = new StrictTestCoordinator<string>();
    const paymentBackend = backend(
      vi.fn(async () => ({
        paid: true,
        skipped: false,
        responseHeaders: {},
        settlement: { success: true, transaction: "" },
      })),
    );
    const execute = createExperimentalPaidActionExecutor({
      operationId: "test:premium",
      backend: paymentBackend,
      replayCoordinator: coordinator,
    });
    const action = vi.fn(async () => "protected");

    await expect(execute(request(), context, action)).rejects.toThrow(
      "requires method, URL, PAYMENT-SIGNATURE and settlement transaction",
    );
    expect(action).not.toHaveBeenCalled();
  });

  it("allows deployments to inject a shared replay key policy", async () => {
    const coordinator = new StrictTestCoordinator<string>();
    const paymentBackend = backend(vi.fn(async () => paidResult()));
    const replayKeyProvider = vi.fn(async () => "deployment-key");
    const execute = createExperimentalPaidActionExecutor({
      operationId: "test:premium",
      backend: paymentBackend,
      replayCoordinator: coordinator,
      replayKeyProvider,
    });
    const action = vi.fn(async () => "protected");

    await execute(request(), context, action);
    await execute(request(), context, action);
    expect(replayKeyProvider).toHaveBeenCalledTimes(2);
    expect(coordinator.keys).toEqual(["deployment-key", "deployment-key"]);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("separates method, URL, payment and settlement transaction identities", async () => {
    const coordinator = new StrictTestCoordinator<string>();
    const enforce = vi.fn(async () => paidResult());
    const execute = createExperimentalPaidActionExecutor({
      operationId: "test:premium",
      backend: backend(enforce),
      replayCoordinator: coordinator,
    });
    const action = vi.fn(async () => "protected");
    await execute(request(), context, action);
    await execute(new Request(request(), { method: "POST" }), context, action);
    await execute(request("https://cms.example/other"), context, action);
    await execute(
      request(
        "https://cms.example/premium",
        paymentHeader({ maxTimeoutSeconds: 61 }),
      ),
      context,
      action,
    );
    enforce.mockResolvedValue(paidResult("bb".repeat(32)));
    await execute(request(), context, action);
    expect(action).toHaveBeenCalledTimes(5);
    expect(new Set(coordinator.keys).size).toBe(5);
  });

  it.each(["signature", "settlement"])(
    "fails closed without %s",
    async (field) => {
      const coordinator = new StrictTestCoordinator<string>();
      const enforcement = paidResult();
      const candidate = request();
      if (field === "signature") candidate.headers.delete("PAYMENT-SIGNATURE");
      else if (field === "settlement") enforcement.settlement = undefined;
      const execute = createExperimentalPaidActionExecutor({
        operationId: "test:premium",
        backend: backend(async () => enforcement),
        replayCoordinator: coordinator,
      });
      const action = vi.fn(async () => "protected");
      await expect(execute(candidate, context, action)).rejects.toThrow(
        "Paid action replay requires",
      );
      expect(action).not.toHaveBeenCalled();
      expect(coordinator.keys).toHaveLength(0);
    },
  );

  it("waits for enforcement before deriving the key and executing the action", async () => {
    const pending = deferred<EnforceResult>();
    const coordinator = new StrictTestCoordinator<string>();
    const replayKeyProvider = vi.fn(async () => "shared-key");
    const execute = createExperimentalPaidActionExecutor({
      operationId: "test:premium",
      backend: backend(() => pending.promise),
      replayCoordinator: coordinator,
      replayKeyProvider,
    });
    const action = vi.fn(async () => "protected");
    const result = execute(request(), context, action);
    expect(replayKeyProvider).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    pending.resolve(paidResult());
    await expect(result).resolves.toBe("protected");
    expect(action).toHaveBeenCalledTimes(1);
  });

  it.each([200, 500])(
    "passes through any enforcement Response (%s)",
    async (status) => {
      const response = new Response("gate", { status });
      const coordinator = new StrictTestCoordinator<string>();
      const execute = createExperimentalPaidActionExecutor({
        operationId: "test:premium",
        backend: backend(async () => response),
        replayCoordinator: coordinator,
      });
      const action = vi.fn(async () => "protected");
      expect(await execute(request(), context, action)).toBe(response);
      expect(action).not.toHaveBeenCalled();
      expect(coordinator.keys).toHaveLength(0);
    },
  );

  it.each([false, true])(
    "runs unpaid successes directly (skipped=%s)",
    async (skipped) => {
      const coordinator = new StrictTestCoordinator<string>();
      const execute = createExperimentalPaidActionExecutor({
        operationId: "test:premium",
        backend: backend(async () => ({
          paid: false,
          skipped,
          responseHeaders: {},
        })),
        replayCoordinator: coordinator,
      });
      const action = vi.fn(async () => "free");
      await execute(new Request("https://cms.example/free"), context, action);
      await execute(new Request("https://cms.example/free"), context, action);
      expect(action).toHaveBeenCalledTimes(2);
      expect(coordinator.keys).toHaveLength(0);
    },
  );

  it("fails closed when the custom key provider fails or returns an empty key", async () => {
    const coordinator = new StrictTestCoordinator<string>();
    const replayKeyProvider = vi.fn(async () => " ");
    const execute = createExperimentalPaidActionExecutor({
      operationId: "test:premium",
      backend: backend(async () => paidResult()),
      replayCoordinator: coordinator,
      replayKeyProvider,
    });
    const action = vi.fn(async () => "protected");
    await expect(execute(request(), context, action)).rejects.toThrow(
      "non-empty replay key",
    );
    replayKeyProvider.mockRejectedValue(new Error("key unavailable"));
    await expect(execute(request(), context, action)).rejects.toThrow(
      "key unavailable",
    );
    expect(action).not.toHaveBeenCalled();
    expect(coordinator.keys).toHaveLength(0);
  });
});

describe("paid replay identity regressions", () => {
  function executor(
    coordinator = new StrictTestCoordinator<string>(),
    operationId = "cms:premium",
  ) {
    return createExperimentalPaidActionExecutor({
      backend: backend(async () => paidResult()),
      replayCoordinator: coordinator,
      operationId,
    });
  }

  it("requires an explicit operation namespace for the default policy", () => {
    expect(() =>
      createExperimentalPaidActionExecutor({
        backend: backend(async () => paidResult()),
        replayCoordinator: new StrictTestCoordinator(),
      }),
    ).toThrow("stable operationId");
  });

  it("coalesces differently encoded instances of the same validated payment", async () => {
    const signature = paymentHeader();
    const decoded = JSON.parse(
      Buffer.from(signature, "base64").toString("utf8"),
    );
    const variant = Buffer.from(JSON.stringify(decoded, null, 1)).toString(
      "base64",
    );
    expect(variant).not.toBe(signature);
    const execute = executor();
    const action = vi.fn(async () => "paid-result");
    expect(await execute(request(undefined, signature), context, action)).toBe(
      "paid-result",
    );
    expect(await execute(request(undefined, variant), context, action)).toBe(
      "paid-result",
    );
    expect(action).toHaveBeenCalledTimes(1);
  });

  it.each(["body", "tenant", "operation", "context"])(
    "separates paid operations with different %s",
    async (field) => {
      const coordinator = new StrictTestCoordinator<string>();
      const first = executor(coordinator);
      const second = executor(
        coordinator,
        field === "operation" ? "cms:other" : "cms:premium",
      );
      const candidate = (body: string, tenant: string) =>
        new Request("https://cms.example/action", {
          method: "POST",
          headers: { "PAYMENT-SIGNATURE": paymentHeader(), "x-tenant": tenant },
          body,
        });
      const a = candidate("a", "one");
      const b = candidate(
        field === "body" ? "b" : "a",
        field === "tenant" ? "two" : "one",
      );
      expect(await first(a, context, async () => "a-result")).toBe("a-result");
      const nextContext =
        field === "context"
          ? { ...context, description: "other-policy" }
          : context;
      expect(await second(b, nextContext, async () => "b-result")).toBe(
        "b-result",
      );
      expect(coordinator.keys[0]).not.toBe(coordinator.keys[1]);
    },
  );

  it("keeps caller and backend mutations out of the replay identity", async () => {
    const pending = deferred<EnforceResult>();
    const entered = deferred<void>();
    const coordinator = new StrictTestCoordinator<string>();
    let calls = 0;
    const execute = createExperimentalPaidActionExecutor({
      operationId: "cms:premium",
      replayCoordinator: coordinator,
      backend: backend(async (candidate, terms) => {
        if (++calls > 1) return paidResult();
        candidate.headers.set("PAYMENT-SIGNATURE", "backend-mutation");
        terms.description = "backend-mutation";
        entered.resolve();
        return pending.promise;
      }),
    });
    const candidate = request();
    const terms = { ...context };
    const action = vi.fn(async () => "result");
    const first = execute(candidate, terms, action);
    await entered.promise;
    candidate.headers.set("PAYMENT-SIGNATURE", "caller-mutation");
    terms.description = "caller-mutation";
    pending.resolve(paidResult());
    expect(await first).toBe("result");
    expect(await execute(request(), context, action)).toBe("result");
    expect(action).toHaveBeenCalledTimes(1);
    expect(coordinator.keys[0]).toBe(coordinator.keys[1]);
  });

  it("gives custom key policies an independent snapshot", async () => {
    const candidate = request();
    const terms = { ...context };
    const signature = candidate.headers.get("PAYMENT-SIGNATURE");
    const replayKeyProvider = vi.fn(async (input) => {
      expect(input.request.headers.get("PAYMENT-SIGNATURE")).toBe(signature);
      expect(input.context.description).toBeUndefined();
      return "custom";
    });
    const execute = createExperimentalPaidActionExecutor({
      replayCoordinator: new StrictTestCoordinator<string>(),
      replayKeyProvider,
      backend: backend(async (received, receivedContext) => {
        received.headers.set("PAYMENT-SIGNATURE", "backend-mutation");
        receivedContext.description = "backend-mutation";
        candidate.headers.set("PAYMENT-SIGNATURE", "caller-mutation");
        terms.description = "caller-mutation";
        return paidResult();
      }),
    });
    expect(await execute(candidate, terms, async () => "result")).toBe(
      "result",
    );
  });

  it("normalizes hexadecimal transaction casing", async () => {
    const coordinator = new StrictTestCoordinator<string>();
    const enforce = vi.fn(async () => paidResult());
    const execute = createExperimentalPaidActionExecutor({
      operationId: "cms:premium",
      backend: backend(enforce),
      replayCoordinator: coordinator,
    });
    const action = vi.fn(async () => "result");
    await execute(request(), context, action);
    enforce.mockResolvedValue(paidResult("AA".repeat(32)));
    await execute(request(), context, action);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it.each(["invalid signature", "wrong network", "invalid transaction"])(
    "does not execute with %s",
    async (field) => {
      const result = paidResult();
      if (field === "wrong network")
        result.settlement = {
          transaction: "aa".repeat(32),
          network: "kaspa:mainnet",
        };
      if (field === "invalid transaction")
        result.settlement = {
          transaction: "not-a-tx",
          network: context.network,
        };
      const execute = createExperimentalPaidActionExecutor({
        operationId: "cms:premium",
        backend: backend(async () => result),
        replayCoordinator: new StrictTestCoordinator<string>(),
      });
      const action = vi.fn(async () => "result");
      await expect(
        execute(
          request(
            undefined,
            field === "invalid signature" ? "invalid" : paymentHeader(),
          ),
          context,
          action,
        ),
      ).rejects.toThrow();
      expect(action).not.toHaveBeenCalled();
    },
  );

  it("reserves test-only ownership before invoking reentrant user code", async () => {
    const coordinator = new StrictTestCoordinator<string>();
    const nestedAction = vi.fn(async () => "nested");
    let nested!: Promise<string>;
    const outer = coordinator.runOnce("same", async () => {
      nested = coordinator.runOnce("same", nestedAction);
      return "outer";
    });
    expect(await outer).toBe("outer");
    expect(await nested).toBe("outer");
    expect(nestedAction).not.toHaveBeenCalled();
  });

  it("retains synchronous uncertain failures in the test-only model", async () => {
    const coordinator = new StrictTestCoordinator<string>();
    const action = vi.fn(() => {
      throw new Error("uncertain side effect");
    });
    await expect(coordinator.runOnce("same", action)).rejects.toThrow(
      "uncertain",
    );
    await expect(coordinator.runOnce("same", action)).rejects.toThrow(
      "uncertain",
    );
    expect(action).toHaveBeenCalledTimes(1);
  });
});

it("passes the protected callback captured input independent of caller and providers", async () => {
  const candidate = new Request("https://cms.example/action", {
    method: "POST",
    headers: { "PAYMENT-SIGNATURE": paymentHeader(), "x-tenant": "original" },
    body: "original-body",
  });
  const terms = { ...context };
  const execute = createExperimentalPaidActionExecutor({
    operationId: "cms:action",
    replayCoordinator: new StrictTestCoordinator<string>(),
    backend: backend(async (received, receivedContext) => {
      expect(await received.text()).toBe("original-body");
      received.headers.set("x-tenant", "backend-change");
      receivedContext.description = "backend-change";
      candidate.headers.set("x-tenant", "caller-change");
      terms.description = "caller-change";
      return paidResult();
    }),
    replayKeyProvider: async ({ request, context }) => {
      expect(await request.text()).toBe("original-body");
      request.headers.set("x-tenant", "key-change");
      context.description = "key-change";
      return "stable";
    },
  });
  expect(
    await execute(candidate, terms, async (_result, input) => {
      expect(input.request.headers.get("x-tenant")).toBe("original");
      expect(input.context.description).toBeUndefined();
      return input.request.text();
    }),
  ).toBe("original-body");
});
