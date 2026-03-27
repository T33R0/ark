// ============================================================================
// Ark — MCP Client
// Connect to external MCP servers via stdio JSON-RPC 2.0
// ============================================================================

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { MCPServerConfig } from '../../types.js';
import type { RegisteredTool, ToolResult } from '../types.js';
import type { ToolDefinition, JSONSchema } from '../../llm/types.js';

// --- JSON-RPC Types ---

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// --- MCP Protocol Types ---

interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema?: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

interface MCPToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
}

// --- MCP Client ---

export class MCPClient extends EventEmitter {
  readonly serverName: string;
  private config: MCPServerConfig;
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private buffer = '';
  private connected = false;
  private serverCapabilities: Record<string, unknown> = {};

  constructor(config: MCPServerConfig) {
    super();
    this.config = config;
    this.serverName = config.name;
    // Prevent unhandled 'error' throws from EventEmitter
    this.on('error', () => {});
  }

  /** Connect to the MCP server, perform handshake, return discovered tools */
  async connect(): Promise<RegisteredTool[]> {
    await this.spawn();
    await this.initialize();
    return this.discoverTools();
  }

  /** Disconnect from the MCP server */
  async disconnect(): Promise<void> {
    if (!this.process) return;

    this.connected = false;

    // Reject all pending requests
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('MCP client disconnecting'));
      this.pending.delete(id);
    }

    // Kill the process
    const proc = this.process;
    this.process = null;

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 5000);

      proc.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      proc.kill('SIGTERM');
    });
  }

  /** Check if connected */
  isConnected(): boolean {
    return this.connected && this.process !== null && !this.process.killed;
  }

  /** Call an MCP tool */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const result = await this.request('tools/call', {
      name,
      arguments: args,
    }) as MCPToolResult;

    const text = result.content
      ?.map(c => c.text || JSON.stringify(c))
      .join('\n') || '';

    return {
      content: text,
      is_error: result.isError === true,
    };
  }

  // --- Private: Process Management ---

  private spawn(): Promise<void> {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, ...this.config.env };
      let settled = false;

      this.process = spawn(this.config.command, this.config.args || [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });

      this.process.stdout!.on('data', (data: Buffer) => {
        this.onData(data.toString());
      });

      this.process.stderr!.on('data', (data: Buffer) => {
        this.emit('stderr', data.toString());
      });

      this.process.on('error', (err) => {
        this.connected = false;
        this.emit('error', err);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      this.process.on('exit', (code, signal) => {
        this.connected = false;
        this.emit('exit', code, signal);
      });

      // Give the server a moment to start, but error can reject first
      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, 100);
    });
  }

  private async initialize(): Promise<void> {
    const result = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'ark', version: '0.1.0' },
    }) as { capabilities?: Record<string, unknown>; serverInfo?: Record<string, unknown> };

    this.serverCapabilities = result.capabilities || {};
    this.connected = true;

    // Send initialized notification
    this.notify('notifications/initialized');
  }

  private async discoverTools(): Promise<RegisteredTool[]> {
    const result = await this.request('tools/list', {}) as {
      tools?: MCPToolDefinition[];
    };

    const tools = result.tools || [];
    return tools.map(t => this.wrapTool(t));
  }

  private wrapTool(mcpTool: MCPToolDefinition): RegisteredTool {
    const prefix = this.serverName;
    const toolName = `${prefix}__${mcpTool.name}`;

    const definition: ToolDefinition = {
      name: toolName,
      description: mcpTool.description || `MCP tool from ${prefix}`,
      parameters: (mcpTool.inputSchema as JSONSchema) || { type: 'object' },
    };

    return {
      definition,
      execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
        return this.callTool(mcpTool.name, args);
      },
    };
  }

  // --- Private: JSON-RPC Transport ---

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;

    const msg: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method} (${id})`));
      }, 30000);

      this.pending.set(id, { resolve, reject, timer });
      this.send(msg);
    });
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    const msg: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.send(msg);
  }

  private send(msg: JsonRpcRequest | JsonRpcNotification): void {
    if (!this.process?.stdin?.writable) {
      throw new Error('MCP server stdin not writable');
    }
    this.process.stdin.write(JSON.stringify(msg) + '\n');
  }

  private onData(data: string): void {
    this.buffer += data;

    // Process newline-delimited JSON messages
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        this.onMessage(msg);
      } catch {
        // Ignore unparseable lines (could be server startup output)
      }
    }
  }

  private onMessage(msg: JsonRpcResponse): void {
    // Handle responses to our requests
    if ('id' in msg && msg.id != null) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);

        if (msg.error) {
          pending.reject(new Error(`MCP error [${msg.error.code}]: ${msg.error.message}`));
        } else {
          pending.resolve(msg.result);
        }
      }
    }

    // Handle server-initiated notifications (future: resource updates, etc.)
    if ('method' in msg && !('id' in msg)) {
      this.emit('notification', msg);
    }
  }
}

/** Connect to multiple MCP servers, return all tools */
export async function connectMCPServers(
  configs: MCPServerConfig[],
): Promise<{ tools: RegisteredTool[]; clients: MCPClient[] }> {
  const clients: MCPClient[] = [];
  const allTools: RegisteredTool[] = [];

  for (const config of configs) {
    const client = new MCPClient(config);
    try {
      const tools = await client.connect();
      clients.push(client);
      allTools.push(...tools);
    } catch (err) {
      // Log but don't fail — other servers may work
      console.error(`[ark] MCP server "${config.name}" failed to connect: ${err instanceof Error ? err.message : err}`);
    }
  }

  return { tools: allTools, clients };
}

/** Disconnect all MCP clients */
export async function disconnectMCPClients(clients: MCPClient[]): Promise<void> {
  await Promise.allSettled(clients.map(c => c.disconnect()));
}
