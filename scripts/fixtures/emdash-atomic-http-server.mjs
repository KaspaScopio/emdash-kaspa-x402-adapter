import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
export { listenLoopback } from "./emdash-http-server.mjs";
export { atomicHttpRequestHash } from "./emdash-atomic-http/binding.mjs";
const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
export async function startAtomicHttpProof(terms, facilitatorUrl) {
  const source = process.env.EMDASH_ATOMIC_PROOF_SOURCE;
  if (!source) throw new Error("EMDASH_ATOMIC_PROOF_SOURCE is required");
  const base = join(source, "packages/core/tests/integration/.servers");
  mkdirSync(base, { recursive: true });
  const cwd = mkdtempSync(join(base, "rc2-atomic-http-"));
  cpSync(join(root, "scripts/fixtures/emdash-atomic-http"), cwd, { recursive: true });
  for (const file of ["astro.config.mjs", "src/middleware.js"]) {
    const path = join(cwd, file);
    writeFileSync(path, readFileSync(path, "utf8").replaceAll("__ADAPTER_ROOT__", root));
  }
  symlinkSync(join(source, "demos/simple/node_modules"), join(cwd, "node_modules"));
  const dbPath = join(cwd, "proof.db"), secret = randomUUID();
  mkdirSync(join(cwd, "uploads"));
  writeFileSync(join(cwd, "requirements.json"), JSON.stringify(terms));
  const env = {
    ...process.env, ASTRO_DEV_BACKGROUND: "1", ASTRO_TELEMETRY_DISABLED: "1",
    EMDASH_TEST_DB: "file:" + dbPath, EMDASH_TEST_UPLOADS: join(cwd, "uploads"),
    RC2_PROOF_TERMS: join(cwd, "requirements.json"),
    RC2_PROOF_FACILITATOR: facilitatorUrl, RC2_PROOF_SECRET: secret,
  };
  for (const key of Object.keys(env))
    if (key === "VITEST" || key.startsWith("VITEST_")) delete env[key];
  let child, url, port = 0, output = "", closed = false;
  const events = [], workers = [];
  async function start() {
    child = spawn(process.execPath, [join(cwd, "serve.mjs")], {
      cwd, env: { ...env, ATOMIC_HTTP_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const pid = child.pid;
    workers.push(pid);
    child.on("exit", (code, signal) =>
      events.push({ type: "atomic-worker-exit", pid, code, signal }));
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (data) => { output = (output + data).slice(-50000); });
    child.on("message", (message) => {
      if (message?.type === "atomic-stage") events.push(message);
    });
    const address = await new Promise((resolve, reject) => {
      const worker = child;
      const timeout = setTimeout(() => finish(new Error("Astro startup timed out")), 90000);
      function finish(error, value) {
        clearTimeout(timeout); worker.off("message", ready);
        worker.off("error", failed); worker.off("exit", exited);
        error ? reject(error) : resolve(value);
      }
      function failed(error) { finish(error); }
      function exited(code, signal) { finish(new Error("Astro exited: " + (signal ?? code))); }
      function ready(message) {
        if (message?.type !== "emdash-http-proof:ready") return;
        if (message.nonce !== secret || message.address !== "127.0.0.1" ||
            !Number.isInteger(message.port) || message.port <= 0 ||
            (port && message.port !== port)) {
          finish(new Error("Invalid or changed Astro address")); return;
        }
        finish(undefined, message.port);
      }
      worker.on("message", ready); worker.once("error", failed); worker.once("exit", exited);
    });
    port = address; url = "http://127.0.0.1:" + port;
  }
  async function stop(signal) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.kill(signal);
    try {
      const [, observedSignal] = await exited;
      if (signal === "SIGKILL" && observedSignal !== "SIGKILL")
        throw new Error("The requested crash did not terminate the worker with SIGKILL");
    } finally { clearTimeout(timeout); }
  }
  function rows() {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const count = (table) => Number(db.prepare("SELECT count(*) n FROM " + table).get().n);
      return { posts: count("ec_posts"), operations: count("_emdash_content_operations"),
        effects: count("_emdash_content_create_effects"),
        revisions: Number(db.prepare("SELECT count(*) n FROM revisions WHERE collection='posts'").get().n) };
    } finally { db.close(); }
  }
  async function control(command = "stats", options = {}) {
    const query = new URLSearchParams({ command, ...options });
    const response = await fetch(url + "/_proof/control?" + query, {
      headers: { "x-proof-secret": secret }, signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("Control failed " + response.status + ": " + await response.text());
    return response.json();
  }
  async function close() {
    if (closed) return;
    closed = true; await stop("SIGTERM");
    if (process.env.KEEP_EMDASH_ATOMIC_HTTP_PROOF === "1") {
      writeFileSync(join(cwd, "server.log"), output);
      writeFileSync(join(cwd, "workers.json"), JSON.stringify({ workers, events }, null, 2));
      console.log("Kept atomic HTTP fixture: " + cwd);
    } else rmSync(cwd, { recursive: true, force: true });
  }
  try {
    await start();
    const setup = await fetch(url + "/_emdash/api/setup/dev-bypass?token=1&content=0",
      { signal: AbortSignal.timeout(60000) });
    if (!setup.ok) throw new Error("Setup failed " + setup.status + ": " + await setup.text());
    const token = (await setup.json()).data.token;
    if (!token) throw new Error("No real PAT");
    const headers = { authorization: "Bearer " + token, "x-emdash-request": "1",
      "content-type": "application/json", "x-tenant": "proof-tenant" };
    return {
      get url() { return url; }, cwd, dbPath, headers, events, workers, rows, control, close,
      logs: () => output,
      async restart() { await stop("SIGKILL"); await start(); },
      async kill() {
        if (!child || child.exitCode !== null || child.signalCode !== null)
          throw new Error("Crash target is not a running HTTP worker");
        await stop("SIGKILL");
      },
      release() { child.send({ type: "atomic-continue" }); },
      async waitStage(name, offset = 0, count = 1) {
        const deadline = Date.now() + 60000;
        while (events.slice(offset).filter((event) => event.name === name).length < count) {
          if (child.exitCode !== null || child.signalCode !== null)
            throw new Error("Worker exited waiting for " + name + "\n" + output);
          if (Date.now() > deadline) throw new Error("Stage timed out " + name + "\n" + output);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return events.slice(offset).filter((event) => event.name === name).at(-1);
      },
      ledger() {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try { return db.prepare("SELECT * FROM _emdash_content_operations").all(); }
        finally { db.close(); }
      },
      userRole(id, role) {
        const db = new DatabaseSync(dbPath);
        try {
          const user = db.prepare("SELECT role FROM users WHERE id=?").get(id);
          if (!user) throw new Error("Missing real content author");
          if (role !== undefined) {
            const updated = db.prepare("UPDATE users SET role=? WHERE id=?").run(role, id);
            if (Number(updated.changes) !== 1) throw new Error("Role update failed");
          }
          return Number(user.role);
        } finally { db.close(); }
      },
      // Fault injection only; the HTTP host never deletes or clears replay records.
      clearReplayResult(contentId) {
        const db = new DatabaseSync(dbPath);
        try {
          const row = db.prepare("SELECT id FROM _emdash_content_operations WHERE json_extract(result, '$.data.item.id') = ?").get(contentId);
          if (!row) throw new Error("No saved result for content");
          const result = db.prepare("UPDATE _emdash_content_operations SET result=NULL WHERE id=?").run(row.id);
          if (Number(result.changes) !== 1) throw new Error("Replay fault injection did not affect one row");
        } finally { db.close(); }
      },
      post(id) {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try { return db.prepare("SELECT id,title,status,author_id FROM ec_posts WHERE id=?").get(id); }
        finally { db.close(); }
      },
    };
  } catch (error) {
    await close(); throw new Error(error.message + "\nAstro:\n" + output, { cause: error });
  }
}
