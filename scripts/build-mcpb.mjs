// Builds the Claude Desktop extension (.mcpb) from the compiled server in dist/.
//
//   npm run build && npm run bundle            # -> bundles/web-ui-tester-<version>.mcpb
//   node scripts/build-mcpb.mjs --out some/folder
//
// The bundle holds the compiled JavaScript and its production dependencies, and runs on the Node.js
// that ships with Claude Desktop, so one bundle serves every platform. It carries no browser: the
// server uses Playwright's Chromium when installed, otherwise Google Chrome or Microsoft Edge. Requires network access for
// `npm ci` and `npx @anthropic-ai/mcpb`.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : join(root, "bundles");
const distDir = join(root, "dist");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

if (!existsSync(join(distDir, "index.js"))) {
  console.error("dist/index.js is missing: run `npm run build` first");
  process.exit(1);
}

const stage = join(outDir, "stage");
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "server"), { recursive: true });

// The compiled server, without the type declarations.
for (const entry of readdirSync(distDir, { withFileTypes: true })) {
  cpSync(join(distDir, entry.name), join(stage, "server", entry.name), {
    recursive: true,
    filter: (src) => !src.endsWith(".d.ts"),
  });
}

// Production dependencies, pinned by the lockfile.
writeFileSync(
  join(stage, "server", "package.json"),
  `${JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: "module", dependencies: pkg.dependencies }, null, 2)}\n`,
);
cpSync(join(root, "package-lock.json"), join(stage, "server", "package-lock.json"));
execFileSync(npm, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: join(stage, "server"),
  stdio: "inherit",
});

const repo = "https://github.com/hofmeister/web-ui-tester";
const manifest = {
  manifest_version: "0.3",
  name: "web-ui-tester",
  display_name: "Web UI Tester",
  version: pkg.version,
  description:
    "Let Claude drive and inspect real web pages in long-lived browser sessions, with console and network diagnostics.",
  long_description:
    "Browser sessions that stay alive between tool calls, pages exposed as accessibility snapshots with clickable refs, DevTools-grade diagnostics (console, network with bodies, JavaScript evaluation, computed styles), and an optional built-in agent (run_task) that carries out a task and reports what broke. Uses Google Chrome or Microsoft Edge if Playwright's Chromium is not installed.",
  author: { name: "Henrik Hofmeister", url: "https://github.com/hofmeister" },
  repository: { type: "git", url: repo },
  homepage: repo,
  documentation: `${repo}#readme`,
  support: `${repo}/issues`,
  license: "MIT",
  privacy_policies: [`${repo}#privacy`],
  keywords: ["browser", "playwright", "testing", "web", "qa", "debugging"],
  server: {
    type: "node",
    entry_point: "server/index.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/server/index.js"],
      env: {
        GOOGLE_GENERATIVE_AI_API_KEY: "${user_config.google_api_key}",
        ANTHROPIC_API_KEY: "${user_config.anthropic_api_key}",
        WUT_MODEL: "${user_config.agent_model}",
        WUT_HEADLESS: "${user_config.headless}",
        WUT_CDP_URL: "${user_config.cdp_url}",
        WUT_CDP_PORT: "${user_config.cdp_port}",
      },
    },
  },
  user_config: {
    google_api_key: {
      type: "string",
      title: "Google Gemini API key (optional)",
      description:
        "Only used by run_task, the built-in agent, with a Gemini model (the default). Every other tool works without a key.",
      sensitive: true,
      required: false,
      default: "",
    },
    anthropic_api_key: {
      type: "string",
      title: "Anthropic API key (optional)",
      description: 'Only used by run_task with an Anthropic model. Set the agent model to "anthropic" to use it.',
      sensitive: true,
      required: false,
      default: "",
    },
    agent_model: {
      type: "string",
      title: "Agent model",
      description: "Model for run_task, as provider or provider:modelId, e.g. google:gemini-flash-latest or anthropic.",
      required: false,
      default: "google:gemini-flash-lite-latest",
    },
    headless: {
      type: "boolean",
      title: "Headless browser",
      description: "Run the browser without a window. Turn off to watch it work.",
      required: false,
      default: true,
    },
    cdp_url: {
      type: "string",
      title: "Attach to Chrome over CDP (optional)",
      description:
        "DevTools endpoint of a Chrome you started with --remote-debugging-port, e.g. http://127.0.0.1:9222. Sessions then drive that browser instead of launching one.",
      required: false,
      default: "",
    },
    cdp_port: {
      type: "string",
      title: "Expose the browser over CDP (optional)",
      description:
        "Local port on which the launched browser accepts DevTools-protocol clients, such as chrome-devtools-mcp, e.g. 9222. Leave empty to keep it private.",
      required: false,
      default: "",
    },
  },
  compatibility: {
    claude_desktop: ">=0.10.0",
    platforms: ["darwin", "win32", "linux"],
    runtimes: { node: ">=20.0.0" },
  },
};
writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

mkdirSync(outDir, { recursive: true });
const out = join(outDir, `web-ui-tester-${pkg.version}.mcpb`);
rmSync(out, { force: true });
execFileSync(npx, ["--yes", "@anthropic-ai/mcpb", "pack", stage, out], { stdio: "inherit" });
rmSync(stage, { recursive: true, force: true });
console.log(`built ${out}`);
