import { PluginSettings } from "../settings";

export interface LLMClient {
  complete(systemPrompt: string, userContent: string, signal?: AbortSignal): Promise<string>;
}

export function createLLMClient(settings: PluginSettings): LLMClient {
  switch (settings.llmProvider) {
    case "openai": {
      const { OpenAIClient } = require("./openai");
      return new OpenAIClient(settings);
    }
    case "anthropic": {
      const { AnthropicClient } = require("./anthropic");
      return new AnthropicClient(settings);
    }
    case "ollama": {
      const { OllamaClient } = require("./ollama");
      return new OllamaClient(settings);
    }
    case "custom": {
      if (settings.customCompatibility === "anthropic") {
        const { CustomAnthropicClient } = require("./custom-anthropic");
        return new CustomAnthropicClient(settings);
      }
      const { CustomOpenAIClient } = require("./custom-openai");
      return new CustomOpenAIClient(settings);
    }
  }
}
