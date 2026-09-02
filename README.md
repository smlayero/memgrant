<p align="center">
  <a href="./README.zh-CN.md">中文</a> · <b>English</b>
</p>

# memgrant

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

Desktop console: `npm run desktop` (binds only `127.0.0.1`). Use **Pull from cloud** to apply ciphertext from your sync node onto this device.

Extra devices: **preferred** — `node scripts/cli.mjs recover <user_id> "<mnemonic>"` on the new machine.

Pairing codes (`pair` / `join`) are a convenience. SPAKE2 has not had a third-party protocol audit.

Deploy to your own Cloudflare account: [docs/self-host.md](docs/self-host.md) or `npm run deploy:cf`.

One-shot client install (Cursor MCP + Claude Code hooks):

```bash
npm run build
npm run clients
```

Then reload MCP in Cursor.

## Optional local model for judging

Default judging is local regex rules (L0). You can optionally point at a **local** OpenAI-compatible endpoint (Ollama, LM Studio, llama.cpp) to decide what is worth storing and at what sensitivity. The mnemonic still derives the master key and **cannot** be replaced by a model.

Default judging is local regex rules (L0). You can optionally point at a **local** OpenAI-compatible endpoint (Ollama, LM Studio, llama.cpp) to decide what is worth storing and at what sensitivity. The mnemonic still derives the master key and **cannot** be replaced by a model.

Add to `~/.memory-backbone/config.json`:

```json
"judge": {
  "l1": {
    "baseUrl": "http://127.0.0.1:11434/v1",
    "model": "qwen2.5:7b"
  }
}
```

L0 always runs first as a safety floor: credentials stay level 4 even if the model says otherwise. If the model is down or slow, judging falls back to L0. No model is required to use this repo.

The local model process sees the plaintext being classified. The sync node still sees ciphertext only. Pointing `baseUrl` at a remote API sends that plaintext off-device—don't do that unless you accept that.

Optional local embeddings (same `/v1` style) for hybrid search:

```json
"embedder": {
  "l1": {
    "baseUrl": "http://127.0.0.1:11434/v1",
    "model": "nomic-embed-text"
  }
}
```

Without this, search still works: keyword match plus a local hash embedder (not a semantic model).

HTTP APIs prefer **MB1** device signatures (`POST /api/auth/challenge` then signed headers). `device_token` remains for WebSocket and older clients.

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

## npm packages

After `npm login`, publish from the monorepo (cloud stays private / self-hosted):

```bash
npm publish -w @memory-backbone/sdk-core --access public
npm publish -w @memory-backbone/mcp-server --access public
npm publish -w @memory-backbone/adapters --access public
npm publish -w @memory-backbone/desktop --access public
```

## License

[Apache License 2.0](LICENSE)

## Known limits

SPAKE2 has not had a third-party protocol audit. If the platform keychain is unavailable, the implementation falls back to a file. Full list: [SECURITY.md](SECURITY.md).
