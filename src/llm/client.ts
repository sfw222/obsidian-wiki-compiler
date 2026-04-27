import { PluginSettings } from "../settings";
import { OpenAIClient } from "./openai";
import { AnthropicClient } from "./anthropic";
import { OllamaClient } from "./ollama";
import { CustomOpenAIClient } from "./custom-openai";
import { CustomAnthropicClient } from "./custom-anthropic";

export interface LLMClient {
  complete(systemPrompt: string, userContent: string, signal?: AbortSignal): Promise<string>;
}

export function createLLMClient(settings: PluginSettings): LLMClient {
  switch (settings.llmProvider) {
    case "openai":
      return new OpenAIClient(settings);
    case "anthropic":
      return new AnthropicClient(settings);
    case "ollama":
      return new OllamaClient(settings);
    case "custom":
      return settings.customCompatibility === "anthropic"
        ? new CustomAnthropicClient(settings)
        : new CustomOpenAIClient(settings);
  }
}
