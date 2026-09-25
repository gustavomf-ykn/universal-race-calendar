# Implantação operacional em homologação

Destino único: `race-platform-staging`, referência `sggrijhyblejlgimgzzc`.
Autorização desta entrega inclui integração, migrations e publicação neste staging.

## Impacto e recuperação

As migrations `20260922000000_worker_presence`, `20260922000100_panel_catalog`,
`20260922000200_administrative_review` e `20260924000000_selective_execution`
adicionam presença, checkpoints, auditoria, campos de exportação/resultados/revisão
e suspensão de tarefas. Não removem tabelas, resultados ou histórico. A alteração
de `ExportArtifact.eventId` permite `NULL` para exportações de catálogo.
A função antiga `claim_task` passa a respeitar suspensões, inclusive para clientes antigos.

Antes de aplicar: manter consumidores desligados; confirmar identidade pelas credenciais
protegidas; salvar dump lógico do schema `public` com dados em `.secrets/backups`,
verificar o índice do arquivo e registrar SHA-256 e contagens, sem publicar conteúdo.
Reaplicar migrations deve informar zero pendentes. Auditar RLS, privilégios e bucket privado.

Recuperação preferida: interromper consumidores, manter as colunas/tabelas aditivas e
corrigir adiante. Se a API precisar voltar ao commit anterior, manter os consumidores
desligados: a API antiga não apresenta nem administra as suspensões. Não restaurar a
função antiga de aquisição, pois isso retiraria a proteção dos pedidos preservados.
Não executar down/reset nem restaurar dump por cima de staging. Restaurar o dump em
outro banco isolado para comparação e recuperar registros específicos após diagnóstico;
preservar também registros criados depois do backup. Não remover colunas de resultados.

## Proteção e execução seletiva

`POST /v1/tasks/{id}/hold` exige admin, recebe `{ "hold": true, "reason": "..." }`
e aceita apenas tarefas `queued`. Preserva status, payload, tentativas e histórico,
registrando auditoria. `hold:false` libera explicitamente. O painel apresenta o motivo
e permite suspender/liberar na página da tarefa. Repetir o mesmo estado não duplica auditoria.

Pedidos preservados desta entrega: `5e8fe9d7-d889-4cd5-b427-972498115f2b` (120) e
`8278a9e1-9eaa-41ea-8e72-856d8b631665` (15), ambos TicketSports.
Confirmar suspensão persistida antes de iniciar qualquer consumidor de staging.

Para o aceite seletivo, iniciar `scripts/start-local-executors.ps1 -SelectedTaskFile`
com caminho absoluto para um JSON de IDs, inicialmente `[]`. Ambos os workers releem
o arquivo a cada aquisição. Lista vazia não adquire nem recupera tarefa alguma;
arquivo ausente/inválido interrompe a aquisição, nunca amplia a seleção.
Gravar atualizações por substituição atômica para evitar leitura de JSON parcial.
A suspensão no banco continua valendo mesmo se o ID estiver selecionado.

O inicializador cotidiano `Iniciar executores.cmd` continua sem argumento de seleção,
consumindo pedidos elegíveis enquanto os suspensos permanecem preservados.
Não registra serviço nem inicialização automática do Windows.

## Verificação e ordem

1. Revisar CI dos heads atuais; integrar backend.
2. Backup protegido, migrations de staging duas vezes, auditoria; proteger os dois pedidos.
3. Deploy manual da API existente no Render Free e confirmar SHA em `/v1/version`.
4. Integrar frontend, publicar pela Lovable e confirmar versão pública.
5. Iniciar executores seletivos, realizar aceite real pequeno, guardar IDs e contagens.
6. Separar evidências por testes automatizados, API e navegador autenticado.

Até haver evidência de implantação e aceite, este documento é um procedimento,
não uma declaração de que a versão está publicada ou operacional.
