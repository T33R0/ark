// ============================================================================
// Ark — End-to-End Test with Ollama (local LLM)
// ============================================================================
//
// This test exercises the full agent lifecycle with a real LLM:
//   1. Boot an agent with Ollama
//   2. Simple conversation (no tools)
//   3. Tool use — file operations
//   4. Tool use — shell command
//   5. Multi-turn conversation with memory
//   6. Persistence — verify state survives across agent instances
//   7. Session handoff
//
// Run: npx tsx tests/e2e-ollama.ts
// Requires: Ollama running on localhost:11434 with qwen3:14b

import { Agent } from '../src/agent.js';
import { createConfig } from '../src/identity/loader.js';
import { SQLiteStore } from '../src/persistence/sqlite.js';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// --- Config ---
const MODEL = 'qwen3:14b';
const OLLAMA_URL = 'http://localhost:11434/v1';
const TIMEOUT = 180000; // 3 min per call (local models can be slow)

// --- Test Infrastructure ---
interface TestResult {
  name: string;
  passed: boolean;
  duration_ms: number;
  details: string;
  error?: string;
}

const results: TestResult[] = [];
let tmpDir: string;
let dbPath: string;

function log(msg: string) {
  const ts = new Date().toISOString().split('T')[1].slice(0, 8);
  console.log(`[${ts}] ${msg}`);
}

async function runTest(name: string, fn: () => Promise<string>): Promise<void> {
  log(`▶ ${name}`);
  const start = Date.now();
  try {
    const details = await fn();
    const duration_ms = Date.now() - start;
    results.push({ name, passed: true, duration_ms, details });
    log(`  ✓ ${name} (${(duration_ms / 1000).toFixed(1)}s)`);
  } catch (err) {
    const duration_ms = Date.now() - start;
    const error = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, duration_ms, details: '', error });
    log(`  ✗ ${name} (${(duration_ms / 1000).toFixed(1)}s) — ${error}`);
  }
}

function createAgent(overrides: Record<string, unknown> = {}): Agent {
  return new Agent({
    config: createConfig({
      name: 'ark-e2e-test',
      identity: {
        soul: `You are a test agent for the Ark runtime.
Be extremely concise — answer in 1-2 sentences max.
When using tools, use the minimum number of tool calls needed.
Do NOT use <think> tags or show your reasoning — just answer directly.`,
        directives: [
          'Be concise. Never more than 2 sentences.',
          'When asked to write a file, just write it. Do not explain.',
          'When asked a math question, give the answer directly.',
        ],
      },
      llm: {
        provider: 'ollama',
        model: MODEL,
        providers: {
          ollama: { base_url: OLLAMA_URL },
        },
      },
      persistence: {
        adapter: 'sqlite',
        path: dbPath,
      },
      tools: {
        native: ['file_read', 'file_write', 'file_edit', 'shell', 'glob', 'grep'],
      },
      behavior: {
        max_tool_rounds: 5,
        session_handoff: true,
      },
      ...overrides,
    }),
  });
}

// --- Pre-flight ---
async function checkOllama(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const data = await res.json() as { models: Array<{ name: string }> };
    const hasModel = data.models.some(m => m.name.includes('qwen3'));
    if (!hasModel) {
      console.error(`Model ${MODEL} not found. Available: ${data.models.map(m => m.name).join(', ')}`);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// --- Tests ---

async function testSimpleConversation(): Promise<string> {
  const agent = createAgent();
  await agent.boot();

  const result = await agent.send('What is 7 multiplied by 8? Just the number.');

  await agent.shutdown();

  const text = result.text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!text.includes('56')) {
    throw new Error(`Expected "56" in response, got: "${text.slice(0, 200)}"`);
  }

  return `Response: "${text.slice(0, 100)}" | Tokens: ${result.usage[0]?.input_tokens || 0}in/${result.usage[0]?.output_tokens || 0}out`;
}

async function testToolUseFileWrite(): Promise<string> {
  const agent = createAgent();
  await agent.boot();

  const testFile = join(tmpDir, 'tool-test.txt');
  const result = await agent.send(
    `Write the text "ark runtime works" to the file ${testFile}. Use the file_write tool.`,
  );

  await agent.shutdown();

  // Verify file was created
  if (!existsSync(testFile)) {
    throw new Error('File was not created by the agent');
  }

  const content = readFileSync(testFile, 'utf-8');
  if (!content.includes('ark')) {
    throw new Error(`File content unexpected: "${content.slice(0, 100)}"`);
  }

  const toolCalls = result.tool_calls_made.map(tc => tc.name);
  return `File written: ${content.slice(0, 50)} | Tools used: ${toolCalls.join(', ')} | Tool calls: ${result.tool_calls_made.length}`;
}

async function testToolUseFileRead(): Promise<string> {
  const agent = createAgent();
  await agent.boot();

  // Create a file for the agent to read
  const testFile = join(tmpDir, 'read-test.txt');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(testFile, 'The secret code is ALPHA-7749.');

  const result = await agent.send(
    `Read the file at ${testFile} and tell me what the secret code is. Be concise.`,
  );

  await agent.shutdown();

  const text = result.text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!text.includes('ALPHA-7749') && !text.includes('7749')) {
    throw new Error(`Expected secret code in response, got: "${text.slice(0, 200)}"`);
  }

  const toolCalls = result.tool_calls_made.map(tc => tc.name);
  return `Response: "${text.slice(0, 100)}" | Tools: ${toolCalls.join(', ')}`;
}

async function testToolUseShell(): Promise<string> {
  const agent = createAgent();
  await agent.boot();

  const result = await agent.send(
    'Use the shell tool to run "date +%Y" and tell me the year. Just the year number.',
  );

  await agent.shutdown();

  const text = result.text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!text.includes('2026')) {
    throw new Error(`Expected "2026" in response, got: "${text.slice(0, 200)}"`);
  }

  return `Response: "${text.slice(0, 100)}" | Tool calls: ${result.tool_calls_made.length}`;
}

async function testPersistence(): Promise<string> {
  // Agent 1: store knowledge
  const agent1 = createAgent();
  await agent1.boot();

  await agent1.remember(
    'The project codename is NIGHTFALL.',
    { node_type: 'fact', domain: 'test', tags: ['codename'] },
  );
  await agent1.getStore().setState('test_counter', 42);
  await agent1.logLedger({
    type: 'win',
    what: 'Successfully tested persistence',
    pattern: 'verification-success',
  });
  // Write handoff last — shutdown() would overwrite with generic message
  // so we close the store manually instead
  await agent1.writeHandoff({
    active_work: 'Testing persistence across instances',
    next_actions: 'Verify data survived',
  });
  await agent1.getStore().close();

  // Agent 2: verify knowledge persisted
  const agent2 = createAgent();
  const context = await agent2.boot();

  const store = agent2.getStore();
  const counter = await store.getState('test_counter');
  const mind = await store.getMind();
  const ledger = await store.getLedger();
  const handoff = await store.getLatestHandoff();

  await agent2.shutdown();

  const checks: string[] = [];

  if (counter !== 42) throw new Error(`State lost: counter = ${counter}`);
  checks.push('state ✓');

  const node = mind.find(n => n.content.includes('NIGHTFALL'));
  if (!node) throw new Error('Mind node not found');
  checks.push('mind ✓');

  const entry = ledger.find(e => e.what.includes('persistence'));
  if (!entry) throw new Error('Ledger entry not found');
  checks.push('ledger ✓');

  if (!handoff?.active_work?.includes('persistence')) throw new Error('Handoff not found');
  checks.push('handoff ✓');

  if (!context.system_prompt.includes('NIGHTFALL')) throw new Error('Mind not in boot context');
  checks.push('boot-context ✓');

  return `All persistence checks passed: ${checks.join(', ')}`;
}

async function testMultiTurn(): Promise<string> {
  const agent = createAgent();
  await agent.boot();

  const r1 = await agent.send('Remember this number: 42. Just acknowledge.');
  const r2 = await agent.send('What number did I just ask you to remember?');

  await agent.shutdown();

  const text = r2.text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!text.includes('42')) {
    throw new Error(`Expected "42" in response, got: "${text.slice(0, 200)}"`);
  }

  const totalMessages = agent.getMessages().length;
  return `Multi-turn maintained context. Messages: ${totalMessages}. Response: "${text.slice(0, 80)}"`;
}

async function testCascadeAvailability(): Promise<string> {
  const agent = createAgent();
  await agent.boot();

  const provider = agent.getProvider();
  const available = await provider.available();
  const tools = agent.getTools().getDefinitions();

  await agent.shutdown();

  return `Provider available: ${available} | Tools registered: ${tools.length} (${tools.map(t => t.name).join(', ')})`;
}

async function testBootContext(): Promise<string> {
  const agent = createAgent();
  const context = await agent.boot();

  const checks: string[] = [];
  if (context.system_prompt.includes('test agent')) checks.push('soul ✓');
  if (context.system_prompt.includes('Be concise')) checks.push('directives ✓');
  if (context.system_prompt.includes('Current date')) checks.push('date ✓');
  if (context.system_prompt.includes('tools available')) checks.push('tool-awareness ✓');

  await agent.shutdown();

  if (checks.length < 4) throw new Error(`Missing boot context elements: ${checks.join(', ')}`);
  return `Boot context complete: ${checks.join(', ')} | Prompt length: ${context.system_prompt.length} chars`;
}

// --- Main ---
async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║          Ark E2E Test Suite (Ollama)             ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log();

  // Pre-flight
  log('Checking Ollama...');
  if (!(await checkOllama())) {
    console.error('Ollama not available. Start it with: ollama serve');
    process.exit(1);
  }
  log(`Ollama ready. Model: ${MODEL}`);

  // Setup
  tmpDir = mkdtempSync(join(tmpdir(), 'ark-e2e-'));
  dbPath = join(tmpDir, 'e2e-test.db');
  log(`Working dir: ${tmpDir}`);
  log(`Database: ${dbPath}`);
  console.log();

  const totalStart = Date.now();

  // Run tests
  await runTest('Boot Context Assembly', testBootContext);
  await runTest('Cascade Provider Availability', testCascadeAvailability);
  await runTest('Simple Conversation (math)', testSimpleConversation);
  await runTest('Tool Use — File Write', testToolUseFileWrite);
  await runTest('Tool Use — File Read', testToolUseFileRead);
  await runTest('Tool Use — Shell Command', testToolUseShell);
  await runTest('Multi-Turn Context', testMultiTurn);
  await runTest('Persistence Across Instances', testPersistence);

  const totalDuration = Date.now() - totalStart;

  // Report
  console.log();
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║                  RESULTS                         ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log();

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  for (const r of results) {
    const status = r.passed ? '✓' : '✗';
    const time = `${(r.duration_ms / 1000).toFixed(1)}s`;
    console.log(`  ${status} ${r.name} (${time})`);
    if (r.passed) {
      console.log(`    ${r.details}`);
    } else {
      console.log(`    ERROR: ${r.error}`);
    }
  }

  console.log();
  console.log(`  Total: ${passed + failed} tests, ${passed} passed, ${failed} failed`);
  console.log(`  Duration: ${(totalDuration / 1000).toFixed(1)}s`);
  console.log(`  Model: ${MODEL} via Ollama`);
  console.log();

  // Write report to file
  const report = {
    timestamp: new Date().toISOString(),
    model: MODEL,
    provider: 'ollama',
    total_duration_ms: totalDuration,
    passed,
    failed,
    tests: results,
  };

  const reportPath = join(tmpDir, 'e2e-report.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`  Report written to: ${reportPath}`);

  // Also write a human-readable summary
  const summaryPath = '/Users/raw_shu/Projects/ark/tests/e2e-results.txt';
  const summary = [
    'Ark E2E Test Results',
    '=' .repeat(50),
    `Date: ${new Date().toISOString()}`,
    `Model: ${MODEL} via Ollama (local)`,
    `Duration: ${(totalDuration / 1000).toFixed(1)}s`,
    `Result: ${passed}/${passed + failed} passed`,
    '',
    ...results.map(r => {
      const status = r.passed ? 'PASS' : 'FAIL';
      return `[${status}] ${r.name} (${(r.duration_ms / 1000).toFixed(1)}s)\n  ${r.passed ? r.details : 'ERROR: ' + r.error}`;
    }),
    '',
  ].join('\n');
  writeFileSync(summaryPath, summary);
  console.log(`  Summary written to: ${summaryPath}`);

  // Cleanup
  try { rmSync(tmpDir, { recursive: true }); } catch {}

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
