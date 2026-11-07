# Autenticação

O InfraHub aceita dois métodos, que podem ser usados juntos. **Pelo menos um é obrigatório:** sem nenhum, o servidor não inicia e diz o que falta.

| Método | Quando usar | Variáveis |
|---|---|---|
| Usuários locais | teste, laboratório, equipe pequena sem diretório | `LOCAL_USERS` |
| LDAP (LDAPS) | existe um diretório (OpenLDAP, FreeIPA, 389-ds, um *broker* LDAP...) | `LDAP_HOST`, `LDAP_BASE`, `LDAP_USER_DN`, `LDAP_CA`, `ALLOWED_GROUP` |

Se o mesmo login existir nos dois, **vale o usuário local**.

## Usuários locais

```bash
npm run hash-senha -- ana.silva
# Senha de ana.silva: ********
# LOCAL_USERS=ana.silva:scrypt.16384.<sal>.<hash>
```

Cole a linha no `.env`. Para vários usuários, separe por vírgula: `LOCAL_USERS=ana.silva:scrypt....,carlos:scrypt....`. A senha precisa ter pelo menos 10 caracteres e **nunca** é guardada: só o hash (scrypt, sal aleatório). O formato não usa `$` de propósito, para o Docker Compose não tentar "expandir" o valor.

Usuários locais não passam pelo `ALLOWED_GROUP` (você os escolheu um a um).

## LDAP

1. O InfraHub abre uma conexão **LDAPS** (`ldaps://LDAP_HOST:LDAP_PORT`, padrão 636). O certificado do servidor é sempre validado. Se ele foi assinado por uma autoridade própria, informe o arquivo PEM dela em `LDAP_CA` (no Docker, monte o arquivo no contêiner).
2. Ele tenta o **bind** com o DN montado pelo molde `LDAP_USER_DN` (padrão `uid={usuario},{base}`). Por exemplo, com `LDAP_BASE=ou=people,dc=exemplo,dc=com`, o usuário `ana.silva` vira `uid=ana.silva,ou=people,dc=exemplo,dc=com`. Em diretórios que usam outro atributo, ajuste o molde (`cn={usuario},ou=pessoas,{base}`).
3. Com o bind aceito, lê `cn` (nome exibido) e `memberOf` (grupos) **do próprio usuário**.
4. Se `ALLOWED_GROUP` estiver definido, o DN dele precisa estar em `memberOf` (comparação sem diferenciar maiúsculas nem espaços). Sem `ALLOWED_GROUP`, qualquer usuário do diretório entra: o servidor avisa isso na partida.

Requisitos do servidor LDAP: aceitar bind direto com o DN acima, ter o atributo `uid` nas entradas (a busca do nome usa `(uid=<usuario>)`) e expor `memberOf` se você usa grupos (em OpenLDAP, o *overlay* `memberof`).

Para descobrir a autoridade do seu servidor:

```bash
openssl s_client -connect ldap.exemplo.com:636 -showcerts </dev/null
```

> O Node.js valida o nome do servidor pelo certificado. Use em `LDAP_HOST` o **nome DNS** que consta nele, não um IP, a menos que o certificado tenha o IP no SAN.

Se o servidor LDAP não responder, o login mostra "Servidor de autenticação indisponível" (503), diferente de "Usuário ou senha inválidos" (401). **Não há login de emergência:** se o LDAP é a única forma de entrar e ele cair, ninguém entra. Por isso vale manter um usuário local de reserva em `LOCAL_USERS`.

## Sessão

- Depois do login, o servidor entrega um cookie `infrahub_session` (`HttpOnly`, `SameSite=Strict`, `Secure` quando o acesso é por HTTPS), assinado com HMAC-SHA256. Não há sessão guardada no servidor.
- **Sessão normal:** cai após `IDLE_SECONDS` sem uso (padrão 15 min) ou `MAX_LIFE_SECONDS` desde o login (padrão 8 h). O cookie some ao fechar o navegador.
- **"Lembrar de mim":** cookie persistente. Cai após `REMEMBER_IDLE_SECONDS` sem uso (padrão 7 dias) ou `REMEMBER_MAX_SECONDS` desde o login (padrão 30 dias). Use só em computador pessoal.
- As consultas automáticas da tela (status a cada 60 s) **não** renovam a sessão; só a atividade real do usuário.
- O grupo é conferido **no login**. Quem sair do grupo perde o acesso quando a sessão atual expirar.
- O segredo que assina o cookie fica em `data/.session-secret` (gerado na 1ª execução, permissão 600) ou em `SESSION_SECRET`. Trocar o segredo derruba todas as sessões.

## Proteções

- Tentativas: 5 falhas em 5 minutos bloqueiam por IP e por usuário (resposta 429), e cada falha atrasa a resposta em 0,7 s.
- CSRF: `POST`, `PUT` e `DELETE` só valem se a origem (`Origin`/`Referer`) for o próprio InfraHub.
- O login só aceita `[A-Za-z0-9._-]` (até 64 caracteres), o que impede injeção de DN e de filtro LDAP.
- Senha vazia nunca é enviada ao LDAP (no LDAP, bind com senha vazia vira bind anônimo, que "funciona").
- Atrás de proxy reverso, informe o proxy em `TRUSTED_PROXIES`; sem isso, `X-Forwarded-For` é ignorado e todos parecem vir do IP do proxy.

## Quem pode editar?

Todo usuário autenticado pode ligar o modo **Admin** e editar links, categorias, inventário e painéis. Não há papéis separados. Se você precisa de "só leitura" para parte da equipe, use `ALLOWED_GROUP` para limitar a quem entra, ou abra uma *issue* descrevendo o caso.
