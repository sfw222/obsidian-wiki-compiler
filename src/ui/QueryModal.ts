import { App, Modal, Setting, TFile } from "obsidian";

export class QueryModal extends Modal {
  private question = "";
  private answer = "";
  private onQuery: (question: string) => Promise<string>;
  private onSave: (question: string, answer: string) => Promise<void>;
  private answerEl: HTMLElement | null = null;
  private saveBtn: HTMLButtonElement | null = null;

  constructor(
    app: App,
    onQuery: (question: string) => Promise<string>,
    onSave: (question: string, answer: string) => Promise<void>
  ) {
    super(app);
    this.onQuery = onQuery;
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Query Wiki" });

    new Setting(contentEl)
      .setName("Question")
      .addText((t) => {
        t.setPlaceholder("Ask anything about your wiki...").onChange((v) => (this.question = v));
        t.inputEl.style.width = "100%";
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") this.runQuery();
        });
      });

    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Ask").setCta().onClick(() => this.runQuery())
    );

    this.answerEl = contentEl.createDiv({ cls: "wiki-query-answer" });
    this.answerEl.style.cssText = "display:none;margin-top:12px;padding:12px;border:1px solid var(--background-modifier-border);border-radius:6px;white-space:pre-wrap;max-height:400px;overflow-y:auto;";

    const saveRow = contentEl.createDiv();
    saveRow.style.cssText = "display:none;margin-top:8px;text-align:right;";
    this.saveBtn = saveRow.createEl("button", { text: "Save to Wiki" });
    this.saveBtn.addEventListener("click", async () => {
      await this.onSave(this.question, this.answer);
      saveRow.style.display = "none";
    });
    // store ref to saveRow for toggling
    (this as any)._saveRow = saveRow;
  }

  private async runQuery() {
    if (!this.question.trim() || !this.answerEl) return;
    this.answerEl.style.display = "block";
    this.answerEl.setText("Searching wiki...");
    (this as any)._saveRow.style.display = "none";

    try {
      this.answer = await this.onQuery(this.question);
      this.answerEl.setText(this.answer);
      (this as any)._saveRow.style.display = "block";
    } catch (e) {
      this.answerEl.setText(`Error: ${(e as Error).message}`);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
