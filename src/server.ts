import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from './config.ts';
import type { SessionManager } from './session.ts';
import { registerAgentTools } from './tools/agent.ts';
import { registerDiagnosticTools } from './tools/diagnose.ts';
import { registerInspectionTools } from './tools/inspect.ts';
import { registerInteractionTools } from './tools/interact.ts';
import { registerSessionTools } from './tools/session.ts';

const INSTRUCTIONS = `Drive and inspect real web pages through long-lived browser sessions.

Workflow: browser_start once to get a sessionId, then reuse it for every later call — the page,
cookies, and history persist between calls.

Seeing the page: browser_snapshot returns an accessibility tree where each element carries a
[ref=eN] handle. Pass those refs to browser_click / browser_type. Refs belong to the page state
that produced them: after navigating or changing the DOM, snapshot again. When an action reports a
missing ref, re-snapshot rather than retry. For targeted checks, browser_query and
browser_read_text cost far less than a full snapshot. Screenshots are available but rarely the
right tool — the tree tells you what is there and how to reach it.

Diagnosing: browser_console (messages and uncaught errors), browser_network plus
browser_request_detail (statuses, timings, bodies), browser_evaluate (page state), and
browser_inspect_element (computed styles, box model).

For multi-step goals, run_task hands the session to a fast built-in agent that does the driving
and reports back.`;

export function buildServer(sessions: SessionManager, config: Config): McpServer {
  const server = new McpServer(
    { name: 'web-ui-tester', version: '0.1.0' },
    { instructions: INSTRUCTIONS },
  );

  const context = { sessions, config };
  registerSessionTools(server, context);
  registerInteractionTools(server, context);
  registerInspectionTools(server, context);
  registerDiagnosticTools(server, context);
  registerAgentTools(server, context);

  return server;
}
