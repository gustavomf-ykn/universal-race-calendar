# Homologação operacional — evidências parciais em 29/09/2026

Destino exclusivo: `race-platform-staging` (`sggrijhyblejlgimgzzc`). API:
https://universal-race-calendar.onrender.com. Painel: https://runfinder-rithmy.lovable.app.

Backend PR #8 integrado e publicado: `481f73b234812f162e43ce0908ee306aeb5e1e49`.
Frontend PR #2 integrado: `49643f893d6e1d046250b6fb022576e02523b34c`;
Lovable confirmou a publicação e os controles novos foram usados no site público.
As quatro migrations operacionais foram aplicadas em staging após backup privado,
com segunda execução sem reaplicação: worker_presence, panel_catalog,
administrative_review e selective_execution. Procedimento em STAGING-OPERATIONS-ROLLOUT.md.

## Fluxos reais

| Operação solicitada no navegador autenticado | Tarefa | Evidência |
|---|---|---|
| Descoberta CorridasBR, SC, 5 | `b3b9359b-20de-45ea-9a21-657f4595a62a` | Concluída, 5 criadas |
| Continuar o mesmo checkpoint | `337de082-ca74-471a-96e1-db1977722797` | Concluída, mais 5 criadas; mesmo syncId, total processado 10 |
| Descoberta TicketSports, lote 5 | `304b97a9-f495-4c6e-a07c-be08c7697e6d` | Concluída, 5 criadas; cobertura bounded_snapshot |
| Catálogo completo, filtro sem restrições | `2fdc7ba9-d331-420d-9b84-355e83af4e24` | Concluída; XLSX com 23 linhas e 19 colunas, incluindo a segunda página do catálogo |
| Nova coleta OpenResults, edição `evt_91fe44bc51e94cf6acf036b6` | `08c92c80-5923-4c21-8250-ed92b935513d` | Concluída, published, 435 resultados; total permaneceu 435 |
| Nova planilha da edição | `265e9c6d-3054-414d-a9bf-c8ce25e20a03` | XLSX baixado por requisição técnica autorizada: 435 linhas, 19 colunas |

Os resultados foram novamente coletados da fonte, não apenas preservados após erro.
O total igual não prova identidade de todos os valores com a versão anterior: ainda
falta uma comparação de conteúdo por chave. Nenhum nome de atleta integra este relatório.

O catálogo administrativo passou de 8 para 23 registros. As descobertas ficam
pending_review; não se espera que apareçam imediatamente no calendário público.
Algumas cidades CorridasBR foram atribuídas à linha anterior pelo parser antigo:
a correção isola a linha da prova e impede atravessar outra prova ao procurar metadados.
Datas sem ano explícito continuam desconhecidas. Não publicar descobertas incompletas.

## Download, permissões e executores

- Navegador: login admin existente, detalhes preservados, 435 resultados em 22 páginas,
  criação das tarefas e histórico servidor; exportação passou de aguardando para pronta.
- O clique de download no Chrome controlado retornou `ERR_BLOCKED_BY_CLIENT`.
  Não houve contorno. Download manual pelo usuário ainda não foi confirmado.
- Teste técnico separado: assinatura Storage e download HTTP 200; acesso público sem
  assinatura HTTP 400. XLSX abertos: cabeçalhos, contagens, negrito, autofiltro e A2 congelada conferidos.
- JWT: rota administrativa retornou 401 sem token, 403 para usuário comum e 200 para
  identidade temporária admin. Identidade de teste removida após a validação.
- Inicializador real Windows recompilou, validou banco e Chromium, iniciou ambos os
  workers, registrou presença ociosa e processou somente IDs de teste selecionados.
  Segunda instância foi recusada. Reinício real em 29/09 confirmado após ausência de processos/presença.

Pedidos anteriores `5e8fe9d7-d889-4cd5-b427-972498115f2b` (120) e
`8278a9e1-9eaa-41ea-8e72-856d8b631665` (15) permanecem queued, tentativa 0,
executionHold=true, com duas entradas de auditoria; não foram cancelados nem consumidos.
O pedido OpenResults `d8ce58b7-8766-4318-96b1-96630adb97b1`, criado em 28/09,
permaneceu fora da seleção desta rodada.

## Aceite ainda incompleto

Faltam correção dos metadados já descobertos, revisão/publicação de uma descoberta,
catálogo simples, prova OpenResults independente, ZIP/seleção individual, cancelamento
e repetição controlados pelo painel, conclusão do download no navegador e transição
final para uso diário sem seleção de IDs por operador. A geração de arquivo e CI não
substituem esses critérios. Não considerar esta rodada como aceite integral.
