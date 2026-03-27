// ============================================================================
// Ark — MCP Client Tests
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MCPClient, connectMCPServers, disconnectMCPClients } from '../src/tools/mcp/client.js';

// --- Test MCP Server ---
// A minimal MCP server that speaks JSON-RPC 2.0 over stdio
const TEST_SERVER_SCRIPT = `
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);

    if (msg.method === 'initialize') {
      const response = {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'test-server', version: '1.0.0' },
        },
      };
      process.stdout.write(JSON.stringify(response) + '\\n');
    }

    else if (msg.method === 'notifications/initialized') {
      // Notification — no response needed
    }

    else if (msg.method === 'tools/list') {
      const response = {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'Echoes input back',
              inputSchema: {
                type: 'object',
                properties: {
                  message: { type: 'string', description: 'Message to echo' },
                },
                required: ['message'],
              },
            },
            {
              name: 'add',
              description: 'Adds two numbers',
              inputSchema: {
                type: 'object',
                properties: {
                  a: { type: 'number', description: 'First number' },
                  b: { type: 'number', description: 'Second number' },
                },
                required: ['a', 'b'],
              },
            },
          ],
        },
      };
      process.stdout.write(JSON.stringify(response) + '\\n');
    }

    else if (msg.method === 'tools/call') {
      const { name, arguments: args } = msg.params;
      let result;

      if (name === 'echo') {
        result = {
          content: [{ type: 'text', text: args.message }],
        };
      } else if (name === 'add') {
        result = {
          content: [{ type: 'text', text: String(args.a + args.b) }],
        };
      } else {
        result = {
          content: [{ type: 'text', text: 'Unknown tool: ' + name }],
          isError: true,
        };
      }

      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result,
      }) + '\\n');
    }

    else {
      // Unknown method
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'Method not found: ' + msg.method },
      }) + '\\n');
    }
  } catch (e) {
    // Ignore parse errors
  }
});
`;

const tmpDir = join(tmpdir(), 'ark-mcp-test-' + Date.now());
const serverScript = join(tmpDir, 'test-mcp-server.cjs');

describe('MCP Client', () => {
  before(() => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(serverScript, TEST_SERVER_SCRIPT);
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('MCPClient', () => {
    let client: MCPClient;

    after(async () => {
      if (client?.isConnected()) {
        await client.disconnect();
      }
    });

    it('connects to an MCP server and discovers tools', async () => {
      client = new MCPClient({
        name: 'test',
        command: 'node',
        args: [serverScript],
      });

      const tools = await client.connect();

      assert.ok(client.isConnected(), 'Client should be connected');
      assert.equal(tools.length, 2, 'Should discover 2 tools');

      const names = tools.map(t => t.definition.name);
      assert.ok(names.includes('test__echo'), 'Should have test__echo tool');
      assert.ok(names.includes('test__add'), 'Should have test__add tool');
    });

    it('prefixes tool names with server name', async () => {
      client = new MCPClient({
        name: 'myserver',
        command: 'node',
        args: [serverScript],
      });

      const tools = await client.connect();
      const names = tools.map(t => t.definition.name);

      assert.ok(names.includes('myserver__echo'));
      assert.ok(names.includes('myserver__add'));
    });

    it('executes MCP tools via callTool', async () => {
      client = new MCPClient({
        name: 'test',
        command: 'node',
        args: [serverScript],
      });

      await client.connect();

      const echoResult = await client.callTool('echo', { message: 'hello world' });
      assert.equal(echoResult.content, 'hello world');
      assert.equal(echoResult.is_error, false);

      const addResult = await client.callTool('add', { a: 3, b: 7 });
      assert.equal(addResult.content, '10');
      assert.equal(addResult.is_error, false);
    });

    it('handles tool errors from server', async () => {
      client = new MCPClient({
        name: 'test',
        command: 'node',
        args: [serverScript],
      });

      await client.connect();

      const result = await client.callTool('nonexistent', {});
      assert.equal(result.is_error, true);
      assert.ok(result.content.includes('Unknown tool'));
    });

    it('executes tools through RegisteredTool wrappers', async () => {
      client = new MCPClient({
        name: 'test',
        command: 'node',
        args: [serverScript],
      });

      const tools = await client.connect();
      const echoTool = tools.find(t => t.definition.name === 'test__echo')!;

      const result = await echoTool.execute({ message: 'via wrapper' });
      assert.equal(result.content, 'via wrapper');
      assert.equal(result.is_error, false);
    });

    it('preserves tool schemas', async () => {
      client = new MCPClient({
        name: 'test',
        command: 'node',
        args: [serverScript],
      });

      const tools = await client.connect();
      const addTool = tools.find(t => t.definition.name === 'test__add')!;

      assert.equal(addTool.definition.description, 'Adds two numbers');
      assert.equal(addTool.definition.parameters.type, 'object');
      assert.ok(addTool.definition.parameters.properties?.a);
      assert.ok(addTool.definition.parameters.properties?.b);
      assert.deepEqual(addTool.definition.parameters.required, ['a', 'b']);
    });

    it('disconnects cleanly', async () => {
      client = new MCPClient({
        name: 'test',
        command: 'node',
        args: [serverScript],
      });

      await client.connect();
      assert.ok(client.isConnected());

      await client.disconnect();
      assert.ok(!client.isConnected());
    });

    it('handles connection failure gracefully', async () => {
      client = new MCPClient({
        name: 'bad',
        command: 'nonexistent-binary-that-does-not-exist',
        args: [],
      });

      await assert.rejects(() => client.connect());
      assert.ok(!client.isConnected());
    });
  });

  describe('connectMCPServers', () => {
    it('connects to multiple servers', async () => {
      const { tools, clients } = await connectMCPServers([
        { name: 'server_a', command: 'node', args: [serverScript] },
        { name: 'server_b', command: 'node', args: [serverScript] },
      ]);

      assert.equal(clients.length, 2, 'Should connect to 2 servers');
      assert.equal(tools.length, 4, 'Should have 4 tools (2 per server)');

      const names = tools.map(t => t.definition.name);
      assert.ok(names.includes('server_a__echo'));
      assert.ok(names.includes('server_b__echo'));
      assert.ok(names.includes('server_a__add'));
      assert.ok(names.includes('server_b__add'));

      await disconnectMCPClients(clients);
    });

    it('continues when one server fails', async () => {
      const { tools, clients } = await connectMCPServers([
        { name: 'good', command: 'node', args: [serverScript] },
        { name: 'bad', command: 'nonexistent-binary-xyz', args: [] },
      ]);

      assert.equal(clients.length, 1, 'Should connect to 1 server');
      assert.equal(tools.length, 2, 'Should have 2 tools from the working server');

      await disconnectMCPClients(clients);
    });
  });

  describe('disconnectMCPClients', () => {
    it('disconnects all clients', async () => {
      const { clients } = await connectMCPServers([
        { name: 'a', command: 'node', args: [serverScript] },
        { name: 'b', command: 'node', args: [serverScript] },
      ]);

      assert.equal(clients.length, 2);
      assert.ok(clients.every(c => c.isConnected()));

      await disconnectMCPClients(clients);
      assert.ok(clients.every(c => !c.isConnected()));
    });
  });
});
