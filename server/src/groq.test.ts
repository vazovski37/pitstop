import { describe, expect, it } from "vitest";
import { DEFAULT_GROQ_MODEL, GroqClient } from "./groq.js";

type Call = { url: string; init: RequestInit };

const fakeFetch = (status: number, body: unknown, calls: Call[]): typeof fetch =>
  (async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

describe("GroqClient", () => {
  it("posts an OpenAI-style chat completion in JSON mode and returns the first choice", async () => {
    const calls: Call[] = [];
    const client = new GroqClient({ apiKey: "gsk_test", fetch: fakeFetch(200, { choices: [{ message: { content: '{"ok":true}' } }] }, calls) });
    const text = await client.complete([{ role: "user", content: "hi" }]);
    expect(text).toBe('{"ok":true}');
    expect(calls[0]?.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer gsk_test");
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.model).toBe(DEFAULT_GROQ_MODEL);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.temperature).toBe(0);
  });

  it("uses the model and base URL it is given", async () => {
    const calls: Call[] = [];
    const client = new GroqClient({
      apiKey: "k",
      model: "llama-3.3-70b-versatile",
      baseUrl: "https://example.test/v1",
      fetch: fakeFetch(200, { choices: [{ message: { content: "x" } }] }, calls),
    });
    await client.complete([{ role: "user", content: "hi" }], { json: false });
    expect(calls[0]?.url).toBe("https://example.test/v1/chat/completions");
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.model).toBe("llama-3.3-70b-versatile");
    expect(body.response_format).toBeUndefined();
  });

  it("fails loudly on an error status or an empty answer", async () => {
    const calls: Call[] = [];
    await expect(new GroqClient({ apiKey: "k", fetch: fakeFetch(429, "rate limited", calls) }).complete([])).rejects.toThrow(/groq answered 429/);
    await expect(new GroqClient({ apiKey: "k", fetch: fakeFetch(200, { choices: [] }, calls) }).complete([])).rejects.toThrow(/without a completion/);
  });
});
