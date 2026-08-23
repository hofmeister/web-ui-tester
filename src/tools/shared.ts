import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../config.js';
import { OpError } from '../ops.js';
import type { SessionManager } from '../session.js';
import { clipHard } from '../snapshot.js';

export interface ToolContext {
  sessions: SessionManager;
  config: Config;
}

export const sessionIdSchema = z
  .string()
  .describe('Session id returned by browser_start.');

/** Ref / css / role+name targeting, shared by every element-addressing tool. */
export const targetShape = {
  ref: z
    .string()
    .optional()
    .describe(
      'Element ref from the most recent snapshot, e.g. "e12". Preferred — refs are exact. ' +
        'Only valid for the page state that produced them.',
    ),
  css: z.string().optional().describe('CSS selector, as an alternative to ref.'),
  role: z
    .string()
    .optional()
    .describe('ARIA role, e.g. "button". Combine with name for an accessible-name match.'),
  name: z.string().optional().describe('Accessible name to match alongside role.'),
  index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Which match to use when the selector is ambiguous (0-based, default 0).'),
};

/**
 * Caller budgets must stay within the configured cap: a larger value would be
 * honoured by the tool and then clipped again by capResult, producing two
 * conflicting paging notes and a gap between pages.
 */
export function budget(requested: number | undefined, config: Config): number {
  return Math.min(requested ?? config.maxOutputChars, config.maxOutputChars);
}

export function text(body: string): CallToolResult {
  return { content: [{ type: 'text', text: body }] };
}

export function errorText(body: string): CallToolResult {
  return { content: [{ type: 'text', text: body }], isError: true };
}

/**
 * Wraps a tool body so operational failures come back as readable, actionable
 * tool errors rather than protocol-level exceptions, and so every result
 * respects the output cap.
 */
export function register(
  server: McpServer,
  context: ToolContext,
  name: string,
  spec: {
    title: string;
    description: string;
    inputSchema: Record<string, z.ZodType>;
    /** Declaring one makes the result's structuredContent machine-readable. */
    outputSchema?: Record<string, z.ZodType>;
    readOnly?: boolean;
  },
  handler: (args: Record<string, never>) => Promise<CallToolResult>,
): void {
  server.registerTool(
    name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      ...(spec.outputSchema ? { outputSchema: spec.outputSchema } : {}),
      annotations: {
        readOnlyHint: spec.readOnly ?? false,
        openWorldHint: true,
      },
    },
    (async (args: Record<string, never>) => {
      try {
        const result = await handler(args);
        return capResult(result, context.config.maxOutputChars);
      } catch (error) {
        if (error instanceof OpError) return errorText(error.message);
        return errorText(`${name} failed: ${(error as Error).message}`);
      }
    }) as Parameters<McpServer['registerTool']>[2],
  );
}

function capResult(result: CallToolResult, maxChars: number): CallToolResult {
  return {
    ...result,
    content: result.content.map((block) =>
      block.type === 'text' ? { ...block, text: clipHard(block.text, maxChars) } : block,
    ),
  };
}
