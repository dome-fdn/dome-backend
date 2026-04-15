# @dome/backend

Standalone API for the Dome Shielded EVM stack:

- Indexer (Merkle paths, encrypted UTXO scan)
- Relayer (`POST /relayer/withdraw`)
- JSON-RPC proxy (`POST /rpc`)
- Dev faucet (`POST /dev/fund`, local chain only)

## Quick start

```bash
npm install
cp .env.example .env
npm start
```

For a full local stack (Hardhat + deploy + circuits), use the Dome monorepo dev scripts or run `@dome/core-evm` deploy + `@dome/web` separately.

## Configuration

See `.env.example` (local) and `.env.sepolia.example` (testnet).

Indexer state persists in SQLite (`.dome-local/backend.sqlite`) or Postgres (`DOME_DATABASE_URL`).

## Integration test

```bash
npm run test:integration
```

Runs deposit → indexer → withdraw against local Hardhat using `@dome/sdk-evm`.

## Docs

- Local stack: [Dome Foundation docs](https://github.com/Dome-Foundation/dome-core-evm) (see monorepo `docs/protocol/` when developing locally)
- Base Sepolia: configure via `.env.sepolia.example`
