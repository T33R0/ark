// ============================================================================
// Ark — Core Types
// ============================================================================

/** Agent configuration loaded from YAML */
export interface AgentConfig {
  name: string;
  version?: string;
  description?: string;

  identity: IdentityConfig;
  llm: LLMConfig;
  persistence: PersistenceConfig;
  tools?: ToolsConfig;
  boot?: BootConfig;
  behavior?: BehaviorConfig;
  interfaces?: InterfacesConfig;
}

// --- Identity ---

export interface IdentityConfig {
  soul?: string;
  soul_file?: string;
  user_file?: string;
  directives?: string[];
}

// --- LLM ---

export interface LLMConfig {
  provider: string;
  model: string;
  cascade?: CascadeEntry[];
  providers?: Record<string, ProviderConfig>;
}

export interface CascadeEntry {
  provider: string;
  model: string;
}

export interface ProviderConfig {
  api_key?: string;
  base_url?: string;
  [key: string]: unknown;
}

// --- Persistence ---

export interface PersistenceConfig {
  adapter: 'sqlite' | 'supabase' | 'memory';
  path?: string;
  url?: string;
  key?: string;
}

// --- Tools ---

export interface ToolsConfig {
  native?: string[];
  mcp?: MCPServerConfig[];
}

export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

// --- Boot ---

export interface BootConfig {
  load_soul?: boolean;
  load_state?: boolean;
  load_memory?: boolean;
  load_ledger?: boolean;
  load_handoff?: boolean;
  memory_limit?: number;
}

// --- Behavior ---

export interface BehaviorConfig {
  verify_actions?: boolean;
  log_mistakes?: boolean;
  session_handoff?: boolean;
  max_tool_rounds?: number;
}

// --- Interfaces ---

export interface InterfacesConfig {
  telegram?: TelegramInterfaceConfig;
}

export interface TelegramInterfaceConfig {
  token?: string;              // Bot token (or env: TELEGRAM_BOT_TOKEN)
  allowed_users?: number[];    // Whitelist of Telegram user IDs
  session_timeout?: number;    // Minutes before session reset (default: 1440 = 24h)
  batch_window?: number;       // Ms to wait for rapid messages (default: 1500)
}
