# Como contribuir

Obrigado pelo interesse! O InfraHub é pequeno de propósito: Node.js + Express, front-end em JavaScript puro, dados em arquivos JSON.

## Ambiente de desenvolvimento

```bash
git clone <url-do-repositório> infrahub && cd infrahub
npm ci
cp .env.example .env
npm run hash-senha -- dev          # copie a linha LOCAL_USERS=... para o .env
npm run dev                        # http://localhost:3000
npm test
```

Os dados de desenvolvimento ficam em `data/` (ignorado pelo Git). Para recomeçar do zero, apague `data/*.json`.

## Regras do código

1. **Nada do seu ambiente no repositório:** sem IPs reais, domínios, nomes de pessoas, certificados ou senhas. Nos exemplos use as faixas de documentação (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`) e `exemplo.com`.
2. **Sem dependência nova** sem boa razão. O front-end não usa bibliotecas nem etapa de *build*.
3. **Conteúdo cadastrado entra na tela escapado** (`esc(...)` ou `textContent`). Nunca monte HTML com dado do usuário sem escapar.
4. **Sem `onclick=` inline:** a CSP só aceita scripts do próprio site.
5. **Padrão seguro:** nada de usuário ou senha padrão, nada de desligar a validação de certificado.
6. **Falhe de forma clara:** variável obrigatória ausente derruba a partida com a mensagem de qual e como corrigir.
7. Toda mudança em `auth.js` (login, sessão, hash) precisa de teste em `test/auth.test.mjs`.

## Antes de abrir um pull request

- `npm test` e `node --check server.js auth.js public/app.js` passando.
- `npm audit --omit=dev` sem vulnerabilidades altas.
- Se mexeu na interface, teste em tela estreita (celular).
- Descreva o que mudou e por quê. Falhas de segurança **não** vão em *issue*: veja o `SECURITY.md`.
