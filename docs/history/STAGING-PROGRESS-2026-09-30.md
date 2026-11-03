> Registro histórico arquivado em 19/10/2026. Descreve evidências e decisões da época, não o estado atual nem uma autorização para executar comandos. Para retomar, leia [CONTINUITY.md](../../CONTINUITY.md) e [AWS-HOSTING.md](../AWS-HOSTING.md). Credenciais, backups, logs privados e capturas não acompanham este arquivo.

# Runfinder — evidência de homologação em 30/09/2026

**Registro histórico:** as pendências abaixo foram resolvidas posteriormente. Consulte [o aceite atualizado de 01/10](STAGING-ACCEPTANCE-2026-10-01.md) para versões, fila, exportações e operação atual.

Destino exclusivo: race-platform-staging (`sggrijhyblejlgimgzzc`).

## Implantação comprovada

- Backend PR #9 integrado em `a645acd65162e8afc7fc3dbeeffd10a0ecca49b4`.
- Backend PR #10 integrado em `91e9941c91ac7a4230ddd55ae3e11876aeb3c1d1`.
- API Render efetivamente Live nesse último commit; `/v1/version` confirmou o SHA.
- Deploy: `dep-daumbt97lnhs73945b3g` no serviço `srv-danjejugekts73968fs0`.
- Preflight PATCH aprovado para publicação e preview, incluindo Authorization, Content-Type e Idempotency-Key.
- Não houve nova migration, contratação, mudança de plano ou ativação de agendamentos nesta atualização.

## Evidências reais

| Cenário | Identificador | Resultado |
|---|---|---|
| Revisão pelo navegador | Garuva `evt_b94d925f5427ad6c39949b2f` | Publicada; persistência confirmada; detalhes carregaram |
| Resultados pelo navegador | Garuva | 387 resultados; filtro 3KM retornou 113 |
| Lote TicketSports | `67e76b79-7909-4673-b34c-2dc7207457bc` | 5 examinados, 1 nova prova, 4 existentes, completed |
| Metadados pelo navegador e worker | `b7d44860-7176-48e9-832d-6cbde87a1c81` | Maratona de Criciúma corrigida de Chapecó para Criciúma, data 27/09/2026, permaneceu pending_review |
| Download pelo usuário | Última exportação | Usuário confirmou download bem-sucedido; não foi observado diretamente pelo agente |
| Exportador com dados persistidos, sem fila | Mountain Do + Garuva | XLSX 822 linhas; ZIP com 435 e 387; 19 colunas, cabeçalho em negrito, congelamento A2 |

Contagens após o lote: 29 provas, 822 resultados. O teste local do exportador não substitui solicitação e download do ZIP pelo painel.

## Operação ainda pendente

O inicializador real gerou cliente, compilou, validou Chromium e staging e iniciou ambos os workers em `91e9941`. O painel mostrou presença e acompanhou a conclusão sem um comando de processamento por tarefa. Porém a sessão supervisionada terminou: em 19:52 UTC seu identificador já não existia, os processos não foram encontrados e o último heartbeat era de 19:49 UTC. Não se afirma disponibilidade independente.

Foi solicitado ao usuário abrir `universal-race-calendar/Iniciar executores.cmd` pelo Explorador e manter a janela aberta. Essa confirmação ainda está pendente. Não configurar inicialização automática do Windows.

Os pedidos antigos `5e8fe9d7-d889-4cd5-b427-972498115f2b` (120) e `8278a9e1-9eaa-41ea-8e72-856d8b631665` (15) permanecem retidos, sem consumo ou cancelamento.

Restam: atualizar os nove registros CorridasBR afetados ainda não corrigidos; tratar o snapshot antigo antes de continuar essa sincronização; concluir exportação ZIP pelo painel; verificar operação cotidiana independente e encerramento. Não declarar aceite integral concluído.
