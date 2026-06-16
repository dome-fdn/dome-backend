const { existsSync, mkdirSync } = require("node:fs");
const { dirname } = require("node:path");
const { info, warn } = require("./logger.cjs");

const HARDHAT_DEFAULT_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function createSqliteStore(sqlitePath) {
  const Database = require("better-sqlite3");
  mkdirSync(dirname(sqlitePath), { recursive: true });
  const db = new Database(sqlitePath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS commitments (
      idx INTEGER PRIMARY KEY,
      commitment TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS encrypted_outputs (
      idx INTEGER PRIMARY KEY,
      output TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      expo_push_token TEXT NOT NULL UNIQUE,
      platform TEXT NOT NULL,
      notification_types TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const getMetaStmt = db.prepare("SELECT value FROM meta WHERE key = ?");
  const setMetaStmt = db.prepare(
    "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const upsertCommitmentStmt = db.prepare(
    "INSERT INTO commitments(idx, commitment) VALUES(?, ?) ON CONFLICT(idx) DO UPDATE SET commitment = excluded.commitment",
  );
  const upsertOutputStmt = db.prepare(
    "INSERT INTO encrypted_outputs(idx, output) VALUES(?, ?) ON CONFLICT(idx) DO UPDATE SET output = excluded.output",
  );
  const listCommitmentsStmt = db.prepare("SELECT idx, commitment FROM commitments ORDER BY idx ASC");
  const listOutputsStmt = db.prepare("SELECT idx, output FROM encrypted_outputs ORDER BY idx ASC");
  const upsertPushDeviceStmt = db.prepare(`
    INSERT INTO push_devices(expo_push_token, platform, notification_types, enabled, created_at, updated_at, last_seen_at)
    VALUES(@token, @platform, @notificationTypes, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(expo_push_token) DO UPDATE SET
      platform = excluded.platform,
      notification_types = excluded.notification_types,
      enabled = 1,
      updated_at = CURRENT_TIMESTAMP,
      last_seen_at = CURRENT_TIMESTAMP
  `);
  const listEnabledPushDevicesStmt = db.prepare(`
    SELECT expo_push_token AS token, platform, notification_types AS notificationTypes
    FROM push_devices
    WHERE enabled = 1
    ORDER BY id ASC
  `);
  const disablePushDeviceStmt = db.prepare(`
    UPDATE push_devices
    SET enabled = 0, updated_at = CURRENT_TIMESTAMP
    WHERE expo_push_token = ?
  `);
  const clearAllStmt = db.transaction(() => {
    db.exec("DELETE FROM meta; DELETE FROM commitments; DELETE FROM encrypted_outputs;");
  });

  return {
    kind: "sqlite",
    getMeta(key) {
      const row = getMetaStmt.get(key);
      return row ? row.value : null;
    },
    setMeta(key, value) {
      setMetaStmt.run(key, String(value));
    },
    loadArrays() {
      const commitments = [];
      const encryptedOutputs = [];
      for (const row of listCommitmentsStmt.iterate()) {
        commitments[row.idx] = row.commitment;
      }
      for (const row of listOutputsStmt.iterate()) {
        encryptedOutputs[row.idx] = row.output;
      }
      return { commitments, encryptedOutputs };
    },
    applyEvents(logs) {
      const apply = db.transaction((entries) => {
        for (const entry of entries) {
          upsertCommitmentStmt.run(entry.index, entry.commitment);
          upsertOutputStmt.run(entry.index, entry.encryptedOutput);
        }
      });
      apply(logs);
    },
    reset() {
      clearAllStmt();
    },
    upsertPushDevice(device) {
      upsertPushDeviceStmt.run({
        token: device.token,
        platform: device.platform,
        notificationTypes: JSON.stringify(device.notificationTypes),
      });
    },
    listEnabledPushDevices() {
      return listEnabledPushDevicesStmt.all().map((row) => ({
        token: row.token,
        platform: row.platform,
        notificationTypes: JSON.parse(row.notificationTypes),
      }));
    },
    disablePushDevices(tokens) {
      const disable = db.transaction((entries) => {
        for (const token of entries) {
          disablePushDeviceStmt.run(token);
        }
      });
      disable(tokens);
    },
    close() {
      db.close();
    },
  };
}

function createPostgresStore(databaseUrl) {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: databaseUrl, ssl: databaseUrl.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined });
  let ready = false;

  async function ensureSchema() {
    if (ready) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commitments (
        idx INTEGER PRIMARY KEY,
        commitment TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS encrypted_outputs (
        idx INTEGER PRIMARY KEY,
        output TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS push_devices (
        id BIGSERIAL PRIMARY KEY,
        expo_push_token TEXT NOT NULL UNIQUE,
        platform TEXT NOT NULL,
        notification_types JSONB NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    ready = true;
  }

  return {
    kind: "postgres",
    async getMeta(key) {
      await ensureSchema();
      const result = await pool.query("SELECT value FROM meta WHERE key = $1", [key]);
      return result.rows[0]?.value ?? null;
    },
    async setMeta(key, value) {
      await ensureSchema();
      await pool.query(
        "INSERT INTO meta(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, String(value)],
      );
    },
    async loadArrays() {
      await ensureSchema();
      const commitments = [];
      const encryptedOutputs = [];
      const commitmentRows = await pool.query("SELECT idx, commitment FROM commitments ORDER BY idx ASC");
      const outputRows = await pool.query("SELECT idx, output FROM encrypted_outputs ORDER BY idx ASC");
      for (const row of commitmentRows.rows) {
        commitments[row.idx] = row.commitment;
      }
      for (const row of outputRows.rows) {
        encryptedOutputs[row.idx] = row.output;
      }
      return { commitments, encryptedOutputs };
    },
    async applyEvents(logs) {
      await ensureSchema();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const entry of logs) {
          await client.query(
            "INSERT INTO commitments(idx, commitment) VALUES($1, $2) ON CONFLICT(idx) DO UPDATE SET commitment = excluded.commitment",
            [entry.index, entry.commitment],
          );
          await client.query(
            "INSERT INTO encrypted_outputs(idx, output) VALUES($1, $2) ON CONFLICT(idx) DO UPDATE SET output = excluded.output",
            [entry.index, entry.encryptedOutput],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async reset() {
      await ensureSchema();
      await pool.query("DELETE FROM meta");
      await pool.query("DELETE FROM commitments");
      await pool.query("DELETE FROM encrypted_outputs");
    },
    async upsertPushDevice(device) {
      await ensureSchema();
      await pool.query(
        `
          INSERT INTO push_devices(expo_push_token, platform, notification_types, enabled, created_at, updated_at, last_seen_at)
          VALUES($1, $2, $3::jsonb, TRUE, NOW(), NOW(), NOW())
          ON CONFLICT(expo_push_token) DO UPDATE SET
            platform = excluded.platform,
            notification_types = excluded.notification_types,
            enabled = TRUE,
            updated_at = NOW(),
            last_seen_at = NOW()
        `,
        [device.token, device.platform, JSON.stringify(device.notificationTypes)],
      );
    },
    async listEnabledPushDevices() {
      await ensureSchema();
      const result = await pool.query(`
        SELECT expo_push_token AS token, platform, notification_types AS "notificationTypes"
        FROM push_devices
        WHERE enabled = TRUE
        ORDER BY id ASC
      `);
      return result.rows.map((row) => ({
        token: row.token,
        platform: row.platform,
        notificationTypes: Array.isArray(row.notificationTypes)
          ? row.notificationTypes
          : JSON.parse(row.notificationTypes),
      }));
    },
    async disablePushDevices(tokens) {
      await ensureSchema();
      if (!tokens.length) return;
      await pool.query(
        "UPDATE push_devices SET enabled = FALSE, updated_at = NOW() WHERE expo_push_token = ANY($1::text[])",
        [tokens],
      );
    },
    async close() {
      await pool.end();
    },
  };
}

function createStore(config) {
  const databaseUrl = config.databaseUrl;
  if (databaseUrl && /^postgres(ql)?:\/\//i.test(databaseUrl)) {
    info("Using Postgres indexer store");
    return wrapStore(createPostgresStore(databaseUrl));
  }

  const sqlitePath = config.sqlitePath;
  info("Using SQLite indexer store", { path: sqlitePath });
  return wrapStore(createSqliteStore(sqlitePath));
}

function wrapStore(store) {
  const isAsync = store.kind === "postgres";
  return {
    kind: store.kind,
    async getMeta(key) {
      return isAsync ? store.getMeta(key) : store.getMeta(key);
    },
    async setMeta(key, value) {
      return isAsync ? store.setMeta(key, value) : store.setMeta(key, value);
    },
    async loadArrays() {
      return isAsync ? store.loadArrays() : store.loadArrays();
    },
    async applyEvents(entries) {
      return isAsync ? store.applyEvents(entries) : store.applyEvents(entries);
    },
    async reset() {
      return isAsync ? store.reset() : store.reset();
    },
    async upsertPushDevice(device) {
      return isAsync ? store.upsertPushDevice(device) : store.upsertPushDevice(device);
    },
    async listEnabledPushDevices() {
      return isAsync ? store.listEnabledPushDevices() : store.listEnabledPushDevices();
    },
    async disablePushDevices(tokens) {
      return isAsync ? store.disablePushDevices(tokens) : store.disablePushDevices(tokens);
    },
    async close() {
      return isAsync ? store.close() : store.close();
    },
  };
}

async function ensureStoreIdentity(store, config) {
  const expectedPool = config.poolAddress.toLowerCase();
  const expectedChainId = String(config.chainId || "");
  const storedPool = await store.getMeta("poolAddress");
  const storedChainId = await store.getMeta("chainId");

  if (storedPool && storedPool.toLowerCase() !== expectedPool) {
    warn("Pool address changed; resetting indexer store", { storedPool, expectedPool });
    await store.reset();
  } else if (storedChainId && expectedChainId && storedChainId !== expectedChainId) {
    warn("Chain id changed; resetting indexer store", { storedChainId, expectedChainId });
    await store.reset();
  }

  await store.setMeta("poolAddress", expectedPool);
  if (expectedChainId) await store.setMeta("chainId", expectedChainId);
  await store.setMeta("deploymentBlock", String(config.deploymentBlock));
}

module.exports = {
  HARDHAT_DEFAULT_KEY,
  createStore,
  ensureStoreIdentity,
};
