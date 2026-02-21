export function stripTitleSuffixes(input: string) {
  let s = String(input || "").trim();
  if (!s) return "";
  const rx =
    /\s*[\(\[]\s*(?:(?:extended|original|radio|club|album|single|clean|explicit|short|long)\s*)?(?:mix|edit|version|remix|re\-mix|rework|bootleg|instrumental|acapella|a\s*cappella|dub|vip|remaster(?:ed)?|mono|stereo)\b[^)\]]*[\)\]]\s*/gi;
  s = s.replace(rx, " ");
  return s.replace(/\s{2,}/g, " ").trim();
}

export function titleCaseEN(input: string) {
  const s = String(input || "").trim();
  if (!s) return "—";
  const lowerWords = new Set([
    "a","an","the","and","but","or","nor","for","so","yet",
    "as","at","by","for","from","in","into","near","of","on","onto","over","per","to","up","via","with","within","without",
  ]);

  const parts = s.split(/(\s+)/);
  return parts
    .map((chunk, idx) => {
      if (/^\s+$/.test(chunk)) return chunk;

      // preserve acronyms like "RJD2", "LCD", "ABF" etc (short + uppercase)
      if (chunk === chunk.toUpperCase() && /[A-Z]/.test(chunk) && chunk.length <= 6) return chunk;

      const hyParts = chunk.split("-");
      const rebuilt = hyParts.map((w, hIdx) => {
        const cleaned = w.replace(/[^\p{L}\p{N}'’]/gu, "");
        const lower = cleaned.toLowerCase();
        const isFirst = idx === 0 && hIdx === 0;
        const isLast = idx === parts.length - 1 && hIdx === hyParts.length - 1;
        if (!cleaned) return w;
        if (!isFirst && !isLast && lowerWords.has(lower)) return w.replace(cleaned, lower);
        const cap = lower.charAt(0).toUpperCase() + lower.slice(1);
        return w.replace(cleaned, cap);
      });

      return rebuilt.join("-");
    })
    .join("");
}

export function prettyTitle(rawTitle: string) {
  return titleCaseEN(stripTitleSuffixes(rawTitle || ""));
}