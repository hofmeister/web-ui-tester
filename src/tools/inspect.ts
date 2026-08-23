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

export function registerInspectionTools(server: McpServer, context: ToolContext): void {
  register(
    server,
    context,
    'browser_snapshot',
    {
      title: 'Snapshot page',
      description:
        'Returns the accessibility tree of the page as compact YAML, with a [ref=eN] handle on ' +
        'every element. This is the primary way to see the page — use these refs to click and ' +
        'type. Far cheaper than HTML or screenshots. Scope it with ref/css/role, cap it with ' +
        'depth, or page through it with offset when a page is large.',
      inputSchema: {
        sessionId: sessionIdSchema,
        ...targetShape,
        depth: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Limit tree depth. Useful for a quick overview of a large page.'),
        interactiveOnly: z
          .boolean()
          .optional()
          .describe('Return only actionable elements (buttons, links, inputs, ...).'),
        boxes: z.boolean().optional().describe('Include [box=x,y,w,h] viewport coordinates.'),
        maxChars: z.number().int().min(500).optional().describe('Character budget for this call.'),
        offset: z.number().int().min(0).optional().describe('Start offset, for paging.'),
      },
      readOnly: true,
    },
    async (args) => {
      const a = args as unknown as TargetArgs & {
        depth?: number;
        interactiveOnly?: boolean;
        boxes?: boolean;
        maxChars?: number;
        offset?: number;
      };
      const session = context.sessions.get(a.sessionId);
      return text(
        await ops.snapshot(session, {
          target: target(a),
          depth: a.depth,
          boxes: a.boxes,
          interactiveOnly: a.interactiveOnly,
          maxChars: a.maxChars ?? context.config.maxOutputChars,
          offset: a.offset,
        }),
      );
    },
  );

  register(
    server,
    context,
    'browser_query',
    {
      title: 'Query elements',
      description:
        'Finds elements by role+name, visible text, or CSS, and returns a compact line per match ' +
        'including its ref and visible/enabled state. Use this instead of a full snapshot when ' +
        'you already know what you are looking for.',
      inputSchema: {
        sessionId: sessionIdSchema,
        role: z.string().optional().describe('ARIA role, e.g. "button".'),
        name: z.string().optional().describe('Accessible name to match alongside role.'),
        text: z.string().optional().describe('Visible text to match.'),
        css: z.string().optional().describe('CSS selector to match.'),
        limit: z.number().int().min(1).max(50).optional().describe('Max matches (default 10).'),
      },
      readOnly: true,
    },
    async (args) => {
      const a = args as unknown as {
        sessionId: string;
        role?: string;
        name?: string;
        text?: string;
        css?: string;
        limit?: number;
      };
      const session = context.sessions.get(a.sessionId);
      return text(
        await ops.query(
          session,
          { role: a.role, name: a.name, text: a.text, css: a.css },
          a.limit,
        ),
      );
    },
  );

  register(
    server,
    context,
    'browser_read_text',
    {
      title: 'Read text',
      description:
        'Returns the rendered text of the page or of one element subtree — the readable content ' +
        'without markup. Use it to verify copy, read results, or check an error message.',
      inputSchema: {
        sessionId: sessionIdSchema,
        ...targetShape,
        maxChars: z.number().int().min(500).optional(),
        offset: z.number().int().min(0).optional().describe('Start offset, for paging.'),
      },
      readOnly: true,
    },
    async (args) => {
      const a = args as unknown as TargetArgs & { maxChars?: number; offset?: number };
      const session = context.sessions.get(a.sessionId);
      return text(
        await ops.readText(session, {
          target: target(a),
          maxChars: a.maxChars ?? 8_000,
          offset: a.offset,
        }),
      );
    },
  );

  register(
    server,
    context,
    'browser_screenshot',
    {
      title: 'Screenshot',
      description:
        'Captures a JPEG of the page or an element. Use this only for genuinely visual questions ' +
        '(layout, styling, rendering); browser_snapshot and browser_read_text are faster and ' +
        'cheaper for finding and verifying content.',
      inputSchema: {
        sessionId: sessionIdSchema,
        ...targetShape,
        fullPage: z.boolean().optional().describe('Capture the full scrollable page.'),
      },
      readOnly: true,
    },
    async (args) => {
      const a = args as unknown as TargetArgs & { fullPage?: boolean };
      const session = context.sessions.get(a.sessionId);
      const shot = await ops.screenshot(session, { target: target(a), fullPage: a.fullPage });
      return {
        content: [
          { type: 'text' as const, text: await ops.stateLine(session) },
          { type: 'image' as const, data: shot.base64, mimeType: shot.mimeType },
        ],
      };
    },
  );
}
