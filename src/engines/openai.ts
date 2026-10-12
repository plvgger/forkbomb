import { OPENAI_ENGINE_KEY_ENV } from "../brand.js";
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
export { OPENAI_ENGINE_KEY_ENV };

export interface OpenAISettings {
  baseUrl: string | null;
  /** Where baseUrl came from, to name it in errors: --base-url or OPENAI_BASE_URL. */
  urlSetting: string;
  apiKey: string | null;
  /** The variable the key came from, and whether the environment or the .env file set it. Null when no key is sent. */
  key: { name: string; from: "env" | "file" } | null;
  /** Why an OPENAI_API_KEY that is set isn't sent to this server, or null. */
  withheld: string | null;
}

const hostOf = (url: string | null) => {
  try {
    return url ? new URL(url).host : null;
  } catch {
    return null;
  }
};

/**
 * The server: --base-url, else OPENAI_BASE_URL. The key: FORKBOMB_OPENAI_API_KEY, this engine's own, which goes to
 * whichever server that is. Failing that, OPENAI_API_KEY, but only where an OpenAI SDK with the same settings
 * would send it: to api.openai.com, or to the server OPENAI_BASE_URL names when both were set in the same place
 * (both in the environment, or both in the .env file). So a key exported for other tools never goes to a server
 * named some other way. `fromFile` is what the .env loader filled in; everything else came from the environment.
 * Blank values count as unset.
 */
export function openaiSettings(flag?: string, env: NodeJS.ProcessEnv = process.env, fromFile: ReadonlySet<string> = new Set()): OpenAISettings {
  const read = (name: string) => {
    const value = env[name]?.trim();
    return value ? { name, value, from: fromFile.has(name) ? ("file" as const) : ("env" as const) } : null;
  };
  const fromFlag = flag?.trim();
  const url = fromFlag ? null : read(OPENAI_URL_ENV);
  const baseUrl = fromFlag || url?.value || null;
  const own = read(OPENAI_ENGINE_KEY_ENV);
  const sdk = read(OPENAI_KEY_ENV);
  const host = hostOf(baseUrl);
  const paired = !!sdk && (host === "api.openai.com" || (!!url && url.from === sdk.from));
  const key = own ?? (paired ? sdk : null);
  return {
    baseUrl,
    urlSetting: fromFlag ? "--base-url" : OPENAI_URL_ENV,
    apiKey: key?.value ?? null,
    key: key ? { name: key.name, from: key.from } : null,
    withheld:
      sdk && !key && host
        ? `${OPENAI_KEY_ENV} is set but isn't sent to ${host}: it only goes to api.openai.com, or to the server ${OPENAI_URL_ENV} names when both are set in the same place. If ${host} needs a key, set ${OPENAI_ENGINE_KEY_ENV}.`
        : null,
  };
}

/** "FORKBOMB_OPENAI_API_KEY (from the environment)", or null when no key is sent. */
function keySource(s: OpenAISettings, envFile: string): string | null {
  return s.key ? `${s.key.name} (from ${s.key.from === "file" ? envFile : "the environment"})` : null;
}

/** Which key goes where, said before anything is sent: "sending FORKBOMB_OPENAI_API_KEY (from the environment) to openrouter.ai". */
export function keyNotice(s: OpenAISettings, host: string, envFile: string): string[] {
  const key = keySource(s, envFile);
  const sent = key ? `sending ${key} to ${host}` : `no API key sent to ${host}`;
  return s.withheld ? [sent, s.withheld] : [sent];
}

export interface OpenAIClientOptions extends Omit<ChatHttpOptions, "urlSetting" | "errorGraceMs"> {
  model: string;
  urlSetting?: string;
  /** The variable the key came from, for messages about it. Default FORKBOMB_OPENAI_API_KEY. */
  keyName?: string;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
/** The statuses a server turns a request down with. A 5xx is the server's own trouble, often passing on. */
const REFUSALS = new Set([400, 404, 422]);
/** A server error that quotes what the model wrote (Ollama: "error parsing tool call: raw='…'"), so its words are the model's, not the server's. */
const QUOTES_MODEL = /parsing tool call|raw=/i;

/**
 * The server or the model can't do tool calls, in the server's own words: "registry.ollama.ai/library/x does not
 * support tools" (Ollama), '"auto" tool choice requires --enable-auto-tool-choice' (vLLM), "No endpoints found that
 * support tool use" (OpenRouter), all 4xx; "tools param requires --jinja flag" (llama.cpp, which answers it with a
 * 500 and that message alone). Only an answer to the request counts, never a mid-stream error.
 */
function noTools(status: number, message: string): boolean {
  if (QUOTES_MODEL.test(message)) return false;
  if (status === 500) return /^tools param requires --jinja\b/i.test(message.trim());
  return REFUSALS.has(status) && /does not support tools|tool choice requires --enable-auto-tool-choice|tools param requires --jinja|no endpoints found that support tool use/i.test(message);
}

/** 'model "x" not found' (Ollama), "The model `x` does not exist" (vLLM), "x is not a valid model ID" (OpenRouter): a 4xx answer to the request. */
function noModel(status: number, text: string): boolean {
  if (!REFUSALS.has(status) || QUOTES_MODEL.test(text) || !/model/i.test(text)) return false;
  return status === 404 || /not found|does(?: not|n't) exist|not a valid|invalid model|unknown model|no such model/i.test(text);
}

/** A 403 that is about the key rather than the request (OpenRouter answers 403 for input its moderation flags). */
const aboutKey = (text: string) => /api[ _-]?key|\bkey\b|token|auth|credential/i.test(text);

export class OpenAIClient extends ChatHttpClient {
  readonly model: string;
  readonly label: string;
  /** Nothing here meters what the server bills, so cost is reported as unknown, as on the claude-code engine. */
  readonly unpriced = true;
  protected readonly server: string;
  protected readonly stream: string;
  /** Ask for the usage chunk (stream_options.include_usage) until the server turns the option down. */
  #usage = true;
  readonly #keyName: string;

  constructor(o: OpenAIClientOptions) {
    // No settlement ever follows an error event here, so there is nothing to wait for after one.
    super({ ...o, urlSetting: o.urlSetting ?? OPENAI_URL_ENV, errorGraceMs: 0 });
    this.model = o.model;
    this.#keyName = o.keyName ?? OPENAI_ENGINE_KEY_ENV;
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
      // A request with no input to object to is refused for who is asking: the key.
      if (e instanceof ChatError && e.status === 403 && e.kind !== "auth") throw this.authError(403, e.serverMessage.slice(0, 300) || "HTTP 403");
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
    // llama.cpp without --jinja answers 500 to every request with tools, the same way every time.
    return RETRYABLE.has(status) && !noTools(status, err.message);
  }

  protected unreachable(why: string): string {
    return `can't reach ${this.server} (${why}). Check that it's running and that the base URL is right.`;
  }

  private authError(status: number, detail: string): ChatError {
    return new ChatError(
      "auth",
      status,
      this.hasKey
        ? `${this.server} rejected the API key (${status}: ${detail}). Check ${this.#keyName}.`
        : `${this.server} wants an API key (${status}: ${detail}). Set ${OPENAI_ENGINE_KEY_ENV}.`,
    );
  }

  protected toError(status: number, err: { message: string; code: string }, retries: number, _transient: boolean, inStream: boolean): ChatError {
    const detail = this.redact(err.message || err.code || `HTTP ${status}`).slice(0, 300);
    const text = `${err.code} ${err.message}`;
    const tries = retries ? ` after ${retries} retries` : "";
    if (status === 401 || (status === 403 && aboutKey(text))) return this.authError(status, detail);
    if (status === 402) return new ChatError("credits", status, `${this.server} says the account is out of credit (${detail}). Top up with the provider and run again.`);
    // Fatal kinds come only from the server's answer to the request: an error mid-stream can quote the model.
    if (!inStream && noTools(status, err.message)) {
      return new ChatError(
        "tools",
        status,
        `${this.server} can't do tool calls with ${this.model} (${detail}). Forks need tool calling: pick a model that supports it (on Ollama, one with the "tools" tag), or turn it on in the server (vLLM: --enable-auto-tool-choice with a --tool-call-parser; llama.cpp: --jinja).`,
      );
    }
    if (!inStream && noModel(status, text)) {
      return new ChatError("model", status, `${this.server} has no model "${this.model}" (${detail}). Check --model against GET ${this.baseUrl}/models; on Ollama, pull it first: ollama pull ${this.model}`);
    }
    if (status === 404 && !inStream) {
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
 * without retries. An unreachable server, a rejected key or a missing model throws with what to do about it. Any
 * other trouble (a 429, a 5xx) only means the model couldn't be checked: that, or a server with no model list,
 * comes back as a warning and the run goes on, its forks retrying as usual.
 */
export async function checkServer(client: OpenAIClient, signal: AbortSignal): Promise<string | null> {
  let ids: string[] | null;
  try {
    ids = await client.models(signal, 0);
  } catch (e) {
    if (!(e instanceof ChatError) || e.kind === "auth" || e.kind === "network") throw e;
    return `couldn't check --model ${client.model}: ${e.message}; starting anyway.`;
  }
  if (ids === null) {
    return `the server at ${client.host} has no model list (GET /models), so --model ${client.model} wasn't checked. If every fork fails, check the base URL: it usually ends in /v1.`;
  }
  if (hasModel(ids, client.model)) return null;
  const shown = ids.slice(0, 12).join(", ");
  const lists = ids.length ? `It lists ${shown}${ids.length > 12 ? ` and ${ids.length - 12} more (GET ${client.baseUrl}/models)` : ""}.` : "It lists no models.";
  throw new Error(`the server at ${client.host} has no model "${client.model}". ${lists} Pass one it lists to --model; on Ollama, pull it first: ollama pull ${client.model}`);
}

/**
 * `forkbomb doctor`'s line for this engine: its settings, and whether the server answers. Never shows the key.
 * Only a key the server turns down fails: OPENAI_BASE_URL may be set for other tools, so a URL this engine won't
 * take, or a server that isn't running right now, is only worth a note.
 */
export async function doctorOpenAI(s: OpenAISettings, signal: AbortSignal, envFile: string): Promise<{ level: "ok" | "fail" | "info"; text: string; hint?: string }> {
  const label = "OpenAI-compatible server (engine: openai)";
  if (!s.baseUrl) {
    return { level: "info", text: `No OpenAI-compatible server set (${OPENAI_URL_ENV}). That's fine: it's only needed for --engine openai, which also takes --base-url` };
  }
  let client: OpenAIClient;
  try {
    client = new OpenAIClient({ baseUrl: s.baseUrl, apiKey: s.apiKey, model: "", urlSetting: s.urlSetting, ...(s.key ? { keyName: s.key.name } : {}) });
  } catch (e) {
    return { level: "info", text: `${(e as Error).message}. Only --engine openai reads it, and it can't use this one` };
  }
  const source = keySource(s, envFile);
  const key = source ? `with ${source}` : "no API key";
  try {
    const ids = await client.models(signal, 0);
    const what = ids === null ? "answers (no model list)" : `lists ${ids.length} model${ids.length === 1 ? "" : "s"}`;
    return { level: "ok", text: `${label}: ${client.baseUrl} ${what}, ${key}` };
  } catch (e) {
    if (e instanceof ChatError && e.kind === "auth") return { level: "fail", text: `${label}: ${client.baseUrl}`, hint: e.message };
    return { level: "info", text: `${OPENAI_URL_ENV} is ${client.baseUrl} (${key}), but ${(e as Error).message}` };
  }
}
