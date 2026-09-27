# web-ui-tester

[![CI](https://github.com/hofmeister/web-ui-tester/actions/workflows/ci.yml/badge.svg)](https://github.com/hofmeister/web-ui-tester/actions/workflows/ci.yml)

An MCP server that lets an AI drive and inspect real web pages quickly, over browser sessions that stay alive between tool calls.

Two things make it fast. Pages are exposed as an **accessibility tree with element refs** rather than screenshots or raw HTML, so the model can find and click things without burning context on markup or waiting on vision. And **sessions persist** — cookies, page state, and history survive across calls, so a long interaction is a series of cheap steps instead of repeated cold starts.

It also carries DevTools-grade diagnostics — console, network with response bodies, JS evaluation, computed styles — so the AI can work out *why* something is broken, not just that it is.

## Quick start

### Claude Desktop (one click)

1. Go to the [latest release](https://github.com/hofmeister/web-ui-tester/releases/latest) and download `web-ui-tester-<version>.mcpb`. The same file works on macOS, Windows and Linux.
2. Double-click it. Claude Desktop installs the extension and offers four optional settings: a Gemini and an Anthropic API key (only for [`run_task`](#the-built-in-agent)), the agent model, and headless mode.
3. Start a new chat and ask Claude to open a page.

The extension runs on the Node.js that ships with Claude Desktop and brings no browser of its own: it drives **Google Chrome or Microsoft Edge** if one is installed, or Playwright's Chromium if you have installed that.

### As a Claude plugin (Claude Code)

```bash
claude plugin marketplace add hofmeister/web-ui-tester
claude plugin install web-ui-tester@web-ui-tester
npx playwright@1.63.0 install chromium   # once, unless Google Chrome or Microsoft Edge is installed
```

The plugin runs the server from the TypeScript source in this repository with your own `node` (22.18 or newer), and Claude Code installs its dependencies from `package-lock.json` when you install the plugin. It asks for four optional settings: a Gemini and an Anthropic API key (only for [`run_task`](#the-built-in-agent), kept in your system's secure credential store), the agent model, and whether the browser runs headless.

Then ask Claude something like *"Open http://localhost:3000, sign up with a test account and tell me what breaks."*

To try a working copy, run `claude --plugin-dir .` in the repository, and `claude plugin validate .` before you push.

### Other MCP clients

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

The server uses Playwright's Chromium when it is installed, and otherwise an installed Google Chrome or Microsoft Edge. To install Playwright's Chromium:

```bash
npx playwright install chromium
```

## Example prompts

- "Open http://localhost:3000, sign up with a new test account, and tell me whether anything errors along the way — console, network or UI."
- "Go to our staging checkout page, add the cheapest product to the cart, and check that the total matches the item price plus shipping."
- "Why does the 'Save' button on /settings do nothing? Click it and look at the console, the network request and the button's computed styles."
- "Log in to the admin as demo@example.com / demo-password and use `run_task` to check that every link in the sidebar opens a page without errors."

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

**Session** — `browser_start` (options: `userAgent`, `viewportWidth`, `viewportHeight`, `headless`, `baseUrl`, `url`, `model`, and for [CDP](#chrome-devtools-protocol-cdp) `cdpUrl`, `useBrowserProfile`, `tab`), `browser_list`, `browser_close`.

**Interaction** — `browser_navigate`, `browser_click`, `browser_type`, `browser_press_key`, `browser_hover`, `browser_select_option`, `browser_scroll`, `browser_wait_for`, `browser_go_back`, `browser_handle_dialog`.

Actions report what they caused: navigation, new console errors, request counts, and any dialog that appeared come back with the result, so a click that quietly broke something doesn't look like a success.

Dialogs need one note. An `alert`/`confirm`/`prompt` blocks the page until it's answered, so the action that opened it can't also answer it — an unanswered dialog is dismissed automatically rather than stalling the click, and the result says so. To accept one, or to fill in a `prompt`, call `browser_handle_dialog` *before* the action that triggers it and the answer is armed for the next dialog.

**Inspection** — `browser_snapshot` (scopeable by element, `depth`-limited, `interactiveOnly`, offset-paged), `browser_query` (find by role/name, text, or CSS — returns refs and state), `browser_read_text` (rendered text of the page or one subtree), `browser_screenshot` (available, but the tree is usually the better tool).

**Diagnostics** — `browser_console` (messages plus uncaught errors with stacks), `browser_network` (statuses, sizes, timings), `browser_request_detail` (headers, timing breakdown, request and response bodies), `browser_evaluate` (run JS in the page), `browser_inspect_element` (computed styles, box model, form state).

Every result is capped to a character budget, and the large ones (`browser_snapshot`, `browser_read_text`, bodies) page with `offset` instead of truncating silently.

## The built-in agent

`run_task` hands a session to a fast model that drives the browser itself and reports back:

```
run_task(sessionId, "Log in as demo@example.com / hunter2 and check the
                     dashboard loads without errors")
```

**Reporting is the point.** It returns a structured verdict, not just prose:

```
status: success
model: google:gemini-flash-lite-latest

Logged in and opened the dashboard. The revenue widget rendered empty.

findings (3):
  [error] Request failed: GET 500 [observed by the harness]
      where: https://app.example.com/api/revenue
      evidence: HTTP 500
  [error] Console exception on the page [observed by the harness]
      where: app.js:214:9
      evidence: TypeError: Cannot read properties of undefined (reading 'total')
  [warning] The revenue widget shows no empty state, just blank space
      where: #revenue-card
      evidence: card is present but contains no text
```

Findings come from two places, and the distinction matters. The agent calls `report_finding` as it goes — so a run that hits its step limit still returns everything it found up to that point. Separately, the harness records every console error, failed request, and dialog during the run and reports those **whether or not the agent mentions them**, marked `[observed by the harness]`. A model that misses a 500 or forgets to mention an exception can't hide it.

The same report is returned as `structuredContent` against a declared output schema, so a calling AI can branch on `findings[].severity` rather than parse text. A task can succeed and still have findings; `success` reflects whether the task was accomplished, not whether the page was clean.

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

In this mode the browser sessions live in the long-running server rather than in a client-owned process, so they **survive client restarts and reconnects** — reconnect, pass the same `sessionId`, and the page is still there. `GET /health` reports session and connection counts.

It binds to `127.0.0.1` by default, where DNS-rebinding protection is enabled. `--host` widens that, and the server warns when you do: there is no authentication, and anyone who can reach the port can drive a browser and run JavaScript through it. Put it behind a proxy or firewall.

## Chrome DevTools Protocol (CDP)

CDP works in both directions.

### Attach to a Chrome that is already running

Point the server at a Chrome started with remote debugging, and sessions drive that browser instead of launching one:

```bash
# Chrome 136+ ignores --remote-debugging-port on your default profile, so give it its own directory
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-debug"

claude mcp add web-ui-tester -e WUT_CDP_URL=http://127.0.0.1:9222 -- npx -y web-ui-tester
```

Or per session: `browser_start` with `cdpUrl: "http://127.0.0.1:9222"` (a `ws://…/devtools/browser/…` URL works too).

By default an attached session uses **that browser's own profile** — its cookies and logins — in a new tab, and keeps the browser's own User-Agent and window size. It only ever acts on tabs it opened (or popups they open), never on the tabs you have open. Two options change that:

- `tab: "<url substring>"` takes over an existing tab instead of opening one — handy for picking up a page you logged in to by hand. Closing the session leaves that tab open.
- `useBrowserProfile: false` uses a fresh isolated context inside the attached browser, as a launched browser would.

Closing a session closes only the tabs it opened; stopping the server disconnects without closing Chrome.

### Expose the launched browser to other CDP clients

Set `WUT_CDP_PORT` (or `--cdp-port`) and the browser the server launches listens for DevTools-protocol clients on that local port; `browser_start` and `browser_list` report the endpoint. Another MCP server, a Playwright script (`chromium.connectOverCDP`) or plain `curl http://127.0.0.1:9222/json/list` can then work on the same pages as web-ui-tester.

MCP clients generally cannot add a server partway through a conversation, so give the port a fixed value and configure the other server up front — it connects when it is first used, by which time the browser is running:

```bash
claude mcp add web-ui-tester -e WUT_CDP_PORT=9222 -- npx -y web-ui-tester
claude mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:9222
```

If the port is taken, or a second browser is launched (headed and headless run separately), it gets a free port instead; `0` always picks a free one. The port is bound to `127.0.0.1`, but any local process can drive the browser through it, so leave it unset unless you need it.

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
| `WUT_CDP_URL` | — | Attach to this running Chrome over CDP instead of launching one |
| `WUT_CDP_PORT` | — | Expose launched browsers' DevTools protocol on this local port (`0` = any free port) |
| `PLAYWRIGHT_BROWSERS_PATH` | — | Where Playwright looks for browsers |

CLI flags: `--port`, `--host`, `--headless` / `--no-headless`, `--idle-timeout`, `--cdp-url`, `--cdp-port`, `--version`, `--help`.

If Playwright's expected Chromium revision isn't installed but another one is, the server finds and uses it rather than failing — handy in prebuilt containers. `WUT_EXECUTABLE_PATH` overrides the search entirely.

## Development

```bash
npm install
npm run build
npm test          # agent loop (mocked model) + full end-to-end suite
npm run typecheck
```

`npm run bundle` (after `npm run build`) builds the Claude Desktop extension into `bundles/`.

`npm test` runs the agent loop against a scripted mock model, then drives the built server as a real MCP client over both transports against a local fixture app — covering refs, stale-ref handling, diagnostics, session persistence across reconnects, and idle reaping. `npm run test:agent:live` additionally exercises `run_task` against a real provider, and skips itself when no key is set.

CI runs the typecheck, build, a start of the server from source, and both suites on Node 22 and 24 for every push and pull request. The live agent test runs separately — on demand via the **Live agent test** workflow, and weekly — because it makes real API calls; it needs `GOOGLE_GENERATIVE_AI_API_KEY` or `ANTHROPIC_API_KEY` as a repository secret, and the scheduled run skips itself when neither is set.

## Releasing

Run the **Release** workflow from the Actions tab and pick `patch`, `minor` or `major`. It works off `master`: the tests run, the new version is written to `package.json`, `.claude-plugin/plugin.json` and `src/index.ts`, committed and tagged (`vX.Y.Z`), and the Claude Desktop extension is built and attached to a new GitHub Release. The version counts up from the newest `vX.Y.Z` tag; with no tags yet, the version already in `package.json` is released as it stands. Pushing a tag `vX.Y.Z` that matches `package.json` releases the commit it points at.

## Privacy

The server runs on your computer. It has no server of its own, collects no analytics or telemetry, and sends nothing to its author or to Anthropic.

- **What it runs and fetches:** a local Chromium-based browser (Playwright's Chromium, or your installed Google Chrome or Microsoft Edge, in a fresh temporary profile that never touches your own browsing profile), through Playwright, which loads the pages you or Claude point it at — along with everything those pages load themselves — and runs JavaScript in them when `browser_evaluate` is called. Treat it like any browser you hand to someone else: it can reach whatever your computer can reach, including `localhost` and your intranet.
- **What it sends to AI providers:** only `run_task` does. It sends the task, the page's accessibility snapshots, and the results of the agent's browser actions to the model provider you configured — Google's Gemini API (`generativelanguage.googleapis.com`) or Anthropic's API (`api.anthropic.com`) — with your own API key. Every other tool is local, and without a key `run_task` is off.
- **What it stores:** nothing on disk. Browser sessions use fresh in-memory profiles; their cookies, storage, console and network logs live in memory and are discarded when a session is closed, idles out (30 minutes by default), or the server stops. API keys are kept by Claude Code in your system's secure credential store and held only in memory while the server runs.
- **Third parties:** the sites you visit see an ordinary browser (User-Agent `AITester/1.0` by default). Google or Anthropic receive the `run_task` data above under their own API terms and privacy policies ([Google](https://policies.google.com/privacy), [Anthropic](https://www.anthropic.com/legal/privacy)). Tool results go back to Claude as part of your conversation.
- **CDP:** with `WUT_CDP_URL` set, sessions drive the Chrome you point them at, by default in its own profile — the sites see your cookies and logins, and anything the session does happens there. With `WUT_CDP_PORT` set, the launched browser accepts DevTools-protocol connections from any process on your computer. Both are off unless you set them; see [CDP](#chrome-devtools-protocol-cdp).
- **HTTP mode** (`--port`) has no authentication; see [HTTP mode](#http-mode). The plugin uses stdio and does not open a port.
- **Contact:** open an issue at [github.com/hofmeister/web-ui-tester/issues](https://github.com/hofmeister/web-ui-tester/issues) for questions about privacy or security.

## Support

Report bugs and ask questions at [github.com/hofmeister/web-ui-tester/issues](https://github.com/hofmeister/web-ui-tester/issues). Report security vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).
