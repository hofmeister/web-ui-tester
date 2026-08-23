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

const REF_NOTE =
  'Address the element by ref (from the latest browser_snapshot), or by css, or by role+name.';

export function registerInteractionTools(server: McpServer, context: ToolContext): void {
  register(
    server,
    context,
    'browser_navigate',
    {
      title: 'Navigate',
      description:
        'Navigates the session to a URL and returns the new page state plus a fresh snapshot ' +
        'with element refs. Relative URLs resolve against the session baseUrl.',
      inputSchema: {
        sessionId: sessionIdSchema,
        url: z.string().describe('Absolute URL, or a path relative to the session baseUrl.'),
        waitUntil: z
          .enum(['load', 'domcontentloaded', 'networkidle'])
          .optional()
          .describe('Navigation completion condition. Defaults to "load".'),
      },
    },
    async (args) => {
      const a = args as unknown as {
        sessionId: string;
        url: string;
        waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
      };
      const session = context.sessions.get(a.sessionId);
      return text(await ops.navigate(session, a.url, a.waitUntil));
    },
  );

  register(
    server,
    context,
    'browser_click',
    {
      title: 'Click',
      description: `Clicks an element. ${REF_NOTE} Reports any navigation, console errors, or network activity the click triggered.`,
      inputSchema: {
        sessionId: sessionIdSchema,
        ...targetShape,
        doubleClick: z.boolean().optional(),
        button: z.enum(['left', 'right', 'middle']).optional(),
        modifiers: z
          .array(z.enum(['Alt', 'Control', 'Meta', 'Shift']))
          .optional()
          .describe('Modifier keys to hold during the click.'),
      },
    },
    async (args) => {
      const a = args as unknown as TargetArgs & {
        doubleClick?: boolean;
        button?: 'left' | 'right' | 'middle';
        modifiers?: string[];
      };
      const session = context.sessions.get(a.sessionId);
      return text(
        await ops.click(session, target(a), {
          doubleClick: a.doubleClick,
          button: a.button,
          modifiers: a.modifiers,
        }),
      );
    },
  );

  register(
    server,
    context,
    'browser_type',
    {
      title: 'Type text',
      description: `Types text into an input or textarea. ${REF_NOTE}`,
      inputSchema: {
        sessionId: sessionIdSchema,
        ...targetShape,
        text: z.string().describe('Text to enter.'),
        submit: z.boolean().optional().describe('Press Enter afterwards.'),
        clear: z
          .boolean()
          .optional()
          .describe('Replace existing content (default true). False appends keystroke by keystroke.'),
      },
    },
    async (args) => {
      const a = args as unknown as TargetArgs & {
        text: string;
        submit?: boolean;
        clear?: boolean;
      };
      const session = context.sessions.get(a.sessionId);
      return text(
        await ops.type(session, target(a), a.text, { submit: a.submit, clear: a.clear }),
      );
    },
  );

  register(
    server,
    context,
    'browser_press_key',
    {
      title: 'Press key',
      description:
        'Presses a key, optionally focused on an element. Key names follow Playwright ' +
        '("Enter", "Escape", "ArrowDown", "Control+a").',
      inputSchema: { sessionId: sessionIdSchema, key: z.string(), ...targetShape },
    },
    async (args) => {
      const a = args as unknown as TargetArgs & { key: string };
      const session = context.sessions.get(a.sessionId);
      return text(await ops.pressKey(session, a.key, target(a)));
    },
  );

  register(
    server,
    context,
    'browser_hover',
    {
      title: 'Hover',
      description: `Hovers an element, e.g. to reveal a menu or tooltip. ${REF_NOTE}`,
      inputSchema: { sessionId: sessionIdSchema, ...targetShape },
    },
    async (args) => {
      const a = args as unknown as TargetArgs;
      const session = context.sessions.get(a.sessionId);
      return text(await ops.hover(session, target(a)));
    },
  );

  register(
    server,
    context,
    'browser_select_option',
    {
      title: 'Select option',
      description: `Selects one or more options in a <select>. ${REF_NOTE}`,
      inputSchema: {
        sessionId: sessionIdSchema,
        ...targetShape,
        values: z.array(z.string()).describe('Option values or labels to select.'),
      },
    },
    async (args) => {
      const a = args as unknown as TargetArgs & { values: string[] };
      const session = context.sessions.get(a.sessionId);
      return text(await ops.selectOption(session, target(a), a.values));
    },
  );

  register(
    server,
    context,
    'browser_scroll',
    {
      title: 'Scroll',
      description:
        'Scrolls an element into view, or scrolls the page by a pixel delta when no element is given.',
      inputSchema: {
        sessionId: sessionIdSchema,
        ...targetShape,
        dy: z.number().optional().describe('Vertical pixels to scroll (positive = down).'),
        dx: z.number().optional().describe('Horizontal pixels to scroll.'),
      },
    },
    async (args) => {
      const a = args as unknown as TargetArgs & { dy?: number; dx?: number };
      const session = context.sessions.get(a.sessionId);
      return text(await ops.scroll(session, { target: target(a), dy: a.dy, dx: a.dx }));
    },
  );

  register(
    server,
    context,
    'browser_wait_for',
    {
      title: 'Wait for condition',
      description:
        'Waits for text to appear, text to disappear, or a selector to become visible. ' +
        'Use after actions that trigger async updates.',
      inputSchema: {
        sessionId: sessionIdSchema,
        text: z.string().optional().describe('Wait until this text is visible.'),
        textGone: z.string().optional().describe('Wait until this text is gone.'),
        selector: z.string().optional().describe('Wait until this CSS selector is visible.'),
        timeoutMs: z.number().int().min(100).max(15000).optional(),
      },
    },
    async (args) => {
      const a = args as unknown as {
        sessionId: string;
        text?: string;
        textGone?: string;
        selector?: string;
        timeoutMs?: number;
      };
      const session = context.sessions.get(a.sessionId);
      return text(
        await ops.waitFor(session, {
          text: a.text,
          textGone: a.textGone,
          selector: a.selector,
          timeoutMs: a.timeoutMs,
        }),
      );
    },
  );

  register(
    server,
    context,
    'browser_go_back',
    {
      title: 'Go back',
      description: 'Navigates back in history and returns the new page state with fresh refs.',
      inputSchema: { sessionId: sessionIdSchema },
    },
    async (args) => {
      const { sessionId } = args as unknown as { sessionId: string };
      return text(await ops.goBack(context.sessions.get(sessionId)));
    },
  );

  register(
    server,
    context,
    'browser_handle_dialog',
    {
      title: 'Handle dialog',
      description:
        'Answers an alert/confirm/prompt. A dialog blocks the page until it is answered, so an ' +
        'unanswered one is dismissed automatically rather than stalling the action that opened ' +
        'it. Call this BEFORE the action that triggers a dialog to arm the answer — that is the ' +
        'only way to accept one or supply prompt() text. Called while a dialog is open, it ' +
        'answers that dialog immediately.',
      inputSchema: {
        sessionId: sessionIdSchema,
        accept: z.boolean().describe('True to accept, false to dismiss.'),
        promptText: z.string().optional().describe('Text to enter into a prompt() dialog.'),
      },
    },
    async (args) => {
      const a = args as unknown as { sessionId: string; accept: boolean; promptText?: string };
      const session = context.sessions.get(a.sessionId);
      return text(await ops.handleDialog(session, a.accept, a.promptText));
    },
  );
}
