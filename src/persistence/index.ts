// ============================================================================
// Ark — Persistence Layer Exports
// ============================================================================

import type { PersistenceConfig } from '../types.js';
import type { Store } from './types.js';
import { MemoryStore } from './memory.js';
import { SQLiteStore } from './sqlite.js';
import { SupabaseStore } from './supabase.js';

/** Create a store from config */
export function createStore(config: PersistenceConfig): Store {
  switch (config.adapter) {
    case 'sqlite':
      return new SQLiteStore(config.path || './data/agent.db');
    case 'supabase': {
      const url = resolveEnv(config.url || '');
      const key = resolveEnv(config.key || '');
      if (!url || !key) throw new Error('Supabase adapter requires url and key');
      return new SupabaseStore(url, key);
    }
    case 'memory':
      return new MemoryStore();
    default:
      throw new Error(`Unknown persistence adapter: ${config.adapter}`);
  }
}

/** Resolve ${ENV_VAR} references in a string */
function resolveEnv(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '');
}

export { MemoryStore } from './memory.js';
export { SQLiteStore } from './sqlite.js';
export { SupabaseStore } from './supabase.js';
export { SCHEMA_SQL, SCHEMA_POSTGRES } from './schema.js';
export { ScopedStore, PrivacyError, checkAccess, DEFAULT_PRIVACY } from './privacy.js';
export type { CallerRole } from './privacy.js';
export type {
  Store, SoulDirective, MindNode, LedgerEntry,
  SessionHandoff, ConversationTurn,
} from './types.js';
