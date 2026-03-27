// ============================================================================
// Ark — Agent Runtime
// ============================================================================

import { randomUUID } from 'node:crypto';
import type { AgentConfig } from './types.js';
import type { LLMProvider, Message, ToolCall, StreamChunk, TokenUsage, LLMCallOptions } from './llm/types.js';
import type { Store } from './persistence/types.js';
import type { BootContext, AgentHooks } from './identity/types.js';
import type { IToolRegistry, ToolResult } from './tools/types.js';
import { CascadeRouter, createProvider } from './llm/router.js';
import { createStore } from './persistence/index.js';
import { ToolRegistry, getNativeTools } from './tools/index.js';
import { connectMCPServers, disconnectMCPClients, type MCPClient } from './tools/mcp/index.js';
import { loadConfig, createConfig } from './identity/loader.js';
import { bootAgent } from './identity/boot.js';

export interface AgentOptions {
  config?: AgentConfig;
  configPath?: string;
  hooks?: AgentHooks;
}

export interface TurnResult {
  text: string;
  tool_calls_made: Array<{ name: string; args: Record<string, unknown>; result: string; is_error: boolean }>;
  usage: TokenUsage[];
  session_id: string;
}

export class Agent {
  readonly config: AgentConfig;
  readonly sessionId: string;

  private provider!: LLMProvider;
  private store!: Store;
  private tools!: IToolRegistry;
  private bootContext!: BootContext;
  private messages: Message[] = [];
  private hooks: AgentHooks;
  private booted = false;
  private totalUsage: TokenUsage[] = [];
  private mcpClients: MCPClient[] = [];

  constructor(options: AgentOptions) {
    if (options.configPath) {
      this.config = loadConfig(options.configPath);
    } else if (options.config) {
      this.config = options.config;
    } else {
      this.config = createConfig();
    }

    this.sessionId = randomUUID();
    this.hooks = options.hooks || {};
  }

  /** Initialize the agent: set up provider, store, tools, and run boot sequence */
  async boot(): Promise<BootContext> {
    // 1. Create LLM provider
    if (this.config.llm.cascade?.length) {
      this.provider = new CascadeRouter(
        this.config.llm.cascade,
        this.config.llm.providers || {},
      );
    } else {
      const providerConfig = this.config.llm.providers?.[this.config.llm.provider] || {};
      this.provider = createProvider(
        this.config.llm.provider,
        providerConfig,
        this.config.llm.model,
      );
    }

    // 2. Create persistence store
    this.store = createStore(this.config.persistence);
    await this.store.init();

    // 3. Register tools
    this.tools = new ToolRegistry();
    const nativeToolNames = this.config.tools?.native;
    const nativeTools = getNativeTools(nativeToolNames);
    for (const tool of nativeTools) {
      (this.tools as ToolRegistry).register(tool);
    }

    // 3b. Connect MCP servers
    if (this.config.tools?.mcp?.length) {
      const { tools: mcpTools, clients } = await connectMCPServers(this.config.tools.mcp);
      this.mcpClients = clients;
      for (const tool of mcpTools) {
        (this.tools as ToolRegistry).register(tool);
      }
    }

    // 4. Run boot sequence
    this.bootContext = await bootAgent(this.config, this.store);

    // 5. Fire hook
    if (this.hooks.onBoot) {
      await this.hooks.onBoot(this.bootContext);
    }

    this.booted = true;
    return this.bootContext;
  }

  /** Send a message and get a complete response (with tool loop) */
  async send(input: string): Promise<TurnResult> {
    if (!this.booted) await this.boot();

    // Add user message
    this.messages.push({ role: 'user', content: input });
    await this.persistTurn('user', input);

    const toolCallsMade: TurnResult['tool_calls_made'] = [];
    const maxRounds = this.config.behavior?.max_tool_rounds || 10;
    let finalText = '';

    for (let round = 0; round < maxRounds; round++) {
      const callOptions: LLMCallOptions = {
        model: this.config.llm.model,
        system: this.bootContext.system_prompt,
        tools: this.tools.getDefinitions(),
        max_tokens: 4096,
      };

      const response = await this.provider.chat(this.messages, callOptions);
      this.totalUsage.push(response.usage);

      if (response.tool_calls.length > 0) {
        // Add assistant message with tool calls
        this.messages.push({
          role: 'assistant',
          content: response.text,
          tool_calls: response.tool_calls,
        });

        // Execute each tool call
        for (const tc of response.tool_calls) {
          if (this.hooks.onToolCall) {
            await this.hooks.onToolCall(tc.name, tc.arguments);
          }

          const result = await this.tools.execute(tc.name, tc.arguments);

          if (this.hooks.onToolResult) {
            await this.hooks.onToolResult(tc.name, result.content, result.is_error);
          }

          toolCallsMade.push({
            name: tc.name,
            args: tc.arguments,
            result: result.content,
            is_error: result.is_error,
          });

          // Add tool result message
          this.messages.push({
            role: 'tool',
            content: result.content,
            tool_call_id: tc.id,
            name: tc.name,
          });
        }

        // Continue loop — LLM needs to process tool results
        continue;
      }

      // No tool calls — this is the final response
      finalText = response.text;
      this.messages.push({ role: 'assistant', content: finalText });
      await this.persistTurn('assistant', finalText);

      if (this.hooks.onResponse) {
        await this.hooks.onResponse(finalText);
      }

      break;
    }

    return {
      text: finalText,
      tool_calls_made: toolCallsMade,
      usage: this.totalUsage.slice(-1),
      session_id: this.sessionId,
    };
  }

  /** Stream a response (yields chunks as they arrive) */
  async *stream(input: string): AsyncIterable<StreamChunk & { tool_result?: ToolResult }> {
    if (!this.booted) await this.boot();

    this.messages.push({ role: 'user', content: input });
    await this.persistTurn('user', input);

    const maxRounds = this.config.behavior?.max_tool_rounds || 10;

    for (let round = 0; round < maxRounds; round++) {
      const callOptions: LLMCallOptions = {
        model: this.config.llm.model,
        system: this.bootContext.system_prompt,
        tools: this.tools.getDefinitions(),
        max_tokens: 4096,
      };

      if (!this.provider.stream) {
        // Fallback: non-streaming provider
        const response = await this.provider.chat(this.messages, callOptions);
        if (response.text) yield { type: 'text', text: response.text };

        if (response.tool_calls.length > 0) {
          this.messages.push({
            role: 'assistant',
            content: response.text,
            tool_calls: response.tool_calls,
          });

          for (const tc of response.tool_calls) {
            yield { type: 'tool_call_end', tool_call: tc };
            const result = await this.tools.execute(tc.name, tc.arguments);
            yield { type: 'text', text: '', tool_result: result };
            this.messages.push({
              role: 'tool',
              content: result.content,
              tool_call_id: tc.id,
              name: tc.name,
            });
          }
          continue;
        }

        this.messages.push({ role: 'assistant', content: response.text });
        yield { type: 'usage', usage: response.usage };
        yield { type: 'done' };
        return;
      }

      // Streaming path
      let accumulatedText = '';
      const completedToolCalls: ToolCall[] = [];
      let hasToolCalls = false;

      for await (const chunk of this.provider.stream(this.messages, callOptions)) {
        if (chunk.type === 'text') {
          accumulatedText += chunk.text || '';
          yield chunk;
        } else if (chunk.type === 'tool_call_start') {
          hasToolCalls = true;
          yield chunk;
        } else if (chunk.type === 'tool_call_end' && chunk.tool_call) {
          completedToolCalls.push(chunk.tool_call as ToolCall);
          yield chunk;
        } else if (chunk.type === 'usage') {
          this.totalUsage.push(chunk.usage!);
          yield chunk;
        } else if (chunk.type === 'done') {
          // Don't yield done yet if we have tool calls to process
          if (!hasToolCalls) {
            this.messages.push({ role: 'assistant', content: accumulatedText });
            await this.persistTurn('assistant', accumulatedText);
            yield chunk;
            return;
          }
        }
      }

      // Process tool calls
      if (completedToolCalls.length > 0) {
        this.messages.push({
          role: 'assistant',
          content: accumulatedText,
          tool_calls: completedToolCalls,
        });

        for (const tc of completedToolCalls) {
          if (this.hooks.onToolCall) {
            await this.hooks.onToolCall(tc.name, tc.arguments);
          }

          const result = await this.tools.execute(tc.name, tc.arguments);

          if (this.hooks.onToolResult) {
            await this.hooks.onToolResult(tc.name, result.content, result.is_error);
          }

          yield { type: 'text', text: '', tool_result: result };

          this.messages.push({
            role: 'tool',
            content: result.content,
            tool_call_id: tc.id,
            name: tc.name,
          });
        }
        // Continue loop for next response
        continue;
      }

      // No tool calls — final response
      this.messages.push({ role: 'assistant', content: accumulatedText });
      await this.persistTurn('assistant', accumulatedText);
      yield { type: 'done' };
      return;
    }
  }

  /** Write a session handoff */
  async writeHandoff(context?: {
    active_work?: string;
    key_decisions?: string;
    open_questions?: string;
    next_actions?: string;
  }): Promise<void> {
    if (!this.store) return;

    await this.store.writeHandoff({
      active_work: context?.active_work || 'Session ended normally',
      key_decisions: context?.key_decisions,
      open_questions: context?.open_questions,
      next_actions: context?.next_actions,
      context_for_next: `Session ${this.sessionId} — ${this.messages.length} messages, ${this.totalUsage.length} LLM calls`,
    });
  }

  /** Log a learning entry (win or mistake) */
  async logLedger(entry: {
    type: 'win' | 'mistake';
    what: string;
    why?: string;
    should_have?: string;
    pattern?: string;
    severity?: string;
  }): Promise<void> {
    if (!this.store) return;

    await this.store.addLedgerEntry({
      entry_type: entry.type,
      what: entry.what,
      why: entry.why,
      should_have: entry.should_have,
      pattern: entry.pattern,
      severity: entry.severity,
    });
  }

  /** Store knowledge in the mind */
  async remember(content: string, options?: {
    node_type?: 'fact' | 'insight' | 'decision' | 'principle';
    domain?: string;
    tags?: string[];
  }): Promise<string> {
    if (!this.store) return '';

    return this.store.addMindNode({
      content,
      node_type: options?.node_type || 'fact',
      domain: options?.domain,
      signal: 0.5,
      heat: 1.0,
      depth: 1,
      tags: options?.tags || [],
    });
  }

  /** Get the persistence store (for direct access) */
  getStore(): Store {
    return this.store;
  }

  /** Get the tool registry */
  getTools(): IToolRegistry {
    return this.tools;
  }

  /** Get the LLM provider */
  getProvider(): LLMProvider {
    return this.provider;
  }

  /** Get the boot context */
  getBootContext(): BootContext {
    return this.bootContext;
  }

  /** Get usage stats */
  getUsage(): TokenUsage[] {
    return [...this.totalUsage];
  }

  /** Get conversation history */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /** Shutdown the agent gracefully */
  async shutdown(): Promise<void> {
    if (this.config.behavior?.session_handoff && this.store) {
      await this.writeHandoff();
    }

    // Disconnect MCP servers
    if (this.mcpClients.length) {
      await disconnectMCPClients(this.mcpClients);
      this.mcpClients = [];
    }

    if (this.hooks.onShutdown) {
      await this.hooks.onShutdown();
    }

    if (this.store) {
      await this.store.close();
    }
  }

  // --- Private ---

  private async persistTurn(role: string, content: string): Promise<void> {
    try {
      await this.store.addConversationTurn({
        session_id: this.sessionId,
        role: role as 'user' | 'assistant',
        content,
      });
    } catch {
      // Don't fail the conversation if persistence fails
    }
  }
}
