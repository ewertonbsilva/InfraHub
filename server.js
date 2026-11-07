import express from "express";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, copyFileSync, mkdirSync as mkdirSyncFs } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  LdapIndisponivel, Limitador, autenticarLdap, carregarSegredo, criarToken, emGrupo, lerCookie, lerToken, lerUsuariosLocais,
  origemOk, verificarSenhaLocal,
} from "./auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, "data", "links.json");
const IPS_FILE = join(__dirname, "data", "ips.json");
const DASH_FILE = join(__dirname, "data", "dashboards.json");
const DATA_SEED = join(__dirname, "seed", "links.seed.json");
const IPS_SEED = join(__dirname, "seed", "ips.seed.json");
const DASH_SEED = join(__dirname, "seed", "dashboards.seed.json");

// Cria o arquivo de dados (em data/) a partir da semente (em seed/) na primeira execução (não sobrescreve edições)
function ensureSeed(target, seed) {
  if (!existsSync(target) && existsSync(seed)) {
    mkdirSyncFs(dirname(target), { recursive: true });
    copyFileSync(seed, target);
    console.log(`📦 ${target.split(/[\\/]/).pop()} criado a partir da semente`);
  }
}
ensureSeed(DATA_FILE, DATA_SEED);
ensureSeed(IPS_FILE, IPS_SEED);
ensureSeed(DASH_FILE, DASH_SEED);
const PORT = process.env.PORT || 3000;

// ---- Autenticação ----
// Pelo menos um método é obrigatório (sem padrão aberto):
//   LDAP:   LDAP_HOST + LDAP_BASE (LDAPS). ALLOWED_GROUP (DN) restringe a um grupo; vazio = qualquer usuário do diretório.
//   Local:  LOCAL_USERS="ana:scrypt.…,bia:scrypt.…" (gere o hash com: npm run hash-senha)
function configuracaoInvalida(msg) {
  console.error(`\n❌ Configuração inválida: ${msg}\n   Veja o .env.example e o README (seção Configuração).\n`);
  process.exit(1);
}
const ORG_NOME = (process.env.ORG_NOME || "").trim();
const ALLOWED_GROUP = (process.env.ALLOWED_GROUP || "").trim();
const LDAP = process.env.LDAP_HOST ? {
  host: process.env.LDAP_HOST,
  porta: Number(process.env.LDAP_PORT || 636),
  base: process.env.LDAP_BASE || "",
  userDn: process.env.LDAP_USER_DN || "uid={usuario},{base}",
  ca: process.env.LDAP_CA || "",
} : null;
let LOCAL_USERS;
try { LOCAL_USERS = lerUsuariosLocais(process.env.LOCAL_USERS); } catch (e) { configuracaoInvalida(e.message); }
if (!LDAP && !LOCAL_USERS.size) configuracaoInvalida("defina LDAP_HOST/LDAP_BASE e/ou LOCAL_USERS para haver como entrar.");
if (LDAP && !LDAP.base) configuracaoInvalida("LDAP_HOST está definido, mas falta LDAP_BASE (ex.: ou=people,dc=exemplo,dc=com).");
if (LDAP?.ca && !existsSync(LDAP.ca)) configuracaoInvalida(`LDAP_CA aponta para um arquivo que não existe: ${LDAP.ca}`);
const IDLE_SECONDS = Number(process.env.IDLE_SECONDS || 900);       // inatividade
const MAX_LIFE_SECONDS = Number(process.env.MAX_LIFE_SECONDS || 28800); // vida máxima da sessão
// "Lembrar de mim" (marcado no login): cookie persistente com limites maiores
const REMEMBER = {
  idle: Number(process.env.REMEMBER_IDLE_SECONDS || 7 * 86400),
  maxLife: Number(process.env.REMEMBER_MAX_SECONDS || 30 * 86400),
};
const COOKIE_NAME = "infrahub_session";
const SECRET = carregarSegredo(process.env.SESSION_SECRET, join(__dirname, "data", ".session-secret"));
const limitador = new Limitador(5, 300); // 5 falhas em 5 min, por IP e por usuário

const app = express();
// Só confia em X-Forwarded-For se o pedido vier de um proxy listado em TRUSTED_PROXIES (ex.: "198.51.100.5").
// Sem isso, qualquer cliente poderia forjar o cabeçalho e burlar ALLOWED_CIDRS e o limite de tentativas.
const TRUSTED_PROXIES = (process.env.TRUSTED_PROXIES || "").split(",").map((x) => x.trim()).filter(Boolean);
app.set("trust proxy", TRUSTED_PROXIES.length ? TRUSTED_PROXIES : false);

// ---- Restrição por rede de origem (opcional) ----
// Defina ALLOWED_CIDRS com faixas separadas por vírgula. Vazio = libera todos.
// Ex.: ALLOWED_CIDRS="192.0.2.0/24,198.51.100.0/24,127.0.0.1/32"
const ALLOWED_CIDRS = (process.env.ALLOWED_CIDRS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

function ipToInt(ip) {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  return ((+p[0] << 24) | (+p[1] << 16) | (+p[2] << 8) | +p[3]) >>> 0;
}
function inCidr(ip, cidr) {
  const [range, bitsStr] = cidr.split("/");
  const bits = bitsStr === undefined ? 32 : +bitsStr;
  const ipInt = ipToInt(ip), rangeInt = ipToInt(range);
  if (ipInt === null || rangeInt === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}
function clientIp(req) {
  let ip = req.ip || req.socket?.remoteAddress || "";
  if (ip.startsWith("::ffff:")) ip = ip.slice(7); // IPv4 mapeado em IPv6
  if (ip === "::1") ip = "127.0.0.1";
  return ip;
}

if (ALLOWED_CIDRS.length) {
  app.use((req, res, next) => {
    const ip = clientIp(req);
    if (ALLOWED_CIDRS.some((c) => inCidr(ip, c))) return next();
    res.status(403).send("Acesso bloqueado para esta rede.");
  });
}

// Cabeçalhos de segurança. frame-src/img-src abertos porque o InfraHub embute painéis (Beszel, Kuma)
// e mostra o favicon de cada sistema cadastrado.
app.use((_req, res, next) => {
  res.set({
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src * data:; " +
      "frame-src *; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
  });
  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(join(__dirname, "public")));

// ---- Persistência (arquivo JSON) ----
async function loadData() {
  const raw = await readFile(DATA_FILE, "utf-8");
  return JSON.parse(raw);
}
async function saveData(data) {
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
}
async function loadIps() {
  const raw = await readFile(IPS_FILE, "utf-8");
  return JSON.parse(raw);
}
async function saveIps(data) {
  await mkdir(dirname(IPS_FILE), { recursive: true });
  await writeFile(IPS_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// Ping ICMP usando o comando do sistema (funciona p/ qualquer host, não só web)
function pingHost(ip) {
  return new Promise((resolve) => {
    const win = process.platform === "win32";
    const args = win ? ["-n", "1", "-w", "1000", ip] : ["-c", "1", "-W", "1", ip];
    execFile("ping", args, { timeout: 3000 }, (err) => resolve(!err));
  });
}
// Executa promessas com limite de concorrência
async function withLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---- Campo "rdp" (host/IP opcional, vira o link infrahub-rdp://<rdp>) ----
// Mesma regra do handler do Windows: só letras, números, ponto e hífen, porta opcional.
const RDP_RE = /^[A-Za-z0-9.\-]+(:\d{1,5})?$/;
function cleanRdp(v) {
  const s = String(v ?? "").trim();
  if (!s) return { ok: true, value: "" }; // vazio = sem RDP
  if (!RDP_RE.test(s)) return { ok: false };
  const port = s.includes(":") ? Number(s.split(":")[1]) : 1;
  if (port < 1 || port > 65535) return { ok: false };
  return { ok: true, value: s };
}
const RDP_ERRO = "RDP inválido: use IP ou hostname (letras, números, ponto e hífen), com porta opcional (ex.: 192.0.2.26 ou srv01:3390)";

// Consultas automáticas da tela (a cada 60 s): exigem sessão, mas NÃO renovam a inatividade.
const PASSIVAS = [/^\/api\/status$/, /^\/api\/ips\/status$/, /^\/api\/kuma\//];

function cookieSessao(req, valor, apagar = false, persistente = false) {
  // Secure só quando o pedido chegou por HTTPS (o InfraHub hoje é HTTP puro na rede interna).
  let c = `${COOKIE_NAME}=${apagar ? "" : valor}; Path=/; HttpOnly; SameSite=Strict`;
  if (apagar) c += "; Max-Age=0";
  else if (persistente) c += `; Max-Age=${REMEMBER.maxLife}`;
  if (req.secure) c += "; Secure";
  return c;
}

function sessaoDe(req) {
  const t = lerCookie(req.headers.cookie, COOKIE_NAME);
  return t ? lerToken(SECRET, t, IDLE_SECONDS, MAX_LIFE_SECONDS, undefined, REMEMBER) : null;
}

function auth(req, res, next) {
  const s = sessaoDe(req);
  // O grupo é conferido no login; quem sair dele perde o acesso quando a sessão expirar (15 min sem uso, 8 h no máximo).
  if (!s) return res.status(401).json({ error: "Sessão expirada. Entre novamente." });
  if (!["GET", "HEAD"].includes(req.method) && !origemOk(req.headers)) return res.status(403).json({ error: "Origem inválida" });
  req.usuario = { uid: s.u, nome: s.n };
  if (!PASSIVAS.some((r) => r.test(req.path))) {
    res.append("Set-Cookie", cookieSessao(req, criarToken(SECRET, s.u, s.n, s.i, Math.floor(Date.now() / 1000), !!s.m), false, !!s.m));
  }
  return next();
}

function log(req, msg) {
  console.log(`${new Date().toISOString()} ip=${clientIp(req)} ${msg}`);
}

// Configuração pública (a tela de entrada precisa dela antes do login): nada sensível aqui.
app.get("/api/config", (_req, res) => res.json({
  org: ORG_NOME,
  kuma: Boolean(KUMA_BASE && KUMA_SLUG),
  kumaSlug: KUMA_SLUG,
  kumaStatusUrl: KUMA_PUBLIC_URL && KUMA_SLUG ? `${KUMA_PUBLIC_URL}/status/${encodeURIComponent(KUMA_SLUG)}` : "",
}));

app.post("/api/login", async (req, res) => {
  if (!origemOk(req.headers)) return res.status(403).json({ error: "Origem inválida" });
  const usuario = String(req.body?.usuario ?? "").trim();
  const senha = String(req.body?.senha ?? "");
  const lembrar = req.body?.lembrar === true;
  const ip = clientIp(req), chaves = ["i:" + ip, "u:" + usuario.toLowerCase()];
  if (limitador.bloqueado(chaves)) {
    log(req, `login bloqueado (muitas tentativas) uid=${usuario.slice(0, 64)}`);
    return res.status(429).json({ error: "Muitas tentativas. Aguarde alguns minutos." });
  }
  let r;
  if (LOCAL_USERS.has(usuario)) {
    const certa = await verificarSenhaLocal(LOCAL_USERS.get(usuario), senha);
    r = certa ? { ok: true, nome: usuario, grupos: null } : { ok: false };
  } else if (LDAP) {
    try {
      r = await autenticarLdap(LDAP, usuario, senha);
    } catch (e) {
      if (!(e instanceof LdapIndisponivel)) throw e;
      log(req, `ldap indisponível: ${e.message}`);
      return res.status(503).json({ error: "Servidor de autenticação indisponível. Tente novamente." });
    }
  } else {
    await verificarSenhaLocal(null, senha); // mesmo tempo de resposta de um usuário que existe
    r = { ok: false };
  }
  if (r.ok && ALLOWED_GROUP && r.grupos && !emGrupo(r.grupos, ALLOWED_GROUP)) {
    log(req, `login negado (sem permissão) uid=${usuario}`);
    limitador.falha(chaves);
    return res.status(403).json({ error: "Seu usuário não tem permissão para este sistema." });
  }
  if (!r.ok) {
    log(req, `login falhou uid=${usuario.slice(0, 64)}`);
    limitador.falha(chaves);
    await new Promise((ok) => setTimeout(ok, 700)); // freia tentativas em série
    return res.status(401).json({ error: "Usuário ou senha inválidos." });
  }
  limitador.ok(chaves);
  log(req, `login ok uid=${usuario}`);
  const agora = Math.floor(Date.now() / 1000);
  res.set("Set-Cookie", cookieSessao(req, criarToken(SECRET, usuario, r.nome, agora, agora, lembrar), false, lembrar));
  res.json({ usuario, nome: r.nome });
});

app.post("/api/logout", (req, res) => {
  if (!origemOk(req.headers)) return res.status(403).json({ error: "Origem inválida" });
  const s = sessaoDe(req);
  if (s) log(req, `logout uid=${s.u}`);
  res.set("Set-Cookie", cookieSessao(req, "", true));
  res.json({ ok: true });
});

app.get("/api/me", auth, (req, res) => res.json({ usuario: req.usuario.uid, nome: req.usuario.nome }));

// ---- Leitura (protegida: exige login) ----
app.get("/api/data", auth, async (_req, res) => {
  try {
    res.json(await loadData());
  } catch {
    res.status(500).json({ error: "Falha ao ler os dados" });
  }
});

// ---- Status (checagem de porta TCP) ----
function checkPort(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => { if (done) return; done = true; socket.destroy(); resolve(ok); };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

app.get("/api/status", auth, async (_req, res) => {
  try {
    const data = await loadData();
    const results = await Promise.all(
      data.links.map(async (l) => {
        let host, port;
        try {
          const u = new URL(l.url);
          host = u.hostname;
          port = u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80);
        } catch {
          return [l.url, "offline"];
        }
        const ok = await checkPort(host, port);
        return [l.url, ok ? "online" : "offline"];
      })
    );
    res.json(Object.fromEntries(results));
  } catch {
    res.status(500).json({ error: "Falha ao checar status" });
  }
});

// ---- Painéis / dashboards embutidos (protegido) ----
async function loadDash() {
  const raw = await readFile(DASH_FILE, "utf-8");
  return JSON.parse(raw);
}
async function saveDash(data) {
  await mkdir(dirname(DASH_FILE), { recursive: true });
  await writeFile(DASH_FILE, JSON.stringify(data, null, 2), "utf-8");
}

app.get("/api/dashboards", auth, async (_req, res) => {
  try { res.json(await loadDash()); }
  catch { res.json({ dashboards: [] }); }
});

app.post("/api/dashboards", auth, async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.url) return res.status(400).json({ error: "Nome e URL são obrigatórios" });
  const data = await loadDash().catch(() => ({ dashboards: [] }));
  const d = { id: "dash-" + randomUUID().slice(0, 8), name: String(b.name), url: String(b.url) };
  data.dashboards.push(d);
  await saveDash(data);
  res.status(201).json(d);
});

app.put("/api/dashboards/:id", auth, async (req, res) => {
  const data = await loadDash();
  const d = data.dashboards.find((x) => x.id === req.params.id);
  if (!d) return res.status(404).json({ error: "Painel não encontrado" });
  const b = req.body || {};
  if (b.name !== undefined) d.name = String(b.name);
  if (b.url !== undefined) d.url = String(b.url);
  await saveDash(data);
  res.json(d);
});

app.delete("/api/dashboards/:id", auth, async (req, res) => {
  const data = await loadDash();
  const before = data.dashboards.length;
  data.dashboards = data.dashboards.filter((x) => x.id !== req.params.id);
  if (data.dashboards.length === before) return res.status(404).json({ error: "Painel não encontrado" });
  await saveDash(data);
  res.json({ ok: true });
});

// ---- Uptime Kuma: proxy da API da status page (protegido) ----
// Sem KUMA_BASE e KUMA_SLUG a aba "Links" some. KUMA_PUBLIC_URL (opcional) é o endereço que o navegador usa para abrir a página completa.
const KUMA_BASE = (process.env.KUMA_BASE || "").replace(/\/+$/, "");
const KUMA_SLUG = (process.env.KUMA_SLUG || "").replace(/[^a-z0-9_-]/gi, "");
const KUMA_PUBLIC_URL = (process.env.KUMA_PUBLIC_URL || "").replace(/\/+$/, "");
app.get("/api/kuma/:slug", auth, async (req, res) => {
  if (!KUMA_BASE) return res.status(404).json({ error: "Uptime Kuma não configurado" });
  const slug = String(req.params.slug).replace(/[^a-z0-9_-]/gi, "");
  try {
    const [cfgR, hbR] = await Promise.all([
      fetch(`${KUMA_BASE}/api/status-page/${slug}`),
      fetch(`${KUMA_BASE}/api/status-page/heartbeat/${slug}`),
    ]);
    if (!cfgR.ok || !hbR.ok) throw new Error("kuma");
    res.json({ config: await cfgR.json(), heartbeat: await hbR.json() });
  } catch {
    res.status(502).json({ error: "Falha ao consultar o Uptime Kuma" });
  }
});

// ---- Inventário de IPs (protegido) ----
app.get("/api/ips", auth, async (_req, res) => {
  try { res.json(await loadIps()); }
  catch { res.status(500).json({ error: "Falha ao ler o inventário" }); }
});

app.put("/api/ips/:n", auth, async (req, res) => {
  const n = Number(req.params.n);
  if (!Number.isInteger(n)) return res.status(400).json({ error: "IP inválido" });
  const data = await loadIps();
  let host = data.hosts.find((h) => h.n === n);
  if (!host) { host = { n, hostname: "", note: "" }; data.hosts.push(host); data.hosts.sort((a, b) => a.n - b.n); }
  const b = req.body || {};
  if (b.hostname !== undefined) host.hostname = String(b.hostname);
  if (b.note !== undefined) host.note = String(b.note);
  if (b.rdp !== undefined) {
    const r = cleanRdp(b.rdp);
    if (!r.ok) return res.status(400).json({ error: RDP_ERRO });
    if (r.value) host.rdp = r.value; else delete host.rdp;
  }
  await saveIps(data);
  res.json(host);
});

app.post("/api/ips", auth, async (req, res) => {
  const b = req.body || {};
  const n = Number(b.n);
  if (!Number.isInteger(n) || n < 1 || n > 254) return res.status(400).json({ error: "Número de IP inválido (1–254)" });
  const data = await loadIps();
  if (data.hosts.some((h) => h.n === n)) return res.status(409).json({ error: `O IP .${n} já existe` });
  const host = { n, hostname: String(b.hostname || ""), note: String(b.note || "") };
  if (b.rdp !== undefined) {
    const r = cleanRdp(b.rdp);
    if (!r.ok) return res.status(400).json({ error: RDP_ERRO });
    if (r.value) host.rdp = r.value;
  }
  data.hosts.push(host);
  data.hosts.sort((a, b) => a.n - b.n);
  await saveIps(data);
  res.status(201).json(host);
});

app.delete("/api/ips/:n", auth, async (req, res) => {
  const n = Number(req.params.n);
  const data = await loadIps();
  const before = data.hosts.length;
  data.hosts = data.hosts.filter((h) => h.n !== n);
  if (data.hosts.length === before) return res.status(404).json({ error: "IP não encontrado" });
  await saveIps(data);
  res.json({ ok: true });
});

app.get("/api/ips/status", auth, async (_req, res) => {
  try {
    const data = await loadIps();
    const results = await withLimit(data.hosts, 24, async (h) => {
      const ok = await pingHost(`${data.network}.${h.n}`);
      return [h.n, ok ? "online" : "offline"];
    });
    res.json(Object.fromEntries(results));
  } catch {
    res.status(500).json({ error: "Falha ao checar status" });
  }
});

// ---- CRUD de links (protegido) ----
app.post("/api/links", auth, async (req, res) => {
  const data = await loadData();
  const link = req.body || {};
  if (!link.name || !link.url) return res.status(400).json({ error: "Nome e URL são obrigatórios" });
  if (link.rdp !== undefined) {
    const r = cleanRdp(link.rdp);
    if (!r.ok) return res.status(400).json({ error: RDP_ERRO });
    if (r.value) link.rdp = r.value; else delete link.rdp;
  }
  link.id = "lnk-" + randomUUID().slice(0, 8);
  link.tags = Array.isArray(link.tags) ? link.tags : [];
  data.links.push(link);
  await saveData(data);
  res.status(201).json(link);
});

app.put("/api/links/:id", auth, async (req, res) => {
  const data = await loadData();
  const idx = data.links.findIndex((l) => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Link não encontrado" });
  const body = req.body || {};
  if (body.rdp !== undefined) {
    const r = cleanRdp(body.rdp);
    if (!r.ok) return res.status(400).json({ error: RDP_ERRO });
    body.rdp = r.value;
  }
  data.links[idx] = { ...data.links[idx], ...body, id: req.params.id };
  if (!data.links[idx].rdp) delete data.links[idx].rdp; // vazio = remove o campo
  await saveData(data);
  res.json(data.links[idx]);
});

app.delete("/api/links/:id", auth, async (req, res) => {
  const data = await loadData();
  const before = data.links.length;
  data.links = data.links.filter((l) => l.id !== req.params.id);
  if (data.links.length === before) return res.status(404).json({ error: "Link não encontrado" });
  await saveData(data);
  res.json({ ok: true });
});

// ---- CRUD de categorias (protegido) ----
app.post("/api/categories", auth, async (req, res) => {
  const data = await loadData();
  const cat = req.body || {};
  if (!cat.name) return res.status(400).json({ error: "Nome é obrigatório" });
  cat.id = cat.id || "cat-" + randomUUID().slice(0, 6);
  if (data.categories.some((c) => c.id === cat.id)) return res.status(409).json({ error: "ID já existe" });
  cat.icon = cat.icon || "📁";
  cat.color = cat.color || "#64748b";
  data.categories.push(cat);
  await saveData(data);
  res.status(201).json(cat);
});

app.put("/api/categories/:id", auth, async (req, res) => {
  const data = await loadData();
  const idx = data.categories.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Categoria não encontrada" });
  data.categories[idx] = { ...data.categories[idx], ...(req.body || {}), id: req.params.id };
  await saveData(data);
  res.json(data.categories[idx]);
});

app.delete("/api/categories/:id", auth, async (req, res) => {
  const data = await loadData();
  if (data.links.some((l) => l.category === req.params.id))
    return res.status(409).json({ error: "Existem links nesta categoria. Mova-os antes de excluir." });
  data.categories = data.categories.filter((c) => c.id !== req.params.id);
  await saveData(data);
  res.json({ ok: true });
});

// ---- Proxy de embed (remove X-Frame-Options p/ permitir iframe) ----
// Espelha alvos (Beszel, Uptime Kuma, etc.) em portas próprias, sem os cabeçalhos que bloqueiam iframe.
// Configure com EMBED_PROXIES="porta=url,porta=url"  (ex.: "3001=http://192.0.2.20:8090,3002=http://192.0.2.21:3001")
// ATENÇÃO: essas portas NÃO pedem login. Restrinja por rede (ALLOWED_CIDRS vale aqui também) e exponha só em rede de confiança.
function startEmbedProxy(port, targetUrl) {
  const target = new URL(targetUrl);
  const mod = target.protocol === "https:" ? https : http;
  const proxy = http.createServer((creq, cres) => {
    if (ALLOWED_CIDRS.length && !ALLOWED_CIDRS.some((c) => inCidr(clientIp({ socket: creq.socket }), c))) {
      cres.writeHead(403); cres.end("Acesso bloqueado para esta rede."); return;
    }
    const opts = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      method: creq.method,
      path: creq.url,
      headers: { ...creq.headers, host: target.host },
      rejectUnauthorized: process.env.EMBED_INSECURE_TLS !== "1", // EMBED_INSECURE_TLS=1 aceita certificado autoassinado do alvo
    };
    const preq = mod.request(opts, (pres) => {
      const h = { ...pres.headers };
      delete h["x-frame-options"];
      delete h["content-security-policy"];
      delete h["content-security-policy-report-only"];
      cres.writeHead(pres.statusCode || 502, h);
      pres.pipe(cres);
    });
    preq.on("error", () => { if (!cres.headersSent) cres.writeHead(502); cres.end("proxy error"); });
    creq.pipe(preq);
  });
  proxy.listen(port, () => console.log(`🔁 Proxy de embed em :${port} -> ${targetUrl}`));
}

const EMBED_PROXIES = process.env.EMBED_PROXIES;
if (EMBED_PROXIES) {
  EMBED_PROXIES.split(",").forEach((pair) => {
    const i = pair.indexOf("=");
    if (i < 0) return;
    const port = Number(pair.slice(0, i).trim());
    const url = pair.slice(i + 1).trim();
    if (port && url) startEmbedProxy(port, url);
  });
} else if (process.env.EMBED_TARGET && process.env.EMBED_PORT) {
  startEmbedProxy(Number(process.env.EMBED_PORT), process.env.EMBED_TARGET);
}

app.listen(PORT, () => {
  if (!existsSync(DATA_FILE)) console.warn("⚠️  data/links.json não encontrado.");
  console.log(`
🚀 InfraHub rodando em http://localhost:${PORT}
   Login: ${[LDAP && `LDAP ${LDAP.host}:${LDAP.porta}${ALLOWED_GROUP ? ` (grupo: ${ALLOWED_GROUP})` : " (qualquer usuário do diretório)"}`, LOCAL_USERS.size && `${LOCAL_USERS.size} usuário(s) local(is)`].filter(Boolean).join(" + ")}
   Redes permitidas: ${ALLOWED_CIDRS.length ? ALLOWED_CIDRS.join(", ") : "todas (ALLOWED_CIDRS não definido)"}
`);
});
