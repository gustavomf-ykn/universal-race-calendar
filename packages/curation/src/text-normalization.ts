/** Repair only reversible UTF-8 bytes misread as Latin-1. Never damage valid Unicode. */
export function repairMojibake(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value.replace(/\S+/gu, (part) => {
    if (!/[ÃÂ]/.test(part) || [...part].some((char) => char.charCodeAt(0) > 255)) return part;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(part, "latin1"));
    } catch {
      return part;
    }
  });
}

export function sourceModality(title: string, text: string): "road" | "trail" | "kids" | "walk" | "unknown" {
  const name = title.toLowerCase();
  const content = text.toLowerCase();
  if (/\b(kids?|infantil)\b/.test(name)) return "kids";
  if (/\btrail\b/.test(name) || /\btrail running\b|\btrilhas\b|\b(?:corrida|percurso)\s+(?:em|de|pela)\s+trilha\b/.test(content)) return "trail";
  if (name.includes("caminhada") && !/(corrida|maratona|meia|desafio|circuito)/.test(name)) return "walk";
  if (/\b(rua|asfalto|road)\b/.test(content) || /(corrida|maratona|meia|circuito|run)\b/.test(name)) return "road";
  if (content.includes("caminhada") && !/(corrida|maratona|meia)/.test(content)) return "walk";
  return "unknown";
}
