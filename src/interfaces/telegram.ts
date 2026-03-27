// ============================================================================
// Ark — Telegram Interface Adapter
// ============================================================================
//
// Long-polling Telegram Bot API adapter. One Agent instance per chat.
// Features: message batching, session timeout/resume, message splitting,
// typing indicators, graceful shutdown.
//
// Usage:
//   ark telegram <config.yaml> [--token BOT_TOKEN] [--users 123,456]
//   TELEGRAM_BOT_TOKEN=... ark telegram <config.yaml>
// ============================================================================

import { Agent } from '../agent.js';
import type { AgentConfig, TelegramInterfaceConfig } from '../types.js';

// --- Telegram API Types ---

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: string;
}

interface TelegramMessage {
  message_id: number;
  from: TelegramUser;
  chat: TelegramChat;
  text?: string;
  date: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

// --- Session State ---

interface UserSession {
  agent: Agent;
  chatId: number;
  userId: number;
  userName: string;
  lastActivity: number;
  pendingMessages: string[];
  batchTimer: ReturnType<typeof setTimeout> | null;
  processing: boolean;
}

// --- Adapter Options ---

export interface TelegramAdapterOptions {
  token: string;
  allowedUsers?: number[];
  sessionTimeout?: number;   // minutes (default: 1440 = 24h)
  batchWindow?: number;      // ms (default: 1500)
  agentConfig: AgentConfig;
}

// --- Constants ---

const TELEGRAM_MSG_LIMIT = 4096;
const DEFAULT_SESSION_TIMEOUT = 1440;  // 24 hours in minutes
const DEFAULT_BATCH_WINDOW = 1500;     // ms
const POLL_TIMEOUT = 30;               // seconds (Telegram long poll)
const ERROR_BACKOFF = 5000;            // ms

// --- ANSI Colors ---

const green = '\x1b[32m';
const yellow = '\x1b[33m';
const cyan = '\x1b[36m';
const magenta = '\x1b[35m';
const dim = '\x1b[2m';
const reset = '\x1b[0m';

// ============================================================================
// TelegramAdapter
// ============================================================================

export class TelegramAdapter {
  private token: string;
  private apiBase: string;
  private allowedUsers: Set<number> | null;
  private sessionTimeoutMs: number;
  private batchWindow: number;
  private agentConfig: AgentConfig;

  private sessions: Map<number, UserSession> = new Map();
  private offset = 0;
  private running = false;
  private pollAbort: AbortController | null = null;

  constructor(options: TelegramAdapterOptions) {
    this.token = options.token;
    this.apiBase = `https://api.telegram.org/bot${this.token}`;
    this.allowedUsers = options.allowedUsers?.length
      ? new Set(options.allowedUsers)
      : null;
    this.sessionTimeoutMs =
      (options.sessionTimeout ?? DEFAULT_SESSION_TIMEOUT) * 60 * 1000;
    this.batchWindow = options.batchWindow ?? DEFAULT_BATCH_WINDOW;
    this.agentConfig = options.agentConfig;
  }

  // --- Public API ---

  async start(): Promise<void> {
    const me = await this.apiCall<TelegramUser>('getMe');
    console.log(`${green}✓${reset} Connected as @${me.username} (${me.first_name})`);

    if (this.allowedUsers) {
      console.log(`${dim}  Allowed users: ${[...this.allowedUsers].join(', ')}${reset}`);
    } else {
      console.log(`${yellow}⚠ No user allowlist — responding to ALL users${reset}`);
    }

    this.running = true;
    this.registerShutdownHandlers();

    console.log('Polling for messages...\n');

    while (this.running) {
      try {
        await this.poll();
      } catch (err) {
        if (!this.running) break;
        const msg = err instanceof Error ? err.message : String(err);
        // Don't log abort errors during shutdown
        if (!msg.includes('abort')) {
          console.error(`${dim}Poll error: ${msg}${reset}`);
        }
        await sleep(ERROR_BACKOFF);
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.pollAbort?.abort();

    for (const [, session] of this.sessions) {
      if (session.batchTimer) clearTimeout(session.batchTimer);
      try {
        await session.agent.shutdown();
      } catch {
        // Best-effort shutdown
      }
    }
    this.sessions.clear();
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  // --- Polling ---

  private async poll(): Promise<void> {
    this.pollAbort = new AbortController();

    const updates = await this.apiCall<TelegramUpdate[]>('getUpdates', {
      offset: this.offset,
      timeout: POLL_TIMEOUT,
      allowed_updates: ['message'],
    }, this.pollAbort.signal);

    if (!Array.isArray(updates)) return;

    for (const update of updates) {
      this.offset = update.update_id + 1;

      if (update.message?.text) {
        await this.handleMessage(update.message as TelegramMessage & { text: string });
      }
    }
  }

  // --- Message Handling ---

  private async handleMessage(msg: TelegramMessage & { text: string }): Promise<void> {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const text = msg.text;
    const userName = msg.from.username || msg.from.first_name;

    // Auth gate
    if (this.allowedUsers && !this.allowedUsers.has(userId)) {
      console.log(`${dim}Blocked: ${userName} (${userId})${reset}`);
      return;
    }

    // Bot commands
    if (text === '/start') {
      await this.sendMessage(chatId, 'Connected. Send me a message to begin.');
      return;
    }

    if (text === '/reset') {
      await this.destroySession(chatId);
      await this.sendMessage(chatId, 'Session reset.');
      return;
    }

    if (text === '/status') {
      const session = this.sessions.get(chatId);
      const status = session
        ? `Active session. Messages: ${session.agent.getMessages().length}. ` +
          `Age: ${Math.round((Date.now() - session.lastActivity) / 60000)}m idle.`
        : 'No active session.';
      await this.sendMessage(chatId, status);
      return;
    }

    // Get or create session
    let session = this.sessions.get(chatId);

    // Check for session timeout
    if (session && Date.now() - session.lastActivity > this.sessionTimeoutMs) {
      console.log(`${dim}Session expired for ${userName}${reset}`);
      await this.destroySession(chatId);
      session = undefined;
    }

    if (!session) {
      const newSession = await this.createSession(chatId, userId, userName);
      if (!newSession) return; // boot failed
      session = newSession;
    }

    session.lastActivity = Date.now();

    // Batch messages — collect rapid-fire input
    session.pendingMessages.push(text);

    if (session.batchTimer) clearTimeout(session.batchTimer);
    session.batchTimer = setTimeout(
      () => this.processBatch(chatId),
      this.batchWindow,
    );
  }

  // --- Session Management ---

  private async createSession(
    chatId: number,
    userId: number,
    userName: string,
  ): Promise<UserSession | null> {
    // Deep clone config for isolation
    const config: AgentConfig = JSON.parse(JSON.stringify(this.agentConfig));

    // Per-user SQLite path to isolate conversations
    if (config.persistence.adapter === 'sqlite' && config.persistence.path) {
      const base = config.persistence.path.replace(/\.db$/, '');
      config.persistence.path = `${base}_tg_${chatId}.db`;
    }

    const agent = new Agent({ config });

    try {
      await agent.boot();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${dim}Boot failed for ${userName}: ${msg}${reset}`);
      await this.sendMessage(chatId, 'Failed to start session. Check agent config.');
      return null;
    }

    const session: UserSession = {
      agent,
      chatId,
      userId,
      userName,
      lastActivity: Date.now(),
      pendingMessages: [],
      batchTimer: null,
      processing: false,
    };

    this.sessions.set(chatId, session);
    console.log(`${green}+${reset} New session: ${userName} (${chatId})`);
    return session;
  }

  private async destroySession(chatId: number): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session) return;

    if (session.batchTimer) clearTimeout(session.batchTimer);
    try {
      await session.agent.shutdown();
    } catch {
      // Best-effort
    }
    this.sessions.delete(chatId);
  }

  // --- Batch Processing ---

  private async processBatch(chatId: number): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session || session.pendingMessages.length === 0) return;

    // Prevent concurrent processing for same chat
    if (session.processing) {
      // Re-schedule — new messages arrived while processing
      session.batchTimer = setTimeout(
        () => this.processBatch(chatId),
        this.batchWindow,
      );
      return;
    }

    session.processing = true;
    const input = session.pendingMessages.join('\n');
    session.pendingMessages = [];
    session.batchTimer = null;

    const preview = input.length > 80 ? input.slice(0, 80) + '...' : input;
    console.log(`${cyan}←${reset} ${session.userName}: ${preview}`);

    // Typing indicator (fire and forget)
    this.sendChatAction(chatId, 'typing').catch(() => {});

    try {
      const result = await session.agent.send(input);

      // Strip thinking tags (qwen, deepseek, etc.)
      const response = result.text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

      if (response) {
        await this.sendLongMessage(chatId, response);
        const rPreview = response.length > 80 ? response.slice(0, 80) + '...' : response;
        console.log(`${magenta}→${reset} ${session.userName}: ${rPreview}`);
      }

      if (result.tool_calls_made.length > 0) {
        console.log(`${dim}  (${result.tool_calls_made.length} tool call(s))${reset}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error [${session.userName}]: ${msg}`);
      await this.sendMessage(chatId, 'Something went wrong. Try again or /reset.').catch(() => {});
    } finally {
      session.processing = false;

      // Check if more messages arrived during processing
      if (session.pendingMessages.length > 0) {
        session.batchTimer = setTimeout(
          () => this.processBatch(chatId),
          this.batchWindow,
        );
      }
    }
  }

  // --- Telegram API ---

  private async apiCall<T>(
    method: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await fetch(`${this.apiBase}/${method}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });

    const data = (await res.json()) as { ok: boolean; result: T; description?: string };

    if (!data.ok) {
      throw new Error(`Telegram API [${method}]: ${data.description || 'Unknown error'}`);
    }

    return data.result;
  }

  private async sendMessage(
    chatId: number,
    text: string,
    parseMode?: string,
  ): Promise<void> {
    const params: Record<string, unknown> = { chat_id: chatId, text };
    if (parseMode) params.parse_mode = parseMode;
    await this.apiCall('sendMessage', params);
  }

  private async sendLongMessage(chatId: number, text: string): Promise<void> {
    if (text.length <= TELEGRAM_MSG_LIMIT) {
      try {
        await this.sendMessage(chatId, text, 'Markdown');
      } catch {
        // Markdown parse failure — send plain
        await this.sendMessage(chatId, text);
      }
      return;
    }

    const chunks = splitMessage(text, TELEGRAM_MSG_LIMIT);
    for (const chunk of chunks) {
      try {
        await this.sendMessage(chatId, chunk, 'Markdown');
      } catch {
        await this.sendMessage(chatId, chunk);
      }
    }
  }

  private async sendChatAction(chatId: number, action: string): Promise<void> {
    await this.apiCall('sendChatAction', { chat_id: chatId, action });
  }

  // --- Lifecycle ---

  private registerShutdownHandlers(): void {
    const shutdown = async () => {
      console.log('\nShutting down...');
      await this.stop();
      console.log('Goodbye.');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

export function splitMessage(text: string, maxLength: number): string[] {
  if (text.length === 0) return [''];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find best split point: paragraph > line > sentence > hard cut
    const threshold = Math.floor(maxLength * 0.3);
    let splitAt = remaining.lastIndexOf('\n\n', maxLength);
    if (splitAt < threshold) splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt < threshold) splitAt = remaining.lastIndexOf('. ', maxLength);
    if (splitAt < threshold) splitAt = maxLength;

    // Include the period in the chunk
    if (remaining[splitAt] === '.') splitAt += 1;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// Convenience Starter (used by CLI)
// ============================================================================

export async function startTelegram(
  agentConfig: AgentConfig,
  options: {
    token?: string;
    allowedUsers?: number[];
    sessionTimeout?: number;
    batchWindow?: number;
  } = {},
): Promise<void> {
  // Token resolution: CLI flag > config > env var
  const telegramConfig = (agentConfig as AgentConfig & { interfaces?: { telegram?: TelegramInterfaceConfig } })
    .interfaces?.telegram;
  const token =
    options.token ||
    telegramConfig?.token ||
    process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    console.error(
      'Error: No Telegram bot token.\n' +
      'Set TELEGRAM_BOT_TOKEN env var, pass --token, or add interfaces.telegram.token to config.',
    );
    process.exit(1);
  }

  // Merge config-level telegram settings with CLI overrides
  const allowedUsers =
    options.allowedUsers ||
    telegramConfig?.allowed_users;
  const sessionTimeout =
    options.sessionTimeout ??
    telegramConfig?.session_timeout;
  const batchWindow =
    options.batchWindow ??
    telegramConfig?.batch_window;

  const adapter = new TelegramAdapter({
    token,
    allowedUsers,
    sessionTimeout,
    batchWindow,
    agentConfig,
  });

  await adapter.start();
}
