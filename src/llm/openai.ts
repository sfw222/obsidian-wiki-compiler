import OpenAI from "openai";
import { PluginSettings } from "../settings";
import { LLMClient } from "./client";

export class OpenAIClient implements LLMClient {
  private client: OpenAI;
  private model: string;

  constructor(settings: PluginSettings, baseURL?: string) {
    this.client = new OpenAI({ apiKey: settings.apiKey, ...(settings.confirmAllowBrowser ? { dangerouslyAllowBrowser: true } : {}), ...(baseURL ? { baseURL } : {}) });
    this.model = settings.model || "gpt-4o";
  }

  async complete(systemPrompt: string, userContent: string, signal?: AbortSignal): Promise<string> {
    const res = await this.client.chat.completions.create(
      { model: this.model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userContent }] },
      { signal }
    );
    return res.choices[0].message.content ?? "";
  }
}
