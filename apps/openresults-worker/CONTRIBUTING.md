# Contribuindo

Contribuições são bem-vindas. Este projeto usa a licença MIT e pode ser bifurcado, modificado e redistribuído.

## Ambiente

```bash
python3.12 -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
pytest -m "not integration" -q
```

Instale o Chromium apenas se precisar desenvolver o fallback:

```bash
playwright install chromium
```

## Pull requests

1. Crie uma branch a partir de `main`.
2. Preserve a validação SSRF e nunca adicione mecanismos para contornar CAPTCHA ou autenticação.
3. Não registre nomes, números de peito ou outros dados de atletas nos logs e metadados de provas.
4. Inclua fixtures e testes determinísticos para mudanças de parser ou contrato.
5. Execute a suíte sem internet antes de abrir o PR.

O teste live é opcional e pode mudar quando o site de origem atualizar resultados:

```bash
RUN_OPENRESULTS_INTEGRATION=1 pytest -m integration -vv
```

## Compatibilidade

- Python 3.12+
- API pública sem prefixo de versão; mudanças incompatíveis devem ser documentadas e introduzidas com uma nova rota.
- SQLite é o adapter padrão. Novos backends devem preservar a interface de `app/storage.py`.
