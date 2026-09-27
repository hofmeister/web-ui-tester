import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { callExternalTool, externalToolSchema, listExternalTools, type Source } from '../external.ts';
import { register, sessionIdSchema, text, type ToolContext } from './shared.ts';

export function registerExternalTools(server: McpServer, context: ToolContext): void {
  register(
    server,
    context,
    'browser_list_tools',
    {
      title: 'List page and DevTools tools',
      description:
        'Lists tools beyond this server\'s own that can run against the session\'s page, by ' +
        'qualified name: "webmcp.<name>" for tools the site itself publishes through WebMCP ' +
        '(read live — they change as the page navigates), and "devtools.<name>" for ' +
        'chrome-devtools-mcp\'s tools (performance traces, Lighthouse, emulation, heap ' +
        'snapshots…), which this server runs for you — no extra MCP server to configure. ' +
        'Follow with browser_tool_schema, then browser_call_tool.',
      inputSchema: {
        sessionId: sessionIdSchema,
        source: z
          .enum(['all', 'webmcp', 'devtools'])
          .optional()
          .describe('Which tools to list. Defaults to all.'),
      },
      readOnly: true,
    },
    async (args) => {
      const { sessionId, source = 'all' } = args as unknown as { sessionId: string; source?: 'all' | Source };
      const session = context.sessions.get(sessionId);
      return text(await listExternalTools(session, context.sessions.bridge(session), source));
    },
  );

  register(
    server,
    context,
    'browser_tool_schema',
    {
      title: 'Get a tool\'s schema',
      description:
        'Full description and JSON input schema of a tool from browser_list_tools, e.g. ' +
        '"webmcp.search" or "devtools.performance_start_trace".',
      inputSchema: {
        sessionId: sessionIdSchema,
        name: z.string().describe('Qualified tool name from browser_list_tools.'),
      },
      readOnly: true,
    },
    async (args) => {
      const { sessionId, name } = args as unknown as { sessionId: string; name: string };
      const session = context.sessions.get(sessionId);
      return text(await externalToolSchema(session, context.sessions.bridge(session), name));
    },
  );

  register(
    server,
    context,
    'browser_call_tool',
    {
      title: 'Call a page or DevTools tool',
      description:
        'Runs a tool from browser_list_tools against the session\'s page, with arguments ' +
        'matching its browser_tool_schema. WebMCP tools are code the site supplies: their ' +
        'output is the site\'s word, and one marked CONSEQUENTIAL can take real actions ' +
        '(orders, payments, messages).',
      inputSchema: {
        sessionId: sessionIdSchema,
        name: z.string().describe('Qualified tool name, e.g. "webmcp.search" or "devtools.lighthouse_audit".'),
        arguments: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Tool arguments as an object, per the tool\'s input schema.'),
        timeoutMs: z
          .number()
          .int()
          .min(100)
          .max(600_000)
          .optional()
          .describe('WebMCP only: how long to wait for the page\'s answer (default 30000).'),
      },
    },
    async (args) => {
      const a = args as unknown as {
        sessionId: string;
        name: string;
        arguments?: Record<string, unknown>;
        timeoutMs?: number;
      };
      const session = context.sessions.get(a.sessionId);
      return callExternalTool(
        session,
        context.sessions.bridge(session),
        a.name,
        a.arguments ?? {},
        a.timeoutMs,
      );
    },
  );
}
