import { App, PluginSettingTab, Setting } from "obsidian";
import WikiCompilerPlugin from "./main";

export interface PluginSettings {
  llmProvider: "openai" | "anthropic" | "ollama" | "custom";
  apiKey: string;
  model: string;
  ollamaBaseUrl: string;
  customBaseUrl: string;
  customCompatibility: "openai" | "anthropic";
  outputFolder: string;
  outputLanguage: string;
  maxConcurrent: number;
  searxngBaseUrl: string;
  searxngToken: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  llmProvider: "openai",
  apiKey: "",
  model: "",
  ollamaBaseUrl: "http://localhost:11434",
  customBaseUrl: "",
  customCompatibility: "openai",
  outputFolder: "Wiki",
  outputLanguage: "auto",
  maxConcurrent: 3,
  searxngBaseUrl: "",
  searxngToken: "",
};

const PROVIDER_MODELS: Record<string, string> = {
  openai: "gpt-4o",
  anthropic: "claude-opus-4-6",
  ollama: "llama3",
  custom: "",
};

export class WikiCompilerSettingTab extends PluginSettingTab {
  plugin: WikiCompilerPlugin;

  constructor(app: App, plugin: WikiCompilerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("LLM Provider")
      .addDropdown((d) =>
        d
          .addOptions({ openai: "OpenAI", anthropic: "Anthropic (Claude)", ollama: "Ollama (local)", custom: "Custom (third-party)" })
          .setValue(this.plugin.settings.llmProvider)
          .onChange(async (v: PluginSettings["llmProvider"]) => {
            this.plugin.settings.llmProvider = v;
            if (!this.plugin.settings.model) {
              this.plugin.settings.model = PROVIDER_MODELS[v];
            }
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.llmProvider === "ollama") {
      new Setting(containerEl)
        .setName("Ollama Base URL")
        .addText((t) =>
          t.setValue(this.plugin.settings.ollamaBaseUrl).onChange(async (v) => {
            this.plugin.settings.ollamaBaseUrl = v;
            await this.plugin.saveSettings();
          })
        );
    } else if (this.plugin.settings.llmProvider === "custom") {
      new Setting(containerEl)
        .setName("Custom Endpoint URL")
        .setDesc("Full endpoint URL, e.g. https://api.minimaxi.com/anthropic/v1/messages or https://api.deepseek.com/v1/chat/completions")
        .addText((t) =>
          t.setPlaceholder("https://...").setValue(this.plugin.settings.customBaseUrl).onChange(async (v) => {
            this.plugin.settings.customBaseUrl = v;
            await this.plugin.saveSettings();
          })
        );
      new Setting(containerEl)
        .setName("API Compatibility")
        .setDesc("Which API format does this provider use?")
        .addDropdown((d) =>
          d
            .addOptions({ openai: "OpenAI-compatible", anthropic: "Anthropic-compatible" })
            .setValue(this.plugin.settings.customCompatibility)
            .onChange(async (v: "openai" | "anthropic") => {
              this.plugin.settings.customCompatibility = v;
              await this.plugin.saveSettings();
            })
        );
      new Setting(containerEl)
        .setName("API Key")
        .addText((t) =>
          t.setPlaceholder("sk-...").setValue(this.plugin.settings.apiKey).onChange(async (v) => {
            this.plugin.settings.apiKey = v;
            await this.plugin.saveSettings();
          })
        );
    } else {
      new Setting(containerEl)
        .setName("API Key")
        .addText((t) =>
          t.setPlaceholder("sk-...").setValue(this.plugin.settings.apiKey).onChange(async (v) => {
            this.plugin.settings.apiKey = v;
            await this.plugin.saveSettings();
          })
        );
    }

    new Setting(containerEl)
      .setName("Model")
      .setDesc(PROVIDER_MODELS[this.plugin.settings.llmProvider] ? `Default: ${PROVIDER_MODELS[this.plugin.settings.llmProvider]}` : "Enter model name")
      .addText((t) =>
        t
          .setPlaceholder(PROVIDER_MODELS[this.plugin.settings.llmProvider] || "model-name")
          .setValue(this.plugin.settings.model)
          .onChange(async (v) => {
            this.plugin.settings.model = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Output Folder")
      .setDesc("Folder where Wiki articles will be saved")
      .addText((t) =>
        t
          .setPlaceholder("Wiki")
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (v) => {
            this.plugin.settings.outputFolder = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Output Language")
      .setDesc('Language for generated articles. "auto" = same as source note.')
      .addDropdown((d) =>
        d
          .addOptions({ auto: "Auto (same as source)", zh: "Chinese (中文)", en: "English", ja: "Japanese (日本語)" })
          .setValue(this.plugin.settings.outputLanguage)
          .onChange(async (v) => {
            this.plugin.settings.outputLanguage = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max Concurrent Requests")
      .setDesc("Number of notes processed in parallel (1–10)")
      .addSlider((s) =>
        s
          .setLimits(1, 10, 1)
          .setValue(this.plugin.settings.maxConcurrent)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.maxConcurrent = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("SearXNG Base URL")
      .setDesc("URL of your SearXNG instance for concept enrichment (e.g. http://localhost:8080). Leave empty to skip.")
      .addText((t) =>
        t.setPlaceholder("http://localhost:8080").setValue(this.plugin.settings.searxngBaseUrl).onChange(async (v) => {
          this.plugin.settings.searxngBaseUrl = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("SearXNG Token")
      .setDesc("Optional Bearer token for authenticated SearXNG instances.")
      .addText((t) =>
        t.setPlaceholder("token...").setValue(this.plugin.settings.searxngToken).onChange(async (v) => {
          this.plugin.settings.searxngToken = v;
          await this.plugin.saveSettings();
        })
      );
  }
}
