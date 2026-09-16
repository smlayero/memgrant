# MCP 客户端

每个客户端进程用环境变量 `MB_AGENT_ID` 选择身份。该 ID 必须出现在本机 `paired-agents.json`，并且 `~/.memory-backbone/agents/<id>.sk` 存在。写入仍在用户设备上用 MK 封密文；检索按这个 Agent 的掩码过滤。

配置与同步节点地址只来自 `~/.memory-backbone/config.json`（可用 `MB_HOME` 覆盖），不依赖 git 仓库路径。

先完成本机 `npm run init`（或已有 config），再写入客户端。通用安装：

```bash
npx @memgrant/adapters
```

会把 Cursor 写成 `npx @memgrant/mcp-server`（`MB_AGENT_ID=cursor`），并安装 Claude Code hooks。

## Cursor

`npx @memgrant/adapters` 已写入 `~/.cursor/mcp.json`。手工等价：

```json
{
  "mcpServers": {
    "memgrant": {
      "command": "npx",
      "args": ["-y", "@memgrant/mcp-server"],
      "env": { "MB_AGENT_ID": "cursor" }
    }
  }
}
```

Windows 下安装脚本会写成 `cmd /c npx -y @memgrant/mcp-server`。在管理台把 `cursor` 的掩码调到你允许的最高级别。

## Claude Code

Hooks：`npx @memgrant/adapters`（身份 `claude-code`）。  
若要用 MCP 而不是 hooks，把上面的 JSON 放进 Claude Code 的 MCP 配置，并把 `MB_AGENT_ID` 改成 `claude-code`。

## 任意 MCP 客户端（Windsurf、Codex、Gemini CLI 等）

同一条命令，只换身份：

1. 管理台添加 Agent ID（例如 `codex`、`gemini-cli`、`windsurf`），选掩码。
2. 客户端 MCP 配置：

```json
{
  "command": "npx",
  "args": ["-y", "@memgrant/mcp-server"],
  "env": { "MB_AGENT_ID": "codex" }
}
```

把 `codex` 换成该客户端的 ID。Gemini CLI / Codex 若用 `mcp.json` 或 `settings.json` 的 `mcpServers`，字段名与 Cursor 相同。不要为每个产品写专用适配器；身份就是 `MB_AGENT_ID`。

## 核对

- 两个客户端用不同 `MB_AGENT_ID` 时，掩码低的不应看到更高级别记忆。
- 撤销后，新从同步节点拉取的密文对该 Agent 不可解；本机已经缓存的明文仍可能被搜到。
