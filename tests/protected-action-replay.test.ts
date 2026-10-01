import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type {
  EnforceResult,
  X402Backend,
  X402BackendContext,
} from "../src/index.js";
import {
  createExperimentalPaidActionExecutor,
  type ProtectedActionReplayCoordinator,
} from "../src/experimental/protected-action-replay.js";

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
  signature = "payment-signature-a",
): Request {
  return new Request(url, {
    headers: { "PAYMENT-SIGNATURE": signature },
  });
}

function backend(
  enforce: X402Backend["enforce"],
): X402Backend {
  return {
    enforce,
    hasPayment(candidate) {
      return candidate.headers.has("PAYMENT-SIGNATURE");
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

// TEST ONLY: a process-local model, not durable or safe across workers.
class StrictTestCoordinator<T> implements ProtectedActionReplayCoordinator<T> {
  readonly keys: string[] = [];
  readonly #states = new Map<
    string,
    | { state: "running"; promise: Promise<T> }
    | { state: "done"; value: T }
    | { state: "uncertain"; error: unknown }
  >();

  async runOnce(key: string, action: () => Promise<T>): Promise<T> {
    this.keys.push(key);
    const existing = this.#states.get(key);
    if (existing?.state === "done") return existing.value;
    if (existing?.state === "running") return existing.promise;
    if (existing?.state === "uncertain") throw existing.error;

    const promise = (async () => {
      try {
        const value = await action();
        this.#states.set(key, { state: "done", value });
        return value;
      } catch (error) {
        // Test model of the required fail-closed production contract: once an
        // action may have run, retries do not automatically execute it again.
        this.#states.set(key, { state: "uncertain", error });
        throw error;
      }
    })();
    this.#states.set(key, { state: "running", promise });
    return promise;
  }
}

describe("experimental protected-action replay boundary", () => {
  it("returns the stored protected result for an identical completed retry", async () => {
    const coordinator = new StrictTestCoordinator<{ body: string }>();
    const paymentBackend = backend(vi.fn(async () => paidResult()));
    const execute = createExperimentalPaidActionExecutor({
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
      backend: paymentBackend,
      replayCoordinator: coordinator,
    });
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => { release = resolve; });
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
    const paymentBackend = backend(vi.fn(async () => ({
      paid: false,
      skipped: true,
      responseHeaders: {},
    })));
    const execute = createExperimentalPaidActionExecutor({
      backend: paymentBackend,
      replayCoordinator: coordinator,
    });
    const action = vi.fn(async () => "public-result");

    await expect(execute(new Request("https://cms.example/public"), context, action)).resolves.toBe(
      "public-result",
    );
    expect(action).toHaveBeenCalledTimes(1);
    expect(coordinator.keys).toHaveLength(0);
  });

  it("does not run the protected action when enforcement returns 402", async () => {
    const coordinator = new StrictTestCoordinator<string>();
    const paymentBackend = backend(vi.fn(async () =>
      new Response("payment required", { status: 402 })));
    const execute = createExperimentalPaidActionExecutor({
      backend: paymentBackend,
      replayCoordinator: coordinator,
    });
    const action = vi.fn(async () => "protected");

    const result = await execute(new Request("https://cms.example/premium"), context, action);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(402);
    expect(action).not.toHaveBeenCalled();
    expect(coordinator.keys).toHaveLength(0);
  });

  it("does not run the protected action when settlement/enforcement fails", async () => {
    const coordinator = new StrictTestCoordinator<string>();
    const paymentBackend = backend(vi.fn(async () => {
      throw new Error("settlement_failed");
    }));
    const execute = createExperimentalPaidActionExecutor({
      backend: paymentBackend,
      replayCoordinator: coordinator,
    });
    const action = vi.fn(async () => "protected");

    await expect(execute(request(), context, action)).rejects.toThrow("settlement_failed");
    expect(action).not.toHaveBeenCalled();
    expect(coordinator.keys).toHaveLength(0);
  });

  it("does not alias different paid requests", async () => {
    const coordinator = new StrictTestCoordinator<string>();
    const paymentBackend = backend(vi.fn(async () => paidResult()));
    const execute = createExperimentalPaidActionExecutor({
      backend: paymentBackend,
      replayCoordinator: coordinator,
    });
    const action = vi.fn(async () => `result-${action.mock.calls.length}`);

    const first = await execute(request("https://cms.example/premium-a"), context, action);
    const second = await execute(request("https://cms.example/premium-b"), context, action);

    expect(first).toBe("result-1");
    expect(second).toBe("result-2");
    expect(action).toHaveBeenCalledTimes(2);
    expect(coordinator.keys[1]).not.toBe(coordinator.keys[0]);
  });

  it("fails closed after an uncertain protected-action failure", async () => {
    const coordinator = new StrictTestCoordinator<string>();
    const paymentBackend = backend(vi.fn(async () => paidResult()));
    const execute = createExperimentalPaidActionExecutor({
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
    const paymentBackend = backend(vi.fn(async () => ({
      paid: true,
      skipped: false,
      responseHeaders: {},
      settlement: { success: true, transaction: "" },
    })));
    const execute = createExperimentalPaidActionExecutor({
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

  it("hashes a domain-separated canonical identity with all four inputs", async () => {
    const coordinator = new StrictTestCoordinator<string>();
    const enforce = vi.fn(async () => paidResult());
    const execute = createExperimentalPaidActionExecutor({
      backend: backend(enforce), replayCoordinator: coordinator,
    });
    const action = vi.fn(async () => "protected");
    await execute(request(), context, action);
    await execute(new Request(request(), { method: "POST" }), context, action);
    await execute(request("https://cms.example/other"), context, action);
    await execute(request("https://cms.example/premium", "other-signature"), context, action);
    enforce.mockResolvedValue(paidResult("bb".repeat(32)));
    await execute(request(), context, action);
    expect(action).toHaveBeenCalledTimes(5);
    expect(new Set(coordinator.keys).size).toBe(5);
    expect(coordinator.keys[0]).toBe(createHash("sha256").update(JSON.stringify([
      "emdash-kaspa-x402:protected-action-replay:v1",
      "GET", "https://cms.example/premium", "payment-signature-a", "aa".repeat(32),
    ])).digest("hex"));
  });

  it.each(["method", "url", "signature", "settlement"])(
    "fails closed without %s", async (field) => {
      const coordinator = new StrictTestCoordinator<string>();
      const enforcement = paidResult();
      const candidate = request();
      if (field === "signature") candidate.headers.delete("PAYMENT-SIGNATURE");
      else if (field === "settlement") enforcement.settlement = undefined;
      else Object.defineProperty(candidate, field, { value: "" });
      const execute = createExperimentalPaidActionExecutor({
        backend: backend(async () => enforcement), replayCoordinator: coordinator,
      });
      const action = vi.fn(async () => "protected");
      await expect(execute(candidate, context, action)).rejects.toThrow("Paid action replay requires");
      expect(action).not.toHaveBeenCalled();
      expect(coordinator.keys).toHaveLength(0);
    },
  );

  it("waits for enforcement before deriving the key and executing the action", async () => {
    const pending = deferred<EnforceResult>();
    const coordinator = new StrictTestCoordinator<string>();
    const replayKeyProvider = vi.fn(async () => "shared-key");
    const execute = createExperimentalPaidActionExecutor({
      backend: backend(() => pending.promise), replayCoordinator: coordinator, replayKeyProvider,
    });
    const action = vi.fn(async () => "protected");
    const result = execute(request(), context, action);
    expect(replayKeyProvider).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    pending.resolve(paidResult());
    await expect(result).resolves.toBe("protected");
    expect(action).toHaveBeenCalledTimes(1);
  });

  it.each([200, 500])("passes through any enforcement Response (%s)", async (status) => {
    const response = new Response("gate", { status });
    const coordinator = new StrictTestCoordinator<string>();
    const execute = createExperimentalPaidActionExecutor({
      backend: backend(async () => response), replayCoordinator: coordinator,
    });
    const action = vi.fn(async () => "protected");
    expect(await execute(request(), context, action)).toBe(response);
    expect(action).not.toHaveBeenCalled();
    expect(coordinator.keys).toHaveLength(0);
  });

  it.each([false, true])("runs unpaid successes directly (skipped=%s)", async (skipped) => {
    const coordinator = new StrictTestCoordinator<string>();
    const execute = createExperimentalPaidActionExecutor({
      backend: backend(async () => ({ paid: false, skipped, responseHeaders: {} })),
      replayCoordinator: coordinator,
    });
    const action = vi.fn(async () => "free");
    await execute(new Request("https://cms.example/free"), context, action);
    await execute(new Request("https://cms.example/free"), context, action);
    expect(action).toHaveBeenCalledTimes(2);
    expect(coordinator.keys).toHaveLength(0);
  });

  it("fails closed when the custom key provider fails or returns an empty key", async () => {
    const coordinator = new StrictTestCoordinator<string>();
    const replayKeyProvider = vi.fn(async () => " ");
    const execute = createExperimentalPaidActionExecutor({
      backend: backend(async () => paidResult()), replayCoordinator: coordinator, replayKeyProvider,
    });
    const action = vi.fn(async () => "protected");
    await expect(execute(request(), context, action)).rejects.toThrow("non-empty replay key");
    replayKeyProvider.mockRejectedValue(new Error("key unavailable"));
    await expect(execute(request(), context, action)).rejects.toThrow("key unavailable");
    expect(action).not.toHaveBeenCalled();
    expect(coordinator.keys).toHaveLength(0);
  });
});
