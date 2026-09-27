import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Page } from 'playwright';
import { OpError } from './ops.ts';

/**
 * The copy installed as this server's dependency, run on the current Node so it
 * works where npx does not exist (the Claude Desktop extension); npx otherwise.
 */
function defaultCommand(): string[] {
  try {
    const manifest = createRequire(import.meta.url).resolve('chrome-devtools-mcp/package.json');
    return [process.execPath, join(dirname(manifest), 'build/src/bin/chrome-devtools-mcp.js')];
  } catch {
    return ['npx', '-y', 'chrome-devtools-mcp@latest'];
  }
}

/** A first start through npx may download the package. */
const CONNECT_TIMEOUT_MS = 120_000;
const STDERR_TAIL_LINES = 20;

/**
 * Runs chrome-devtools-mcp as a child MCP server attached to one browser's
 * DevTools endpoint, so its tools reach the caller through this server
 * without the client having to configure a second MCP server — which it
 * could not do partway through a conversation anyway.
 */
export class DevtoolsBridge {
  private client?: Promise<Client>;
  private tools?: Tool[];
  private readonly stderrTail: string[] = [];
  /** chrome-devtools-mcp numbers pages itself; this maps ours onto its ids. */
  private readonly pageIds = new WeakMap<Page, number>();

  private readonly endpoint: string;
  private readonly command: string[];

  constructor(endpoint: string, command?: string) {
    this.endpoint = endpoint;
    this.command = command ? splitCommand(command) : defaultCommand();
  }

  private connect(): Promise<Client> {
    if (this.client) return this.client;
    const [bin, ...baseArgs] = this.command;
    if (!bin) throw new OpError('WUT_DEVTOOLS_MCP_COMMAND is empty.');
    const target = /^wss?:/i.test(this.endpoint)
      ? ['--wsEndpoint', this.endpoint]
      : ['--browserUrl', this.endpoint];
    const transport = new StdioClientTransport({
      command: bin,
      // No telemetry, CrUX lookups or update pings, matching this server's own promise.
      args: [...baseArgs, ...target, '--no-usage-statistics', '--no-performance-crux'],
      env: {
        ...(process.env as Record<string, string>),
        CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
        CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
      },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail.push(...chunk.toString('utf8').split('\n').filter(Boolean));
      this.stderrTail.splice(0, Math.max(0, this.stderrTail.length - STDERR_TAIL_LINES));
    });

    const client = new Client({ name: 'web-ui-tester', version: '0.1.0' });
    const pending = (async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          client.connect(transport),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`no answer within ${CONNECT_TIMEOUT_MS / 1000}s`)),
              CONNECT_TIMEOUT_MS,
            );
          }),
        ]);
      } catch (error) {
        await transport.close().catch(() => {});
        throw new OpError(
          `Could not start chrome-devtools-mcp (${this.command.join(' ')}): ${(error as Error).message}` +
            (this.stderrTail.length ? `\n${this.stderrTail.join('\n')}` : '') +
            '\nWUT_DEVTOOLS_MCP_COMMAND can point at another copy.',
        );
      } finally {
        clearTimeout(timer);
      }
      return client;
    })();
    this.client = pending;
    // A crash or a failed start must not poison the slot; the next call retries.
    const forget = () => {
      if (this.client === pending) {
        this.client = undefined;
        this.tools = undefined;
      }
    };
    client.onclose = forget;
    pending.catch(forget);
    return pending;
  }

  /** The child's tools, with pageId hidden: the bridge fills it in per session. */
  async listTools(): Promise<Tool[]> {
    if (!this.tools) {
      const client = await this.connect();
      const { tools } = await client.listTools();
      this.tools = tools;
    }
    return this.tools.map(withoutPageId);
  }

  async call(page: Page, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const client = await this.connect();
    await this.listTools();
    const tool = this.tools!.find((candidate) => candidate.name === name);
    if (!tool) {
      throw new OpError(
        `chrome-devtools-mcp has no tool "${name}". It has: ${this.tools!.map((t) => t.name).join(', ')}.`,
      );
    }
    const needsPage = Boolean(tool.inputSchema.properties?.pageId);
    const run = async () => {
      const full = needsPage ? { ...args, pageId: await this.pageId(client, page) } : args;
      return (await client.callTool({ name, arguments: full })) as CallToolResult;
    };
    const result = await run();
    // Its page ids outlive neither a crash nor the page; re-resolve once.
    if (needsPage && result.isError && /page/i.test(textOf(result)) && /not found|no page|closed/i.test(textOf(result))) {
      this.pageIds.delete(page);
      return run();
    }
    return result;
  }

  /**
   * chrome-devtools-mcp sees every tab in the browser, including other
   * sessions' and the user's own. Tagging the session's page title with a
   * nonce for one list_pages call picks it out even when URLs repeat.
   */
  private async pageId(client: Client, page: Page): Promise<number> {
    const cached = this.pageIds.get(page);
    if (cached !== undefined) return cached;

    const nonce = `wut-${randomBytes(4).toString('hex')}`;
    const original = await page
      .evaluate((mark) => {
        const title = document.title;
        document.title = `${mark} ${title}`;
        return title;
      }, nonce)
      .catch(() => undefined);
    let listing: string;
    try {
      listing = textOf((await client.callTool({ name: 'list_pages', arguments: {} })) as CallToolResult);
    } finally {
      if (original !== undefined) {
        await page.evaluate((title) => void (document.title = title), original).catch(() => {});
      }
    }

    const lines = listing.split('\n');
    let line = lines.find((candidate) => candidate.includes(nonce));
    if (!line) {
      const byUrl = lines.filter((candidate) => candidate.includes(page.url()));
      if (byUrl.length === 1) line = byUrl[0];
    }
    const id = line ? Number(/^\s*(\d+):/.exec(line)?.[1]) : NaN;
    if (!Number.isInteger(id)) {
      throw new OpError(
        `chrome-devtools-mcp does not list this session's page (${page.url()}).\n${listing}`,
      );
    }
    this.pageIds.set(page, id);
    return id;
  }

  async close(): Promise<void> {
    const pending = this.client;
    this.client = undefined;
    if (pending) await pending.then((client) => client.close()).catch(() => {});
  }
}

function withoutPageId(tool: Tool): Tool {
  const properties = tool.inputSchema.properties;
  if (!properties || !('pageId' in properties)) return tool;
  const { pageId: _hidden, ...rest } = properties;
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: rest,
      required: tool.inputSchema.required?.filter((name) => name !== 'pageId'),
    },
  };
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** Whitespace-separated, with "double quotes" around arguments that contain spaces. */
export function splitCommand(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]!);
}
