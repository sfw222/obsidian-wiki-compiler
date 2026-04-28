### 默认分类（中文）

以下为插件默认的中文分类（已同步自用户笔记）。最后一项为回退分类（当 LLM 无法匹配任何类别时使用）。
单行可复制列表：

```
天文学, 地球科学, 物理, 化学, 历史, 哲学, 工程, 军事, 教育, 数学, 文学, 生物, 社会学, 经济学, 艺术, 计算机科学, 人工智能, 游戏开发, 游戏设计, 语言学, 其他
```

分行展示：

- 天文学
- 地球科学
- 物理
- 化学
- 历史
- 哲学
- 工程
- 军事
- 教育
- 数学
- 文学
- 生物
- 社会学
- 经济学
- 艺术
- 计算机科学
- 人工智能
- 游戏开发
- 游戏设计
- 语言学
- 其他
# Obsidian Wiki Compiler

> 灵感来源于 [Andrej Karpathy 的 LLM 知识库](https://x.com/karpathy/status/2039805659525644595) 理念。

使用 LLM 将 Obsidian 笔记编译成结构化、互相关联的 Wiki。选择一篇笔记或一个文件夹，插件自动生成带有双向 `[[wikilinks]]` 的百科式文章，并按主题自动分类存入子目录。还能自动提取高频概念，通过网络搜索生成专属概念页面，持续丰富你的知识库。

[English Documentation](README.md)

---

## 功能特性

- **一键编译** — 右键任意笔记或文件夹 → "Compile to Wiki"
- **递归处理子目录** — 自动处理所选文件夹下所有子目录中的 `.md` 文件
- **智能分类** — LLM 将文章归入你自定义的分类列表；无匹配时回退到最后一个分类
- **自定义分类** — 在设置中自定义分类列表，切换输出语言时自动更新默认分类
- **结构化知识提取** — 每篇文章生成后独立执行第二轮 LLM 提取，产出 `facts[]`（结构化事实）、`relations[]`（显式关系）、`faq[]`（常见问答）、`definition`（一句话定义）和 `summary`（摘要）；提取失败不影响主文章；成功提取后文章状态自动标记为 `status: verified`
- **自动生成标签** — `tags` 字段由文章元数据自动派生为 `type/<类型>`、`cat/<分类>`、`status/<状态>` 三组层级标签，无需手动填写即可在 Obsidian 原生标签面板中按类型、分类和审核状态筛选文章
- **双向链接** — 新文章同时从 `relatedTopics` 和 `relations[].target` 生成 `## See Also`；已有文章通过 LLM 增量更新相关内容
- **概念提取** — 自动提取跨文章的高频概念，通过 SearXNG 搜索权威信息，生成带有标准结构化 frontmatter 的专属概念页面；所有页面生成完毕后统一注入双向链接；已有概念页面通过代码侧过滤跳过，无额外 LLM token 消耗
- **概念页面刷新** — 对所有已有概念页面重新搜索：从提及该概念的 wiki 文章标题中提取领域上下文，作为 SearXNG 查询的消歧提示；适用于改善早期缺乏上下文时生成的概念页面，无需 LLM
- **附件补丁** — 从归档的 raw 笔记中提取附件引用（`![[...]]`），补充写入对应 wiki 文章；适用于初次处理时遗漏附件的情况，无需 LLM
- **Wiki 问答** — 提问时先对 `facts`、`faq`、`relations` 字段进行结构化预检索，命中结果优先传入 LLM；LLM 以学术引用格式回答（正文标注 `[1][2]`，末尾列出参考文献）；点击序号跳转引用；支持一键复制答案或保存为笔记
- **Wiki 健康检查** — 两阶段检查，支持进度弹窗与取消：(1) 代码级静态分析（零 LLM 消耗）— 检测缺失 `source` 字段、无来源的 facts/relations、超期未复审文章（自动标记 `needs-review`）、孤立页面；(2) LLM 分析矛盾内容、缺失概念、过时信息与可执行修复建议。完成后会自动打开 `_lint-report.md`。每次 lint 会更新同一个 `_lint-report.md`，完整执行过程按时间戳写入 `_runs/`，并在 `_log.md` 留痕。
- **源文件归档** — 处理完成的笔记移入 `raw/` 目录，避免重复处理
- **累积索引** — `_index.md` 跨会话合并所有文章，按分类层级组织
- **操作日志** — `_log.md` 记录所有操作（编译、问答、检查、概念提取）；每次编译的详细步骤日志按时间戳保存至 `_runs/`，时间采用本地时区
- **进度界面** — 实时显示处理进度，支持取消操作
- **多 LLM 支持** — OpenAI、Anthropic (Claude)、Ollama（本地）或任意第三方 API；零第三方 SDK 依赖（仅使用原生 `requestUrl`）

---

## 安装

### 手动安装（推荐，在上架社区插件市场前）

1. 从 [最新 Release](https://github.com/colin4k/obsidian-wiki-compiler/releases) 下载 `main.js`、`manifest.json`、`styles.css`
2. 将三个文件复制到 vault 目录：
   ```
   <你的vault>/.obsidian/plugins/wiki-compiler/
   ```
3. 在 Obsidian 中：**设置 → 第三方插件 → 启用** "Wiki Compiler"

### 从源码构建

```bash
git clone https://github.com/colin4k/obsidian-wiki-compiler.git
cd obsidian-wiki-compiler
npm install
npm run build
# 将 main.js + manifest.json + styles.css 复制到 vault 插件目录
```

---

## 配置

打开 **设置 → Wiki Compiler**：

| 设置项 | 说明 | 默认值 |
|--------|------|--------|
| LLM Provider | OpenAI / Anthropic / Ollama / 自定义 | OpenAI |
| API Key | API 密钥（Ollama 不需要） | — |
| Model | 模型名称 | gpt-4o |
| Output Folder | Wiki 文章保存目录 | `Wiki` |
| Output Language | auto / zh / en / ja | auto |
| Categories | 每行一个分类，最后一行为兜底分类 | （随语言自动设置） |
| Max Concurrent | 并发请求数（1–10） | 3 |
| SearXNG Base URL | SearXNG 实例地址，用于概念搜索增强 | — |
| SearXNG Token | SearXNG 认证 Token（可选） | — |
| Enable Structured Extraction | 是否启用第二轮 LLM 提取 facts、relations、FAQ 等结构化字段 | 开启 |
| Review Interval Days | 超过此天数未复审的文章被健康检查标记为 `needs-review` | 90 |

### 自定义第三方 API

将 **LLM Provider** 设为 "Custom"，然后配置：
- **Custom Endpoint URL** — 完整的请求端点 URL，例如 `https://api.deepseek.com/v1/chat/completions`
- **API Compatibility** — OpenAI 兼容或 Anthropic 兼容
- **API Key** 和 **Model**

---

## 使用方法

### 处理单篇笔记

在文件浏览器中右键任意 `.md` 文件 → **Compile to Wiki**

或使用命令面板：`Wiki Compiler: Process current file`

### 处理文件夹

右键任意文件夹 → **Compile folder to Wiki**

或使用命令面板：`Wiki Compiler: Process folder (enter path)`

会递归处理所有子目录中的 `.md` 文件。

### Wiki 问答

命令面板：`Wiki Compiler: Query Wiki`

打开问答窗口，输入问题后 LLM 基于 Wiki 内容回答，采用学术引用格式——正文中标注 `[1]`、`[2]`，答案末尾的 **References** 区块按序号列出引用的 Wiki 页面。点击序号可跳转到对应引用。点击 **Copy** 复制原始答案到剪贴板，或点击 **Save to Wiki** 将问答保存为 `Wiki/Queries/` 下的笔记。

### 健康检查

命令面板：`Wiki Compiler: Lint Wiki (health check)`

执行时会显示分阶段进度弹窗，并支持取消。

生成（或更新）`_lint-report.md` 报告，包含：
- 页面间的矛盾信息
- 无入链的孤立页面
- 值得独立成页的缺失概念
- 过时或陈旧的内容

说明：
- 最新结果会覆盖 `_lint-report.md`
- 每次完整过程都会写入 `_runs/`，并在 `_log.md` 记录
- 完成后自动打开 `_lint-report.md`

### 刷新概念页面

命令面板：`Wiki Compiler: Refresh Concept Pages (re-search with wiki context)`

对所有已有概念页面重新执行搜索。对每个概念，插件找出提及它的 wiki 文章，将这些文章的标题作为领域上下文提示传入 SearXNG 查询，从而自动消歧同名概念。无需 LLM。

### 附件补丁

命令面板：`Wiki Compiler: Patch attachments from raw (no LLM)`

从 `raw/` 归档目录中提取附件引用，补充写入对应的 wiki 文章。适用于初次处理时遗漏附件的情况。无需 LLM。

### 概念提取

命令面板：`Wiki Compiler: Extract Concepts (retry SearXNG)`

手动触发概念提取，需配置 SearXNG。插件识别跨文章高频概念，通过网络搜索权威信息，生成专属概念页面，并将 `[[wikilink]]` 注入回相关文章。

### 输出结构

```
Wiki/
├── Wiki/                      ← 按分类组织的生成文章
│   ├── 机器学习/
│   │   ├── Transformer.md
│   │   └── 神经网络.md
│   └── 金融/
│       └── IPO流程.md
├── Concepts/                  ← 自动生成的概念页面
│   ├── 注意力机制.md
│   └── 梯度下降.md
├── raw/                       ← 原始源笔记（已归档）
├── Queries/                   ← 保存的问答结果
├── _runs/                     ← 每次编译的详细运行日志（含时间戳）
├── _index.md                  ← 文章累积索引
├── _log.md                    ← 操作日志
└── _lint-report.md            ← 最近一次健康检查报告（每次执行更新）
```

每篇文章包含：
- Frontmatter：`id`、`title`、`type`、`category`、`status`、`source`、`source_mtime`、`created`、`updated`、`lastReviewed`、`definition`、`summary`、`tags`（自动派生）、`facts[]`、`relations[]`、`faq[]`
- 带 `[[wikilinks]]` 的百科式正文
- `## See Also` 双向链接区块（合并自 `relatedTopics` 和 `relations[].target`）
- `## Attachments` 附件区块（当源笔记包含嵌入文件时）

---

## 工作原理

1. **生成（Phase 1）** — 每篇源笔记发送给 LLM，生成包含标题、分类、正文和相关主题的结构化 Wiki 文章
2. **提取（Phase 2）** — 对每篇文章独立执行第二轮 LLM 调用，提取 `facts[]`、`relations[]`、`faq[]`、`definition` 和 `summary`；此阶段失败不影响 Phase 1 结果；成功时自动设置 `status: verified`
3. **链接** — 在所有新文章间注入双向 `[[wikilinks]]`（同时来自 `relatedTopics` 和 `relations[].target`），并添加 `## See Also` 区块
4. **更新** — 通过 LLM 增量更新已有的相关 Wiki 文章，融入新知识
5. **归档** — 源笔记移入 `raw/` 目录，防止重复处理
6. **索引** — 更新 `_index.md`，按分类组织新条目
7. **增强** — 若配置了 SearXNG，提取高频概念并通过网络搜索生成带有结构化 frontmatter 的专属概念页面；已有概念自动跳过
8. **日志** — 每次编译的逐步详情以时间戳命名保存至 `_runs/`（使用本地时区时间）

---

## License

MIT
