> Registro histórico arquivado em 19/10/2026. Descreve evidências e decisões da época, não o estado atual nem uma autorização para executar comandos. Para retomar, leia [CONTINUITY.md](../../CONTINUITY.md) e [AWS-HOSTING.md](../AWS-HOSTING.md). Credenciais, backups, logs privados e capturas não acompanham este arquivo.

# Correção do painel publicado — ação na Lovable

O repositório universal-race-calendar contém o backend. O proprietário informou que o frontend publicado não está conectado ao GitHub, portanto não é possível corrigir/republicar esse frontend por um PR neste repositório. Não alterar o contrato da API para mascarar o erro de renderização.

## Diagnóstico

API `GET /v1/events/evt_91fe44bc51e94cf6acf036b6`: 200, com distances como quatro objetos. O bundle publicado `eventos._id-DjS5gGza.js` passa cada objeto diretamente para children do Badge. O render falha antes de abrir Resultados. Os hooks de resultados usam o endpoint correto e auth=true; o endpoint não está ausente. A resposta paginada autenticada foi validada com total 435 no ensaio desta sessão.

Outro defeito concreto: a ação Coletar resultados gera uma Idempotency-Key nova a cada clique/tentativa. Após timeout, clicar novamente pode duplicar trabalho. A exportação já preserva uma chave até receber sucesso, mas sua chave de armazenamento deve incluir o usuário, não só a edição.

## Texto para enviar à Lovable

Corrija o painel existente e teste antes de publicar. Não altere backend, banco, secrets ou permissões.

1. Na rota de detalhes `/eventos/$id`, corrija a tipagem de `event.distances`: a API retorna objetos com `id`, `label`, `distanceKm`, `modality` etc. O código atual renderiza o objeto inteiro dentro de Badge e como key, causando a tela “Esta página não carregou”. Renderize `distance.label`, com fallback `${distance.distanceKm} km` quando houver distância numérica; use `distance.id` como key. Trate array ausente/vazio e entradas nulas sem quebrar. Não use String(objeto), JSON.stringify ou [object Object] como texto para o usuário. Exemplo para os objetos reais:

```tsx
const distances = Array.isArray(event.distances) ? event.distances : [];
// No JSX:
{distances.filter(Boolean).map((distance, index) => (
  <Badge key={distance.id ?? `distance-${index}`} variant="secondary">
    {distance.label || (distance.distanceKm != null
      ? `${distance.distanceKm} km`
      : 'Distância não informada')}
  </Badge>
))}
```

Se a aplicação já suporta strings antigas, normalize-as explicitamente antes do JSX. Ajuste os tipos; não elimine o erro com cast para any.

2. Confirme que as abas Informações, Resultados e Ações continuam acessíveis. Resultados: `GET /v1/events/{id}/results?page=1&limit=20`, Bearer do Supabase. Ler `{data,pagination}`, mostrar `pagination.total`, permitir paginação e filtro pelo nome exato de modality. Campos opcionais podem ser null. Não inserir números fixos na interface.

3. Na ação Coletar resultados, persista a chave de idempotência por usuário + edição + intenção. Após timeout ou falha de rede, reutilize a mesma chave; só descarte após resposta confirmada ou decisão explícita sobre uma nova intenção. Impedir cliques concorrentes. Uma nova coleta intencional após conclusão pode usar outra chave. Aplicar o mesmo escopo por usuário à chave de exportação. Não repetir automaticamente em source_access_blocked.

4. Testar renderização com distances de objetos, vazio, ausente e valores nulos; verificar fallback de label. Testar timeout seguido de retry usando a mesma chave e usuário. Manter os estados failed/source_access_blocked distintos de completed. Não criar tarefas reais adicionais apenas para testar o comportamento do botão: mockar a rede nos testes unitários.

5. No preview, entrar no usuário autorizado, abrir a edição `evt_91fe44bc51e94cf6acf036b6` e verificar: informações sem erro; distâncias 5 km, 9 km, 21 km e 42 km; aba Resultados com total retornado pela API (435 no ensaio), troca de página e filtro. Depois publicar a correção. Nenhuma chave interna ou secret deve ir para o frontend.

## Testes já executados pelo agente

- Detalhes reais: HTTP 200, quatro objetos de distância.
- Bundle publicado: confirmado objeto usado como children do Badge.
- Regra de apresentação proposta: quatro labels reais corretos; casos de objeto sem label, distância nula, entrada nula e string legada verificados em teste de contrato. Não é teste de renderização no navegador.
- CORS de publicação e preview: preflight e GET reais aprovados.
- Coleta local e exportação: completed, 435 resultados/linhas, conforme LOVABLE-ACCEPTANCE-2026-09-20.md.

Pendência secundária de qualidade de dados: o nome retornado pela API já contém U+FFFD (caractere de substituição) em COSTÃO. Portanto a grafia defeituosa do calendário não deve ser corrigida com substituições genéricas no frontend; exige correção separada na origem/importação. Não causa a exceção de objetos React.
