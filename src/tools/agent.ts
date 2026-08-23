import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatRunResult, runTask } from '../agent.js';
import { register, sessionIdSchema, text, type ToolContext } from './shared.js';

export function registerAgentTools(server: McpServer, context: ToolContext): void {
  register(
    server,
    context,
    'run_task',
    {
      title: 'Run UI task',
      description:
        'Delegates a multi-step UI task to a fast built-in browser agent, which drives the ' +
        'session itself and reports what it did and found. Use it for goal-shaped work ' +
        '("log in as demo@example.com and check the dashboard loads", "walk the checkout flow ' +
        'and report anything broken") rather than driving each click yourself. The session is ' +
        'left on whatever page the agent ended on, so you can inspect it afterwards.',
      inputSchema: {
        sessionId: sessionIdSchema,
        instruction: z.string().describe('What the agent should accomplish.'),
        expectation: z
          .string()
          .optional()
          .describe('What a successful outcome looks like, if it is worth stating.'),
        maxSteps: z
          .number()
          .int()
          .min(1)
          .max(60)
          .optional()
          .describe('Step budget for the agent loop (default 20).'),
        model: z
          .string()
          .optional()
          .describe(
            'Override the model for this call, as "provider:modelId" — e.g. ' +
              '"google:gemini-flash-lite-latest" or "anthropic:claude-haiku-4-5".',
          ),
      },
    },
    async (args) => {
      const a = args as unknown as {
        sessionId: string;
        instruction: string;
        expectation?: string;
        maxSteps?: number;
        model?: string;
      };
      const session = context.sessions.get(a.sessionId);
      const result = await runTask(session, context.config, {
        instruction: a.instruction,
        expectation: a.expectation,
        maxSteps: a.maxSteps,
        model: a.model,
      });
      return {
        ...text(formatRunResult(result)),
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );
}
