import Anthropic from "@anthropic-ai/sdk";
import { PluginSettings } from "../settings";
import { LLMClient } from "./client";

export class AnthropicClient implements LLMClient {
  private client: Anthropic;
  private model: string;

  constructor(settings: PluginSettings, baseURL?: string) {
    this.client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true, ...(baseURL ? { baseURL } : {}) });
    this.model = settings.model || "claude-opus-4-6";
  }

  async complete(systemPrompt: string, userContent: string, signal?: AbortSignal): Promise<string> {
    const res = await this.client.messages.create(
      { model: this.model, max_tokens: 4096, system: systemPrompt, messages: [{ role: "user", content: userContent }] },
      { signal }
    );
    const block = res.content[0];
    return block.type === "text" ? block.text : "";
  }
}
