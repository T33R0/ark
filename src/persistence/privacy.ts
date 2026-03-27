// ============================================================================
// Ark — Privacy & Multi-Agent Isolation
// ============================================================================

import type {
  Store, SoulDirective, MindNode, LedgerEntry,
  SessionHandoff, ConversationTurn,
} from './types.js';
import type { PrivacyConfig, Visibility } from '../types.js';

/** Access level for a caller */
export type CallerRole = 'owner' | 'admin' | 'other';

/** Resource types that can have visibility settings */
export type PrivacyResource = 'conversations' | 'mind' | 'soul' | 'state' | 'ledger' | 'handoff';

/**
 * ScopedStore wraps any Store and adds agent-name isolation.
 *
 * For SQLite (file-per-agent), isolation is inherent — ScopedStore passes through.
 * For shared backends (Supabase), the underlying store must support agent_name filtering.
 *
 * Privacy rules control cross-agent data access:
 * - "owner" — only the owning agent/user can access
 * - "admin" — owner + system admin can access
 * - "public" — any agent in the system can access
 */
export class ScopedStore implements Store {
  readonly agentName: string;
  private inner: Store;
  private privacy: PrivacyConfig;
  private callerRole: CallerRole;

  constructor(
    inner: Store,
    agentName: string,
    privacy: PrivacyConfig,
    callerRole: CallerRole = 'owner',
  ) {
    this.inner = inner;
    this.agentName = agentName;
    this.privacy = privacy;
    this.callerRole = callerRole;
  }

  /** Check if the current caller can access a resource type */
  canAccess(resource: PrivacyResource): boolean {
    const visibility = this.privacy.visibility?.[resource] || 'owner';
    return checkAccess(this.callerRole, visibility);
  }

  /** Create a view of this store for a different caller role */
  asRole(role: CallerRole): ScopedStore {
    return new ScopedStore(this.inner, this.agentName, this.privacy, role);
  }

  // --- Delegated Store methods with privacy checks ---

  async init(): Promise<void> {
    return this.inner.init();
  }

  async close(): Promise<void> {
    return this.inner.close();
  }

  // --- Soul ---
  async getSoul(): Promise<SoulDirective[]> {
    this.assertAccess('soul');
    return this.inner.getSoul();
  }

  async addSoulDirective(directive: Omit<SoulDirective, 'id' | 'created_at'>): Promise<string> {
    this.assertAccess('soul');
    return this.inner.addSoulDirective(directive);
  }

  async updateSoulDirective(id: string, updates: Partial<SoulDirective>): Promise<void> {
    this.assertAccess('soul');
    return this.inner.updateSoulDirective(id, updates);
  }

  // --- Mind ---
  async getMind(limit?: number): Promise<MindNode[]> {
    this.assertAccess('mind');
    return this.inner.getMind(limit);
  }

  async addMindNode(node: Omit<MindNode, 'id' | 'created_at' | 'updated_at'>): Promise<string> {
    this.assertAccess('mind');
    return this.inner.addMindNode(node);
  }

  async updateMindNode(id: string, updates: Partial<MindNode>): Promise<void> {
    this.assertAccess('mind');
    return this.inner.updateMindNode(id, updates);
  }

  async searchMind(query: string, limit?: number): Promise<MindNode[]> {
    this.assertAccess('mind');
    return this.inner.searchMind(query, limit);
  }

  // --- Ledger ---
  async getLedger(limit?: number): Promise<LedgerEntry[]> {
    this.assertAccess('ledger');
    return this.inner.getLedger(limit);
  }

  async addLedgerEntry(entry: Omit<LedgerEntry, 'id' | 'created_at'>): Promise<string> {
    this.assertAccess('ledger');
    return this.inner.addLedgerEntry(entry);
  }

  async countPattern(pattern: string): Promise<number> {
    this.assertAccess('ledger');
    return this.inner.countPattern(pattern);
  }

  // --- State ---
  async getState(key: string): Promise<unknown | null> {
    this.assertAccess('state');
    return this.inner.getState(key);
  }

  async getAllState(): Promise<Record<string, unknown>> {
    this.assertAccess('state');
    return this.inner.getAllState();
  }

  async setState(key: string, value: unknown): Promise<void> {
    this.assertAccess('state');
    return this.inner.setState(key, value);
  }

  // --- Handoff ---
  async getLatestHandoff(): Promise<SessionHandoff | null> {
    this.assertAccess('handoff');
    return this.inner.getLatestHandoff();
  }

  async writeHandoff(handoff: Omit<SessionHandoff, 'id' | 'created_at'>): Promise<string> {
    this.assertAccess('handoff');
    return this.inner.writeHandoff(handoff);
  }

  // --- Conversations ---
  async getConversation(session_id: string): Promise<ConversationTurn[]> {
    this.assertAccess('conversations');
    return this.inner.getConversation(session_id);
  }

  async addConversationTurn(turn: Omit<ConversationTurn, 'id' | 'created_at'>): Promise<string> {
    this.assertAccess('conversations');
    return this.inner.addConversationTurn(turn);
  }

  async listSessions(limit?: number): Promise<string[]> {
    this.assertAccess('conversations');
    return this.inner.listSessions(limit);
  }

  // --- Internal ---

  private assertAccess(resource: PrivacyResource): void {
    if (!this.canAccess(resource)) {
      throw new PrivacyError(
        `Access denied: ${this.callerRole} cannot access ${resource} for agent "${this.agentName}" (visibility: ${this.privacy.visibility?.[resource] || 'owner'})`,
      );
    }
  }
}

/** Check if a caller role has access given a visibility level */
export function checkAccess(caller: CallerRole, visibility: Visibility): boolean {
  switch (visibility) {
    case 'public':
      return true;
    case 'admin':
      return caller === 'owner' || caller === 'admin';
    case 'owner':
      return caller === 'owner';
    default:
      return false;
  }
}

/** Error thrown when privacy rules block access */
export class PrivacyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrivacyError';
  }
}

/** Default privacy config — everything is owner-only */
export const DEFAULT_PRIVACY: PrivacyConfig = {
  owner: 'self',
  visibility: {
    conversations: 'owner',
    mind: 'owner',
    soul: 'admin',
    state: 'owner',
    ledger: 'admin',
    handoff: 'owner',
  },
};
