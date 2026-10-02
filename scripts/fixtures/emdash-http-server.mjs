import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const adapterRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
export async function listenLoopback(handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: "http://127.0.0.1:" + server.address().port,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
async function freePort() {
  const listener = await listenLoopback((_, response) => response.end());
  const port = Number(new URL(listener.url).port);
  await listener.close();
  return port;
}
export async function startEmDashHttpProof(terms, facilitatorUrl) {
  const emdash = process.env.EMDASH_HTTP_PROOF_SOURCE;
  if (!emdash) throw new Error("EMDASH_HTTP_PROOF_SOURCE is required");
  const base = join(emdash, "packages/core/tests/integration/.servers");
  mkdirSync(base, { recursive: true });
  const cwd = mkdtempSync(join(base, "rc2-http-"));
  cpSync(join(adapterRoot, "scripts/fixtures/emdash-http"), cwd, { recursive: true });
  for (const filename of ["astro.config.mjs", "src/middleware.js"]) {
    const path = join(cwd, filename);
    writeFileSync(path, readFileSync(path, "utf8").replaceAll("__ADAPTER_ROOT__", adapterRoot));
  }
  symlinkSync(join(emdash, "demos/simple/node_modules"), join(cwd, "node_modules"));
  writeFileSync(join(cwd, "requirements.json"), JSON.stringify(terms));
  const secret = randomUUID();
  const port = await freePort();
  const url = "http://127.0.0.1:" + port;
  const dbPath = join(cwd, "proof.db");
  mkdirSync(join(cwd, "uploads"));
  const env = {
    ...process.env, ASTRO_DEV_BACKGROUND: "1", ASTRO_TELEMETRY_DISABLED: "1",
    EMDASH_TEST_DB: "file:" + dbPath, EMDASH_TEST_UPLOADS: join(cwd, "uploads"),
    RC2_PROOF_TERMS: join(cwd, "requirements.json"),
    RC2_PROOF_FACILITATOR: facilitatorUrl, RC2_PROOF_SECRET: secret,
  };
  for (const key of Object.keys(env))
    if (key === "VITEST" || key.startsWith("VITEST_")) delete env[key];
  const child = spawn(join(cwd, "node_modules/.bin/astro"),
    ["dev", "--host", "127.0.0.1", "--port", String(port)], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => { output = (output + data).slice(-12000); });
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
      child.kill("SIGTERM");
      await exited;
      clearTimeout(kill);
    }
    if (process.env.KEEP_EMDASH_HTTP_PROOF === "1") {
      writeFileSync(join(cwd, "server.log"), output);
      console.log("Kept EmDash HTTP fixture: " + cwd);
    } else rmSync(cwd, { recursive: true, force: true });
  }
  async function control(command = "stats", options = {}) {
    const query = new URLSearchParams({ command, ...options });
    const response = await fetch(url + "/_proof/control?" + query, {
      headers: { "x-proof-secret": secret }, signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("Control failed: " + response.status + " " + await response.text());
    return response.json();
  }
  try {
    const deadline = Date.now() + 90000;
    let setup;
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("Astro exited");
      try {
        setup = await fetch(url + "/_emdash/api/setup/dev-bypass?token=1&content=0",
          { signal: AbortSignal.timeout(30000) });
        break;
      } catch {
        if (Date.now() > deadline) throw new Error("Astro startup timed out");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!setup.ok) throw new Error("EmDash setup failed: " + setup.status + " " + await setup.text());
    const token = (await setup.json()).data.token;
    if (!token) throw new Error("EmDash did not issue a PAT");
    const headers = {
      authorization: "Bearer " + token, "x-emdash-request": "1",
      "content-type": "application/json", "x-tenant": "proof-tenant",
    };
    return {
      url, cwd, dbPath, headers, control, close,
      rows() {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
          return {
            posts: Number(db.prepare("SELECT count(*) AS n FROM ec_posts").get().n),
            revisions: Number(db.prepare("SELECT count(*) AS n FROM revisions WHERE collection = 'posts'").get().n),
          };
        } finally { db.close(); }
      },
      post(id) {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
          return db.prepare("SELECT id, title, status, author_id FROM ec_posts WHERE id = ?").get(id);
        } finally { db.close(); }
      },
      logs: () => output,
    };
  } catch (error) {
    await close();
    throw new Error(error.message + "\nAstro output:\n" + output, { cause: error });
  }
}
