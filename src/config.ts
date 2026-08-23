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
}

export const DEFAULT_USER_AGENT = 'AITester/1.0';
export const DEFAULT_MODEL = 'google:gemini-flash-lite-latest';

const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  google: 'gemini-flash-lite-latest',
  anthropic: 'claude-haiku-4-5',
};

function num(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !/^(0|false|no)$/i.test(value.trim());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    userAgent: env.WUT_USER_AGENT?.trim() || DEFAULT_USER_AGENT,
    headless: bool(env.WUT_HEADLESS, true),
    idleTimeoutMs: num(env.WUT_IDLE_TIMEOUT_MS, 30 * 60 * 1000),
    maxOutputChars: num(env.WUT_MAX_OUTPUT_CHARS, 15_000),
    actionTimeoutMs: num(env.WUT_ACTION_TIMEOUT_MS, 5_000),
    agentMaxSteps: num(env.WUT_AGENT_MAX_STEPS, 20),
    model: env.WUT_MODEL?.trim() || DEFAULT_MODEL,
    executablePath: env.WUT_EXECUTABLE_PATH?.trim() || undefined,
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
