const http = require("node:http");
const { buildConfig, validateRuntimeConfig } = require("./config.cjs");
const { json, text } = require("./http.cjs");
const { handleRpc, handleDevFund } = require("./rpc.cjs");
const { createIndexerService } = require("./indexer.cjs");
const { createStore, ensureStoreIdentity } = require("./store.cjs");
const { createRateLimiter } = require("./rateLimit.cjs");
const { info, error, warn } = require("./logger.cjs");

async function main() {
  const config = buildConfig();
  const runtime = await validateRuntimeConfig(config);
  config.chainId = runtime.chainId;

  const store = createStore(config);
  await ensureStoreIdentity(store, config);

  const indexer = createIndexerService(config, store);
  await indexer.syncToLatest(true);

  const rpcLimiter = createRateLimiter({
    windowMs: 60_000,
    max: config.rateLimitRpcPerMinute,
  });
  const relayerLimiter = createRateLimiter({
    windowMs: 60_000,
    max: config.rateLimitRelayerPerMinute,
  });

  async function getHealth() {
    let rpc = { reachable: false, chainId: null };
    try {
      const response = await fetch(config.rpcUpstream, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      const payload = await response.json();
      rpc = {
        reachable: response.ok && !payload.error,
        chainId: payload.result ? Number.parseInt(payload.result, 16) : null,
      };
    } catch (cause) {
      rpc = { reachable: false, chainId: null, error: String(cause) };
    }

    const indexerStatus = indexer.getStatus();
    return {
      ok: rpc.reachable && indexerStatus.ready,
      rpc,
      indexer: {
        ...indexerStatus,
        store: store.kind,
        deploymentBlock: config.deploymentBlock,
      },
      pool: config.poolAddress,
      relayer: indexer.relayerAddress,
      deployFile: config.deployFile,
    };
  }

  async function handleRequest(req, res) {
    const started = Date.now();
    const url = new URL(req.url || "/", `http://${req.headers.host || config.host}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const clientIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";

    const finish = (statusCode) => {
      info("request", {
        method: req.method,
        path,
        status: statusCode,
        ms: Date.now() - started,
      });
    };

    if (req.method === "OPTIONS") {
      finish(204);
      return text(res, 204, "", "text/plain");
    }

    try {
      if (path === "/health") {
        const health = await getHealth();
        finish(health.ok ? 200 : 503);
        return json(res, health.ok ? 200 : 503, health);
      }

      if (path === "/rpc") {
        if (!rpcLimiter.allow(clientIp)) {
          finish(429);
          return json(res, 429, { error: "rate limit exceeded" });
        }
        await handleRpc(req, res, config.rpcUpstream);
        finish(200);
        return;
      }

      if (path === "/dev/fund") {
        await handleDevFund(req, res, {
          upstreamRpc: config.rpcUpstream,
          enabled: config.localFaucetEnabled,
        });
        finish(200);
        return;
      }

      if (path === "/relayer/withdraw" && !relayerLimiter.allow(clientIp)) {
        finish(429);
        return json(res, 429, { error: "rate limit exceeded" });
      }

      const indexerResult = await indexer.handle(req, res, path, url);
      if (indexerResult !== null) {
        finish(200);
        return indexerResult;
      }

      finish(404);
      return json(res, 404, { error: "not found" });
    } catch (cause) {
      error("request failed", {
        method: req.method,
        path,
        message: cause instanceof Error ? cause.message : String(cause),
      });
      finish(500);
      return json(res, 500, { error: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  const server = http.createServer(handleRequest);
  server.listen(config.port, config.host, () => {
    info("Dome backend listening", {
      url: `http://${config.host}:${config.port}`,
      rpcUpstream: config.rpcUpstream,
      pool: config.poolAddress,
      relayer: indexer.relayerAddress,
      store: store.kind,
    });
  });

  const shutdown = async (signal) => {
    warn("Shutting down", { signal });
    server.close(async () => {
      await store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((cause) => {
  error("Failed to start backend", { message: cause instanceof Error ? cause.message : String(cause) });
  process.exit(1);
});
