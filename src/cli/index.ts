#!/usr/bin/env node
// ============================================================================
// Ark — CLI Entry Point
// ============================================================================

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { Agent } from '../agent.js';
import { startRepl } from './repl.js';
import { createConfig } from '../identity/loader.js';
import { runInit } from './init.js';
import { startRoom } from './room.js';
import { startTelegram } from '../interfaces/telegram.js';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  // Subcommands
  if (command === 'init') {
    await runInit();
    return;
  }

  if (command === 'test') {
    await runTest(args.slice(1));
    return;
  }

  if (command === 'room') {
    await runRoomCommand(args.slice(1));
    return;
  }

  if (command === 'start') {
    await runStart(args.slice(1));
    return;
  }

  if (command === 'telegram') {
    await runTelegramCommand(args.slice(1));
    return;
  }

  // No subcommand — check for flags or treat as start
  let configPath: string | undefined;
  let showHelp = false;
  let showVersion = false;
  let provider: string | undefined;
  let model: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      showHelp = true;
    } else if (arg === '--version' || arg === '-v') {
      showVersion = true;
    } else if ((arg === '--config' || arg === '-c') && args[i + 1]) {
      configPath = args[++i];
    } else if ((arg === '--provider' || arg === '-p') && args[i + 1]) {
      provider = args[++i];
    } else if ((arg === '--model' || arg === '-m') && args[i + 1]) {
      model = args[++i];
    } else if (!arg.startsWith('-')) {
      configPath = arg;
    }
  }

  if (showVersion) {
    console.log('ark 0.1.0');
    process.exit(0);
  }

  if (showHelp) {
    printHelp();
    process.exit(0);
  }

  // Default: start the agent
  await startAgent(configPath, provider, model);
}

async function runStart(args: string[]): Promise<void> {
  let configPath: string | undefined;
  let provider: string | undefined;
  let model: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '-p' || arg === '--provider') && args[i + 1]) {
      provider = args[++i];
    } else if ((arg === '-m' || arg === '--model') && args[i + 1]) {
      model = args[++i];
    } else if (!arg.startsWith('-')) {
      configPath = arg;
    }
  }

  await startAgent(configPath, provider, model);
}

async function runTest(args: string[]): Promise<void> {
  let configPath: string | undefined;
  let provider: string | undefined;
  let model: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-p' || args[i] === '--provider') && args[i + 1]) {
      provider = args[++i];
    } else if ((args[i] === '-m' || args[i] === '--model') && args[i + 1]) {
      model = args[++i];
    } else if (!args[i].startsWith('-')) {
      configPath = args[i];
    }
  }

  console.log('\nark test — Quick smoke test\n');

  let agent: Agent;
  if (configPath) {
    const absPath = resolve(configPath);
    if (!existsSync(absPath)) {
      console.error(`Config file not found: ${absPath}`);
      process.exit(1);
    }
    agent = new Agent({ configPath: absPath });
  } else {
    agent = new Agent({
      config: createConfig({
        name: 'ark-test',
        identity: { soul: 'You are a test agent. Be extremely concise.' },
        llm: {
          provider: provider || 'ollama',
          model: model || 'qwen3:14b',
          providers: provider === 'ollama' || !provider ? { ollama: { base_url: 'http://localhost:11434/v1' } } : undefined,
        },
        persistence: { adapter: 'memory' },
        tools: { native: ['shell'] },
      }),
    });
  }

  const dim = '\x1b[2m';
  const green = '\x1b[32m';
  const red = '\x1b[31m';
  const reset = '\x1b[0m';

  // Test 1: Boot
  process.stdout.write('  Boot agent... ');
  try {
    const context = await agent.boot();
    console.log(`${green}OK${reset} ${dim}(${context.system_prompt.length} char prompt)${reset}`);
  } catch (err) {
    console.log(`${red}FAIL${reset} — ${(err as Error).message}`);
    process.exit(1);
  }

  // Test 2: Provider availability
  process.stdout.write('  Check provider... ');
  const available = await agent.getProvider().available();
  if (available) {
    console.log(`${green}OK${reset} ${dim}(${agent.config.llm.provider}/${agent.config.llm.model})${reset}`);
  } else {
    console.log(`${red}UNAVAILABLE${reset} — check your API key or Ollama`);
    process.exit(1);
  }

  // Test 3: Simple conversation
  process.stdout.write('  Send message... ');
  const start = Date.now();
  try {
    const result = await agent.send('What is 2+2? Just the number, nothing else.');
    const duration = ((Date.now() - start) / 1000).toFixed(1);
    const text = result.text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const hasAnswer = text.includes('4');
    if (hasAnswer) {
      console.log(`${green}OK${reset} ${dim}(${duration}s, "${text.slice(0, 50)}")${reset}`);
    } else {
      console.log(`${red}UNEXPECTED${reset} ${dim}(${duration}s, "${text.slice(0, 80)}")${reset}`);
    }
  } catch (err) {
    console.log(`${red}FAIL${reset} — ${(err as Error).message}`);
  }

  // Test 4: Tool use
  process.stdout.write('  Tool use... ');
  try {
    const result = await agent.send('Use the shell tool to run "echo hello" and tell me the output. Just the output.');
    const text = result.text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const usedTool = result.tool_calls_made.length > 0;
    if (usedTool) {
      console.log(`${green}OK${reset} ${dim}(${result.tool_calls_made.length} tool call(s), "${text.slice(0, 50)}")${reset}`);
    } else {
      console.log(`${red}NO TOOL CALL${reset} ${dim}("${text.slice(0, 80)}")${reset}`);
    }
  } catch (err) {
    console.log(`${red}FAIL${reset} — ${(err as Error).message}`);
  }

  await agent.shutdown();
  console.log(`\n  ${green}All checks passed.${reset}\n`);
}

async function runRoomCommand(args: string[]): Promise<void> {
  const configPaths: string[] = [];
  let topic: string | undefined;
  let rounds: number | undefined;
  let provider: string | undefined;
  let model: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-t' || args[i] === '--topic') && args[i + 1]) {
      topic = args[++i];
    } else if ((args[i] === '-r' || args[i] === '--rounds') && args[i + 1]) {
      rounds = parseInt(args[++i], 10);
    } else if ((args[i] === '-p' || args[i] === '--provider') && args[i + 1]) {
      provider = args[++i];
    } else if ((args[i] === '-m' || args[i] === '--model') && args[i + 1]) {
      model = args[++i];
    } else if (!args[i].startsWith('-')) {
      configPaths.push(args[i]);
    }
  }

  if (configPaths.length === 0) {
    console.error('Usage: ark room <agent1.yaml> <agent2.yaml> [...] [-t topic] [-r rounds]');
    process.exit(1);
  }

  const agents: Agent[] = [];
  for (const cp of configPaths) {
    const absPath = resolve(cp);
    if (!existsSync(absPath)) {
      console.error(`Config file not found: ${absPath}`);
      process.exit(1);
    }
    const agent = new Agent({ configPath: absPath });
    if (provider) agent.config.llm.provider = provider;
    if (model) agent.config.llm.model = model;
    agents.push(agent);
  }

  await startRoom(agents, { topic, rounds });
}

async function runTelegramCommand(args: string[]): Promise<void> {
  let configPath: string | undefined;
  let token: string | undefined;
  let allowedUsers: number[] | undefined;
  let provider: string | undefined;
  let model: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--token' || arg === '-t') && args[i + 1]) {
      token = args[++i];
    } else if ((arg === '--users' || arg === '-u') && args[i + 1]) {
      allowedUsers = args[++i].split(',').map(Number).filter(n => !isNaN(n));
    } else if ((arg === '-p' || arg === '--provider') && args[i + 1]) {
      provider = args[++i];
    } else if ((arg === '-m' || arg === '--model') && args[i + 1]) {
      model = args[++i];
    } else if (!arg.startsWith('-')) {
      configPath = arg;
    }
  }

  if (!configPath) {
    console.error('Usage: ark telegram <config.yaml> [--token BOT_TOKEN] [--users 123,456]');
    process.exit(1);
  }

  const absPath = resolve(configPath);
  if (!existsSync(absPath)) {
    console.error(`Config file not found: ${absPath}`);
    process.exit(1);
  }

  const agent = new Agent({ configPath: absPath });
  if (provider) agent.config.llm.provider = provider;
  if (model) agent.config.llm.model = model;

  await startTelegram(agent.config, { token, allowedUsers });
}

async function startAgent(configPath?: string, provider?: string, model?: string): Promise<void> {
  if (!configPath) {
    const defaults = ['agent.yaml', 'agent.yml', 'ark.yaml', 'ark.yml'];
    for (const d of defaults) {
      if (existsSync(d)) {
        configPath = d;
        break;
      }
    }
  }

  let agent: Agent;

  if (configPath) {
    const absPath = resolve(configPath);
    if (!existsSync(absPath)) {
      console.error(`Config file not found: ${absPath}`);
      process.exit(1);
    }
    agent = new Agent({ configPath: absPath });
  } else {
    const config = createConfig({
      name: 'ark',
      description: 'Interactive Ark agent',
      identity: { soul: 'You are a helpful, capable AI assistant. Be direct and concise.' },
      llm: {
        provider: provider || 'anthropic',
        model: model || 'claude-sonnet-4-5-20250514',
      },
      persistence: { adapter: 'memory' },
      tools: { native: ['file_read', 'file_write', 'file_edit', 'shell', 'glob', 'grep', 'http_fetch'] },
    });
    agent = new Agent({ config });
  }

  if (provider) agent.config.llm.provider = provider;
  if (model) agent.config.llm.model = model;

  await startRepl(agent);
}

function printHelp() {
  console.log(`
ark — Model-agnostic portable agent runtime

Usage:
  ark [config.yaml]               Start agent from config
  ark start [config.yaml]         Start agent (same as above)
  ark init                        Create a new agent interactively
  ark test [config.yaml]          Quick smoke test
  ark room <a.yaml> <b.yaml> ...  Multi-agent chat room
  ark telegram <config.yaml>      Connect agent to Telegram
  ark --help                      Show this help

Commands:
  init                     Create a new agent config interactively
  start [config]           Start an agent REPL
  test [config]            Run a quick smoke test (boot, connect, chat, tools)
  room <configs...>        Start a multi-agent chat room
  telegram <config>        Connect an agent to Telegram Bot API

Options:
  -c, --config <path>      Path to agent YAML config
  -p, --provider <name>    LLM provider (anthropic, openai, ollama, google)
  -m, --model <name>       Model name
  -h, --help               Show help
  -v, --version            Show version

Room Options:
  -t, --topic <text>       Conversation topic
  -r, --rounds <n>         Max rounds (default: 20)
  -p, --provider <name>    Override provider for all agents
  -m, --model <name>       Override model for all agents

Telegram Options:
  -t, --token <token>      Bot token (or env: TELEGRAM_BOT_TOKEN)
  -u, --users <ids>        Comma-separated allowed user IDs
  -p, --provider <name>    Override LLM provider
  -m, --model <name>       Override model

Quick Start:
  ark init                                    # Create my-agent.yaml
  ark start my-agent.yaml                     # Start chatting
  ark test -p ollama -m qwen3:14b             # Test with local Ollama
  ark room agents/alpha.yaml agents/beta.yaml # Multi-agent chat
  ark telegram agent.yaml --users 12345       # Telegram bot
`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
