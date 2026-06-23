# Sources

`SourceAdapter` e a fronteira entre um site especifico e o dominio canonico da API.

```ts
type SourceAdapter = {
  sourceType: string;
  adapter: string;
  adapterVersion: string;
  canHandle(url: string): boolean;
  fetchAndExtract(input: SourceFetchInput): Promise<RawSourceExtraction>;
};
```

## TicketSports

TicketSports e a primeira fonte real. O adapter reaproveita a abordagem do `scraper-cbr`:

- detectar URLs `ticketsports.com.br`;
- descobrir corridas de rua via `/api/events/list?quickFilter=corrida-de-rua`;
- buscar `api/events/detail` quando houver `eventId`;
- extrair `eventContents`;
- limpar HTML/texto;
- preservar payload bruto em `rawSourceData`;
- calcular `contentHash`.

A saida do adapter e sempre `RawSourceExtraction`. Ela nao e o modelo publico da API.

O importador `import-ticketsports` cria/atualiza `Source` por `adapter + externalId` e roda o check de cada evento descoberto. No MVP, a normalizacao da TicketSports e deterministica e nao chama provider de IA.

Em producao, o workflow chama a importacao em lotes usando `quantity` e `offset`. Cada lote grava um `ImportRun` com contadores, falhas e duracao.

## RawSourceExtraction

Representa o conteudo bruto importante de uma fonte:

- `sourceType`, `sourceId`, `sourceExternalId`, `url`;
- `title`, `importantHtml`, `importantText`;
- `rawSourceData`, `extractedLinks`;
- `contentHash`, `fetchedAt`;
- `adapter`, `adapterVersion`.

## Adicionando novas fontes

1. Criar outro adapter em `packages/sources`.
2. Implementar `canHandle`.
3. Retornar `RawSourceExtraction` sem mapear para schema publico.
4. Registrar no `SourceAdapterRegistry`.
5. Adicionar fixtures e testes.

Nenhum adapter deve criar campos publicos especificos da sua plataforma.
