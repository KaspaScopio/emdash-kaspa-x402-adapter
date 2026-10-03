import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { listenLoopback, startEmDashHttpProof } from "./fixtures/emdash-http-server.mjs";

const expected = "913cb1bb9b7f08c3ff0d258b4420e53835b6a58e";
const source = process.env.EMDASH_HTTP_PROOF_SOURCE;
if (!source) throw new Error("Set EMDASH_HTTP_PROOF_SOURCE to the clean, built checkout used by proof:emdash-http-rc2");
const actual = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
assert.equal(actual, expected, "EmDash source must match the HTTP proof pin");
assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: source, encoding: "utf8" }).trim(), "");
const scratch = mkdtempSync(join(tmpdir(), "emdash-durable-content-"));
const seed = join(scratch, "seed.db");
const worker = join(dirname(fileURLToPath(import.meta.url)), "fixtures/durable-content-worker.mjs");
const children = new Set();
let sequence = 0;
function query(path, sql) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}
function rows(path, posts, executions) {
  assert.equal(Number(query(path, "SELECT count(*) AS n FROM ec_posts")[0].n), posts);
  assert.equal(Number(query(path, "SELECT count(*) AS n FROM proof_executions")[0].n), executions);
}
function freshDatabase() {
  const path = join(scratch, "case-" + (++sequence) + ".db");
  const db = new DatabaseSync(seed);
  try { db.prepare("VACUUM INTO ?").run(path); } finally { db.close(); }
  return path;
}
function start(path, { identity = "tenant/actor/posts/create/operation-1",
  fingerprint = "title-one", mode = "atomic", pauseAt = "" } = {}) {
  const child = spawn(process.execPath, [worker, path, identity, fingerprint, mode, pauseAt], {
    env: { ...process.env, EMDASH_HTTP_PROOF_SOURCE: resolve(source) },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.add(child);
  const stages = [];
  const waiting = new Map();
  let result, error, output = "";
  const deadline = setTimeout(() => {
    error = "Worker exceeded its 30 second deadline";
    child.kill("SIGKILL");
  }, 30000);
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => { output = (output + data).slice(-6000); });
  child.on("message", (message) => {
    if (message.type === "result") result = message.result;
    else if (message.type === "failure") error = message.error;
    else if (message.type === "stage") {
      stages.push(message);
      waiting.get(message.name)?.resolve(message);
    }
  });
  const done = new Promise((resolve) => {
    child.once("error", (cause) => { error = cause.message; });
    child.once("exit", (code, signal) => {
      clearTimeout(deadline);
      children.delete(child);
      for (const pending of waiting.values()) {
        pending.reject(new Error("Worker exited before checkpoint: " + (error ?? output)));
      }
      resolve({ code, signal, result, error, stages, output });
    });
  });
  return { child, done, stages,
    resume: () => child.send({ type: "continue" }),
    wait(name) {
      const found = stages.find((stage) => stage.name === name);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Checkpoint timed out: " + name)), 20000);
        waiting.set(name, {
          resolve: (value) => { clearTimeout(timer); waiting.delete(name); resolve(value); },
          reject: (error) => { clearTimeout(timer); waiting.delete(name); reject(error); },
        });
      });
    },
  };
}
function successful(report) {
  assert.equal(report.signal, null, report.output);
  assert.equal(report.code, 0, report.error ?? report.output);
  assert.equal(report.result.status, 201);
  assert.equal(report.result.body.success, true);
  return report.result;
}
function persistedResult(path, result) {
  const item = result.body.data.item;
  const actual = query(path, "SELECT id, title FROM ec_posts").find((row) => row.id === item.id);
  assert.ok(actual, "The returned content ID must identify a real CMS row");
  assert.equal(actual.title, item.data.title);
  const records = query(path, "SELECT state, result FROM proof_executions");
  assert.ok(records.some((row) => row.state === "completed" &&
    row.result === JSON.stringify(result)), "The exact CMS result must be persisted");
}
function actions(...reports) {
  return reports.reduce((total, report) =>
    total + report.stages.filter((stage) => stage.name === "action").length, 0);
}
async function crashAt(path, phase, options = {}) {
  const instance = start(path, { ...options, pauseAt: phase });
  const observed = await instance.wait(phase);
  instance.child.kill("SIGKILL");
  const report = await instance.done;
  assert.equal(report.signal, "SIGKILL");
  return { observed, report };
}
try {
  let traffic = 0;
  const facilitator = await listenLoopback(() => {
    traffic += 1;
    throw new Error("This durability probe must not use a facilitator");
  });
  let app;
  try {
    app = await startEmDashHttpProof({
      scheme: "exact", network: "kaspa:tn10", amount: "1",
      payTo: "unused-in-this-database-only-proof", maxTimeoutSeconds: 60,
    }, facilitator.url);
    assert.deepEqual(app.rows(), { posts: 0, revisions: 0 });
    const db = new DatabaseSync(app.dbPath);
    try { db.prepare("VACUUM INTO ?").run(seed); } finally { db.close(); }
    assert.equal(traffic, 0);
  } finally {
    try { await app?.close(); } finally { await facilitator.close(); }
  }
  const db = new DatabaseSync(seed);
  try {
    db.exec(`CREATE TABLE proof_executions (
      identity TEXT PRIMARY KEY NOT NULL, fingerprint TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('started', 'completed')),
      result TEXT,
      CHECK (state != 'completed' OR result IS NOT NULL)
    )`);
  } finally { db.close(); }
  await test("replays the stored CMS result in a new process", async () => {
    const path = freshDatabase();
    const first = await start(path).done;
    const second = await start(path).done;
    assert.deepEqual(successful(second), successful(first));
    persistedResult(path, second.result);
    assert.equal(actions(first, second), 1);
    rows(path, 1, 1);
  });
  await test("two independent processes share one atomic content commit", async () => {
    const path = freshDatabase();
    const owner = start(path, { pauseAt: "claimed" });
    await owner.wait("claimed");
    const contender = start(path);
    await contender.wait("attempt");
    owner.resume();
    const [first, second] = await Promise.all([owner.done, contender.done]);
    assert.deepEqual(successful(second), successful(first));
    persistedResult(path, second.result);
    assert.equal(actions(first, second), 1);
    rows(path, 1, 1);
  });
  for (const phase of ["claimed", "created", "recorded"]) {
    await test("SIGKILL at " + phase + " rolls back both content and replay record", async () => {
      const path = freshDatabase();
      const interrupted = await crashAt(path, phase);
      rows(path, 0, 0);
      const retry = await start(path).done;
      successful(retry);
      assert.equal(actions(interrupted.report, retry), phase === "claimed" ? 1 : 2);
      rows(path, 1, 1);
    });
  }
  await test("SIGKILL after commit replays without invoking the CMS handler again", async () => {
    const path = freshDatabase();
    const interrupted = await crashAt(path, "committed");
    rows(path, 1, 1);
    const retry = await start(path).done;
    assert.deepEqual(successful(retry), interrupted.observed.result);
    persistedResult(path, retry.result);
    assert.equal(actions(interrupted.report, retry), 1);
    rows(path, 1, 1);
  });
  await test("an exception after a real CMS write aborts the outer transaction", async () => {
    const path = freshDatabase();
    const failed = await start(path, { mode: "throw-after-create" }).done;
    assert.equal(failed.code, 1);
    assert.equal(failed.error, "INJECTED_AFTER_CREATE_FAILURE");
    rows(path, 0, 0);
    const retry = await start(path).done;
    successful(retry);
    assert.equal(actions(failed, retry), 2);
    rows(path, 1, 1);
  });
  await test("a conflicting binding cannot reuse an operation; distinct identities can", async () => {
    const path = freshDatabase();
    const first = await start(path).done;
    successful(first);
    const conflict = await start(path, { fingerprint: "different-title" }).done;
    assert.equal(conflict.code, 1);
    assert.equal(conflict.error, "OPERATION_CONFLICT");
    assert.equal(actions(conflict), 0);
    rows(path, 1, 1);
    const distinct = await start(path, {
      identity: "tenant/actor/posts/create/operation-2", fingerprint: "different-title",
    }).done;
    assert.notEqual(successful(distinct).body.data.item.id, first.result.body.data.item.id);
    assert.equal(actions(first, conflict, distinct), 2);
    rows(path, 2, 2);
  });
  await test("negative control: separate commits duplicate content after a process crash", async () => {
    const path = freshDatabase();
    const interrupted = await crashAt(path, "cms-committed", { mode: "separate-commits" });
    rows(path, 1, 0);
    const retry = await start(path, { mode: "separate-commits" }).done;
    successful(retry);
    assert.equal(actions(interrupted.report, retry), 2);
    rows(path, 2, 1);
  });
  await test("negative control: a shared ledger alone permits two concurrent CMS writes", async () => {
    const path = freshDatabase();
    const owner = start(path, { mode: "separate-commits", pauseAt: "cms-committed" });
    await owner.wait("cms-committed");
    const second = await start(path, { mode: "separate-commits" }).done;
    successful(second);
    owner.resume();
    const first = await owner.done;
    assert.equal(first.code, 1);
    assert.match(first.error, /UNIQUE constraint failed/);
    assert.equal(actions(first, second), 2);
    rows(path, 2, 1);
  });
  console.log("SQLite content durability probe finished at EmDash " + actual);
} finally {
  await Promise.all([...children].map((child) => new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGKILL");
  })));
  if (process.env.KEEP_EMDASH_DURABILITY_PROOF === "1")
    console.log("Kept SQLite durability databases: " + scratch);
  else rmSync(scratch, { recursive: true, force: true });
}
