import { modalityFromSourceText, type SourceModality } from "@race-calendar/utils";

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

export function sourceModality(title: string, text: string): SourceModality {
  return modalityFromSourceText(title, text).modality;
}
