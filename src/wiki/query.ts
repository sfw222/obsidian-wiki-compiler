import { LLMClient } from "../llm/client";

const QUERY_PROMPT = `You are a knowledge base assistant. The user will ask a question. You have access to a wiki index and relevant wiki pages.

Read the provided wiki content carefully and answer the question with citations using [[page title]] format. Be specific and thorough. If the wiki lacks sufficient information, say so clearly.`;

export async function queryWiki(
  question: string,
  wikiContext: string,
  client: LLMClient,
  signal?: AbortSignal
): Promise<string> {
  const userMsg = `Wiki content:\n${wikiContext}\n\n---\n\nQuestion: ${question}`;
  return client.complete(QUERY_PROMPT, userMsg, signal);
}
