import { LLMClient } from "../llm/client";
import { WikiArticle } from "./generator";

const QUERY_PROMPT = `You are a knowledge base assistant. The user will ask a question. You have access to a wiki index and relevant wiki pages.

Read the provided wiki content carefully and answer the question. Be specific and thorough. If the wiki lacks sufficient information, say so clearly.

Citation format (academic style):
- In the body, mark citations as superscript numbers: [1], [2], etc.
- At the end of your answer, add a "## References" section listing each cited wiki page in order:
  [1] [[Page Title]]
  [2] [[Another Page]]
- Only list pages you actually cited. Do not use [[wikilinks]] inline in the body text.`;

function buildStructuredContext(question: string, articles: WikiArticle[]): string {
  const keywords = question.toLowerCase().split(/\W+/).filter(w => w.length > 2);
  const matched: WikiArticle[] = [];
  for (const a of articles) {
    const searchable = [
      a.title,
      a.definition,
      a.summary,
      ...a.facts.map(f => `${f.name} ${f.value}`),
      ...a.relations.map(r => `${r.predicate} ${r.target}`),
      ...a.faq.map(q => `${q.question} ${q.answer}`),
    ].join(" ").toLowerCase();
    const score = keywords.filter(k => searchable.includes(k)).length;
    if (score >= 2) matched.push(a);
  }
  if (matched.length === 0) return "";
  return matched.map(a => {
    const parts: string[] = [`## ${a.title}`];
    if (a.definition) parts.push(`**Definition**: ${a.definition}`);
    if (a.summary) parts.push(`**Summary**: ${a.summary}`);
    if (a.facts.length > 0) {
      parts.push("**Key Facts**:");
      for (const f of a.facts) parts.push(`- ${f.name}: ${f.value}`);
    }
    if (a.relations.length > 0) {
      parts.push("**Relations**:");
      for (const r of a.relations) parts.push(`- ${r.predicate} → ${r.target}`);
    }
    if (a.faq.length > 0) {
      parts.push("**FAQ**:");
      for (const q of a.faq) parts.push(`- Q: ${q.question}\n  A: ${q.answer}`);
    }
    return parts.join("\n");
  }).join("\n\n---\n\n");
}

export async function queryWiki(
  question: string,
  wikiContext: string,
  client: LLMClient,
  signal?: AbortSignal,
  articles?: WikiArticle[]
): Promise<string> {
  let contextToUse = wikiContext;
  if (articles && articles.length > 0) {
    const structured = buildStructuredContext(question, articles);
    if (structured) {
      contextToUse = `## Structured Knowledge (structured pre-retrieval)\n\n${structured}\n\n---\n\n## Full Wiki\n\n${wikiContext}`;
    }
  }
  const userMsg = `Wiki content:\n${contextToUse}\n\n---\n\nQuestion: ${question}`;
  return client.complete(QUERY_PROMPT, userMsg, signal);
}
