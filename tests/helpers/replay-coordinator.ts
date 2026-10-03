import type { ProtectedActionReplayCoordinator } from "../../src/experimental/protected-action-replay.js";

// TEST ONLY: a process-local model, not durable or safe across workers.
export class StrictTestCoordinator<T>
  implements ProtectedActionReplayCoordinator<T>
{
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

    const promise = Promise.resolve()
      .then(action)
      .then(
        (value) => {
          this.#states.set(key, { state: "done", value });
          return value;
        },
        (error: unknown) => {
          this.#states.set(key, { state: "uncertain", error });
          throw error;
        },
      );
    this.#states.set(key, { state: "running", promise });
    return promise;
  }
}
