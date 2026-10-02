# Catalogo multi-fonte

## Prioridade e proveniencia

1. TicketSports e a fonte primaria quando existir.
2. Site oficial completa campos vazios e fornece capa/JSON-LD/OpenGraph.
3. CorridasBR cria eventos proprios quando nao houver correspondencia.

`EventSourceReference` registra todas as fontes de um evento. Uma prova CorridasBR promovida para TicketSports preserva `eventId` e slug. A promocao mantem campos anteriores quando a fonte prioritaria nao os fornece.

## Correspondencia

Identidade de fonte ja associada e reutilizada. Para novas associacoes entre fontes, exigir link direto reconhecido de edicao, correspondencia unica, mesma data/cidade/UF/pais e observacao validada da localizacao. URLs genericas de organizadores, fingerprints e similaridade de nome somente sugerem revisao; nenhum score de nome autoriza vinculo automatico. Links contraditorios, referencias sem evidencia, conflito de localizacao, identidades diferentes da mesma fonte e estados hidden/rejected exigem revisao. Anos distintos permanecem separados. Uniao auditada de registros ja separados ainda esta em desenvolvimento na branch nacional.

## Publicacao

CorridasBR pode publicar com nome, data, cidade, UF, pais BR e URL de origem. Banner, preco, lote e kit nao sao obrigatorios. Precos/lotes so entram por evidencia explicita; banners publicitarios do CorridasBR nunca sao usados.

## Operacao

Os parametros legados abaixo descrevem o importador antigo, nao uma agenda atualmente habilitada. A branch nacional usa limites compartilhados, intervalos conservadores e continuidade opt-in descritos em [NATIONAL-CATALOG.md](NATIONAL-CATALOG.md). Agenda nacional semanal ainda pendente; nao confundir configuracao/documentacao com execucao real.

- `Catalog Import` diario: reaplica somente fontes alteradas.
- Reconciliacao semanal: `force=true`.
- Lotes: 25 candidatos.
- CorridasBR: concorrencia 2 e atraso de 500 ms.
- Pagina oficial: uma requisicao por dominio e cache em memoria de sete dias.
- Simulacao: `POST /v1/admin/import-runs` com `mode=simulate`; nao altera `Event`.
- Bloqueios/desafios de seguranca do CorridasBR geram falha auditavel; nunca sao tratados como calendario vazio.

O artifact do workflow contem os resultados de ambas as fontes, resumo de cobertura e amostra da API publica.
