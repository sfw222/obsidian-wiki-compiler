import { requestUrl } from "obsidian";
import { PluginSettings } from "../settings";
import { LLMClient } from "./client";

export class AnthropicClient implements LLMClient {
  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor(settings: PluginSettings, baseURL?: string) {
    this.baseUrl = baseURL ?? "https://api.anthropic.com/v1/messages";
    this.apiKey = settings.apiKey;
    this.model = settings.model || "claude-opus-4-6";
  }

  async complete(systemPrompt: string, userContent: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const res = await requestUrl({
      url: this.baseUrl,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }),
      throw: false,
    });
    if (res.status >= 400) {
      throw new Error(`Anthropic API error: ${res.status} — ${res.text.slice(0, 200)}`);
    }
    const json = JSON.parse(res.text);
    const textBlock = Array.isArray(json?.content) ? json.content.find((b: any) => b.type === "text") : null;
    return textBlock?.text ?? "";
  }
}
