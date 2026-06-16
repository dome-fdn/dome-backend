const { ethers } = require("ethers");
const EtherPoolAbi = require("../../dome-sdk-evm/src/utils/EtherPool.abi.json");
const { json, readBody } = require("./http.cjs");
const { debug, info } = require("./logger.cjs");

function createIndexerService(config, store) {
  const provider = new ethers.providers.JsonRpcProvider(config.rpcUpstream);
  const relayer = new ethers.Wallet(config.relayerPrivateKey, provider);
  const pool = new ethers.Contract(config.poolAddress, EtherPoolAbi, provider);
  const relayerPool = pool.connect(relayer);

  let syncPromise = null;
  let cachedState = null;
  let status = {
    ready: false,
    lastIndexedBlock: config.deploymentBlock,
    commitmentCount: 0,
    encryptedOutputCount: 0,
  };

  async function queryCommitmentLogs(fromBlock, toBlock) {
    const filter = pool.filters.NewCommitment();
    const batchSize = Math.max(1, config.logQueryBatchSize || 10);
    const logs = [];
    for (let start = fromBlock; start <= toBlock; start += batchSize) {
      const end = Math.min(start + batchSize - 1, toBlock);
      const chunk = await pool.queryFilter(filter, start, end);
      logs.push(...chunk);
    }
    return logs;
  }

  async function syncToLatest(force = false) {
    if (syncPromise && !force) {
      return syncPromise;
    }

    syncPromise = (async () => {
      const latest = await provider.getBlockNumber();
      const storedLast = Number(
        (await store.getMeta("lastIndexedBlock")) ?? config.deploymentBlock - 1,
      );
      const fromBlock = Math.max(config.deploymentBlock, storedLast + 1);

      let { commitments, encryptedOutputs } = await store.loadArrays();

      if (fromBlock <= latest) {
        const logs = await queryCommitmentLogs(fromBlock, latest);
        const entries = [];
        for (const log of logs) {
          const index = Number(log.args.index.toString());
          commitments[index] = log.args.commitment;
          encryptedOutputs[index] = log.args.encryptedOutput;
          entries.push({
            index,
            commitment: log.args.commitment,
            encryptedOutput: log.args.encryptedOutput,
          });
        }
        if (entries.length > 0) {
          await store.applyEvents(entries);
          info("Indexed new commitments", { count: entries.length, fromBlock, latest });
        }
      }

      await store.setMeta("lastIndexedBlock", String(latest));

      const [root, nextIndex, levels] = await Promise.all([
        pool.getLastRoot(),
        pool.nextIndex(),
        pool.levels(),
      ]);

      cachedState = {
        blockNumber: latest,
        commitments,
        encryptedOutputs,
        levels: Number(levels),
        nextIndex: Number(nextIndex),
        root,
        updatedAt: new Date().toISOString(),
      };

      status = {
        ready: true,
        lastIndexedBlock: latest,
        commitmentCount: commitments.filter(Boolean).length,
        encryptedOutputCount: encryptedOutputs.filter(Boolean).length,
      };

      return cachedState;
    })();

    try {
      return await syncPromise;
    } finally {
      syncPromise = null;
    }
  }

  async function loadState() {
    return syncToLatest(false);
  }

  function kickBackgroundSync() {
    if (syncPromise) return;
    void syncToLatest(false).catch((cause) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      info("Background indexer sync failed", { message });
    });
  }

  async function readState() {
    if (cachedState && status.ready) {
      kickBackgroundSync();
      return cachedState;
    }
    return syncToLatest(false);
  }

  function cachedSummary() {
    const commitmentCount =
      cachedState?.commitments?.filter(Boolean).length ?? status.commitmentCount ?? 0;
    const encryptedOutputCount =
      cachedState?.encryptedOutputs?.filter(Boolean).length ?? status.encryptedOutputCount ?? 0;

    return {
      ready: status.ready,
      root: cachedState?.root ?? null,
      nextIndex: cachedState?.nextIndex ?? commitmentCount,
      blockNumber: cachedState?.blockNumber ?? status.lastIndexedBlock ?? config.deploymentBlock,
      lastIndexedBlock: status.lastIndexedBlock,
      commitmentCount,
      encryptedOutputCount,
      deploymentBlock: config.deploymentBlock,
      updatedAt: cachedState?.updatedAt ?? null,
    };
  }

  async function getZero(level) {
    return pool.zeros(level);
  }

  async function hashPair(left, right) {
    return pool.hashLeftRight(left, right);
  }

  async function merklePathFor(index, commitments, levels) {
    let currentIndex = index;
    let levelNodes = commitments.slice();
    const pathElements = [];

    for (let level = 0; level < levels; level += 1) {
      const zero = await getZero(level);
      const siblingIndex = currentIndex ^ 1;
      pathElements.push(levelNodes[siblingIndex] || zero);

      const nextLevel = [];
      const width = Math.max(levelNodes.length, siblingIndex + 1);
      for (let i = 0; i < width; i += 2) {
        const left = levelNodes[i] || zero;
        const right = levelNodes[i + 1] || zero;
        nextLevel.push(await hashPair(left, right));
      }

      levelNodes = nextLevel;
      currentIndex = Math.floor(currentIndex / 2);
    }

    return pathElements;
  }

  async function handle(req, res, path, url) {
    if (req.method === "GET" && path === "/config") {
      return json(res, 200, {
        prices: { eth: 0 },
        minimum_withdrawal: { eth: 0.0005, usdc: 1 },
        minimum_deposit: { eth: 0.0005, usdc: 1 },
        rent_fees: { eth: 0, usdc: 0 },
        fee_rate: 0,
      });
    }

    if (req.method === "GET" && path === "/merkle/root") {
      const state = await readState();
      return json(res, 200, { root: state.root, nextIndex: state.nextIndex });
    }

    if (req.method === "GET" && (path === "/merkle/root/cached" || path === "/stats/summary")) {
      return json(res, 200, cachedSummary(), {
        "cache-control": "public, max-age=5, stale-while-revalidate=30",
      });
    }

    if (req.method === "GET" && path === "/get_encrypted") {
      const state = await readState();
      const start = Number(url.searchParams.get("start") || 0);
      const end = Number(url.searchParams.get("end") || state.nextIndex);
      const encrypted_outputs = [];
      const indices = [];
      for (let i = start; i < end && i < state.nextIndex; i += 1) {
        const output = state.encryptedOutputs[i];
        if (output) {
          encrypted_outputs.push(output);
          indices.push(i);
        }
      }
      return json(res, 200, {
        encrypted_outputs,
        indices,
        hasMore: end < state.nextIndex,
        start,
        total: state.nextIndex,
      });
    }

    if (req.method === "POST" && (path === "/commitment" || path === "/commitment/")) {
      const state = await readState();
      const body = await readBody(req);
      const target = String(body.commitment || "").toLowerCase();
      const index = state.commitments.findIndex(
        (commitment) => commitment && commitment.toLowerCase() === target,
      );
      if (index < 0) return json(res, 404, { error: "commitment not found" });
      const pathElements = await merklePathFor(index, state.commitments, state.levels);
      return json(res, 200, { index, pathElements });
    }

    if (req.method === "POST" && path === "/screen_address") {
      return json(res, 200, { isRisk: false });
    }

    if (req.method === "POST" && path === "/check_encrypted_output") {
      const state = await readState();
      const body = await readBody(req);
      const encryptedOutput = String(body.encryptedOutput || "").toLowerCase();
      const exists = state.encryptedOutputs.some(
        (output) => output && output.toLowerCase() === encryptedOutput,
      );
      return json(res, 200, { exists });
    }

    if (req.method === "POST" && path === "/relayer/withdraw") {
      if (config.relayerSecret) {
        const provided = req.headers["x-dome-relayer-secret"];
        if (provided !== config.relayerSecret) {
          return json(res, 401, { error: "invalid relayer secret" });
        }
      }

      const body = await readBody(req);
      debug("Submitting relayer withdraw");
      const tx = await relayerPool.transact(body.args, body.extData, { gasLimit: 3000000 });
      const receipt = await tx.wait();
      cachedState = null;
      await syncToLatest(true);
      return json(res, 200, {
        success: true,
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
      });
    }

    return null;
  }

  return {
    handle,
    relayerAddress: relayer.address,
    getStatus: () => ({ ...status }),
    syncToLatest,
    kickBackgroundSync,
  };
}

module.exports = {
  createIndexerService,
};
