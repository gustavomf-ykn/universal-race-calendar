# Segurança

## Relatando uma vulnerabilidade

Não publique detalhes exploráveis em uma issue pública. Abra um aviso privado em **Security → Advisories → New draft security advisory** no repositório GitHub.

Inclua a rota afetada, impacto, passos mínimos de reprodução e uma sugestão de mitigação quando possível.

## Modelo de segurança

- A instalação padrão não possui autenticação. Coloque a API atrás de autenticação no proxy se ela não deve ser pública.
- Somente URLs HTTPS com host exato `openresults.run` e caminho `/evento/<slug>/` são aceitas.
- O enriquecimento opcional aceita apenas o host exato `roadrunners.run`.
- Ative `OPENRESULTS_TRUST_PROXY_HEADERS=1` somente atrás de um proxy confiável que substitua `X-Forwarded-For`.
- Os UUIDs de trabalhos não substituem autenticação. Quem conhece um `job_id` pode consultar e baixar aquele trabalho.
- O serviço processa dados já publicados pelo site de origem. O operador é responsável por cumprir legislação, termos aplicáveis e políticas de retenção.

Não são considerados vulnerabilidades do projeto: bloqueios, CAPTCHA ou mudanças de HTML do site de origem.
