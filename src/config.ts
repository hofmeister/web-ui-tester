export interface Config {
  /** Default user agent for new sessions. */
  userAgent: string;
  /** Default headless mode for new sessions. */
  headless: boolean;
  /** Milliseconds a session may sit unused before it is closed. */
  idleTimeoutMs: number;
  /** Character cap applied to every MCP tool result. */
  maxOutputChars: number;
  /** Timeout for a single Playwright locator action. */
  actionTimeoutMs: number;
  /** Default step cap for the embedded agent. */
  agentMaxSteps: number;
  /** Default model for the embedded agent, as "provider:modelId". */
  model: string;
  /** Explicit Chromium binary, bypassing Playwright's revision lookup. */
  executablePath?: string;
  /** Attach to this already-running Chrome over CDP instead of launching one. */
  cdpUrl?: string;
  /**
   * Expose launched browsers' DevTools protocol on this local port (0 = any
   * free port), so other CDP clients can drive the same browser.
   */
  cdpPort?: number;
  /**
   * Default for browser_start's devtools option: give launched browsers a
   * private DevTools port so chrome-devtools-mcp's tools can reach them.
   */
  devtools: boolean;
  /**
   * How to start chrome-devtools-mcp; the endpoint flags are appended.
   * Undefined runs the copy installed alongside this server.
   */
  devtoolsCommand?: string;
}

export const DEFAULT_USER_AGENT = 'AITester/1.0';
export const DEFAULT_MODEL = 'google:gemini-flash-lite-latest';

const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  google: 'gemini-flash-lite-latest',
  anthropic: 'claude-haiku-4-5',
};

/**
 * A setting from the environment, trimmed, or undefined when it is empty. Claude
 * Desktop passes an optional extension setting the user left empty as its
 * unsubstituted placeholder (`${user_config.google_api_key}`), so those count as
 * empty too.
 */
export function setting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  if (!value || /^\$\{[^}]*\}$/.test(value)) return undefined;
  return value;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** A TCP port, where 0 is allowed and means "pick a free one". */
export function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : undefined;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !/^(0|false|no)$/i.test(value.trim());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    userAgent: setting(env, 'WUT_USER_AGENT') ?? DEFAULT_USER_AGENT,
    headless: bool(setting(env, 'WUT_HEADLESS'), true),
    idleTimeoutMs: num(setting(env, 'WUT_IDLE_TIMEOUT_MS'), 30 * 60 * 1000),
    maxOutputChars: num(setting(env, 'WUT_MAX_OUTPUT_CHARS'), 15_000),
    actionTimeoutMs: num(setting(env, 'WUT_ACTION_TIMEOUT_MS'), 5_000),
    agentMaxSteps: num(setting(env, 'WUT_AGENT_MAX_STEPS'), 20),
    model: setting(env, 'WUT_MODEL') ?? DEFAULT_MODEL,
    executablePath: setting(env, 'WUT_EXECUTABLE_PATH'),
    cdpUrl: setting(env, 'WUT_CDP_URL'),
    cdpPort: parsePort(setting(env, 'WUT_CDP_PORT')),
    devtools: bool(setting(env, 'WUT_DEVTOOLS'), true),
    devtoolsCommand: setting(env, 'WUT_DEVTOOLS_MCP_COMMAND'),
  };
}

export interface ModelSpec {
  provider: 'google' | 'anthropic';
  modelId: string;
}

/**
 * Parses "provider:modelId", "provider" (provider's fast-tier default), or a
 * bare model id (provider inferred from the id's prefix).
 */
export function parseModelSpec(spec: string): ModelSpec {
  const trimmed = spec.trim();
  const sep = trimmed.indexOf(':');
  const head = sep === -1 ? trimmed : trimmed.slice(0, sep);
  const tail = sep === -1 ? '' : trimmed.slice(sep + 1).trim();

  if (head === 'google' || head === 'anthropic') {
    return { provider: head, modelId: tail || PROVIDER_DEFAULT_MODELS[head]! };
  }
  if (sep !== -1) {
    throw new Error(
      `Unknown model provider "${head}". Use "google:<model>" or "anthropic:<model>".`,
    );
  }
  if (/^gemini|^models\/gemini/.test(trimmed)) {
    return { provider: 'google', modelId: trimmed };
  }
  if (/^claude/.test(trimmed)) {
    return { provider: 'anthropic', modelId: trimmed };
  }
  throw new Error(
    `Cannot infer a provider from model "${trimmed}". Use "google:<model>" or "anthropic:<model>".`,
  );
}
