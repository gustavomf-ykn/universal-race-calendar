# Evidências da preparação AWS — 13/10/2026

Escopo: branches de preparação de backend e frontend. Base backend cadf75bf1aed5f89465385e719b4f9d474076cd3; base frontend ebbabd4e991ac7af71f283389683c7539af7299c. Nenhum merge, provisionamento, deploy, mudança de DNS, migration Supabase ou coleta real foi feito nesta etapa.

| Cenário | Ambiente | Evidência / resultado | Pendência |
| --- | --- | --- | --- |
| Migrations aditivas e repetição | PostgreSQL sintético local | 31 migrations; nova tabela/counters/trigger/índices; segunda execução sem mudanças pendentes | Aplicar somente no staging após backup/integração autorizados |
| JWT admin, recusa de membro/ausência, versão e readiness | API injetada + JWT sintético | Contrato e recusas testados; readiness falha com projeto divergente | Repetir com Supabase Auth e API AWS reais |
| Campanha, idempotência, pausa/retomada/cancelamento, checkpoints, conflitos | PostgreSQL sintético | 12 testes aprovados; preservação de tarefas externas; pausa concorrente sem deadlock | Navegador/consumo por AWS |
| Heartbeat, polling, destino staging antes de conexão | Testes TypeScript | 3 testes aprovados; máximo 15s ocioso; heartbeat não comprova conclusão | Verificar processos AWS e reinício real |
| Agenda durável existente | PostgreSQL sintético | 19 testes aprovados com relógio controlado | Agenda real continua desativada; primeira ocorrência após aceite |
| Python | Offline | 186 aprovados; 53 ignorados por dependências de banco/integração; 1 de integração real excluído | SQL completo no CI; fontes reais após deploy |
| CloudFormation, secrets, imagens imutáveis | Offline | cfn-lint sa-east-1, 7 testes pytest e bash -n aprovados | Custo regional autenticado/SSO/hostname/secrets/digests |
| Painel | Testes automatizados locais | 52 testes, TypeScript e build aprovados | Publicação Lovable e navegador autenticado |
| Imagens e Chromium com restrições AWS | CI preparado | Três processos, readonly, tmpfs, limites de memória, heartbeat e navegador em PostgreSQL descartável | Confirmar conclusão do CI do commit final e repetir na AWS |
| Pilotos até 5/fonte, expansão 25/etapa e cruzamento | Não executados | Não há novas tarefas ou crescimento medido nesta preparação | AWS ativa, fontes acessíveis e reserva Supabase conferida |
| 435 resultados existentes e nova exportação XLSX/ZIP | Não executados novamente | São referência do aceite remoto, não evidência nova desta entrega | Consultar, abrir arquivo e testar acesso privado na AWS |
| Reboot do host, recuperação de lease e executor antigo | Não executados na AWS | Testes de fences existentes continuam no CI | Repetir com contêineres/host reais antes de liberar carga ampla |

Dois testes novos reproduziram deadlock ao usar o pacote compilado anterior. Após recompilar com aquisição anterior aos locks de checkpoint, ambos e a suite completa da campanha passaram. O pacote de banco é importado pelo build; executar build antes dos testes locais.

Uma execução local anterior com pool de conexão único teve timeouts em testes concorrentes e de varredura extensa, com medição física de capacidade lenta no Windows. O limite de segurança não foi removido. A agenda passou com pool de cinco; o CI Linux executa a suite completa em PostgreSQL descartável. Não converter esses testes em promessa de desempenho do Supabase.

A fila staging não foi consumida ou alterada, seus pedidos protegidos continuam protegidos e não foi iniciado executor local de staging. O PostgreSQL usado aqui é descartável, sem dados ou credenciais reais. Consultar [runbook AWS](AWS-HOSTING.md) para os passos restantes, e registrar os resultados do CI nos PRs.
