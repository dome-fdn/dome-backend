import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const deployFile = resolve(root, ".dome-local/base-deploy.json");
const deploy = JSON.parse(readFileSync(deployFile, "utf8"));
const backendUrl = process.env.DOME_BACKEND_URL || "http://127.0.0.1:8788";
const rpcUrl = deploy.rpcUrl || "http://127.0.0.1:8545";
const circuitBase = resolve(root, "dome-sdk-evm/circuits/transaction");

process.env.DOME_EVM_INDEXER_URL = backendUrl;
process.env.DOME_ETH_POOL_ADDRESS = deploy.ethPoolAddress;
process.env.DOME_FEE_RECIPIENT_ADDRESS =
  deploy.feeRecipientAddress || "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
process.env.DOME_BASE_RPC = rpcUrl;

const { ethers } = await import("ethers");
const { deposit, withdraw, getBalance, clearCache, DOME_SIGN_IN_MESSAGE } = await import(
  "../../dome-sdk-evm/dist/index.js"
);

const HARDHAT_ACCOUNT_1 =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b4b38777d";

async function assertHealth() {
  const response = await fetch(`${backendUrl}/health`);
  const health = await response.json();
  if (!response.ok || !health.ok) {
    throw new Error(`Backend unhealthy: ${JSON.stringify(health)}`);
  }
}

async function main() {
  if (!existsSync(`${circuitBase}2.wasm`) || !existsSync(`${circuitBase}2.zkey`)) {
    throw new Error(`Missing circuit artifacts at ${circuitBase}2.{wasm,zkey}`);
  }

  await assertHealth();

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl, {
    name: "hardhat",
    chainId: Number(deploy.chainId || 31337),
  });
  const signer = new ethers.Wallet(HARDHAT_ACCOUNT_1, provider);
  const address = await signer.getAddress();
  const signature = await signer.signMessage(DOME_SIGN_IN_MESSAGE);

  const txSender = async (unsignedTx) => {
    const tx = await signer.sendTransaction(unsignedTx);
    await tx.wait();
    return tx.hash;
  };

  console.log("Funding test account via /dev/fund");
  const fundRes = await fetch(`${backendUrl}/dev/fund`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  });
  if (!fundRes.ok) {
    throw new Error(`Faucet failed: ${await fundRes.text()}`);
  }

  await clearCache(address);
  console.log("Cleared SDK UTXO cache for test account");

  console.log("Depositing 0.001 ETH");
  await deposit({
    depositAmountInput: 0.001,
    keyBasePath: circuitBase,
    signature,
    address,
    txSender,
  });

  console.log("Checking shielded balance");
  const balance = await getBalance({ signature, address });
  if (Number(balance.balance) <= 0) {
    throw new Error(`Expected positive shielded balance, got ${balance.balance}`);
  }
  console.log(`Shielded balance: ${balance.balance} ETH`);

  console.log("Withdrawing 0.0006 ETH via relayer");
  const txHash = await withdraw({
    withdrawAmountInput: 0.0006,
    recipient: address,
    keyBasePath: circuitBase,
    signature,
    address,
  });

  console.log(`Withdraw succeeded: ${txHash}`);
  console.log("Integration test passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
