import { PluginSettings } from "../settings";
import { LLMClient } from "./client";

export class OllamaClient implements LLMClient {
  private baseUrl: string;
  private model: string;

  constructor(settings: PluginSettings) {
    this.baseUrl = settings.ollamaBaseUrl.replace(/\/$/, "");
    this.model = settings.model || "llama3";
  }

  async complete(systemPrompt: string, userContent: string, signal?: AbortSignal): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userContent }],
      }),
      signal,
    });
    if (!res.ok) throw new Error(`Ollama error: ${res.status} ${res.statusText}`);
    const data = await res.json();
    return data.message?.content ?? "";
  }
}
