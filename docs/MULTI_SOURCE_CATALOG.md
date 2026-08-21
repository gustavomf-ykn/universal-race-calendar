# Catalogo multi-fonte

## Prioridade e proveniencia

1. TicketSports e a fonte primaria quando existir.
2. Site oficial completa campos vazios e fornece capa/JSON-LD/OpenGraph.
3. CorridasBR cria eventos proprios quando nao houver correspondencia.

`EventSourceReference` registra todas as fontes de um evento. Uma prova CorridasBR promovida para TicketSports preserva `eventId` e slug. A promocao mantem campos anteriores quando a fonte prioritaria nao os fornece.

## Correspondencia

Ordem: ID TicketSports no link externo, URL, fingerprint exato e similaridade de nome com data/cidade/UF iguais. Scores a partir de `0.92` vinculam; `0.80` a `0.919` ficam em revisao; abaixo disso o CorridasBR cria um evento.

## Publicacao

CorridasBR pode publicar com nome, data, cidade, UF, pais BR e URL de origem. Banner, preco, lote e kit nao sao obrigatorios. Precos/lotes so entram por evidencia explicita; banners publicitarios do CorridasBR nunca sao usados.

## Operacao

- `Catalog Import` diario: reaplica somente fontes alteradas.
- Reconciliacao semanal: `force=true`.
- Lotes: 25 candidatos.
- CorridasBR: concorrencia 2 e atraso de 500 ms.
- Pagina oficial: uma requisicao por dominio e cache em memoria de sete dias.
- Simulacao: `POST /v1/admin/import-runs` com `mode=simulate`; nao altera `Event`.
- Bloqueios/desafios de seguranca do CorridasBR geram falha auditavel; nunca sao tratados como calendario vazio.

O artifact do workflow contem os resultados de ambas as fontes, resumo de cobertura e amostra da API publica.
