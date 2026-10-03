import { createDialect as realDialect } from "emdash/db/sqlite";
import { state, checkpoint } from "./state.mjs";
// Observe the real driver; statements and transaction behavior are unchanged.
export function createDialect(config) {
  const dialect = realDialect(config);
  const driver = dialect.createDriver();
  const originals = new WeakMap(), observed = new WeakMap();
  const facade = new Proxy(driver, {
    get(target, property) {
      if (property === "acquireConnection") return async () => {
        const connection = await target.acquireConnection();
        if (observed.has(connection)) return observed.get(connection);
        const wrapped = {
          async executeQuery(query) {
            const active = state.scope.getStore();
            const statement = query.sql.toLowerCase().trim();
            const claim = statement.startsWith('insert into "_emdash_content_operations"');
            if (active && claim) await checkpoint("claim-attempt");
            const result = await connection.executeQuery(query);
            if (active) {
              if (claim && result.rows.length) await checkpoint("claimed");
              else if (statement.startsWith('insert into "ec_posts"')) {
                state.contentWrites += 1;
                await checkpoint("content-written");
              } else if (statement.startsWith('update "_emdash_content_operations"'))
                await checkpoint("replay-written");
              else if (statement.startsWith('insert into "_emdash_content_create_effects"'))
                await checkpoint("outbox-written");
            }
            return result;
          },
          streamQuery: connection.streamQuery.bind(connection),
        };
        originals.set(wrapped, connection); observed.set(connection, wrapped);
        return wrapped;
      };
      if (["beginTransaction", "rollbackTransaction", "releaseConnection"].includes(property))
        return (connection, ...args) => Reflect.apply(target[property], target,
          [originals.get(connection) ?? connection, ...args]);
      if (property === "commitTransaction") return async (connection) => {
        if (state.scope.getStore()) await checkpoint("before-commit");
        await target.commitTransaction(originals.get(connection) ?? connection);
        if (state.scope.getStore()) await checkpoint("committed");
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  dialect.createDriver = () => facade;
  return dialect;
}
