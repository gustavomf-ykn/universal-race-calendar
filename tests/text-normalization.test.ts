import { describe, expect, it } from "vitest";
import { repairMojibake, sourceModality } from "../packages/curation/src/text-normalization.js";

describe("source text normalization", () => {
  it.each(["MOUNTAIN DO COSTÃO DO SANTINHO 2026", "6ª CORRIDA VALORIZAÇÃO DA VIDA", "Ângela € 🏃", "SÃO JOSÉ"])("preserves valid text: %s", (text) => {
    expect(repairMojibake(text)).toBe(text);
  });
  it("repairs reversible mojibake without damaging other words", () => {
    expect(repairMojibake("SÃO FlorianÃ³polis")).toBe("SÃO Florianópolis");
    expect(repairMojibake(null)).toBeNull();
  });
  it("uses trail evidence rather than the generic road default", () => {
    expect(sourceModality("MOUNTAIN DO COSTÃO", "percursos com trilhas, bosques, praias e dunas")).toBe("trail");
    expect(sourceModality("Corrida da Serra", "trail running")).toBe("trail");
    expect(sourceModality("Evento desconhecido", "inscrições abertas")).toBe("unknown");
    expect(sourceModality("Corrida da Cidade", "corrida de rua")).toBe("road");
    expect(sourceModality("Corrida de Verão", "Acesse Trilha do Líder clicando aqui")).toBe("road");
  });
});
