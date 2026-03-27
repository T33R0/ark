// ============================================================================
// Ark — Telegram Adapter Tests
// ============================================================================

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramAdapter, splitMessage } from '../src/interfaces/telegram.js';
import type { TelegramAdapterOptions } from '../src/interfaces/telegram.js';
import { createConfig } from '../src/identity/loader.js';
import type { AgentConfig } from '../src/types.js';

// --- Test Helpers ---

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return createConfig({
    name: 'test-bot',
    identity: { soul: 'You are a test bot.' },
    persistence: { adapter: 'memory' },
    ...overrides,
  });
}

function makeAdapterOptions(overrides?: Partial<TelegramAdapterOptions>): TelegramAdapterOptions {
  return {
    token: 'test-token-123',
    agentConfig: makeConfig(),
    ...overrides,
  };
}

// --- splitMessage tests ---

describe('splitMessage', () => {
  it('returns single chunk for short text', () => {
    const chunks = splitMessage('Hello world', 4096);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], 'Hello world');
  });

  it('returns single chunk for exactly max length', () => {
    const text = 'a'.repeat(4096);
    const chunks = splitMessage(text, 4096);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, 4096);
  });

  it('splits on paragraph boundaries', () => {
    const para1 = 'a'.repeat(2000);
    const para2 = 'b'.repeat(2000);
    const para3 = 'c'.repeat(2000);
    const text = `${para1}\n\n${para2}\n\n${para3}`;
    const chunks = splitMessage(text, 4096);
    assert.ok(chunks.length >= 2, `Expected >=2 chunks, got ${chunks.length}`);
    // First chunk should end at a paragraph boundary
    assert.ok(chunks[0].endsWith(para1) || chunks[0].endsWith(para2),
      'Should split on paragraph boundary');
  });

  it('splits on line boundaries when no paragraph break', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}: ${'x'.repeat(50)}`);
    const text = lines.join('\n');
    const chunks = splitMessage(text, 4096);
    assert.ok(chunks.length >= 2);
    // Reassembled content should be complete (no data lost at split points)
    const totalChars = chunks.reduce((sum, c) => sum + c.length, 0);
    // Allow for trimmed whitespace between chunks
    assert.ok(totalChars >= text.length * 0.95, 'Should preserve content across splits');
    // Each non-final chunk should be under the limit
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 4096, `Chunk exceeds max length: ${chunk.length}`);
    }
  });

  it('handles text with no good split points', () => {
    const text = 'a'.repeat(10000);
    const chunks = splitMessage(text, 4096);
    assert.ok(chunks.length >= 3);
    assert.equal(chunks[0].length, 4096);
  });

  it('handles empty text', () => {
    const chunks = splitMessage('', 4096);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], '');
  });

  it('preserves all content across chunks', () => {
    const text = Array.from({ length: 200 }, (_, i) => `Sentence ${i}.`).join(' ');
    const chunks = splitMessage(text, 500);
    const reassembled = chunks.join('');
    // Account for trimmed whitespace between chunks
    assert.ok(reassembled.length >= text.length * 0.95,
      'Should preserve most content');
  });
});

// --- TelegramAdapter construction tests ---

describe('TelegramAdapter', () => {
  it('constructs with minimal options', () => {
    const adapter = new TelegramAdapter(makeAdapterOptions());
    assert.equal(adapter.getSessionCount(), 0);
  });

  it('constructs with allowed users', () => {
    const adapter = new TelegramAdapter(makeAdapterOptions({
      allowedUsers: [123, 456],
    }));
    assert.equal(adapter.getSessionCount(), 0);
  });

  it('constructs with custom timeouts', () => {
    const adapter = new TelegramAdapter(makeAdapterOptions({
      sessionTimeout: 60,
      batchWindow: 500,
    }));
    assert.equal(adapter.getSessionCount(), 0);
  });

  it('constructs with sqlite persistence config', () => {
    const config = makeConfig({
      persistence: { adapter: 'sqlite', path: './data/bot.db' },
    });
    const adapter = new TelegramAdapter(makeAdapterOptions({
      agentConfig: config,
    }));
    assert.equal(adapter.getSessionCount(), 0);
  });
});

// --- TelegramAdapter with mocked fetch ---

describe('TelegramAdapter API calls', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; options?: RequestInit }>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchCalls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('start() calls getMe and begins polling', async () => {
    let pollCount = 0;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchCalls.push({ url, options: init });

      if (url.includes('/getMe')) {
        return new Response(JSON.stringify({
          ok: true,
          result: { id: 1, first_name: 'TestBot', username: 'test_bot' },
        }));
      }

      if (url.includes('/getUpdates')) {
        pollCount++;
        if (pollCount >= 2) {
          // Stop after 2 polls by throwing abort
          throw new DOMException('Aborted', 'AbortError');
        }
        return new Response(JSON.stringify({ ok: true, result: [] }));
      }

      return new Response(JSON.stringify({ ok: true, result: {} }));
    }) as typeof fetch;

    const adapter = new TelegramAdapter(makeAdapterOptions());

    // Run start in background, stop after short delay
    const startPromise = adapter.start().catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 200));
    await adapter.stop();
    await startPromise;

    // Should have called getMe
    assert.ok(fetchCalls.some(c => c.url.includes('/getMe')),
      'Should call getMe on start');

    // Should have started polling
    assert.ok(fetchCalls.some(c => c.url.includes('/getUpdates')),
      'Should start polling for updates');
  });

  it('processes incoming messages', async () => {
    let pollCount = 0;
    const sentMessages: string[] = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('/getMe')) {
        return new Response(JSON.stringify({
          ok: true,
          result: { id: 1, first_name: 'TestBot', username: 'test_bot' },
        }));
      }

      if (url.includes('/getUpdates')) {
        pollCount++;
        if (pollCount === 1) {
          // Return a /start command
          return new Response(JSON.stringify({
            ok: true,
            result: [{
              update_id: 1,
              message: {
                message_id: 1,
                from: { id: 999, first_name: 'Tester', username: 'tester' },
                chat: { id: 999, type: 'private' },
                text: '/start',
                date: Math.floor(Date.now() / 1000),
              },
            }],
          }));
        }
        // Subsequent polls: abort to stop
        throw new DOMException('Aborted', 'AbortError');
      }

      if (url.includes('/sendMessage')) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        sentMessages.push(body.text);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 2 } }));
      }

      return new Response(JSON.stringify({ ok: true, result: {} }));
    }) as typeof fetch;

    const adapter = new TelegramAdapter(makeAdapterOptions());

    const startPromise = adapter.start().catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 500));
    await adapter.stop();
    await startPromise;

    // Should have sent the /start welcome message
    assert.ok(sentMessages.some(m => m.includes('Connected')),
      `Expected welcome message, got: ${JSON.stringify(sentMessages)}`);
  });

  it('blocks unauthorized users', async () => {
    let pollCount = 0;
    const sentMessages: Array<{ chatId: number; text: string }> = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('/getMe')) {
        return new Response(JSON.stringify({
          ok: true,
          result: { id: 1, first_name: 'TestBot', username: 'test_bot' },
        }));
      }

      if (url.includes('/getUpdates')) {
        pollCount++;
        if (pollCount === 1) {
          return new Response(JSON.stringify({
            ok: true,
            result: [{
              update_id: 1,
              message: {
                message_id: 1,
                from: { id: 666, first_name: 'Hacker' },
                chat: { id: 666, type: 'private' },
                text: 'hack the planet',
                date: Math.floor(Date.now() / 1000),
              },
            }],
          }));
        }
        throw new DOMException('Aborted', 'AbortError');
      }

      if (url.includes('/sendMessage')) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        sentMessages.push({ chatId: body.chat_id, text: body.text });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 2 } }));
      }

      return new Response(JSON.stringify({ ok: true, result: {} }));
    }) as typeof fetch;

    const adapter = new TelegramAdapter(makeAdapterOptions({
      allowedUsers: [123], // Only allow user 123
    }));

    const startPromise = adapter.start().catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 500));
    await adapter.stop();
    await startPromise;

    // Should NOT have sent any message to unauthorized user
    const toHacker = sentMessages.filter(m => m.chatId === 666);
    assert.equal(toHacker.length, 0, 'Should not respond to unauthorized users');
  });

  it('handles API errors gracefully', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('/getMe')) {
        return new Response(JSON.stringify({
          ok: false,
          description: 'Unauthorized',
        }));
      }

      return new Response(JSON.stringify({ ok: true, result: {} }));
    }) as typeof fetch;

    const adapter = new TelegramAdapter(makeAdapterOptions());

    await assert.rejects(
      () => adapter.start(),
      /Telegram API.*Unauthorized/,
      'Should throw on invalid token',
    );
  });
});

// --- Config integration tests ---

describe('Telegram config in AgentConfig', () => {
  it('accepts interfaces.telegram config', () => {
    const config = createConfig({
      name: 'telegram-bot',
      interfaces: {
        telegram: {
          token: 'bot123:ABC',
          allowed_users: [111, 222],
          session_timeout: 60,
          batch_window: 1000,
        },
      },
    });

    assert.equal(config.name, 'telegram-bot');
    assert.equal(config.interfaces?.telegram?.token, 'bot123:ABC');
    assert.deepEqual(config.interfaces?.telegram?.allowed_users, [111, 222]);
    assert.equal(config.interfaces?.telegram?.session_timeout, 60);
    assert.equal(config.interfaces?.telegram?.batch_window, 1000);
  });

  it('works without interfaces config', () => {
    const config = createConfig({ name: 'no-telegram' });
    assert.equal(config.interfaces, undefined);
  });
});
