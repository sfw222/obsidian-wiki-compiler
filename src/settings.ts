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
  categories: string[];
}

export const DEFAULT_CATEGORIES: Record<string, string[]> = {
  en: [
    "Computer Science", "Mathematics", "Physics", "Chemistry",
    "Biology", "Medicine", "Engineering",
    "Economics", "Finance", "Business",
    "Law", "Education",
    "Philosophy", "Psychology", "Sociology",
    "History", "Literature", "Art", "Music",
    "Others",
  ],
  // NOTE: The Chinese category list below was synchronized from the user's vault `_index.md` on 2026-04-20.
  // Keep in sync with README.zh-CN.md if you update the categories there.
  zh: [
    "天文学", "地球科学", "物理", "化学",
    "历史", "哲学", "工程", "军事",
    "教育", "数学", "文学", "生物",
    "社会学", "经济学", "艺术", "计算机科学",
    "人工智能", "游戏开发", "游戏设计", "语言学",
    "其他",
  ],
  ja: [
    "コンピュータサイエンス", "数学", "物理学", "化学",
    "生物学", "医学", "工学",
    "経済学", "金融", "ビジネス",
    "法学", "教育",
    "哲学", "心理学", "社会学",
    "歴史", "文学", "芸術", "音楽",
    "その他",
  ],
};

export function getDefaultCategories(lang: string): string[] {
  return [...(DEFAULT_CATEGORIES[lang] ?? DEFAULT_CATEGORIES["en"])];
}

export function getFallbackCategory(lang: string): string {
  const cats = DEFAULT_CATEGORIES[lang] ?? DEFAULT_CATEGORIES["en"];
  return cats[cats.length - 1];
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
  categories: getDefaultCategories("zh"),
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
            const oldLang = this.plugin.settings.outputLanguage === "auto" ? "en" : this.plugin.settings.outputLanguage;
            this.plugin.settings.outputLanguage = v;
            const newLang = v === "auto" ? "en" : v;
            const oldDefaults = getDefaultCategories(oldLang);
            const currentIsDefault = JSON.stringify(this.plugin.settings.categories) === JSON.stringify(oldDefaults);
            if (currentIsDefault) {
              this.plugin.settings.categories = getDefaultCategories(newLang);
            }
            await this.plugin.saveSettings();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Categories")
      .setDesc("One category per line. Articles MUST be classified into one of these. The last entry is the fallback for uncategorizable articles.")
      .addTextArea((t) => {
        t.inputEl.rows = 10;
        t.inputEl.style.width = "100%";
        t.setValue(this.plugin.settings.categories.join("\n")).onChange(async (v) => {
          this.plugin.settings.categories = v.split("\n").map((s) => s.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        });
      })
      .addButton((b) =>
        b.setButtonText("Reset to defaults").onClick(async () => {
          const lang = this.plugin.settings.outputLanguage === "auto" ? "en" : this.plugin.settings.outputLanguage;
          this.plugin.settings.categories = getDefaultCategories(lang);
          await this.plugin.saveSettings();
          this.display();
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
