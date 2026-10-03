import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [database, identity, fingerprint, mode, pauseAt] = process.argv.slice(2);
const source = process.env.EMDASH_HTTP_PROOF_SOURCE;
if (!source || !process.send) throw new Error("A built EmDash source and parent IPC are required");
const core = join(source, "packages/core");
const resolve = createRequire(join(core, "package.json")).resolve;
const { Kysely } = await import(pathToFileURL(resolve("kysely")));
const { createDialect } = await import(pathToFileURL(join(core, "dist/db/sqlite.mjs")));
const { handleContentCreate } = await import(pathToFileURL(join(core, "dist/index.mjs")));
const db = new Kysely({ dialect: createDialect({ url: "file:" + database }) });

function send(message) {
  return new Promise((resolve, reject) => {
    process.send(message, (error) => error ? reject(error) : resolve());
  });
}
async function checkpoint(name, details = {}) {
  const continuation = pauseAt === name ? new Promise((resolve) => {
    process.once("message", (message) => {
      if (message?.type !== "continue") throw new Error("Unexpected parent message");
      resolve();
    });
  }) : undefined;
  await send({ type: "stage", name, ...details });
  await continuation;
}

async function createContent(connection) {
  await checkpoint("action");
  const created = await handleContentCreate(connection, "posts", {
    data: { title: fingerprint }, status: "draft",
  });
  if (!created.success) throw new Error("CMS_CREATE_FAILED: " + created.error.code);
  const result = { status: 201, body: created };
  await checkpoint("created", { result });
  if (mode === "throw-after-create") throw new Error("INJECTED_AFTER_CREATE_FAILURE");
  return result;
}
function conflict() {
  throw new Error("OPERATION_CONFLICT");
}
function replay(record) {
  if (record.fingerprint !== fingerprint) conflict();
  if (record.state !== "completed" || !record.result) throw new Error("UNCERTAIN_OPERATION");
  return JSON.parse(record.result);
}
async function atomic() {
  await checkpoint("attempt");
  const result = await db.transaction().execute(async (trx) => {
    const claim = await trx.insertInto("proof_executions")
      .values({ identity, fingerprint, state: "started", result: null })
      .onConflict((oc) => oc.column("identity").doNothing())
      .returning("identity").executeTakeFirst();
    if (!claim) {
      return replay(await trx.selectFrom("proof_executions").selectAll()
        .where("identity", "=", identity).executeTakeFirstOrThrow());
    }
    await checkpoint("claimed");
    const response = await createContent(trx);
    await trx.updateTable("proof_executions")
      .set({ state: "completed", result: JSON.stringify(response) })
      .where("identity", "=", identity).executeTakeFirstOrThrow();
    await checkpoint("recorded", { result: response });
    return response;
  });
  await checkpoint("committed", { result });
  return result;
}
async function separateCommits() {
  const existing = await db.selectFrom("proof_executions").selectAll()
    .where("identity", "=", identity).executeTakeFirst();
  if (existing) return replay(existing);
  const result = await createContent(db);
  await checkpoint("cms-committed", { result });
  await db.insertInto("proof_executions").values({
    identity, fingerprint, state: "completed", result: JSON.stringify(result),
  }).execute();
  return result;
}
try {
  const result = mode === "separate-commits" ? await separateCommits() : await atomic();
  await send({ type: "result", result });
} catch (error) {
  await send({ type: "failure", error: error.message });
  process.exitCode = 1;
} finally {
  await db.destroy();
  process.disconnect();
}
