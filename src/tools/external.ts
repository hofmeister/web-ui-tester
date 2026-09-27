import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { OpError } from '../ops.ts';
import type { Session } from '../session.ts';
import { callWebMcpTool, listWebMcpTools, type WebMcpTool } from '../webmcp.ts';
import { register, sessionIdSchema, text, type ToolContext } from './shared.ts';

/**
 * Tools this server does not define itself, reached through three generic
 * tools because an MCP client cannot pick up new tools mid-conversation:
 *
 *   webmcp.<name>    tools the page publishes through WebMCP — read live
 *   devtools.<name>  chrome-devtools-mcp's tools, run against this session's tab
 */
type Source = 'webmcp' | 'devtools';

const NO_DEVTOOLS =
  "chrome-devtools-mcp's tools need the session's browser to have a DevTools port. " +
  'Start the session with browser_start devtools: true (or set WUT_DEVTOOLS=1 or WUT_CDP_PORT, ' +
  'or attach to a Chrome with cdpUrl).';

function splitName(qualified: string): { source: Source; name: string } {
  const dot = qualified.indexOf('.');
  const source = qualified.slice(0, dot);
  if (dot === -1 || (source !== 'webmcp' && source !== 'devtools')) {
    throw new OpError(
      `Tool names are qualified by source: "webmcp.<name>" or "devtools.<name>", got "${qualified}". ` +
        'browser_list_tools shows them.',
    );
  }
  return { source, name: qualified.slice(dot + 1) };
}

function webMcpFlags(tool: WebMcpTool): string {
  const notes: string[] = [];
  if (tool.annotations?.readOnly) notes.push('read-only');
  if (tool.annotations?.consequential) notes.push('CONSEQUENTIAL');
  if (tool.annotations?.untrustedContent) notes.push('untrusted output');
  return notes.length ? ` [${notes.join(', ')}]` : '';
}

function firstLine(description: string | undefined): string {
  const line = (description ?? '').split('\n')[0]!.trim();
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

async function devtoolsTools(context: ToolContext, session: Session): Promise<Tool[]> {
  const bridge = context.sessions.bridge(session);
  if (!bridge) throw new OpError(NO_DEVTOOLS);
  return bridge.listTools();
}

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
      const sections: string[] = [];

      if (source !== 'devtools') {
        try {
          const tools = await listWebMcpTools(session.page);
          sections.push(
            `## WebMCP tools published by ${session.page.url()}`,
            tools.length
              ? tools
                  .map((tool) => `webmcp.${tool.name} — ${firstLine(tool.description)}${webMcpFlags(tool)}`)
                  .join('\n')
              : 'None right now.',
          );
        } catch (error) {
          sections.push('## WebMCP tools', (error as Error).message);
        }
      }

      if (source !== 'webmcp') {
        sections.push('', '## chrome-devtools-mcp tools (element uids come from devtools.take_snapshot, not [ref=eN])');
        try {
          const tools = await devtoolsTools(context, session);
          sections.push(tools.map((tool) => `devtools.${tool.name} — ${firstLine(tool.description)}`).join('\n'));
        } catch (error) {
          sections.push((error as Error).message);
        }
      }
      return text(sections.join('\n').trim());
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
      const { sessionId, name: qualified } = args as unknown as { sessionId: string; name: string };
      const session = context.sessions.get(sessionId);
      const { source, name } = splitName(qualified);

      if (source === 'webmcp') {
        const tools = await listWebMcpTools(session.page);
        const tool = tools.find((candidate) => candidate.name === name);
        if (!tool) {
          throw new OpError(
            `The page publishes no WebMCP tool "${name}" right now` +
              (tools.length ? `; it has: ${tools.map((t) => t.name).join(', ')}.` : '.'),
          );
        }
        const { description, inputSchema, annotations } = tool;
        return text(JSON.stringify({ name: qualified, description, inputSchema, annotations }, null, 2));
      }

      const tools = await devtoolsTools(context, session);
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) {
        throw new OpError(`chrome-devtools-mcp has no tool "${name}". browser_list_tools shows them.`);
      }
      return text(
        JSON.stringify(
          {
            name: qualified,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations,
            note: 'pageId is filled in with this session\'s page; do not pass it.',
          },
          null,
          2,
        ),
      );
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
      const { source, name } = splitName(a.name);
      const input = a.arguments ?? {};

      if (source === 'webmcp') {
        const result = await callWebMcpTool(session.page, name, input, a.timeoutMs ?? 30_000);
        return {
          isError: result.isError,
          content: [
            { type: 'text', text: `Result of the page's WebMCP tool "${name}" (site-provided):` },
            ...result.content,
          ],
        } as CallToolResult;
      }

      const bridge = context.sessions.bridge(session);
      if (!bridge) throw new OpError(NO_DEVTOOLS);
      return bridge.call(await session.ensurePage(), name, input);
    },
  );
}
