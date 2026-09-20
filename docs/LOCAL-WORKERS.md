# Workers locais de homologação

A API continua no Render. Este computador executa apenas os consumidores da fila do Supabase `race-platform-staging`. Os secrets já cadastrados ficam cifrados em `.secrets/staging.dpapi.json`; use o mesmo usuário Windows que os cadastrou. Não copiar valores para comandos ou para a Lovable.

## Iniciar

Abra PowerShell na pasta `universal-race-calendar`. Antes, confira em GitHub → Actions que nenhum **Staging calendar batch** ou **Staging results batch** esteja queued/in_progress/waiting. Não dispare workflows enquanto os workers locais estiverem ligados. Não abra duas instâncias do mesmo worker.

Para processar **uma tarefa já na fila** e encerrar automaticamente:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-staging-worker.ps1 -Worker results
```

Esse é o worker Python: coleta/descoberta/inspeção OpenResults e **novas exportações XLSX**. Usa lote de uma tarefa, limite de 600 segundos. Se a fila estiver vazia, encerra sem coletar. O limite de tempo pode interromper trabalho longo; nesse caso, a recuperação depende do lease e de outro executor.

Para manter disponível enquanto você usa o painel:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-staging-worker.ps1 -Worker results -Mode continuous
```

Somente quando precisar de tarefas de calendário TicketSports/CorridasBR ou curadoria, abra **outro terminal**:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-staging-worker.ps1 -Worker calendar -Mode continuous
```

O launcher usa Node do PATH e o Python de `../.venv/Scripts` quando disponível. Dependências, Chromium e build TypeScript já preparados são necessários. Em outro computador, primeiro prepare os runtimes conforme RUNBOOK e cadastre os secrets com o script seguro. Não executar migrations para iniciar workers. O parâmetro ExecutionPolicy vale apenas para o processo aberto, sem mudar a política permanente do Windows.

## Encerrar

No terminal de cada worker, pressione **Ctrl+C uma vez** e aguarde o retorno ao prompt. O worker solicita parada e deixa de adquirir novas tarefas; uma tarefa em andamento pode precisar terminar. Não feche à força se quiser concluir o trabalho atual. Em encerramento forçado/queda do computador, a tarefa pode continuar aparecendo running até o lease expirar e outro worker recuperá-la. Depois que ambos terminaram, feche as janelas. Só então volte a usar runners manuais.

| Funcionalidade do painel | Precisa de worker ligado? |
|---|---|
| Login, calendário salvo, resultados salvos, histórico de tarefas | Não; depende da API/Supabase |
| Registrar uma tarefa (202) | Não; fica queued até haver executor |
| Atualizar calendário TicketSports/CorridasBR | Sim, TypeScript (`calendar`) |
| Descobrir/inspecionar/coletar OpenResults | Sim, Python (`results`) |
| Gerar uma nova exportação | Sim, Python, mesmo com resultados já salvos |
| Obter link/baixar arquivo já gerado e ainda válido | Não; API/Storage atendem |
| Limpeza física de exportações expiradas | Sim, Python; a API já recusa acesso após expiresAt |

O nome `results` não limita o worker a coletas: ele também consome exportações. Em lote, será processada a próxima tarefa elegível, não necessariamente a última criada pelo painel. Não existe endpoint de status online dos workers nem de iniciar o processo local pela API. Computador suspenso/desligado significa ausência desses executores.

## Bloqueio da fonte

`failed` com `errorCode=source_access_blocked`: mostrar **Fonte bloqueou o acesso; resultados anteriores mantidos**. Não repetir automaticamente nem trocar IP, proxy ou método para contornar o bloqueio. `collection_failed` é genérico e não prova bloqueio. O código específico depende de executar o worker com a correção do PR #6; a API atual já consegue retorná-lo.

Ensaio de 20/09/2026: tarefa `1acc7940-7868-405a-80bc-e8d3c0e2a00f`, criada pela API Render e processada localmente, completed/attempt 1, 435 publicados. Conteúdo idêntico, timestamp de publicação atualizado. O runner GitHub havia sido bloqueado; este sucesso local não valida coleta pelo runner. Evidências: [STAGING.md](STAGING.md).
