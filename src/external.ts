import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { DevtoolsBridge } from './devtools.ts';
import { OpError } from './ops.ts';
import type { Session } from './session.ts';
import { callWebMcpTool, listWebMcpTools, type WebMcpTool } from './webmcp.ts';

/**
 * Tools this server does not define itself, reached through three generic
 * tools because an MCP client cannot pick up new tools mid-conversation — and
 * shared with run_task's agent, which gets the same three:
 *
 *   webmcp.<name>    tools the page publishes through WebMCP — read live
 *   devtools.<name>  chrome-devtools-mcp's tools, run against this session's tab
 */
export type Source = 'webmcp' | 'devtools';

const NO_DEVTOOLS =
  "chrome-devtools-mcp's tools need the session's browser to have a DevTools port, and this " +
  'session was started with devtools: false (or WUT_DEVTOOLS=0). Start a session without it, ' +
  'or attach to a Chrome with cdpUrl.';

function splitName(qualified: string): { source: Source; name: string } {
  const dot = qualified.indexOf('.');
  const source = qualified.slice(0, dot);
  if (dot === -1 || (source !== 'webmcp' && source !== 'devtools')) {
    throw new OpError(
      `Tool names are qualified by source: "webmcp.<name>" or "devtools.<name>", got "${qualified}". ` +
        'List the tools to see them.',
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

function devtoolsTools(bridge: DevtoolsBridge | undefined): Promise<Tool[]> {
  if (!bridge) throw new OpError(NO_DEVTOOLS);
  return bridge.listTools();
}

export async function listExternalTools(
  session: Session,
  bridge: DevtoolsBridge | undefined,
  source: 'all' | Source = 'all',
): Promise<string> {
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
      const tools = await devtoolsTools(bridge);
      sections.push(tools.map((tool) => `devtools.${tool.name} — ${firstLine(tool.description)}`).join('\n'));
    } catch (error) {
      sections.push((error as Error).message);
    }
  }
  return sections.join('\n').trim();
}

export async function externalToolSchema(
  session: Session,
  bridge: DevtoolsBridge | undefined,
  qualified: string,
): Promise<string> {
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
    return JSON.stringify({ name: qualified, description, inputSchema, annotations }, null, 2);
  }

  const tools = await devtoolsTools(bridge);
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new OpError(`chrome-devtools-mcp has no tool "${name}". List the tools to see them.`);
  }
  return JSON.stringify(
    {
      name: qualified,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      note: "pageId is filled in with this session's page; do not pass it.",
    },
    null,
    2,
  );
}

export async function callExternalTool(
  session: Session,
  bridge: DevtoolsBridge | undefined,
  qualified: string,
  input: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<CallToolResult> {
  const { source, name } = splitName(qualified);

  if (source === 'webmcp') {
    const result = await callWebMcpTool(session.page, name, input, timeoutMs);
    return {
      isError: result.isError,
      content: [
        { type: 'text', text: `Result of the page's WebMCP tool "${name}" (site-provided):` },
        ...result.content,
      ],
    } as CallToolResult;
  }

  if (!bridge) throw new OpError(NO_DEVTOOLS);
  return bridge.call(await session.ensurePage(), name, input);
}
