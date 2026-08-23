# web-ui-tester

An MCP server that lets an AI drive and inspect real web pages quickly, over browser sessions that stay alive between tool calls.

Two things make it fast. Pages are exposed as an **accessibility tree with element refs** rather than screenshots or raw HTML, so the model can find and click things without burning context on markup or waiting on vision. And **sessions persist** — cookies, page state, and history survive across calls, so a long interaction is a series of cheap steps instead of repeated cold starts.

It also carries DevTools-grade diagnostics — console, network with response bodies, JS evaluation, computed styles — so the AI can work out *why* something is broken, not just that it is.

## Quick start

```bash
claude mcp add web-ui-tester -- npx -y web-ui-tester
```

With a key for the built-in agent (see [run_task](#the-built-in-agent)):

```bash
claude mcp add web-ui-tester \
  -e GOOGLE_GENERATIVE_AI_API_KEY=your-key \
  -- npx -y web-ui-tester
```

Or in any MCP client's config file:

```json
{
  "mcpServers": {
    "web-ui-tester": {
      "command": "npx",
      "args": ["-y", "web-ui-tester"],
      "env": { "GOOGLE_GENERATIVE_AI_API_KEY": "your-key" }
    }
  }
}
```

Chromium comes from Playwright. If it isn't installed yet:

```bash
npx playwright install chromium
```

## How a session works

```
browser_start          → sessionId, kept alive across calls
browser_navigate       → page state + snapshot with [ref=eN] handles
browser_click ref=e12  → act on what the snapshot showed you
browser_snapshot       → fresh refs after the page changes
browser_close          → done (or let it idle out after 30 minutes)
```

Everything after `browser_start` takes that `sessionId`. The snapshot is the thing to get used to:

```yaml
- generic [ref=e1]:
  - heading "Signup" [level=1] [ref=e2]
  - textbox "Name" [ref=e5]:
    - /placeholder: Your name
  - combobox "Plan" [ref=e7]
  - button "Create account" [ref=e10]
  - link "Go to second page" [ref=e12] [cursor=pointer]:
    - /url: /second.html
```

Those refs go straight into `browser_click`, `browser_type`, and the rest. They belong to the page state that produced them: after navigating or a DOM change, snapshot again. When a tool says a ref is no longer valid, re-snapshot rather than retry — the message says so explicitly.

Element-addressing tools also accept `css`, or `role` + `name`, when you already know the selector and would rather skip the snapshot.

## Tools

**Session** — `browser_start` (options: `userAgent`, `viewportWidth`, `viewportHeight`, `headless`, `baseUrl`, `url`, `model`), `browser_list`, `browser_close`.

**Interaction** — `browser_navigate`, `browser_click`, `browser_type`, `browser_press_key`, `browser_hover`, `browser_select_option`, `browser_scroll`, `browser_wait_for`, `browser_go_back`, `browser_handle_dialog`.

Actions report what they caused: navigation, new console errors, and request counts come back with the result, so a click that quietly broke something doesn't look like a success.

**Inspection** — `browser_snapshot` (scopeable by element, `depth`-limited, `interactiveOnly`, offset-paged), `browser_query` (find by role/name, text, or CSS — returns refs and state), `browser_read_text` (rendered text of the page or one subtree), `browser_screenshot` (available, but the tree is usually the better tool).

**Diagnostics** — `browser_console` (messages plus uncaught errors with stacks), `browser_network` (statuses, sizes, timings), `browser_request_detail` (headers, timing breakdown, request and response bodies), `browser_evaluate` (run JS in the page), `browser_inspect_element` (computed styles, box model, form state).

Every result is capped to a character budget, and the large ones (`browser_snapshot`, `browser_read_text`, bodies) page with `offset` instead of truncating silently.

## The built-in agent

`run_task` hands a session to a fast model that drives the browser itself and reports back:

```
run_task(sessionId, "Log in as demo@example.com / hunter2 and check the
                     dashboard loads without errors")
```

It gets the same operations as the MCP tools, runs a bounded loop (20 steps by default), and returns what it did, what it found, the steps it took, and token usage. The session is left wherever the agent finished, so you can inspect the result yourself afterwards.

This is the one part that needs an API key. It defaults to Gemini Flash Lite for latency; Anthropic works too:

| | Default model | Key |
|---|---|---|
| Google | `gemini-flash-lite-latest` | `GOOGLE_GENERATIVE_AI_API_KEY` |
| Anthropic | `claude-haiku-4-5` | `ANTHROPIC_API_KEY` |

Set `WUT_MODEL` to pick (`anthropic`, or `google:gemini-flash-latest`, or any `provider:modelId`). A session can override it via `browser_start`'s `model`, and a single call via `run_task`'s `model`. Every other tool works without a key.

## HTTP mode

```bash
web-ui-tester --port 7399
claude mcp add --transport http web-ui-tester http://127.0.0.1:7399/mcp
```

In this mode the browser sessions live in the long-running server rather than in a client-owned process, so they **survive client restarts and reconnects** — reconnect, pass the same `sessionId`, and the page is still there. Binds to `127.0.0.1` by default; `--host` changes that, and DNS-rebinding protection is on. `GET /health` reports session and connection counts.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `WUT_MODEL` | `google:gemini-flash-lite-latest` | Model for `run_task`, as `provider[:modelId]` |
| `GOOGLE_GENERATIVE_AI_API_KEY` | — | Key for Gemini |
| `ANTHROPIC_API_KEY` | — | Key for Anthropic |
| `WUT_USER_AGENT` | `AITester/1.0` | Default User-Agent for new sessions |
| `WUT_HEADLESS` | `true` | Default headless mode |
| `WUT_IDLE_TIMEOUT_MS` | `1800000` | Close sessions unused this long |
| `WUT_MAX_OUTPUT_CHARS` | `15000` | Character cap per tool result |
| `WUT_ACTION_TIMEOUT_MS` | `5000` | Timeout for a single element action |
| `WUT_AGENT_MAX_STEPS` | `20` | Default step budget for `run_task` |
| `WUT_EXECUTABLE_PATH` | — | Explicit Chromium binary |
| `PLAYWRIGHT_BROWSERS_PATH` | — | Where Playwright looks for browsers |

CLI flags: `--port`, `--host`, `--headless` / `--no-headless`, `--idle-timeout`, `--version`, `--help`.

If Playwright's expected Chromium revision isn't installed but another one is, the server finds and uses it rather than failing — handy in prebuilt containers. `WUT_EXECUTABLE_PATH` overrides the search entirely.

## Development

```bash
npm install
npm run build
npm test          # agent loop (mocked model) + full end-to-end suite
npm run typecheck
```

`npm test` runs the agent loop against a scripted mock model, then drives the built server as a real MCP client over both transports against a local fixture app — covering refs, stale-ref handling, diagnostics, session persistence across reconnects, and idle reaping. `npm run test:agent:live` additionally exercises `run_task` against a real provider, and skips itself when no key is set.

## License

MIT
