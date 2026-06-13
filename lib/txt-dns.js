const TXT_CHUNK_SIZE = 255;

/** Extract logical TXT payload from one or more quoted segments. */
export function parseTxtContent(value) {
  const str = String(value ?? "").trim();
  if (!str) return "";

  const parts = [];
  const re = /"([^"]*)"/g;
  let match;
  while ((match = re.exec(str)) !== null) {
    parts.push(match[1]);
  }

  if (parts.length) return parts.join("");
  return str.replace(/^"|"$/g, "");
}

/** Format TXT for Hetzner — split into <=255-char quoted chunks when needed. */
export function formatTxt(value) {
  const stripped = parseTxtContent(value);
  if (!stripped) return '""';
  if (stripped.length <= TXT_CHUNK_SIZE) {
    return `"${stripped}"`;
  }

  const chunks = [];
  for (let i = 0; i < stripped.length; i += TXT_CHUNK_SIZE) {
    chunks.push(`"${stripped.slice(i, i + TXT_CHUNK_SIZE)}"`);
  }
  return chunks.join(" ");
}
