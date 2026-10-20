> Registro histórico arquivado em 19/10/2026. Descreve evidências e decisões da época, não o estado atual nem uma autorização para executar comandos. Para retomar, leia [CONTINUITY.md](../../CONTINUITY.md) e [AWS-HOSTING.md](../AWS-HOSTING.md). Credenciais, backups, logs privados e capturas não acompanham este arquivo.

# Integração Lovable — evidências de 20/09/2026

Publicado: https://runfinder-rithmy.lovable.app

Preview: https://id-preview--e21cded7-e20c-4cde-affb-e861bee99b6e.lovable.app

API: https://universal-race-calendar.onrender.com, versão observada 2.0.0, commit `97f27f7c98fe5a01b0fe676302b14cc97f9b3886`. Supabase exclusivo: race-platform-staging / sggrijhyblejlgimgzzc. Worker local atualizado com diagnóstico source_access_blocked.

## Comprovado por terminal/API

- CORS inicialmente ausente; após configuração aplicada pelo proprietário, ambas as origens passaram em OPTIONS GET/POST com authorization, idempotency-key e content-type. Status 204 com Access-Control-Allow-Origin exato. Resposta real GET calendário: 200 com origem permitida. Origem não autorizada não recebeu esse header.
- Uma única conta correspondeu ao email informado pelo proprietário; promovida via Auth Admin a app_metadata.role=admin, com demais metadados preservados e releitura confirmando a alteração. Não foram alterados senha, email ou user_metadata.
- Calendário e detalhes acessíveis pela API; consulta autenticada paginada com 435 resultados.
- Coleta criada pela API: `a6eb9e60-d784-4855-8651-ddf19e017124`, completed, attempt 1, 435 publicados, 10 s de worker. Conteúdo anterior e posterior idêntico, timestamp renovado: nova coleta/publicação, sem novos registros nem mudança de conteúdo.
- Mesma chave de idempotência, antes e depois da conclusão, devolveu a mesma tarefa. Nenhuma coleta duplicada.
- Exportação `4821481c-2776-4012-a56b-9d272212bcef`, tarefa `330125e5-536b-45b3-8aa1-d888d8a9f2de`, completed, 2 s. XLSX baixado: 435 linhas / 36.123 bytes. Mesma chave devolveu o mesmo artefato/tarefa.
- Bucket privado; download assinado 200; URL pública sem assinatura 400; endpoint de exportação sem login 401. Resultados preservados após exportação.
- Fila inicialmente vazia, nenhum runner aguardando/em execução, nenhum worker local concorrente. Cada lote consumiu exatamente uma tarefa identificada acima. Processos encerrados, sem recuperação pendente. Nenhuma agenda habilitada ou runner disparado.
- Identidade administrativa temporária usada pelo ensaio removida. O usuário real promovido permanece ativo. Segredos e links assinados não foram registrados no relatório.

## Navegador

Login e calendário confirmados pelo proprietário e calendário documentado em screenshot. Detalhes falharam com a tela de erro; resultados não puderam ser acessados. A ferramenta de navegação do agente não iniciou (falha de inicialização do ambiente); o agente inspecionou os screenshots fornecidos e o JavaScript público, sem operar a sessão do proprietário. O ensaio API acima foi realizado por terminal com identidade temporária.

Diagnóstico confirmado no módulo público `/assets/eventos._id-DjS5gGza.js`: o componente de detalhes faz `distances.map` passando cada objeto como `children` e como key do Badge. A resposta real 200 contém quatro objetos `{id,label,distanceKm,...}`, não strings. Renderizar objeto diretamente causa a exceção React. A aba de resultados existe no código, mas fica atrás dessa falha. Instruções de correção: [LOVABLE-FIX-DETAILS.md](LOVABLE-FIX-DETAILS.md). O frontend não está conectado ao GitHub; aplicação da correção e republicação precisam ocorrer na Lovable pelo proprietário.

## Próximas verificações na interface

1. Sair e entrar novamente após a promoção (login já relatado como funcionando).
2. Abrir calendário, localizar MOUNTAIN DO COSTÃO DO SANTINHO 2026 (25/07/2026), abrir detalhes e resultados; conferir total 435 e paginação.
3. A exportação já produzida pode ser consultada por esse usuário admin pelo ID acima; links duram até 60 s e o arquivo até 24 h. Se a interface só permitir criar uma nova exportação, ela exigirá iniciar o Python local conforme LOCAL-WORKERS.md. Não presumir que o worker continua ligado.

O êxito local não resolve o bloqueio anterior do GitHub runner. Nenhuma restrição da fonte foi contornada. Não houve migrations, merge, deploy pelo agente ou alteração de produção.
