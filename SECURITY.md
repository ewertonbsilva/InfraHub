# Política de segurança

## Reportando uma vulnerabilidade no InfraHub

Se você achou uma falha de segurança **no InfraHub** (por exemplo: contornar o login, injeção, XSS, CSRF, vazamento de dados, acesso a rotas sem sessão), **não abra uma *issue* pública**.

Use o recurso de **relato privado de vulnerabilidades do GitHub** (aba *Security* do repositório, "Report a vulnerability"). Se ele não estiver disponível, entre em contato com os mantenedores por um canal privado indicado no perfil do repositório.

Inclua, se puder: a versão (ou o *commit*), como reproduzir, o impacto que você enxerga e, se houver, uma sugestão de correção. Pedimos um prazo razoável para corrigir antes da divulgação pública.

## O que está no escopo

- Login, sessão (cookie assinado) e autorização, incluindo o "Lembrar de mim".
- Qualquer caminho em que dados cadastrados (nome, URL, RDP, tags) virem **HTML**, **comando** ou **consulta** sem validação.
- Rotas `/api/*` acessíveis sem sessão (a única pública é `/api/config`, que não traz nada sensível).
- O filtro por rede (`ALLOWED_CIDRS`) e o tratamento de `X-Forwarded-For`.
- Os scripts de protocolo RDP para Windows (`public/rdp/`).
- Vazamento de segredos (`.env`, `data/.session-secret`, senhas) em logs, respostas ou arquivos.

## Fora do escopo

- Falhas no Node.js, no Express, no `ldapts`, no Docker ou no servidor LDAP: reporte aos projetos deles.
- Ataques que exigem acesso de administrador ao servidor onde o InfraHub roda.
- InfraHub exposto à internet sem as proteções recomendadas no README (HTTPS, `ALLOWED_CIDRS`).
- As portas de embed (`EMBED_PROXIES`) **não pedem login por projeto**: isso está documentado, e o risco é de quem as habilita fora de uma rede de confiança.

## Princípios de projeto

- **Nada aberto por omissão:** sem LDAP e sem `LOCAL_USERS` o servidor nem inicia; não existe usuário ou senha padrão.
- **Senhas locais só como hash** (scrypt com sal); a senha nunca é gravada nem registrada em log.
- **LDAPS com validação de certificado sempre ligada;** o bind só acontece com senha não vazia (bind anônimo "funciona" no LDAP).
- **Entrada validada:** o login só aceita letras, números, ponto, hífen e sublinhado (evita injeção de DN e de filtro); o campo RDP só aceita host e porta.
- **Cookie de sessão** `HttpOnly`, `SameSite=Strict` (e `Secure` quando o acesso é por HTTPS), assinado com HMAC-SHA256.
- **CSRF:** pedidos que alteram dados só valem se a origem for o próprio InfraHub.
- **Força bruta:** 5 falhas em 5 minutos bloqueiam por IP e por usuário.
- **CSP restritiva** (`script-src 'self'`) e conteúdo cadastrado entra na tela sempre escapado.

## Boas práticas para quem instala

- Coloque o InfraHub atrás de **HTTPS** (Nginx, Caddy, Traefik...) e informe o proxy em `TRUSTED_PROXIES`.
- Use `ALLOWED_CIDRS` para limitar a rede que alcança o portal, e `ALLOWED_GROUP` para limitar quem entra.
- Não exponha as portas de embed fora da rede de administração.
- Guarde o `.env` e a pasta `data/` com permissão restrita e faça backup de `data/`.
- Mantenha as dependências atualizadas (`npm audit`).
