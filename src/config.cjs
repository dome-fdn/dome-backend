const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { ethers } = require("ethers");
const { HARDHAT_DEFAULT_KEY } = require("./store.cjs");

const root = resolve(__dirname, "../..");
const defaultDeployFile = resolve(root, ".dome-local/base-deploy.json");

function readDeploy(deployFile) {
  if (!existsSync(deployFile)) {
    throw new Error(`Missing deploy file: ${deployFile}. Run bash scripts/base/deploy-local.sh first.`);
  }
  return JSON.parse(readFileSync(deployFile, "utf8"));
}

function buildConfig() {
  const deployFile = resolve(process.env.DOME_DEPLOY_FILE || defaultDeployFile);
  const deploy = readDeploy(deployFile);
  const poolAddress = process.env.DOME_ETH_POOL_ADDRESS || deploy.ethPoolAddress;
  const rpcUpstream =
    process.env.DOME_BASE_RPC_UPSTREAM ||
    process.env.DOME_BASE_RPC ||
    deploy.rpcUrl ||
    "http://127.0.0.1:8545";
  const relayerPrivateKey = process.env.DOME_RELAYER_PRIVATE_KEY || HARDHAT_DEFAULT_KEY;
  const chainId = Number(process.env.DOME_CHAIN_ID || deploy.chainId || 0);
  const databaseUrl = process.env.DOME_DATABASE_URL || process.env.DATABASE_URL || "";
  const sqlitePath = resolve(
    process.env.DOME_SQLITE_PATH || resolve(root, ".dome-local/backend.sqlite"),
  );

  if (!poolAddress || !ethers.utils.isAddress(poolAddress)) {
    throw new Error(`Invalid pool address: ${poolAddress}`);
  }
  if (!rpcUpstream.startsWith("http://") && !rpcUpstream.startsWith("https://")) {
    throw new Error(`Invalid RPC URL: ${rpcUpstream}`);
  }
  if (!relayerPrivateKey.startsWith("0x") || relayerPrivateKey.length !== 66) {
    throw new Error("DOME_RELAYER_PRIVATE_KEY must be a 32-byte hex private key");
  }

  return {
    root,
    deployFile,
    deploy,
    port: Number(process.env.DOME_BACKEND_PORT || process.env.DOME_INDEXER_PORT || 8788),
    host: process.env.DOME_BACKEND_HOST || "127.0.0.1",
    rpcUpstream,
    poolAddress,
    chainId,
    deploymentBlock: Number(deploy.deploymentBlock || 0),
    relayerPrivateKey,
    relayerSecret: process.env.DOME_RELAYER_SECRET || "",
    localFaucetEnabled: process.env.DOME_DEV_FAUCET !== "false",
    databaseUrl,
    sqlitePath,
    rateLimitRpcPerMinute: Number(process.env.DOME_RATE_LIMIT_RPC_PER_MIN || 240),
    rateLimitRelayerPerMinute: Number(process.env.DOME_RATE_LIMIT_RELAYER_PER_MIN || 20),
    logQueryBatchSize: Number(process.env.DOME_LOG_BATCH_SIZE || 10),
  };
}

async function validateRuntimeConfig(config) {
  const provider = new ethers.providers.JsonRpcProvider(config.rpcUpstream);
  const network = await provider.getNetwork();
  const resolvedChainId = Number(network.chainId);

  if (config.chainId && config.chainId !== resolvedChainId) {
    throw new Error(
      `Chain id mismatch: deploy/config=${config.chainId}, rpc=${resolvedChainId}`,
    );
  }

  if (
    resolvedChainId !== 31337 &&
    config.relayerPrivateKey.toLowerCase() === HARDHAT_DEFAULT_KEY.toLowerCase()
  ) {
    throw new Error(
      "Refusing to start with the Hardhat default relayer key outside chain 31337",
    );
  }

  const code = await provider.getCode(config.poolAddress);
  if (!code || code === "0x") {
    throw new Error(`No contract bytecode at pool address ${config.poolAddress}`);
  }

  return {
    chainId: resolvedChainId,
    relayerAddress: new ethers.Wallet(config.relayerPrivateKey).address,
  };
}

module.exports = {
  buildConfig,
  validateRuntimeConfig,
};
