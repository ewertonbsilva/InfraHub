// Autenticação do InfraHub: login por LDAP (LDAPS) e/ou por usuários locais (senha com scrypt),
// sessão em cookie assinado (sem banco), limite de tentativas e checagem de origem (CSRF).
// Sem dependência de Express aqui, para poder testar isolado (ver test/auth.test.mjs).
import { createHmac, timingSafeEqual, randomBytes, scrypt } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Login: letras, números, ponto, hífen e sublinhado. Qualquer outra coisa nem chega ao LDAP
// (evita injeção de DN/filtro: vírgula, parênteses, asterisco, barra invertida...).
export const USUARIO_RE = /^[A-Za-z0-9._-]{1,64}$/;

export class LdapIndisponivel extends Error {}

export function escaparRdn(valor) {
  return valor.replace(/([,+"\\<>;=#])/g, "\\$1");
}

// ---- Sessão: cookie assinado (HMAC-SHA256), sem estado no servidor ----
const b64 = (buf) => Buffer.from(buf).toString("base64url");

export function criarToken(segredo, uid, nome, emitido, ultimo, lembrar = false) {
  const dados = { u: uid, n: nome, i: emitido, l: ultimo };
  if (lembrar) dados.m = 1; // "lembrar de mim": usa os limites mais longos de `lembrado`
  const corpo = b64(JSON.stringify(dados));
  const assinatura = b64(createHmac("sha256", segredo).update(corpo).digest());
  return `${corpo}.${assinatura}`;
}

// Devolve { u, n, i, l } ou null (assinatura inválida, inativa demais ou velha demais).
export function lerToken(segredo, token, idle, maxLife, agora = Math.floor(Date.now() / 1000), lembrado = null) {
  try {
    const [corpo, assinatura] = String(token).split(".");
    if (!corpo || !assinatura) return null;
    const esperada = b64(createHmac("sha256", segredo).update(corpo).digest());
    const a = Buffer.from(assinatura), e = Buffer.from(esperada);
    if (a.length !== e.length || !timingSafeEqual(a, e)) return null;
    const d = JSON.parse(Buffer.from(corpo, "base64url").toString("utf-8"));
    if (typeof d.u !== "string") return null;
    if (d.m && lembrado) { idle = lembrado.idle; maxLife = lembrado.maxLife; }
    if (agora - d.l > idle || agora - d.i > maxLife) return null;
    return d;
  } catch {
    return null;
  }
}

// Segredo da sessão: variável de ambiente, ou um arquivo gerado na 1ª execução (fica no volume de dados).
export function carregarSegredo(envValor, arquivo) {
  if (envValor) {
    if (envValor.length < 32) throw new Error("SESSION_SECRET curto (mínimo 32 caracteres)");
    return envValor;
  }
  if (existsSync(arquivo)) return readFileSync(arquivo, "utf-8").trim();
  const novo = randomBytes(48).toString("hex");
  mkdirSync(dirname(arquivo), { recursive: true });
  writeFileSync(arquivo, novo + "\n", { mode: 0o600 });
  return novo;
}

export function lerCookie(header, nome) {
  for (const parte of String(header || "").split(";")) {
    const i = parte.indexOf("=");
    if (i > 0 && parte.slice(0, i).trim() === nome) return parte.slice(i + 1).trim();
  }
  return null;
}

// ---- Anti força bruta (por IP e por usuário) ----
export class Limitador {
  constructor(tentativas = 5, janelaSeg = 300) {
    this.n = tentativas;
    this.janela = janelaSeg;
    this.f = new Map();
  }
  _podar(chave, agora) {
    const lista = (this.f.get(chave) || []).filter((t) => agora - t < this.janela);
    if (lista.length) this.f.set(chave, lista); else this.f.delete(chave);
    return lista;
  }
  bloqueado(chaves, agora = Date.now() / 1000) {
    return chaves.some((c) => this._podar(c, agora).length >= this.n);
  }
  falha(chaves, agora = Date.now() / 1000) {
    for (const c of chaves) {
      const lista = this._podar(c, agora);
      lista.push(agora);
      this.f.set(c, lista);
    }
  }
  ok(chaves) {
    for (const c of chaves) this.f.delete(c);
  }
}

// ---- CSRF: a origem do POST tem de ser o próprio sistema ----
export function origemOk(headers) {
  let o = headers.origin;
  if (!o || o === "null") o = headers.referer; // 'null' = navegador omitiu a origem; cai no Referer
  if (o) {
    try { return new URL(o).host === headers.host; } catch { return false; }
  }
  return ["same-origin", "none", undefined].includes(headers["sec-fetch-site"]);
}

// ---- Grupos: o servidor LDAP devolve memberOf (DN de cada grupo) na entrada do próprio usuário ----
const normalizarDn = (dn) => String(dn).toLowerCase().replace(/\s*,\s*/g, ",").trim();
export function emGrupo(grupos, grupoDn) {
  const alvo = normalizarDn(grupoDn);
  return (grupos || []).some((g) => normalizarDn(g) === alvo);
}

// ---- Usuários locais (opcional): senha guardada como hash scrypt, nunca em texto ----
// Formato de cada registro: "usuario:scrypt.<N>.<sal>.<hash>" (base64url; sem "$" para não confundir o Docker Compose).
const SCRYPT_N = 16384;
const scryptAsync = (senha, sal, n) => new Promise((ok, falha) =>
  scrypt(senha, sal, 32, { N: n, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? falha(e) : ok(k))));

export async function gerarHashSenha(senha) {
  const sal = randomBytes(16);
  const chave = await scryptAsync(senha, sal, SCRYPT_N);
  return `scrypt.${SCRYPT_N}.${sal.toString("base64url")}.${chave.toString("base64url")}`;
}

// Lê "ana:scrypt.…,bia:scrypt.…" e devolve Map(usuario → hash). Registro malformado derruba a partida com mensagem clara.
export function lerUsuariosLocais(texto) {
  const mapa = new Map();
  for (const item of String(texto || "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const i = item.indexOf(":");
    const usuario = item.slice(0, i), hash = item.slice(i + 1);
    if (i < 1 || !USUARIO_RE.test(usuario) || !/^scrypt\.\d+\.[\w-]+\.[\w-]+$/.test(hash))
      throw new Error(`LOCAL_USERS: registro inválido para "${item.slice(0, 20)}…". Gere o hash com: npm run hash-senha`);
    mapa.set(usuario, hash);
  }
  return mapa;
}

// true/false. Com hash ausente (usuário inexistente) ainda gasta o mesmo tempo, para não revelar quem existe.
const HASH_FALSO = `scrypt.${SCRYPT_N}.${Buffer.alloc(16).toString("base64url")}.${Buffer.alloc(32).toString("base64url")}`;
export async function verificarSenhaLocal(hash, senha) {
  const [, n, sal, chave] = String(hash || HASH_FALSO).split(".");
  const esperado = Buffer.from(chave, "base64url");
  const obtido = await scryptAsync(senha, Buffer.from(sal, "base64url"), Number(n));
  return Boolean(hash) && esperado.length === obtido.length && timingSafeEqual(esperado, obtido);
}

// ---- Login por LDAP (LDAPS, bind direto) ----
// cfg: { host, porta, base, userDn?, ca? }. userDn é um molde, ex.: "uid={usuario},{base}" (padrão) ou "cn={usuario},ou=pessoas,{base}".
// ca (caminho de um PEM) é opcional: sem ele vale a lista de autoridades do sistema. A validação do certificado nunca é desligada.
// Devolve { ok: true, nome, grupos } (grupos = memberOf do usuário) ou { ok: false }. Levanta LdapIndisponivel se o servidor não respondeu.
// Senha vazia NUNCA vai ao servidor: no LDAP, bind com senha vazia é bind anônimo e "funciona".
export async function autenticarLdap(cfg, usuario, senha) {
  if (!USUARIO_RE.test(usuario || "") || !senha) return { ok: false };
  const { Client, InvalidCredentialsError } = await import("ldapts");
  const molde = cfg.userDn || "uid={usuario},{base}";
  const dn = molde.replace("{usuario}", () => escaparRdn(usuario)).replace("{base}", () => cfg.base);
  const tlsOptions = { rejectUnauthorized: true };
  if (cfg.ca) tlsOptions.ca = readFileSync(cfg.ca);
  const client = new Client({
    url: `ldaps://${cfg.host}:${cfg.porta}`,
    tlsOptions,
    connectTimeout: 5000,
    timeout: 8000,
  });
  try {
    await client.bind(dn, senha);
  } catch (e) {
    await client.unbind().catch(() => {});
    if (e instanceof InvalidCredentialsError || /invalid ?credentials/i.test(String(e?.message))) return { ok: false };
    throw new LdapIndisponivel(String(e?.message || e));
  }
  let nome = usuario, grupos = [];
  try { // nome completo (cn) e grupos (memberOf) do próprio usuário
    const { searchEntries } = await client.search(cfg.base, { scope: "sub", filter: `(uid=${usuario})`, attributes: ["cn", "memberOf"] });
    const e = searchEntries[0] || {};
    const cn = e.cn;
    if (cn) nome = String(Array.isArray(cn) ? cn[0] : cn);
    grupos = [].concat(e.memberOf || []).map(String);
  } catch (err) { // sem a busca não dá para saber o grupo: tratar como indisponível, não como "sem permissão"
    await client.unbind().catch(() => {});
    throw new LdapIndisponivel(String(err?.message || err));
  }
  await client.unbind().catch(() => {});
  return { ok: true, nome, grupos };
}
