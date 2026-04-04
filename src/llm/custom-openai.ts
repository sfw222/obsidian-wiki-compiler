import { requestUrl } from "obsidian";
import { PluginSettings } from "../settings";
import { LLMClient } from "./client";

export class CustomOpenAIClient implements LLMClient {
  private baseUrl: string;
  private apiKey: string;
  private model: string;

  constructor(settings: PluginSettings) {
    this.baseUrl = settings.customBaseUrl;
    this.apiKey = settings.apiKey;
    this.model = settings.model;
  }

  async complete(systemPrompt: string, userContent: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const res = await requestUrl({
      url: this.baseUrl,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userContent }],
      }),
      throw: false,
    });
    if (res.status >= 400 || !res.text.trim().startsWith("{")) {
      throw new Error(`Custom OpenAI API error: ${res.status} — ${res.text.slice(0, 200)}`);
    }
    const json = JSON.parse(res.text);
    return json?.choices?.[0]?.message?.content ?? "";
  }
}
