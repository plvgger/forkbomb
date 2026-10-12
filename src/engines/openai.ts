import { ChatError, type ChatHttpOptions, ChatHttpClient, type ChatRequest, type ChatTurn, type StreamWatch } from "./chat.js";

/**
 * Fork engine for any OpenAI-compatible Chat Completions server: Ollama, LM Studio, vLLM, llama.cpp, OpenRouter
 * and the like. Same client and fork loop as the hosted engine (chat.ts); what differs is that the user names the
 * server and the model, a key is optional (local servers need none), and nothing is metered here, so cost is
 * reported as unknown. A key, if set, goes to that one server in the Authorization header and nowhere else.
 */

/** The names the OpenAI SDKs use, so a setup that works for them works here. */
export const OPENAI_KEY_ENV = "OPENAI_API_KEY";
export const OPENAI_URL_ENV = "OPENAI_BASE_URL";

export interface OpenAISettings {
  baseUrl: string | null;
  /** Where baseUrl came from, to name it in errors: --base-url or OPENAI_BASE_URL. */
  urlSetting: string;
  apiKey: string | null;
}

/** --base-url, else OPENAI_BASE_URL; the key from OPENAI_API_KEY (call the .env loader first). Blank values count as unset. */
export function openaiSettings(flag?: string, env: NodeJS.ProcessEnv = process.env): OpenAISettings {
  const fromFlag = flag?.trim();
  return {
    baseUrl: fromFlag || env[OPENAI_URL_ENV]?.trim() || null,
    urlSetting: fromFlag ? "--base-url" : OPENAI_URL_ENV,
    apiKey: env[OPENAI_KEY_ENV]?.trim() || null,
  };
}

export interface OpenAIClientOptions extends Omit<ChatHttpOptions, "urlSetting" | "errorGraceMs"> {
  model: string;
  urlSetting?: string;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** "model X does not support tools" (Ollama), "auto tool choice requires --enable-auto-tool-choice" (vLLM), "tools param requires --jinja" (llama.cpp), "No endpoints found that support tool use" (OpenRouter). */
const noTools = (text: string) => /\btool/i.test(text) && /support|requires?|enable|jinja|no endpoints?/i.test(text);

/** 'model "x" not found' (Ollama), "The model `x` does not exist" (vLLM), "x is not a valid model ID" (OpenRouter). */
const noModel = (status: number, text: string) =>
  /model/i.test(text) && (status === 404 || /not found|does(?: not|n't) exist|not a valid|invalid model|unknown model|no such model/i.test(text));

export class OpenAIClient extends ChatHttpClient {
  readonly model: string;
  readonly label: string;
  /** Nothing here meters what the server bills, so cost is reported as unknown, as on the claude-code engine. */
  readonly unpriced = true;
  protected readonly server: string;
  protected readonly stream: string;
  /** Ask for the usage chunk (stream_options.include_usage) until the server turns the option down. */
  #usage = true;

  constructor(o: OpenAIClientOptions) {
    // No settlement ever follows an error event here, so there is nothing to wait for after one.
    super({ ...o, urlSetting: o.urlSetting ?? OPENAI_URL_ENV, errorGraceMs: 0 });
    this.model = o.model;
    this.label = `${o.model} at ${this.host}`;
    this.server = `the server at ${this.host}`;
    this.stream = `the stream from ${this.host}`;
  }

  async chat(req: ChatRequest, signal: AbortSignal, watch?: StreamWatch): Promise<ChatTurn> {
    const usage = this.#usage;
    try {
      return await this.send(req, signal, watch, usage);
    } catch (e) {
      // stream_options is newer than some servers. One that rejects it gets the request again without it, and from then on.
      if (!usage || !(e instanceof ChatError) || e.status !== 400 || !/stream_options/i.test(e.serverMessage)) throw e;
      this.#usage = false;
      return this.send(req, signal, watch, false);
    }
  }

  private send(req: ChatRequest, signal: AbortSignal, watch: StreamWatch | undefined, usage: boolean): Promise<ChatTurn> {
    const body = {
      model: this.model,
      messages: req.messages,
      tools: req.tools,
      tool_choice: "auto",
      stream: true,
      ...(usage ? { stream_options: { include_usage: true } } : {}),
    };
    return this.streamChat(body, signal, watch);
  }

  /** The model ids GET /models lists, or null if the server has no such list. An unreachable server or a rejected key throws. */
  async models(signal: AbortSignal, retries = this.maxRetries): Promise<string[] | null> {
    let body: unknown;
    try {
      body = await this.request("GET", "/models", undefined, signal, (res) => this.json(res), "application/json", retries);
    } catch (e) {
      if (e instanceof ChatError && (e.kind === "bad_response" || [400, 404, 405, 501].includes(e.status))) return null;
      throw e;
    }
    const data = (body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) return null;
    return data.flatMap((m: unknown) => {
      const id = (m as { id?: unknown } | null)?.id;
      return typeof id === "string" ? [id] : [];
    });
  }

  protected retryable(status: number, _headers: Headers, err: { message: string; code: string }): boolean {
    // A server that can't do tool calls says so the same way every time.
    return RETRYABLE.has(status) && !noTools(`${err.code} ${err.message}`);
  }

  protected unreachable(why: string): string {
    return `can't reach ${this.server} (${why}). Check that it's running and that the base URL is right.`;
  }

  protected toError(status: number, err: { message: string; code: string }, retries: number): ChatError {
    const detail = this.redact(err.message || err.code || `HTTP ${status}`).slice(0, 300);
    const text = `${err.code} ${err.message}`;
    const tries = retries ? ` after ${retries} retries` : "";
    if (status === 401 || status === 403) {
      return new ChatError(
        "auth",
        status,
        this.hasKey
          ? `${this.server} rejected the API key (${status}: ${detail}). Check ${OPENAI_KEY_ENV}.`
          : `${this.server} wants an API key (${status}: ${detail}). Set ${OPENAI_KEY_ENV}.`,
      );
    }
    if (status === 402) return new ChatError("credits", status, `${this.server} says the account is out of credit (${detail}). Top up with the provider and run again.`);
    if (status >= 400 && noTools(text)) {
      return new ChatError(
        "tools",
        status,
        `${this.server} can't do tool calls with ${this.model} (${detail}). Forks need tool calling: pick a model that supports it (on Ollama, one with the "tools" tag), or turn it on in the server (vLLM: --enable-auto-tool-choice with a --tool-call-parser; llama.cpp: --jinja).`,
      );
    }
    if (noModel(status, text)) {
      return new ChatError("model", status, `${this.server} has no model "${this.model}" (${detail}). Check --model against GET ${this.baseUrl}/models; on Ollama, pull it first: ollama pull ${this.model}`);
    }
    if (status === 404) {
      return new ChatError("endpoint", status, `${this.server} has no Chat Completions API at ${this.baseUrl} (404: ${detail}). Check the base URL: it usually ends in /v1, like http://localhost:11434/v1.`);
    }
    if (status === 429) return new ChatError("rate", status, `rate limited by ${this.server}${tries} (${detail})`);
    if (status === 503) return new ChatError("unavailable", status, `${this.server} is unavailable${tries} (${detail}). Try again shortly.`);
    return new ChatError("http", status, `${this.server} answered ${status}${err.code ? ` ${err.code}` : ""}${tries}: ${detail}`);
  }
}

/**
 * Whether `model` is one the server lists: exactly, as Ollama's implied ":latest" tag, or as a variant of a listed
 * model (OpenRouter's ":nitro" and the like).
 */
export function hasModel(ids: readonly string[], model: string): boolean {
  const have = new Set(ids);
  if (have.has(model) || have.has(`${model}:latest`)) return true;
  const cut = model.lastIndexOf(":");
  return cut > 0 && have.has(model.slice(0, cut));
}

/**
 * Before any fork starts: can the server be reached, does it take the key, and does it serve the model? Asked once,
 * without retries, and throws with what to do about it. Returns a warning when the server has no model list, so
 * the model couldn't be checked.
 */
export async function checkServer(client: OpenAIClient, signal: AbortSignal): Promise<string | null> {
  const ids = await client.models(signal, 0);
  if (ids === null) {
    return `the server at ${client.host} has no model list (GET /models), so --model ${client.model} wasn't checked. If every fork fails, check the base URL: it usually ends in /v1.`;
  }
  if (hasModel(ids, client.model)) return null;
  const shown = ids.slice(0, 12).join(", ");
  const lists = ids.length ? `It lists ${shown}${ids.length > 12 ? ` and ${ids.length - 12} more (GET ${client.baseUrl}/models)` : ""}.` : "It lists no models.";
  throw new Error(`the server at ${client.host} has no model "${client.model}". ${lists} Pass one it lists to --model; on Ollama, pull it first: ollama pull ${client.model}`);
}

/** `forkbomb doctor`'s line for this engine: its settings, and whether the server answers. Never shows the key. */
export async function doctorOpenAI(s: OpenAISettings, signal: AbortSignal): Promise<{ level: "ok" | "fail" | "info"; text: string; hint?: string }> {
  const label = "OpenAI-compatible server (engine: openai)";
  if (!s.baseUrl) {
    return { level: "info", text: `No OpenAI-compatible server set (${OPENAI_URL_ENV}). That's fine: it's only needed for --engine openai, which also takes --base-url` };
  }
  const key = s.apiKey ? `with ${OPENAI_KEY_ENV}` : `no ${OPENAI_KEY_ENV}`;
  let client: OpenAIClient;
  try {
    client = new OpenAIClient({ baseUrl: s.baseUrl, apiKey: s.apiKey, model: "", urlSetting: s.urlSetting });
  } catch (e) {
    return { level: "fail", text: label, hint: (e as Error).message };
  }
  try {
    const ids = await client.models(signal, 0);
    const what = ids === null ? "answers (no model list)" : `lists ${ids.length} model${ids.length === 1 ? "" : "s"}`;
    return { level: "ok", text: `${label}: ${client.baseUrl} ${what}, ${key}` };
  } catch (e) {
    // A key the server turns down is broken; a server that isn't running right now is only worth a note.
    if (e instanceof ChatError && e.kind === "auth") return { level: "fail", text: `${label}: ${client.baseUrl}`, hint: e.message };
    return { level: "info", text: `${OPENAI_URL_ENV} is ${client.baseUrl} (${key}), but ${(e as Error).message}` };
  }
}
