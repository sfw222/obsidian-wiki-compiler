import { LLMClient } from "../llm/client";

const LINT_PROMPT = `You are a wiki health auditor. Analyze the provided wiki content and identify issues.

Return a markdown report with these sections:
## Contradictions
List any pages with conflicting information (cite [[page title]]).

## Orphan Pages
List pages with no incoming [[wikilinks]] from other pages.

## Missing Concepts
List important concepts mentioned in multiple pages but lacking their own dedicated page.

## Stale Content
List pages that appear outdated or reference things that may have changed.

Be specific and actionable. If a section has no issues, write "None found."`;

export async function lintWiki(
  wikiContext: string,
  client: LLMClient,
  signal?: AbortSignal
): Promise<string> {
  return client.complete(LINT_PROMPT, `Wiki content:\n${wikiContext}`, signal);
}
