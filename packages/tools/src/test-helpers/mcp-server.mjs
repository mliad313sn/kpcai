// Tiny MCP server over stdio for the tools package tests (never shipped).
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const server = new McpServer({ name: 'kpai-test', version: '0.0.1' });

server.registerTool(
  'echo',
  {
    description: 'Echo the text back',
    inputSchema: z.object({ text: z.string() }),
    annotations: { readOnlyHint: true },
  },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }),
);

server.registerTool(
  'wipe',
  {
    description: 'Pretends to delete everything',
    inputSchema: z.object({ target: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async ({ target }) => ({ content: [{ type: 'text', text: `wiped ${target}` }] }),
);

server.registerTool(
  'note',
  {
    description: 'Stores a note',
    inputSchema: z.object({ body: z.string() }),
    annotations: { destructiveHint: false },
  },
  async ({ body }) => ({
    content: [
      { type: 'text', text: `noted ${body.length} chars` },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ],
  }),
);

server.registerTool(
  'fail',
  { description: 'Always fails', inputSchema: z.object({}), annotations: { readOnlyHint: true } },
  async () => ({ content: [{ type: 'text', text: 'boom' }], isError: true }),
);

server.registerTool(
  'env',
  {
    description: 'Reports whether a variable is visible',
    inputSchema: z.object({ name: z.string() }),
    annotations: { readOnlyHint: true },
  },
  async ({ name }) => ({
    content: [{ type: 'text', text: process.env[name] === undefined ? 'unset' : 'set' }],
  }),
);

await server.connect(new StdioServerTransport());
