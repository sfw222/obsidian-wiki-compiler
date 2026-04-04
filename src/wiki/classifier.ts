export function sanitizeFolderName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, "").trim() || "Uncategorized";
}

export function categoryPath(outputFolder: string, category: string): string {
  return `${outputFolder}/${sanitizeFolderName(category)}`;
}
