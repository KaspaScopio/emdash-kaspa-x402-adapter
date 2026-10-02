import { AsyncLocalStorage } from "node:async_hooks";
const identity = Symbol.for("rc2.atomic-http.observer");
export const state = globalThis[identity] ??= {
  scope: new AsyncLocalStorage(), pauses: new Set(), events: [], mode: "atomic",
  waiters: [], pipelineRuns: 0, contentWrites: 0,
};
export async function checkpoint(name, details = {}) {
  const event = { type: "atomic-stage", name, pid: process.pid, ...details };
  state.events.push(event);
  const continuation = state.pauses.has(name)
    ? new Promise((resolve) => state.waiters.push(resolve)) : undefined;
  if (process.send) await new Promise((resolve, reject) =>
    process.send(event, (error) => error ? reject(error) : resolve()));
  await continuation;
}
process.on("message", (message) => {
  if (message?.type === "atomic-continue") {
    state.pauses.clear();
    for (const resolve of state.waiters.splice(0)) resolve();
  }
});
