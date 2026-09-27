import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as ops from '../ops.ts';
import { register, sessionIdSchema, text, type ToolContext } from './shared.ts';

export function registerSessionTools(server: McpServer, context: ToolContext): void {
  register(
    server,
    context,
    'browser_start',
    {
      title: 'Start browser session',
      description:
        'Opens a new browser session and returns its sessionId. The session (cookies, ' +
        'storage, page state) stays alive across tool calls until closed or idle-timed-out, ' +
        'so you can interact with the same page over many turns.',
      inputSchema: {
        url: z.string().optional().describe('Navigate here immediately after starting.'),
        userAgent: z
          .string()
          .optional()
          .describe('User-Agent for this session. Defaults to AITester/1.0.'),
        viewportWidth: z.number().int().min(200).max(4000).optional(),
        viewportHeight: z.number().int().min(200).max(4000).optional(),
        headless: z
          .boolean()
          .optional()
          .describe('Run headless. Defaults to true. Ignored when attaching over CDP.'),
        cdpUrl: z
          .string()
          .optional()
          .describe(
            'Attach to an already-running Chrome over the DevTools protocol instead of ' +
              'launching one, e.g. "http://127.0.0.1:9222" (Chrome started with ' +
              '--remote-debugging-port=9222). Defaults to WUT_CDP_URL when that is set.',
          ),
        useBrowserProfile: z
          .boolean()
          .optional()
          .describe(
            "With cdpUrl: drive the browser's own profile (its cookies, logins and tabs). " +
              'Defaults to true; false uses a fresh isolated context inside that browser.',
          ),
        devtools: z
          .boolean()
          .optional()
          .describe(
            "Make chrome-devtools-mcp's tools (devtools.* in browser_list_tools) available by " +
              'giving the browser a private DevTools port. Defaults to WUT_DEVTOOLS (off).',
          ),
        tab: z
          .string()
          .optional()
          .describe(
            "With the browser's profile: take over the open tab whose URL contains this, " +
              'instead of opening a new tab. Closing the session leaves that tab open.',
          ),
        baseUrl: z
          .string()
          .optional()
          .describe('Base URL that relative paths in browser_navigate resolve against.'),
        model: z
          .string()
          .optional()
          .describe(
            'Default model for run_task in this session, as "provider:modelId" ' +
              '(e.g. "google:gemini-flash-lite-latest" or "anthropic:claude-haiku-4-5").',
          ),
      },
    },
    async (args) => {
      const a = args as {
        url?: string;
        userAgent?: string;
        viewportWidth?: number;
        viewportHeight?: number;
        headless?: boolean;
        baseUrl?: string;
        model?: string;
        cdpUrl?: string;
        useBrowserProfile?: boolean;
        tab?: string;
        devtools?: boolean;
      };
      const { text: body } = await ops.startSession(context.sessions, context.config, {
        url: a.url,
        userAgent: a.userAgent,
        headless: a.headless,
        baseUrl: a.baseUrl,
        model: a.model,
        cdpUrl: a.cdpUrl,
        useBrowserProfile: a.useBrowserProfile,
        tab: a.tab,
        devtools: a.devtools,
        ...(a.viewportWidth || a.viewportHeight
          ? {
              viewport: {
                width: a.viewportWidth ?? 1280,
                height: a.viewportHeight ?? 720,
              },
            }
          : {}),
      });
      return text(body);
    },
  );

  register(
    server,
    context,
    'browser_list',
    {
      title: 'List sessions',
      description: 'Lists open browser sessions with their current URL, age, and idle time.',
      inputSchema: {},
      readOnly: true,
    },
    async () => text(ops.listSessions(context.sessions)),
  );

  register(
    server,
    context,
    'browser_close',
    {
      title: 'Close session',
      description: 'Closes a browser session and frees its resources.',
      inputSchema: { sessionId: sessionIdSchema },
    },
    async (args) => {
      const { sessionId } = args as unknown as { sessionId: string };
      await context.sessions.close(sessionId);
      return text(`Closed session ${sessionId}.`);
    },
  );
}
