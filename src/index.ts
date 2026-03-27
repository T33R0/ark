// ============================================================================
// Ark — Main Exports
// ============================================================================

// Agent
export { Agent } from './agent.js';
export type { AgentOptions, TurnResult } from './agent.js';

// Config
export type {
  AgentConfig, IdentityConfig, LLMConfig, PersistenceConfig,
  ToolsConfig, BootConfig, BehaviorConfig, CascadeEntry,
  ProviderConfig, MCPServerConfig, InterfacesConfig,
  TelegramInterfaceConfig,
} from './types.js';

// LLM
export {
  AnthropicProvider, OpenAIProvider, GoogleProvider,
  CascadeRouter, createProvider,
} from './llm/index.js';
export type {
  LLMProvider, LLMResponse, LLMCallOptions, Message,
  ToolDefinition, ToolCall, StreamChunk, TokenUsage,
  ProviderOptions, JSONSchema,
} from './llm/index.js';

// Persistence
export {
  createStore, MemoryStore, SQLiteStore, SupabaseStore,
  SCHEMA_SQL, SCHEMA_POSTGRES,
} from './persistence/index.js';
export type {
  Store, SoulDirective, MindNode, LedgerEntry,
  SessionHandoff, ConversationTurn,
} from './persistence/index.js';

// Tools
export { ToolRegistry, getNativeTools, NATIVE_TOOLS } from './tools/index.js';
export type {
  ToolResult, RegisteredTool, ToolExecutor, IToolRegistry,
} from './tools/index.js';

// Identity
export { loadConfig, createConfig, bootAgent } from './identity/index.js';
export type { BootContext, AgentHooks } from './identity/index.js';

// Interfaces
export { TelegramAdapter, startTelegram, splitMessage } from './interfaces/telegram.js';
export type { TelegramAdapterOptions } from './interfaces/telegram.js';
