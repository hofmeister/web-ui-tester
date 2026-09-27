import type { CDPSession, Page } from 'playwright';
import { OpError } from './ops.ts';

/**
 * WebMCP lets a site publish its own tools — imperatively through
 * document.modelContext.registerTool(), or declaratively with
 * <form toolname="…">. Chrome surfaces them through the DevTools protocol's
 * WebMCP domain, so they are read here straight from the session's page, with
 * no extra server and no exposed debugging port.
 */
export interface WebMcpTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnly?: boolean;
    untrustedContent?: boolean;
    consequential?: boolean;
    autosubmit?: boolean;
  };
  frameId: string;
}

interface ToolResponse {
  invocationId: string;
  status: 'Completed' | 'Canceled' | 'Error';
  output?: unknown;
  errorText?: string;
  exception?: { description?: string };
}

/** The WebMCP domain is newer than Playwright's protocol typings. */
type LooseCdp = {
  send(method: string, params?: object): Promise<any>;
  on(event: string, handler: (params: any) => void): void;
};

export const WEBMCP_UNSUPPORTED =
  'This browser does not expose WebMCP. It needs Chrome 150 or newer with the WebMCP ' +
  'feature on: browsers this server launches have it, and a Chrome you attach to over CDP ' +
  'must be started with --enable-features=WebMCP.';

/**
 * Opens a fresh DevTools session on the page and enables WebMCP, which replays
 * every tool registered right now. Fresh each time on purpose: a site's tools
 * come and go as it navigates and re-renders, so a cached list would lie.
 */
async function withWebMcp<T>(
  page: Page,
  body: (cdp: LooseCdp, tools: WebMcpTool[]) => Promise<T>,
): Promise<T> {
  const session: CDPSession = await page.context().newCDPSession(page);
  const cdp = session as unknown as LooseCdp;
  const tools = new Map<string, WebMcpTool>();
  const key = (tool: { name: string; frameId: string }) => `${tool.frameId} ${tool.name}`;
  cdp.on('WebMCP.toolsAdded', ({ tools: added }: { tools: WebMcpTool[] }) => {
    for (const tool of added) tools.set(key(tool), tool);
  });
  cdp.on('WebMCP.toolsRemoved', ({ tools: removed }: { tools: WebMcpTool[] }) => {
    for (const tool of removed) tools.delete(key(tool));
  });
  try {
    try {
      await cdp.send('WebMCP.enable');
    } catch {
      throw new OpError(WEBMCP_UNSUPPORTED);
    }
    // The replayed toolsAdded events can trail the enable reply by a moment.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return await body(cdp, [...tools.values()]);
  } finally {
    await session.detach().catch(() => {});
  }
}

export function listWebMcpTools(page: Page): Promise<WebMcpTool[]> {
  return withWebMcp(page, async (_cdp, tools) => tools);
}

export interface WebMcpCallResult {
  isError: boolean;
  /** MCP content blocks when the tool returned them, else its output as JSON text. */
  content: Array<{ type: string; [key: string]: unknown }>;
}

export async function callWebMcpTool(
  page: Page,
  name: string,
  input: Record<string, unknown>,
  timeoutMs: number,
): Promise<WebMcpCallResult> {
  return withWebMcp(page, async (cdp, tools) => {
    const matches = tools.filter((tool) => tool.name === name);
    if (!matches.length) {
      const available = tools.map((tool) => tool.name);
      throw new OpError(
        `The page has no WebMCP tool "${name}". ` +
          (available.length
            ? `It has: ${available.join(', ')}.`
            : 'It registers no WebMCP tools right now.'),
      );
    }
    // The same name can be registered by an iframe; the top frame's is the page's own.
    const { frameTree } = await cdp.send('Page.getFrameTree').catch(() => ({ frameTree: undefined }));
    const tool = matches.find((match) => match.frameId === frameTree?.frame?.id) ?? matches[0]!;

    // Subscribed before invoking: a fast tool can answer before invokeTool returns.
    const responses = new Map<string, ToolResponse>();
    let wake: () => void = () => {};
    cdp.on('WebMCP.toolResponded', (response: ToolResponse) => {
      responses.set(response.invocationId, response);
      wake();
    });

    let invocationId: string;
    try {
      ({ invocationId } = await cdp.send('WebMCP.invokeTool', {
        frameId: tool.frameId,
        toolName: tool.name,
        input,
      }));
    } catch (error) {
      throw new OpError(`Invoking WebMCP tool "${name}" failed: ${(error as Error).message}`);
    }

    const response = await new Promise<ToolResponse | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), timeoutMs);
      wake = () => {
        const found = responses.get(invocationId);
        if (found) {
          clearTimeout(timer);
          resolve(found);
        }
      };
      wake();
    });

    if (!response) {
      await cdp.send('WebMCP.cancelInvocation', { invocationId }).catch(() => {});
      throw new OpError(
        `WebMCP tool "${name}" did not answer within ${timeoutMs}ms and was cancelled. ` +
          'Pass a larger timeoutMs if it is expected to be slow.',
      );
    }
    if (response.status === 'Completed') {
      return { isError: false, content: asContent(response.output) };
    }
    const reason =
      response.exception?.description || response.errorText || `the call was ${response.status.toLowerCase()}`;
    return { isError: true, content: [{ type: 'text', text: `WebMCP tool "${name}" failed: ${reason}` }] };
  });
}

function asContent(output: unknown): WebMcpCallResult['content'] {
  const blocks = (output as { content?: unknown } | undefined)?.content;
  if (
    Array.isArray(blocks) &&
    blocks.every((block) => block && typeof block === 'object' && typeof block.type === 'string')
  ) {
    return blocks;
  }
  if (output === undefined) return [{ type: 'text', text: '(the tool returned nothing)' }];
  return [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output, null, 2) }];
}
