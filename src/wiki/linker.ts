import { WikiArticle } from "./generator";

export function injectBidirectionalLinks(articles: WikiArticle[]): WikiArticle[] {
  // Build title → article map (case-insensitive)
  const titleMap = new Map<string, WikiArticle>();
  for (const a of articles) titleMap.set(a.title.toLowerCase(), a);

  // Build backlink map: title → set of titles that reference it
  const backlinks = new Map<string, Set<string>>();
  for (const a of articles) {
    for (const related of a.relatedTopics) {
      const key = related.toLowerCase();
      if (!backlinks.has(key)) backlinks.set(key, new Set());
      backlinks.get(key)!.add(a.title);
    }
  }

  return articles.map((a) => {
    const seeAlso = new Set<string>(a.relatedTopics);
    // Add backlinks from other articles that reference this one
    const incoming = backlinks.get(a.title.toLowerCase());
    if (incoming) for (const t of incoming) seeAlso.add(t);

    const seeAlsoSection =
      seeAlso.size > 0
        ? `\n\n## See Also\n${[...seeAlso].map((t) => `- [[${t}]]`).join("\n")}`
        : "";

    return { ...a, content: a.content + seeAlsoSection };
  });
}
