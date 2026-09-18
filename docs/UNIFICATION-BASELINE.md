# Base verificável — 18/09/2026

Calendário: `9bfeb66e5455ff5c0a8e08512bcf67df91040545` (MIT).
OpenResults: `43779c8310f2c986ef2e936e58f0d95bf169c5d6` (MIT).
Os dois HEADs continuam iguais aos commits da análise anterior.

## Evidências

Logs GitHub dos jobs 105607215005 e 105607131813 confirmam respectivamente
HTTP 404 ao criar import-runs e HTTP 500 na importação TicketSports. As URLs
estão mascaradas e os logs não incluem corpo de resposta nem traceback do
servidor. Não há evidência suficiente para atribuir o erro ao parser, banco ou
deploy. Verificar URL efetiva, SHA em execução e logs do Render continua necessário.

As duas rotas existem no HEAD. Há dois agendamentos diários idênticos e importações
longas no processo HTTP. A vitrine e render.yaml usam nomes distintos de serviço.
O worker existente é CLI. OpenResults mantém execução, SQLite e TTL no servidor antigo.

## Plano

1. Preservar coletores, normalização e contratos de calendário; incorporar Python com atribuição.
2. Acrescentar modelos permanentes e fila PostgreSQL com leases, retries e fencing.
3. API assíncrona, autenticação Supabase e API keys independentes; workers separados.
4. Storage, migração controlada, contratos e documentação Lovable.
5. Testes de regressão e fluxo integrado com fixtures em banco isolado.

Nenhuma migration ou transferência será aplicada a produção. Nenhum frontend será criado.
