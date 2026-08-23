import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as ops from '../ops.js';
import { register, sessionIdSchema, targetShape, text, type ToolContext } from './shared.js';

type TargetArgs = {
  sessionId: string;
  ref?: string;
  css?: string;
  role?: string;
  name?: string;
  index?: number;
};

function target(args: TargetArgs): ops.Target {
  return { ref: args.ref, css: args.css, role: args.role, name: args.name, index: args.index };
}

export function registerDiagnosticTools(server: McpServer, context: ToolContext): void {
  register(
    server,
    context,
    'browser_console',
    {
      title: 'Console log',
      description:
        'Returns buffered console messages and uncaught page errors (with stacks). Check this ' +
        'whenever the page misbehaves — it usually names the failure directly.',
      inputSchema: {
        sessionId: sessionIdSchema,
        level: z
          .enum(['error', 'warning', 'info', 'all'])
          .optional()
          .describe('Filter by level. "error" also includes uncaught page errors.'),
        limit: z.number().int().min(1).max(200).optional().describe('Max entries (default 50).'),
        sinceLastCall: z
          .boolean()
          .optional()
          .describe('Only entries since the previous call (default true).'),
        clear: z.boolean().optional().describe('Empty the buffer after reading.'),
      },
      readOnly: true,
    },
    async (args) => {
      const a = args as unknown as {
        sessionId: string;
        level?: 'error' | 'warning' | 'info' | 'all';
        limit?: number;
        sinceLastCall?: boolean;
        clear?: boolean;
      };
      const session = context.sessions.get(a.sessionId);
      return text(
        ops.consoleLog(session, {
          level: a.level,
          limit: a.limit,
          sinceLastCall: a.sinceLastCall ?? true,
          clear: a.clear,
        }),
      );
    },
  );

  register(
    server,
    context,
    'browser_network',
    {
      title: 'Network log',
      description:
        'Lists network requests the session has made, with status, size, and duration. Each line ' +
        'carries an #id for browser_request_detail. Filter by URL substring or by failure status.',
      inputSchema: {
        sessionId: sessionIdSchema,
        filter: z.string().optional().describe('Only requests whose URL contains this substring.'),
        status: z
          .enum(['failed', '4xx', '5xx', 'all'])
          .optional()
          .describe('"failed" covers network failures plus any 4xx/5xx.'),
        limit: z.number().int().min(1).max(100).optional().describe('Max entries (default 30).'),
      },
      readOnly: true,
    },
    async (args) => {
      const a = args as unknown as {
        sessionId: string;
        filter?: string;
        status?: 'failed' | '4xx' | '5xx' | 'all';
        limit?: number;
      };
      const session = context.sessions.get(a.sessionId);
      return text(ops.networkLog(session, { filter: a.filter, status: a.status, limit: a.limit }));
    },
  );

  register(
    server,
    context,
    'browser_request_detail',
    {
      title: 'Request detail',
      description:
        'Inspects one request from browser_network: headers, timing breakdown, request body, or ' +
        'response body. Small text responses are cached, so they stay readable after navigation.',
      inputSchema: {
        sessionId: sessionIdSchema,
        id: z.number().int().min(1).describe('The #id from browser_network.'),
        part: z
          .enum(['summary', 'headers', 'requestBody', 'responseBody'])
          .optional()
          .describe('Which part to return. Defaults to "summary".'),
        maxChars: z.number().int().min(500).optional(),
      },
      readOnly: true,
    },
    async (args) => {
      const a = args as unknown as {
        sessionId: string;
        id: number;
        part?: 'summary' | 'headers' | 'requestBody' | 'responseBody';
        maxChars?: number;
      };
      const session = context.sessions.get(a.sessionId);
      return text(
        await ops.requestDetail(
          session,
          a.id,
          a.part ?? 'summary',
          a.maxChars ?? 10_000,
        ),
      );
    },
  );

  register(
    server,
    context,
    'browser_evaluate',
    {
      title: 'Evaluate JavaScript',
      description:
        'Runs JavaScript in the page and returns the JSON-serialized result. Accepts a bare ' +
        'expression ("document.title") or a function ("el => el.value"). When an element is ' +
        'targeted, it is bound to `el`. Use it to read state the accessibility tree does not expose.',
      inputSchema: {
        sessionId: sessionIdSchema,
        expression: z.string().describe('Expression or function source to evaluate.'),
        ...targetShape,
        maxChars: z.number().int().min(500).optional(),
      },
      readOnly: false,
    },
    async (args) => {
      const a = args as unknown as TargetArgs & { expression: string; maxChars?: number };
      const session = context.sessions.get(a.sessionId);
      return text(await ops.evaluate(session, a.expression, target(a), a.maxChars ?? 10_000));
    },
  );

  register(
    server,
    context,
    'browser_inspect_element',
    {
      title: 'Inspect element',
      description:
        'DevTools-style inspection of one element: tag, attributes, box model, form state, and ' +
        'computed styles. Use it to diagnose layout and visibility problems.',
      inputSchema: {
        sessionId: sessionIdSchema,
        ...targetShape,
        props: z
          .array(z.string())
          .optional()
          .describe('Extra computed CSS properties to include, e.g. ["flex-direction","margin"].'),
      },
      readOnly: true,
    },
    async (args) => {
      const a = args as unknown as TargetArgs & { props?: string[] };
      const session = context.sessions.get(a.sessionId);
      return text(await ops.inspectElement(session, target(a), a.props ?? []));
    },
  );
}
