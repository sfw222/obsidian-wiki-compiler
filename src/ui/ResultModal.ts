import { App, Modal } from "obsidian";

export class ResultModal extends Modal {
  private title: string;
  private message: string;

  constructor(app: App, title: string, message: string) {
    super(app);
    this.title = title;
    this.message = message;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: this.title });
    const pre = contentEl.createEl("div");
    pre.style.cssText = "white-space:pre-wrap;margin:12px 0;line-height:1.6;";
    pre.setText(this.message);
    const btnRow = contentEl.createDiv();
    btnRow.style.cssText = "text-align:right;margin-top:16px;";
    const btn = btnRow.createEl("button", { text: "OK" });
    btn.addClass("mod-cta");
    btn.onclick = () => this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}
