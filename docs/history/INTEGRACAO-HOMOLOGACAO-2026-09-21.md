> Registro histórico arquivado em 19/10/2026. Descreve evidências e decisões da época, não o estado atual nem uma autorização para executar comandos. Para retomar, leia [CONTINUITY.md](../../CONTINUITY.md) e [AWS-HOSTING.md](../AWS-HOSTING.md). Credenciais, backups, logs privados e capturas não acompanham este arquivo.

# Integração das correções em homologação

## Código e verificações

- Backend PR7 integrado primeiro: `21fce06e40b3f5bd5b30035e6c27ca7a8baa6323`.
- Frontend PR1 integrado depois: `6e80d4d85562815aee12adc629fd7ddd9fc1882a`.
- Heads revisados: backend `4a45f6963d40f034c4bef79b822ae14cafacf939`, frontend `93a61048c17be5333016c19eda7d9f350954b15f`; sem alterações posteriores ou comentários de revisão pendentes, ambos com CI aprovado.
- Backend main: CI aprovado https://github.com/gustavomf-ykn/universal-race-calendar/actions/runs/35671374957 (test e containers).
- Frontend: CI do head aprovado https://github.com/gustavomf-ykn/runfinder-rithmy/actions/runs/35656207695. O workflow só dispara em PR; não houve nova execução na main após merge.
- Checkouts locais atualizados para main por fast-forward. Build TypeScript completo aprovado; worker Python compilado sem execução. Frontend: tipos e cinco regressões aprovados novamente, incluindo resposta perdida e cliques concorrentes simulados, sem tarefas reais.
- Nenhum worker foi iniciado e nenhuma tarefa foi processada nesta etapa. Nenhuma migration ou alteração de agendamento.

## Fila realmente encontrada

As sete tarefas da rodada anterior já estavam canceladas antes de qualquer alteração desta etapa. Datas em UTC.

| ID | Operação | Fonte | Quantidade | Criação UTC | Situação encontrada |
|---|---|---|---|---|---|
| acf62deb-71f9-4ac0-874a-230d236ed907 | calendar | ticketsports | 10 | 20/09/2026 17:28:48 | cancelled |
| cfd8a59b-d00f-4a00-851a-c1899b3b18a9 | calendar | ticketsports | 500 | 21/09/2026 00:16:17 | cancelled |
| 96971c36-871c-4a66-b4a4-faf587bb7d01 | calendar | ticketsports | 10 | 21/09/2026 00:17:32 | cancelled |
| e3176320-32bf-4bc8-ae70-c80c3786c42f | calendar | ticketsports | 500 | 21/09/2026 00:39:02 | cancelled |
| 66b7e386-7fb9-4b3b-8d85-e58d619aa0bf | inspect | openresults | não se aplica | 21/09/2026 00:43:52 | cancelled |
| bf6df8a0-3ca7-4890-b7c3-67f0bd3fe561 | inspect | openresults | não se aplica | 21/09/2026 00:44:18 | cancelled |
| 4b14197b-1251-47d4-86b3-4b2a072c8bf7 | export | exports | não se aplica | 21/09/2026 00:45:59 | cancelled |

Havia apenas uma tarefa ativa correspondente a500: `bdcd8257-2540-4269-bd8f-28605ca73b5a`, calendar/ticketsports, criada em21/09/2026 21:49:48UTC, queued, tentativa0. Foi cancelada pelo endpoint suportado `POST /v1/tasks/{id}/cancel`. O registro foi preservado como cancelled e todas as demais tarefas comparadas antes/depois permaneceram iguais. Fila final: zero queued e zero running. Não houve remoção de resultados ou eventos.

A chave interna local recebeu401; o cancelamento foi concluído com JWT de identidade técnica temporária em Supabase staging. Essa identidade foi removida. Não foram impressos nem alterados secrets do Render. A divergência da chave interna continua pendente para operações que dependam dela; não bloqueia o login JWT do painel.

## Versões publicadas e impacto

API efetivamente observada em `GET /v1/version`: versão2.0.0, commit `97f27f7c98fe5a01b0fe676302b14cc97f9b3886`. Não foi feito deploy no Render.

Desde esse commit, não há diferença em apps/api nem nas migrations. PR7 corrige extração/normalização executada pelo worker TypeScript; PR6 anterior corrige principalmente o worker Python e operação/documentação. A API importa a biblioteca de curadoria, mas suas rotas de coleta/curadoria enfileiram o trabalho. O contrato público usado pelo frontend permanece compatível. Não é obrigatório atualizar o Render para publicar estas correções do painel.

Para alinhar a versão da API opcionalmente: Render → serviço universal-race-calendar → Manual Deploy → Deploy a specific commit → `21fce06e40b3f5bd5b30035e6c27ca7a8baa6323`. Se a tela oferecer apenas Deploy latest commit, conferir antes que a main ainda aponta para esse commit. Manter Auto Deploy desligado e não executar migrations. Após Live, conferir GET /v1/version.

Frontend: GitHub main atualizado; não há check de sincronização Lovable nem identificador de publicação confirmado. O editor e o navegador autenticado não estavam acessíveis nesta sessão (somente navegador integrado sem sessão). Portanto, sincronização no editor e versão do site público não foram presumidas a partir do merge.

## Ação manual e próxima validação

Abrir o projeto runfinder-rithmy na Lovable e confirmar a atualização vinda da main (commit6e80d4d ou alterações correspondentes: quantity inicial3, estados de exportação e idempotência persistente). Quando o preview estiver pronto, publicar/atualizar o site pelo botão Publish/Update. Não houve publicação automática por este agente.

Após confirmar publicação e disponibilizar navegador autenticado, validar calendário, filtros, detalhes, resultados, estados de exportação e comportamento após retomada da API. As simulações de timeout/resposta perdida desta etapa são testes automatizados locais; não representam validação do frontend publicado.

Não há tarefas pendentes para consumir. Qualquer teste futuro que exija worker deverá primeiro identificar as tarefas propostas e seu escopo; não iniciar workers ou criar coletas por antecipação.
