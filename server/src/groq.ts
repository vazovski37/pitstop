/**
 * A small client for Groq Cloud's OpenAI-compatible chat completions, used by AI repair.
 * No SDK: one POST with fetch, a timeout, and the text of the first choice back.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Anything that answers a chat: the Groq client, or a fake in tests. */
export interface Completer {
  complete(messages: ChatMessage[], opts?: { json?: boolean }): Promise<string>;
}

export interface GroqOptions {
  apiKey: string;
  /** A production model id from https://console.groq.com/docs/models. */
  model?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Default 60 s. */
  timeoutMs?: number;
}

export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";
const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";

export class GroqClient implements Completer {
  readonly model: string;

  constructor(private readonly opts: GroqOptions) {
    this.model = opts.model ?? DEFAULT_GROQ_MODEL;
  }

  async complete(messages: ChatMessage[], { json = true }: { json?: boolean } = {}): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 60_000);
    try {
      const res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl ?? DEFAULT_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0,
          ...(json ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`groq answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("groq answered without a completion");
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}
