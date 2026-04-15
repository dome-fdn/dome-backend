const { ethers } = require("ethers");
const { json, readBody, readRawBody, text } = require("./http.cjs");

async function rpcCall(upstreamRpc, method, params = []) {
  const response = await fetch(upstreamRpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw new Error(payload.error?.message ?? `RPC ${method} failed with ${response.status}`);
  }
  return payload.result;
}

async function handleRpc(req, res, upstreamRpc) {
  if (req.method === "OPTIONS") {
    return text(res, 204, "", "text/plain");
  }
  if (req.method !== "POST") {
    return json(res, 405, { error: "method not allowed" });
  }

  const upstream = await fetch(upstreamRpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await readRawBody(req),
    cache: "no-store",
  });

  return text(res, upstream.status, await upstream.text(), upstream.headers.get("content-type") ?? "application/json");
}

async function handleDevFund(req, res, { upstreamRpc, enabled }) {
  if (req.method === "OPTIONS") {
    return text(res, 204, "", "text/plain");
  }
  if (req.method !== "POST") {
    return json(res, 405, { error: "method not allowed" });
  }
  if (!enabled) {
    return json(res, 403, { error: "Local faucet is disabled" });
  }

  try {
    const { address } = await readBody(req);
    if (!address || !ethers.utils.isAddress(address)) {
      return json(res, 400, { error: "Valid address is required" });
    }

    const chainIdHex = String(await rpcCall(upstreamRpc, "eth_chainId"));
    const chainId = Number.parseInt(chainIdHex, 16);
    if (chainId !== 31337) {
      return json(res, 400, { error: `Refusing to fund non-local chain ${chainId}` });
    }

    const balance = ethers.BigNumber.from(await rpcCall(upstreamRpc, "eth_getBalance", [address, "latest"]));
    const targetBalance = ethers.utils.parseEther("100");
    if (balance.gte(targetBalance)) {
      return json(res, 200, {
        funded: false,
        balance: ethers.utils.formatEther(balance),
      });
    }

    await rpcCall(upstreamRpc, "hardhat_setBalance", [address, targetBalance.toHexString()]);
    const nextBalance = ethers.BigNumber.from(await rpcCall(upstreamRpc, "eth_getBalance", [address, "latest"]));

    return json(res, 200, {
      funded: true,
      balance: ethers.utils.formatEther(nextBalance),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json(res, 500, { error: message });
  }
}

module.exports = {
  handleRpc,
  handleDevFund,
};
