# Ark

**Model-agnostic portable agent runtime.** Define AI agents in YAML. Connect to any LLM. Give them persistence, tools, and a self-correcting learning loop.

<!-- badges -->
<!-- [![npm](https://img.shields.io/npm/v/ark-agent)](https://npmjs.com/package/ark-agent) -->
<!-- [![license](https://img.shields.io/github/license/OWNER/ark)](LICENSE) -->

---

## What is Ark

Ark is a runtime for building AI agents that aren't locked to a single provider. Define your agent's identity, tools, and behavior in a YAML file, then run it against Anthropic, OpenAI, Google, Ollama, or any OpenAI-compatible endpoint. Agents persist their knowledge, track their own mistakes, and self-correct over time using a built-in learning loop (soul, mind, ledger). Zero vendor lock-in — swap providers by changing one line.

## Status

**v0.1.0** — early release, actively developed. Expect breaking changes.

| Feature | Status |
|---------|--------|
| SQLite persistence | Stable |
| Supabase persistence | Experimental |
| Streaming | Works with Anthropic and OpenAI-compatible providers |
| MCP tool integration | Config schema exists, client not yet implemented |

## Quick Start

**Prerequisites:** [Node.js](https://nodejs.org/) >= 20 and [Ollama](https://ollama.com/) installed.

```bash
# 1. Pull a model (one-time)
ollama pull qwen3:14b

# 2. Clone and install
git clone https://github.com/OWNER/ark.git
cd ark
npm install
npm run build

# 3. Run — you now have an AI agent with a learning loop
ark -p ollama -m qwen3:14b
```

That's it. No API keys, no cloud accounts. You're talking to a local agent that persists its knowledge in SQLite.

Want to use a cloud provider instead?

```bash
# Anthropic
export ANTHROPIC_API_KEY=sk-ant-...
ark -p anthropic -m claude-sonnet-4-5-20250514

# Or use a YAML config for full control
ark agents/example.yaml
```

During development, use `npm run dev` instead of `ark` to skip the build step:

```bash
npm run dev -- agents/example.yaml
npm run dev -- -p ollama -m llama3:8b
```

## Architecture

```
┌──────────────────────────────────────────────────┐
│                    CLI / REPL                     │
├──────────────────────────────────────────────────┤
│                   Agent Loop                      │
│         (multi-turn, tool execution,              │
│          verification, handoff)                   │
├───────────┬──────────────┬───────────────────────┤
│  Identity │  LLM Router  │     Tool Registry     │
│  (soul,   │  (cascade,   │  (native + MCP)       │
│   boot,   │   failover)  │                       │
│   state)  │              │                       │
├───────────┼──────────────┼───────────────────────┤
│           │   Providers  │                       │
│           │  ┌─────────┐ │  file_read  shell     │
│  Ledger   │  │Anthropic│ │  file_write glob      │
│  Mind     │  │ OpenAI  │ │  file_edit  grep      │
│  Soul     │  │ Google  │ │  http_fetch           │
│  Handoff  │  │ Ollama  │ │                       │
│           │  │ Custom  │ │                       │
│           │  └─────────┘ │                       │
├───────────┴──────────────┴───────────────────────┤
│               Persistence Layer                   │
│         SQLite  |  Supabase  |  Memory            │
└──────────────────────────────────────────────────┘
```

## Configuration

Full YAML reference with every field:

```yaml
# Agent metadata
name: my-agent                    # Required. Agent name.
version: "1.0"                    # Optional. Semantic version.
description: "What this agent does" # Optional.

# Identity — who the agent is
identity:
  soul: |                         # Inline personality/instructions
    You are a helpful assistant.
    Be direct and concise.
  soul_file: ./soul.md            # Or load from a file (overrides soul)
  user_file: ./user.md            # Optional user context file
  directives:                     # Additional behavioral rules
    - "Always verify before reporting"
    - "Log mistakes immediately"

# LLM — which model to talk to
llm:
  provider: anthropic             # Primary provider
  model: claude-sonnet-4-5-20250514     # Primary model
  cascade:                        # Optional failover chain
    - provider: anthropic
      model: claude-sonnet-4-5-20250514
    - provider: ollama
      model: qwen3:14b
  providers:                      # Provider-specific config
    anthropic:
      api_key: ${ANTHROPIC_API_KEY} # Or set env var directly
    openai:
      api_key: ${OPENAI_API_KEY}
    ollama:
      base_url: http://localhost:11434/v1
    google:
      api_key: ${GOOGLE_API_KEY}

# Persistence — where the agent stores state
persistence:
  adapter: sqlite                 # sqlite | supabase | memory
  path: ./data/agent.db           # For sqlite: path to DB file
  # url: https://xxx.supabase.co  # For supabase: project URL
  # key: your-service-key         # For supabase: service role key

# Tools — what the agent can do
tools:
  native:                         # Built-in tools (see table below)
    - file_read
    - file_write
    - file_edit
    - shell
    - glob
    - grep
    - http_fetch
  mcp:                            # MCP server connections
    - name: my-server
      command: npx
      args: ["-y", "my-mcp-server"]
      env:
        API_KEY: ${MY_KEY}

# Boot — what to load on startup
boot:
  load_soul: true                 # Load soul directives from store
  load_state: true                # Load persistent state
  load_memory: true               # Load mind/knowledge graph
  load_ledger: true               # Load wins and mistakes
  load_handoff: true              # Load session handoff from last run
  memory_limit: 10                # Max memory entries to load

# Behavior — runtime controls
behavior:
  verify_actions: true            # Verify tool results before continuing
  log_mistakes: true              # Auto-log mistakes to ledger
  session_handoff: true           # Write handoff on session end
  max_tool_rounds: 5              # Max tool-use rounds per turn
```

## Providers

| Provider | Name | Model Examples | Streaming | Auth |
|----------|------|----------------|-----------|------|
| Anthropic | `anthropic` | `claude-sonnet-4-5-20250514`, `claude-haiku-3-5-20241022` | Yes | `ANTHROPIC_API_KEY` |
| OpenAI | `openai` | `gpt-4o`, `gpt-4o-mini` | Yes | `OPENAI_API_KEY` |
| Google | `google` or `gemini` | `gemini-2.0-flash`, `gemini-2.5-pro` | Yes | `GOOGLE_API_KEY` |
| Ollama | `ollama` | `qwen3:14b`, `llama3:8b`, `mistral` | Yes | None (local) |
| Custom | Any string | Depends on endpoint | Yes | Via `providers.<name>.api_key` |

Any unrecognized provider name is treated as OpenAI-compatible. Set `base_url` and `api_key` under `providers.<name>` to point at any endpoint.

**Cascade failover:** List multiple providers under `llm.cascade`. If the first fails, Ark tries the next. Useful for "try cloud, fall back to local."

## Persistence

Ark agents persist their identity, knowledge, and conversation history across sessions.

| Adapter | Config | Best For |
|---------|--------|----------|
| **SQLite** | `adapter: sqlite`, `path: ./data/agent.db` | Default. Local agents. Zero setup. |
| **Supabase** | `adapter: supabase`, `url: ...`, `key: ...` | Cloud agents. Multi-device sync. Shared state. |
| **Memory** | `adapter: memory` | Testing. Ephemeral. Nothing survives restart. |

What gets persisted:
- **Soul** — behavioral directives (who the agent is)
- **Mind** — knowledge graph nodes with signal, depth, and heat scores
- **Ledger** — wins and mistakes with timestamps
- **State** — key-value pairs for arbitrary persistent data
- **Conversation** — full turn history per session
- **Handoff** — session summary for continuity across restarts

SQLite is the default. The database file is created automatically on first run.

## Tools

| Tool | Description |
|------|-------------|
| `file_read` | Read a file with optional offset/limit. Returns content with line numbers. |
| `file_write` | Write content to a file. Creates directories. Uses atomic write. |
| `file_edit` | Find-and-replace in a file. Supports `replace_all`. |
| `shell` | Execute a shell command. 120-second timeout. |
| `glob` | Find files matching a glob pattern. Returns paths sorted by modification time. |
| `grep` | Search file contents with regex. Uses ripgrep when available. |
| `http_fetch` | Fetch a URL. Supports GET/POST/PUT/DELETE/PATCH with headers and body. |

Tools are opt-in. List only the ones your agent needs in `tools.native`.

## Security

Ark gives agents real capabilities. Treat configuration with the same care you'd give any tool with shell access.

- **Shell access.** The `shell` tool gives the LLM full shell access as the running user. This is powerful but dangerous with untrusted models. Tools are opt-in per config — omit `shell` for safer agents (see `agents/coach.yaml` for a zero-tools example).
- **Secrets.** Never put real API keys in YAML files. Use `${ENV_VAR}` references and `.env` files.
- **Remote persistence.** The Supabase adapter sends queries to a remote database. Ensure your RLS policies are configured correctly.
- **File access.** Agents can read and write files. Scope the working directory carefully and only grant the file tools your agent actually needs.

## Programmatic API

Use Ark as a library instead of the CLI:

```typescript
import { Agent } from 'ark-agent';

const agent = new Agent({
  config: {
    name: 'my-agent',
    identity: { soul: 'You are a concise assistant.' },
    llm: { provider: 'ollama', model: 'qwen3:14b' },
    persistence: { adapter: 'memory' },
    tools: { native: ['shell', 'file_read'] },
  },
});

await agent.boot();

const result = await agent.send('What files are in the current directory?');
console.log(result.text);
console.log(`Tools used: ${result.tool_calls_made.length}`);
console.log(`Session: ${result.session_id}`);
```

The `Agent` class exposes:
- `boot()` — Initialize provider, store, tools, and run boot sequence. Called automatically on first `send()` if not called explicitly.
- `send(input)` — Send a message, run the full tool loop, return a `TurnResult` with text, tool calls, and token usage.
- `config` — The resolved `AgentConfig` (read-only).
- `sessionId` — Unique ID for this agent instance.

You can also load config from a YAML file:

```typescript
const agent = new Agent({ configPath: './agents/example.yaml' });
```

## Creating Your First Agent

1. Create a YAML file:

```yaml
# agents/researcher.yaml
name: researcher
description: "An agent that can search the web and read files"

identity:
  soul: |
    You are a research assistant. When asked a question:
    1. Search for relevant files or fetch web resources
    2. Read and analyze the content
    3. Provide a clear, sourced answer

llm:
  provider: ollama
  model: qwen3:14b

persistence:
  adapter: sqlite
  path: ./data/researcher.db

tools:
  native:
    - file_read
    - glob
    - grep
    - http_fetch

boot:
  load_soul: true
  load_memory: true
  load_ledger: true

behavior:
  verify_actions: true
  log_mistakes: true
  max_tool_rounds: 5
```

2. Run it:

```bash
ark agents/researcher.yaml
```

3. The agent boots, loads any prior state from SQLite, and drops into an interactive REPL. It remembers context across turns and persists knowledge across sessions.

## Self-Correction

Ark agents learn from their own behavior through three interconnected systems:

**Soul** — Behavioral directives stored in persistence. These are rules the agent follows ("always verify file writes", "never delete without confirmation"). They load on boot and shape every response. You can seed them in the YAML `identity.directives` or let the agent write them as it learns.

**Mind** — A knowledge graph. Nodes have content, signal strength, depth, and heat (recency). When the agent learns something, it writes a mind node. On boot, the highest-value nodes load into context. This is adaptive long-term memory — not a chat log.

**Ledger** — A log of wins (things that worked) and mistakes (things that didn't). Each entry has a pattern name and description. When `behavior.log_mistakes` is true, the agent tracks its own errors. Recurring mistake patterns can promote to soul directives, closing the loop.

The flow: **make a mistake -> log it to ledger -> notice the pattern -> write a soul directive -> never make it again.** This is self-correction without fine-tuning.

**Session Handoff** — When `behavior.session_handoff` is true, the agent writes a summary of active work, decisions, and open questions before shutting down. The next session loads this on boot, maintaining continuity across restarts.

## Testing

```bash
# Run all 109 unit tests
npm test

# Run E2E tests (requires Ollama running locally)
npx tsx tests/e2e-ollama.ts
```

Unit tests cover the agent lifecycle, LLM provider abstraction, persistence adapters, tool execution, and identity/boot system. E2E tests run 8 scenarios against a real LLM — conversation, tool use, multi-turn context, and persistence across instances.

Requires Node.js >= 20.

## Contributing

Contributions welcome — issues, PRs, and feedback all appreciated. If you find a bug or have an idea, open an issue. If you build something cool with Ark, we'd love to hear about it.

## License

[Ark Source Available License](LICENSE) — free for personal use, learning, research, and non-commercial projects. Commercial redistribution of Ark itself requires permission. See [LICENSE](LICENSE) for details.
