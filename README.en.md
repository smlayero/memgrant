<p align="center">
  <a href="./README.md">中文</a> · <b>English</b>
</p>

# cross-agent-memory

A self-hosted, user-held, end-to-end encrypted memory layer for multiple agents.
Each agent decrypts only what it has been granted. This repository does not run a hosted cloud.

npm workspace name: `memory-backbone` (`@memory-backbone/*`)

[VISION](VISION.md) · [SECURITY](SECURITY.md) · [Self-hosting](docs/self-host.md)

## Why this exists

You already talk to more than one agent. Coding, research, and editing often happen in several windows at once, while preferences, project facts, and corrections stay trapped inside a single product. Switch agents, and you start from zero.

Putting that material on someone else's servers means handing long-lived notes to a third party. The actual need is narrower: you hold the keys; judging and search stay on your device in plaintext; the sync node sees only ciphertext; each agent can decrypt only what you granted; after you revoke a grant, newly fetched ciphertext is unreadable to that agent.

This repo is a protocol component you run yourself. The mental model is tools like [age](https://github.com/FiloSottile/age)—user-held keys—not another memory-retrieval product. Memory follows your key, not a particular agent vendor.

## Guarantees

- The sync node (including your own Workers) sees ciphertext only
- An agent can decrypt only with its ECIES grant. Revoke = delete the grant = newly fetched ciphertext is unreadable
- Classification and search run locally. Plaintext does not leave the device

This does **not** promise secrecy from model vendors: any snippet injected into context is plaintext to the model. See [SECURITY.md](SECURITY.md).

## Architecture

```
packages/
├── sdk-core/      crypto, L0 rules, local cache, sync client, SPAKE2
├── cloud/         self-hosted Workers: ciphertext on R2, metadata on D1, sync DO
├── mcp-server/    save / search / delete
├── adapters/      Claude Code hooks
└── desktop/       local console bound to 127.0.0.1
```

```
BIP-39 mnemonic
  │ PBKDF2-SHA256(mnemonic, fixed_salt, 600k)
  ▼
MK (platform keychain, never leaves the device)
  │ AES-KW
  ▼
DEK (per-memory, AES-256-GCM)
  │ ECIES (secp256k1)
  ▼
one wrapped DEK per granted agent
```

## Quick start (local)

```bash
npm install
npm run build
npm test
node scripts/smoke.mjs

npm run dev:cloud          # wrangler dev → http://127.0.0.1:8787
```

Local D1 starts empty. Create tables on first run (or after deleting `.wrangler`):

```bash
cd packages/cloud
npx wrangler d1 execute memory-backbone --local --file=./schema.sql
cd ../..
npm run setup              # writes ~/.memory-backbone/config.json and registers the first device
```

MCP (Claude Code, Cursor, and others):

```json
{
  "mcpServers": {
    "memory-backbone": {
      "command": "node",
      "args": ["path/to/packages/mcp-server/dist/index.js"]
    }
  }
}
```

Desktop console: `npm run desktop` (binds only `127.0.0.1`).

Extra devices: run `node scripts/cli.mjs pair` on an existing device, then `node scripts/cli.mjs join <code>` on the new one.

Mnemonic recover: `node scripts/cli.mjs recover <user_id> "<mnemonic>"`.

Deploy to your own Cloudflare account: [docs/self-host.md](docs/self-host.md).

## Acceptance tests

| Gate | What it checks |
|------|------|
| S1 | Two devices, same mnemonic → same MK |
| S2 | ECIES success and failure paths |
| S3 | SPAKE2 RFC 9382 vectors + malicious relay fails |
| S4 | Agent decrypts only its grant |
| S5 | Revoke then grant is gone |
| S7 | Tag allowlist |
| R1/R2 | Offline read + outbox |

```bash
node scripts/e2e-selfhost.mjs    # write on A, read on B
node scripts/revoke-demo.mjs     # revoke → 404
```

## License

[Apache License 2.0](LICENSE)

## Known limits

SPAKE2 has not had a third-party protocol audit. If the platform keychain is unavailable, the implementation falls back to a file. Full list: [SECURITY.md](SECURITY.md).
