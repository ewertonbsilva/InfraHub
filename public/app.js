// ---------- Estado ----------
let DATA = { categories: [], links: [] };
let activeCategory = "all";
let statusFilter = ""; // "" | "online" | "offline" | "checking" (clique nos cartões de números)
let idsNaTela = ""; // ids exibidos no último render (para redesenhar quando o status mudar)
let searchTerm = "";
const view = "list"; // layout fixo: menu lateral + uma linha por sistema
let editingId = null;
const statusCache = {}; // { url: { state: "online"|"offline", title, ts } }
const STATUS_TTL = 60000; // revalida a cada 60s
let mode = "cards"; // "cards" | "ips" | "dash"
let IPS = { network: "", hosts: [] };
const ipStatus = {}; // { n: { state, ts } }
let DASHBOARDS = [];
let dashSelected = null;
let editingDash = null;

const $ = (sel) => document.querySelector(sel);
const catById = (id) => DATA.categories.find((c) => c.id === id);

// ---------- API ----------
async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401 && authed && path !== "/api/login") {
    // sessão acabou (inatividade, limite de 8 h ou usuário removido da lista): volta para a tela de entrada
    authed = false; setAuthed(false);
    showGateError("Sessão expirada. Entre novamente.");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "Erro " + res.status);
  }
  return res.status === 204 ? null : res.json();
}

async function loadData() {
  DATA = await api("/api/data");
  render();
}

// ---------- Render ----------
function isAdmin() { return authed; }

const RDP_FILTER = "__rdp"; // "categoria" especial: só os links com RDP configurado

const porNome = (a, b) => (a.name || "").localeCompare(b.name || "", "pt-BR", { numeric: true, sensitivity: "base" });

const estadoDe = (l) => statusCache[l.url]?.state || "checking";

function filteredLinks(ignorarStatus = false) {
  const t = searchTerm.toLowerCase();
  return DATA.links.filter((l) => {
    if (!ignorarStatus && statusFilter && estadoDe(l) !== statusFilter) return false;
    if (activeCategory === RDP_FILTER) { if (!l.rdp) return false; }
    else if (activeCategory !== "all" && l.category !== activeCategory) return false;
    if (!t) return true;
    const hay = [l.name, l.url, l.description, (l.tags || []).join(" "), catById(l.category)?.name, l.rdp ? "rdp " + l.rdp : ""]
      .join(" ").toLowerCase();
    return hay.includes(t);
  });
}

function renderFilters() {
  const nav = $("#filters");
  const counts = {};
  DATA.links.forEach((l) => (counts[l.category] = (counts[l.category] || 0) + 1));
  const chips = [
    `<div class="chip ${activeCategory === "all" ? "active" : ""}" data-cat="all">
       <span>📋 Todos</span><span class="count">${DATA.links.length}</span></div>`,
  ];
  const comRdp = DATA.links.filter((l) => l.rdp).length;
  if (comRdp || activeCategory === RDP_FILTER) { // sem nenhum RDP cadastrado, o filtro só ocupa espaço
    chips.push(`<div class="chip ${activeCategory === RDP_FILTER ? "active" : ""}" data-cat="${RDP_FILTER}" title="Só os que têm RDP configurado">
       <span>🖥️ Com RDP</span><span class="count">${comRdp}</span></div>`);
  }
  DATA.categories.forEach((c) => {
    chips.push(
      `<div class="chip ${activeCategory === c.id ? "active" : ""}" data-cat="${c.id}">
         <span>${c.icon} ${esc(c.name)}</span><span class="count">${counts[c.id] || 0}</span></div>`
    );
  });
  nav.innerHTML = chips.join("");
  nav.querySelectorAll(".chip").forEach((chip) =>
    chip.addEventListener("click", () => { activeCategory = chip.dataset.cat; render(); })
  );
}

function itemParts(link) {
  const cat = catById(link.category) || { color: "var(--red)", name: "—", icon: "🔗" };
  const fallback = cat.icon || (link.name || "?").trim().charAt(0).toUpperCase();
  return {
    cat,
    icon: iconHTML(link, fallback),
    host: hostOf(link.url),
    dot: `<span class="status-dot ${statusCache[link.url]?.state || ""}" data-url="${esc(link.url)}"
            title="${statusCache[link.url]?.title || "Verificando…"}"></span>`,
    admin: `<span class="card-admin">
        <button class="icon-btn edit" title="Editar" data-edit="${link.id}">✎</button>
        <button class="icon-btn del" title="Excluir" data-del="${link.id}">🗑</button>
      </span>`,
  };
}

// Uma linha por sistema
function rowHTML(link) {
  const p = itemParts(link);
  const tags = (link.tags || []).slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
  return `
    <a class="row" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer"
       style="--accent:${p.cat.color}" data-id="${link.id}">
      ${p.dot}
      <span class="row-icon">${p.icon}</span>
      <span class="row-main">
        <span class="row-name">${esc(link.name)}</span>
        ${link.description ? `<span class="row-desc">${esc(link.description)}</span>` : ""}
      </span>
      <span class="row-tags">${tags}</span>
      ${link.rdp ? rdpButtonHTML(link.rdp) : ""}
      <span class="row-url">${esc(p.host)}</span>
      ${p.admin}
    </a>`;
}

// ---------- RDP (protocolo infrahub-rdp://, abre o mstsc direto no host) ----------
// Mesma regra do handler instalado nos PCs: só letras, números, ponto e hífen, porta opcional.
const RDP_RE = /^[A-Za-z0-9.\-]+(:\d{1,5})?$/;
function rdpHostOk(h) {
  if (!RDP_RE.test(h || "")) return false;
  if (!h.includes(":")) return true;
  const port = Number(h.split(":")[1]);
  return port >= 1 && port <= 65535;
}

function rdpButtonHTML(host) {
  return `<button type="button" class="rdp-btn" data-rdp="${esc(host)}"
            title="Abrir Área de Trabalho Remota em ${esc(host)}">🖥️ RDP</button>`;
}

function openRdp(host) {
  if (!rdpHostOk(host)) { alert("Host RDP inválido: " + host); return; }
  const a = document.createElement("a");
  a.href = "infrahub-rdp://" + host;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Delegação: funciona para os botões dos cards e da tabela de IPs (inclusive dentro de <a>)
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-rdp]");
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  openRdp(btn.dataset.rdp);
}, true);

function hostOf(url) {
  try { return new URL(url).host || url; } catch { return url; }
}

function faviconOf(url) {
  try { return new URL(url).origin + "/favicon.ico"; } catch { return ""; }
}

// Ícone do card: personalizado (link.icon) → favicon do sistema → emoji da categoria
function iconHTML(link, fallback) {
  const fav = faviconOf(link.url);
  const primary = link.icon || fav;
  if (!primary) return `<span class="avatar emoji">${esc(fallback)}</span>`;
  const triedFav = link.icon ? "" : "1"; // se já começamos pelo favicon, não tenta de novo
  return `<img class="app-icon" src="${esc(primary)}" alt="" loading="lazy"
            data-fav="${esc(fav)}" data-letter="${esc(fallback)}" data-triedfav="${triedFav}"
            />`;
}

// Cadeia de fallback quando a imagem falha
function iconError(img) {
  if (!img.dataset.triedfav && img.dataset.fav) {
    img.dataset.triedfav = "1";
    img.src = img.dataset.fav;
    return;
  }
  const span = document.createElement("span");
  span.className = "avatar emoji";
  span.textContent = img.dataset.letter || "?";
  img.replaceWith(span);
}
// 'error' não borbulha: escuta na captura (a CSP do servidor proíbe onerror inline)
document.addEventListener("error", (e) => {
  if (e.target instanceof HTMLImageElement && e.target.classList.contains("app-icon")) iconError(e.target);
}, true);
// campo de busca nasce readonly (evita autofill de gerenciador de senhas); libera ao focar
$("#search").addEventListener("focus", (e) => e.target.removeAttribute("readonly"));

function render() {
  if (mode === "ips") return renderIps();
  if (mode === "dash") return renderDash();
  if (mode === "links") return renderLinks();
  document.body.dataset.view = view;
  renderFilters();
  const content = $("#content");
  const links = filteredLinks().sort(porNome); // ordem alfabética dentro de cada categoria
  idsNaTela = links.map((l) => l.id).join(",");
  $("#stats").textContent = `${links.length} de ${DATA.links.length} itens`;

  let html = "";
  const showAllCats = activeCategory === "all" || activeCategory === RDP_FILTER;
  const showEmpty = editMode() && activeCategory !== RDP_FILTER; // com o filtro RDP, categorias vazias ficam ocultas
  const cats = showAllCats
    ? DATA.categories.filter((c) => links.some((l) => l.category === c.id) || showEmpty)
    : DATA.categories.filter((c) => c.id === activeCategory);

  cats.forEach((c) => {
    const items = links.filter((l) => l.category === c.id);
    if (!items.length && !showEmpty) return;
    html += `<section class="cat-section">
      <div class="cat-header"><span class="bar" style="background:${c.color}"></span>
        ${c.icon} ${esc(c.name)} <span class="cnt">${items.length}</span></div>
      <div class="rows">
        ${items.map(rowHTML).join("")}
        <div class="add-item" data-add="${c.id}"><span class="plus">+</span><span>Adicionar link</span></div>
      </div></section>`;
  });

  if (!html) html = `<div class="empty">${statusFilter ? "Nenhum sistema neste estado. Clique no cartão de novo para limpar o filtro." : "Nenhum item encontrado."}</div>`;
  content.innerHTML = html;

  content.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", (e) => { e.preventDefault(); openLinkModal(b.dataset.edit); }));
  content.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", (e) => { e.preventDefault(); deleteLink(b.dataset.del); }));
  content.querySelectorAll("[data-add]").forEach((b) =>
    b.addEventListener("click", (e) => { e.preventDefault(); openLinkModal(null, b.dataset.add); }));

  renderStats();
  checkVisibleStatus();
}

// ---------- Estatísticas (no ar / fora do ar) ----------
function renderStats() {
  const el = $("#statsBar");
  if (!el || mode !== "cards") return;
  // Os números acompanham o que está na tela: categoria escolhida e busca
  const lista = filteredLinks(true); // os cartões contam sem o filtro de estado, senão o número sumiria ao clicar
  let on = 0, off = 0, checking = 0;
  lista.forEach((l) => {
    const st = statusCache[l.url]?.state;
    if (st === "online") on++;
    else if (st === "offline") off++;
    else checking++;
  });
  const total = lista.length;
  const escopo = activeCategory === "all" ? "" : activeCategory === RDP_FILTER ? "com RDP" : (catById(activeCategory)?.name || "");
  const contexto = escopo ? (searchTerm ? `${escopo}, filtrados` : escopo) : (searchTerm ? "resultado da busca" : "");
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  const card = (cls, valor, rotulo, legenda, barra, estado = "") => `
    <button type="button" class="stat ${cls}${statusFilter === estado ? " sel" : ""}" data-estado="${estado}" aria-pressed="${statusFilter === estado}" title="${estado ? "Clique para ver só estes" : "Clique para ver todos"}">
      <div class="stat-top"><span class="stat-dot"></span><span class="stat-label">${rotulo}</span></div>
      <b>${valor}</b>
      <span class="stat-note">${legenda}</span>
      ${barra === undefined ? "" : `<span class="stat-bar"><i style="width:${barra}%"></i></span>`}
    </button>`;
  el.innerHTML = `<div class="stat-kpis">
      ${card("st-on", on, "No ar", checking ? "verificando…" : `${pct(on)}% ${contexto ? "de " + contexto : "dos sistemas"}`, checking ? undefined : pct(on), "online")}
      ${card("st-off" + (off ? " bad" : ""), off, "Fora do ar", off ? (contexto ? `a porta não respondeu · ${contexto}` : "a porta não respondeu") : contexto ? `nenhum em ${contexto}` : "nenhum no momento", undefined, "offline")}
      ${checking ? card("st-chk", checking, "Verificando", "checagem em andamento", undefined, "checking") : ""}
      ${card("st-all", total, "Sistemas", contexto || `${DATA.categories.length} categorias`, undefined, "")}
    </div>`;
}

// Clique nos cartões: filtra a lista por estado (clicar de novo, ou em "Sistemas", limpa)
$("#statsBar").addEventListener("click", (e) => {
  const b = e.target.closest(".stat[data-estado]");
  if (!b) return;
  const est = b.dataset.estado;
  statusFilter = est && statusFilter !== est ? est : "";
  render();
});

// ---------- Status ao vivo (checado pelo servidor via porta TCP) ----------
let statusInFlight = false;

function applyStatus() {
  document.querySelectorAll(".status-dot[data-url]").forEach((dot) => {
    const c = statusCache[dot.dataset.url];
    if (c) {
      dot.className = "status-dot " + c.state;
      dot.title = c.state === "online" ? "Online — porta respondeu" : "Offline — porta não respondeu";
    } else {
      dot.className = "status-dot checking";
      dot.title = "Verificando…";
    }
  });
  renderStats();
  // com filtro de estado ligado, a lista muda quando o status chega: redesenha só se mudou
  if (statusFilter && mode === "cards" && filteredLinks().sort(porNome).map((l) => l.id).join(",") !== idsNaTela) render();
}

async function checkVisibleStatus() {
  if (!authed) return; // só checa status quando autenticado
  applyStatus(); // mostra cache atual / "verificando" imediatamente
  const fresh = Object.values(statusCache)[0];
  if (fresh && Date.now() - fresh.ts < STATUS_TTL) return; // ainda válido
  if (statusInFlight) return;
  statusInFlight = true;
  try {
    const map = await api("/api/status");
    const ts = Date.now();
    Object.entries(map).forEach(([url, state]) => { statusCache[url] = { state, ts }; });
    applyStatus();
  } catch {
    /* servidor indisponível: mantém o que tiver */
  } finally {
    statusInFlight = false;
  }
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Painel (dashboards embutidos) ----------
async function loadDashData() {
  try { DASHBOARDS = (await api("/api/dashboards")).dashboards || []; }
  catch { DASHBOARDS = []; }
  if (!dashSelected || !DASHBOARDS.some((d) => d.id === dashSelected)) {
    dashSelected = DASHBOARDS[0]?.id || null;
  }
}

// Página de status nativa consumindo a API do Uptime Kuma
// Configuração pública vinda do servidor (/api/config): nome da organização e integração com o Uptime Kuma
let CONFIG = { org: "", kuma: false, kumaSlug: "", kumaStatusUrl: "" };

const BEAT = { 1: "up", 0: "down", 2: "pending", 3: "maint" };
const BEAT_LABEL = { up: "No ar", down: "Fora", pending: "Pendente", maint: "Manutenção" };

async function renderLinks() {
  const content = $("#content");
  if (!content.querySelector(".kuma-wrap")) {
    content.innerHTML = `<div class="ip-count"><span>Carregando status…</span></div>`;
  }
  let data;
  try { data = await api("/api/kuma/" + CONFIG.kumaSlug); }
  catch {
    content.innerHTML = `<div class="empty">Não foi possível carregar o status do Uptime Kuma.</div>`;
    return;
  }
  const groups = data.config?.publicGroupList || [];
  const hbList = data.heartbeat?.heartbeatList || {};
  const upList = data.heartbeat?.uptimeList || {};
  const title = data.config?.config?.title || "Status dos Links";

  const all = groups.flatMap((g) => g.monitorList.map((m) => m.id));
  const upCount = all.filter((id) => (hbList[id] || []).slice(-1)[0]?.status === 1).length;

  const groupSection = (g) => {
    const cards = g.monitorList.map((m) => {
      const beats = hbList[m.id] || [];
      const last = beats[beats.length - 1];
      const state = BEAT[last?.status] || "";
      const ping = last?.ping != null ? Math.round(last.ping) + " ms" : "—";
      const up24 = upList[m.id + "_24"] != null ? (upList[m.id + "_24"] * 100).toFixed(2) + "%" : "—";
      const bars = beats.slice(-30).map((b) =>
        `<span class="beat ${BEAT[b.status] || ""}" title="${esc(b.time || "")}${b.msg ? " · " + esc(b.msg) : ""}"></span>`).join("");
      return `<div class="kuma-card">
        <div class="kuma-top">
          <span class="status-dot ${state}"></span>
          <span class="kuma-name">${esc(m.name)}</span>
          <span class="kuma-badge ${state}">${BEAT_LABEL[state] || "—"}</span>
        </div>
        <div class="beats">${bars || '<span class="muted">sem dados</span>'}</div>
        <div class="kuma-meta"><span>⏱️ ${ping}</span><span>📈 24h: ${up24}</span></div>
      </div>`;
    }).join("");
    return `<section class="cat-section">
      <div class="cat-header"><span class="bar"></span>${esc(g.name)} <span class="cnt">${g.monitorList.length}</span></div>
      <div class="kuma-grid">${cards}</div>
    </section>`;
  };

  // Os grupos da página de status se alternam entre as duas colunas
  const col1 = groups.filter((_, i) => i % 2 === 0);
  const col2 = groups.filter((_, i) => i % 2 === 1);

  content.innerHTML = `
    <div class="kuma-wrap">
      <div class="ip-count kuma-summary">
        <span><b>${esc(title)}</b> — ${upCount}/${all.length} no ar · atualiza a cada 60s</span>
        ${CONFIG.kumaStatusUrl ? `<a class="mini" href="${esc(CONFIG.kumaStatusUrl)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none">Abrir status completo ↗</a>` : ""}
      </div>
      <div class="kuma-cols">
        <div class="kuma-col">${col1.map(groupSection).join("")}</div>
        <div class="kuma-col">${col2.map(groupSection).join("")}</div>
      </div>
    </div>`;
}

// "proxy://5011[/path]" → usa o host atual na porta indicada (proxy de embed do InfraHub)
function resolveDashUrl(u) {
  const m = /^proxy:\/\/(\d+)(\/.*)?$/.exec(u || "");
  if (m) return `${location.protocol}//${location.hostname}:${m[1]}${m[2] || "/"}`;
  return u;
}

function renderDash() {
  const content = $("#content");
  const adm = editMode();
  if (!DASHBOARDS.length) {
    content.innerHTML = `<div class="dash-bar">${adm ? `<button class="mini" id="dashAdd">➕ Adicionar painel</button>` : ""}</div>
      <div class="dash-empty">Nenhum painel configurado.${adm ? " Clique em “Adicionar painel”." : ""}</div>`;
    if (adm) $("#dashAdd").addEventListener("click", () => openDashModal(null));
    return;
  }
  const cur = DASHBOARDS.find((d) => d.id === dashSelected) || DASHBOARDS[0];
  content.innerHTML = `
    <div class="dash-bar">
      ${DASHBOARDS.map((d) => `<button class="tab ${d.id === cur.id ? "active" : ""}" data-dash="${d.id}">📊 ${esc(d.name)}</button>`).join("")}
      <span class="spacer"></span>
      ${adm ? `<button class="mini" id="dashAdd">➕ Adicionar</button>
               <button class="mini" id="dashEdit">✎ Editar</button>
               <button class="mini" id="dashDel">🗑 Excluir</button>` : ""}
    </div>
    <div class="dash-frame-wrap">
      <a class="dash-open" href="${esc(resolveDashUrl(cur.url))}" target="_blank" rel="noopener noreferrer">Abrir em nova aba ↗</a>
      <iframe src="${esc(resolveDashUrl(cur.url))}" referrerpolicy="no-referrer" sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"></iframe>
    </div>`;

  content.querySelectorAll("[data-dash]").forEach((b) =>
    b.addEventListener("click", () => { dashSelected = b.dataset.dash; render(); }));
  if (adm) {
    $("#dashAdd").addEventListener("click", () => openDashModal(null));
    $("#dashEdit").addEventListener("click", () => openDashModal(cur.id));
    $("#dashDel").addEventListener("click", () => deleteDash(cur.id));
  }
}

function openDashModal(id) {
  editingDash = id;
  $("#dashError").classList.add("hidden");
  const d = id ? DASHBOARDS.find((x) => x.id === id) : null;
  $("#dashModalTitle").textContent = id ? "Editar painel" : "Novo painel";
  $("#d-name").value = d?.name || "";
  $("#d-url").value = d?.url || "";
  showModal("dashModal");
  $("#d-name").focus();
}

$("#dashSubmit").addEventListener("click", async () => {
  const payload = { name: $("#d-name").value.trim(), url: $("#d-url").value.trim() };
  if (!payload.name || !payload.url) {
    const el = $("#dashError"); el.textContent = "Nome e URL são obrigatórios."; el.classList.remove("hidden"); return;
  }
  try {
    if (editingDash) await api("/api/dashboards/" + editingDash, { method: "PUT", body: JSON.stringify(payload) });
    else { const d = await api("/api/dashboards", { method: "POST", body: JSON.stringify(payload) }); dashSelected = d.id; }
    hideModals();
    await loadDashData();
    render();
  } catch (e) {
    const el = $("#dashError"); el.textContent = e.message; el.classList.remove("hidden");
  }
});

async function deleteDash(id) {
  const d = DASHBOARDS.find((x) => x.id === id);
  if (!confirm(`Excluir o painel "${d?.name}"?`)) return;
  try { await api("/api/dashboards/" + id, { method: "DELETE" }); dashSelected = null; await loadDashData(); render(); }
  catch (e) { alert(e.message); }
}

// ---------- Inventário de IPs ----------
async function loadIpsData() {
  try { IPS = await api("/api/ips"); } catch { IPS = { network: "", hosts: [] }; }
}

let ipOnlyRdp = false; // filtro do inventário: só os IPs com RDP configurado

function renderIps() {
  const content = $("#content");
  const t = searchTerm.toLowerCase();
  const rows = IPS.hosts.filter((h) => {
    if (ipOnlyRdp && !h.rdp) return false;
    if (!t) return true;
    const ip = `${IPS.network}.${h.n}`;
    return [h.hostname, h.note, ip, h.rdp ? "rdp " + h.rdp : ""].join(" ").toLowerCase().includes(t);
  });
  const ro = editMode() ? "" : "readonly";
  $("#stats").textContent = `${rows.length} de ${IPS.hosts.length} IPs`;

  const adm = editMode();
  content.innerHTML = `
    <div class="ip-count">
      <span>Faixa <b>${esc(IPS.network)}.0/24</b> — ${IPS.hosts.filter(h=>h.hostname).length} nomeados${adm ? " · clique para editar nome/observação" : ""}</span>
      <div class="ip-actions">
        <span class="chip ${ipOnlyRdp ? "active" : ""}" id="ipRdpFilter" title="Mostrar só os IPs com RDP configurado">
          <span>🖥️ Só com RDP</span><span class="count">${IPS.hosts.filter((h) => h.rdp).length}</span></span>
        ${adm ? `<button id="ipAddBtn" class="btn-primary">➕ Adicionar IP</button>` : ""}
      </div>
    </div>
    <div class="ip-table-wrap">
      <table class="ip-table">
        <thead><tr><th class="st">•</th><th>IP</th><th>Host / Equipamento</th><th>Observação</th><th>RDP</th>${adm ? "<th></th>" : ""}</tr></thead>
        <tbody>
          ${rows.map((h) => {
            const st = ipStatus[h.n]?.state || "";
            return `<tr data-n="${h.n}">
              <td class="st"><span class="status-dot ${st}" title="${st || "—"}"></span></td>
              <td class="ip-col">${esc(IPS.network)}.${h.n}</td>
              <td><input class="h-host ${h.hostname ? "" : "empty-host"}" value="${esc(h.hostname)}" placeholder="— livre —" ${ro} data-n="${h.n}" /></td>
              <td><input class="h-note" value="${esc(h.note || "")}" placeholder="${adm ? "adicionar observação" : ""}" ${ro} data-n="${h.n}" /></td>
              <td class="rdp-col">
                ${adm ? `<input type="checkbox" class="h-rdp" data-n="${h.n}" ${h.rdp ? "checked" : ""}
                           title="Marcar = este IP tem RDP (usa ${esc(IPS.network)}.${h.n})" />` : ""}
                ${h.rdp ? rdpButtonHTML(h.rdp) : ""}
              </td>
              ${adm ? `<td class="st"><button class="icon-btn del" title="Excluir IP" data-ipdel="${h.n}">🗑</button></td>` : ""}
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>`;

  $("#ipRdpFilter").addEventListener("click", () => { ipOnlyRdp = !ipOnlyRdp; renderIps(); });

  if (adm) {
    content.querySelectorAll(".ip-table input").forEach((inp) => {
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") inp.blur(); });
      inp.addEventListener("change", () => saveIpField(inp));
    });
    content.querySelectorAll("[data-ipdel]").forEach((b) =>
      b.addEventListener("click", () => deleteIp(Number(b.dataset.ipdel))));
    $("#ipAddBtn").addEventListener("click", openIpModal);
  }
  checkIpsStatus();
}

async function saveIpField(inp) {
  const n = Number(inp.dataset.n);
  const field = inp.classList.contains("h-host") ? "hostname" : inp.classList.contains("h-rdp") ? "rdp" : "note";
  const host = IPS.hosts.find((h) => h.n === n) || { n, hostname: "", note: "" };

  if (field === "rdp") {
    // caixa marcada = RDP no próprio IP da linha; desmarcada = sem RDP
    const v = inp.checked ? `${IPS.network}.${n}` : "";
    try {
      await api("/api/ips/" + n, { method: "PUT", body: JSON.stringify({ rdp: v }) });
      if (v) host.rdp = v; else delete host.rdp;
      if (!IPS.hosts.includes(host)) IPS.hosts.push(host);
      renderIps(); // mostra/oculta o botão RDP da linha
    } catch (e) { alert("Falha ao salvar: " + e.message); inp.checked = !!host.rdp; }
    return;
  }

  host[field] = inp.value;
  if (!IPS.hosts.includes(host)) IPS.hosts.push(host);
  try { await api("/api/ips/" + n, { method: "PUT", body: JSON.stringify({ [field]: inp.value }) }); }
  catch (e) { alert("Falha ao salvar: " + e.message); }
}

function openIpModal() {
  $("#ip-n").value = ""; $("#ip-host").value = ""; $("#ip-note").value = ""; $("#ip-rdp").checked = false;
  $("#ipError").classList.add("hidden");
  showModal("ipModal");
  $("#ip-n").focus();
}

$("#ipSubmit").addEventListener("click", async () => {
  const n = Number($("#ip-n").value);
  if (!Number.isInteger(n) || n < 1 || n > 254) {
    const el = $("#ipError"); el.textContent = "Informe um número de 1 a 254."; el.classList.remove("hidden"); return;
  }
  const rdp = $("#ip-rdp").checked ? `${IPS.network}.${n}` : ""; // caixa marcada = RDP no próprio IP
  try {
    await api("/api/ips", { method: "POST", body: JSON.stringify({
      n, hostname: $("#ip-host").value.trim(), note: $("#ip-note").value.trim(), rdp,
    }) });
    hideModals();
    await loadIpsData();
    render();
  } catch (e) {
    const el = $("#ipError"); el.textContent = e.message; el.classList.remove("hidden");
  }
});

async function deleteIp(n) {
  if (!confirm(`Excluir o IP ${IPS.network}.${n} do inventário?`)) return;
  try {
    await api("/api/ips/" + n, { method: "DELETE" });
    await loadIpsData();
    render();
  } catch (e) { alert(e.message); }
}

async function checkIpsStatus() {
  if (!authed || mode !== "ips") return;
  const fresh = Object.values(ipStatus)[0];
  if (fresh && Date.now() - fresh.ts < STATUS_TTL) { applyIpStatus(); return; }
  try {
    const map = await api("/api/ips/status");
    const ts = Date.now();
    Object.entries(map).forEach(([n, state]) => { ipStatus[n] = { state, ts }; });
    applyIpStatus();
  } catch { /* silencioso */ }
}

function applyIpStatus() {
  document.querySelectorAll(".ip-table tr[data-n]").forEach((tr) => {
    const dot = tr.querySelector(".status-dot");
    const c = ipStatus[tr.dataset.n];
    if (dot && c) { dot.className = "status-dot " + c.state; dot.title = c.state; }
  });
}

// Alternância entre Dispositivos e Inventário
document.querySelectorAll(".mode-toggle button").forEach((b) =>
  b.addEventListener("click", async () => {
    mode = b.dataset.mode;
    document.querySelectorAll(".mode-toggle button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    document.body.classList.remove("mode-ips", "mode-dash", "mode-links");
    if (mode === "ips") document.body.classList.add("mode-ips");
    if (mode === "dash") document.body.classList.add("mode-dash");
    if (mode === "links") document.body.classList.add("mode-links");
    if (mode === "ips" && !IPS.hosts.length) await loadIpsData();
    if (mode === "dash") await loadDashData();
    render();
  }));

// ---------- Login / sessão ----------
function editMode() { return document.body.classList.contains("admin"); }

function setAuthed(on) {
  document.body.classList.toggle("authed", on);
  if (!on) setEdit(false); // ao sair, desliga o modo de edição
}

function setEdit(on) {
  document.body.classList.toggle("admin", on);
  const btn = $("#editBtn");
  btn.classList.toggle("on", on);
  btn.textContent = on ? "✅ Editando" : "🔧 Admin";
}

// Botão Admin (liga/desliga o modo de edição — sem pedir senha)
$("#editBtn").addEventListener("click", () => { setEdit(!editMode()); render(); });

// Botão Sair (encerra a sessão)
$("#logoutBtn").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST" }); } catch {}
  authed = false;
  setAuthed(false);
  $("#gatePassword").value = "";
  $("#gateUser").focus();
});

function showGateError(msg) {
  const el = $("#gateError");
  el.textContent = msg; el.classList.remove("hidden");
}

// Login pela tela de entrada (usuário e senha, conferidos pelo servidor: LDAP e/ou usuários locais)
$("#gateForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#gateSubmit");
  btn.disabled = true;
  try {
    const r = await api("/api/login", { method: "POST", body: JSON.stringify({
      usuario: $("#gateUser").value.trim(), senha: $("#gatePassword").value, lembrar: $("#gateRemember").checked }) });
    $("#gateError").classList.add("hidden");
    $("#gatePassword").value = "";
    authed = true;
    $("#userName").textContent = r.nome || r.usuario;
    setAuthed(true);
    await loadData();
  } catch (err) {
    $("#gatePassword").value = "";
    showGateError(err.message);
  } finally {
    btn.disabled = false;
  }
});

// ---------- Admin: CRUD link ----------
function openLinkModal(id, presetCategory) {
  editingId = id;
  const sel = $("#f-category");
  sel.innerHTML = DATA.categories.map((c) => `<option value="${c.id}">${c.icon} ${esc(c.name)}</option>`).join("");
  $("#linkError").classList.add("hidden");
  if (id) {
    const l = DATA.links.find((x) => x.id === id);
    $("#linkModalTitle").textContent = "Editar link";
    $("#f-name").value = l.name || "";
    $("#f-url").value = l.url || "";
    $("#f-category").value = l.category || DATA.categories[0]?.id;
    $("#f-icon").value = l.icon || "";
    $("#f-description").value = l.description || "";
    $("#f-tags").value = (l.tags || []).join(", ");
    $("#f-rdp").value = l.rdp || "";
  } else {
    $("#linkModalTitle").textContent = "Novo link";
    $("#f-name").value = ""; $("#f-url").value = "";
    $("#f-category").value = presetCategory || DATA.categories[0]?.id;
    $("#f-icon").value = ""; $("#f-description").value = ""; $("#f-tags").value = "";
    $("#f-rdp").value = "";
  }
  showModal("linkModal");
  $("#f-name").focus();
}

$("#linkSubmit").addEventListener("click", async () => {
  const payload = {
    name: $("#f-name").value.trim(),
    url: $("#f-url").value.trim(),
    category: $("#f-category").value,
    icon: $("#f-icon").value.trim(),
    description: $("#f-description").value.trim(),
    tags: $("#f-tags").value.split(",").map((t) => t.trim()).filter(Boolean),
    rdp: $("#f-rdp").value.trim(), // vazio = sem botão RDP
  };
  if (!payload.name || !payload.url) {
    const el = $("#linkError"); el.textContent = "Nome e URL são obrigatórios."; el.classList.remove("hidden"); return;
  }
  if (payload.rdp && !rdpHostOk(payload.rdp)) {
    const el = $("#linkError"); el.textContent = "RDP inválido: use IP ou hostname (sem espaços), porta opcional (ex.: 192.0.2.26 ou srv01:3390)."; el.classList.remove("hidden"); return;
  }
  try {
    if (editingId) await api("/api/links/" + editingId, { method: "PUT", body: JSON.stringify(payload) });
    else await api("/api/links", { method: "POST", body: JSON.stringify(payload) });
    hideModals(); await loadData();
  } catch (e) {
    const el = $("#linkError"); el.textContent = e.message; el.classList.remove("hidden");
  }
});

async function deleteLink(id) {
  const l = DATA.links.find((x) => x.id === id);
  if (!confirm(`Excluir o link "${l?.name}"?`)) return;
  try { await api("/api/links/" + id, { method: "DELETE" }); await loadData(); }
  catch (e) { alert(e.message); }
}

// ---------- Admin: gerenciar categorias ----------
$("#catBtn").addEventListener("click", () => { renderCatList(); $("#catError").classList.add("hidden"); showModal("catModal"); });

function renderCatList() {
  const counts = {};
  DATA.links.forEach((l) => (counts[l.category] = (counts[l.category] || 0) + 1));
  const list = $("#catList");
  list.innerHTML = DATA.categories.map((c) => {
    const n = counts[c.id] || 0;
    return `<div class="cat-row" data-id="${c.id}">
      <span class="swatch" style="background:${c.color}"></span>
      <input class="ic" type="text" maxlength="2" value="${esc(c.icon)}" title="Ícone" />
      <input type="text" value="${esc(c.name)}" title="Nome" />
      <input type="color" value="${toHex(c.color)}" title="Cor" />
      <span class="rcount">${n} link${n === 1 ? "" : "s"}</span>
      <button class="icon-btn save" title="Salvar" data-save="${c.id}">💾</button>
      <button class="icon-btn del" title="Excluir" data-cdel="${c.id}">🗑</button>
    </div>`;
  }).join("") || `<p class="muted">Nenhuma categoria.</p>`;

  list.querySelectorAll("[data-save]").forEach((b) =>
    b.addEventListener("click", () => saveCat(b.dataset.save)));
  list.querySelectorAll("[data-cdel]").forEach((b) =>
    b.addEventListener("click", () => deleteCat(b.dataset.cdel)));
}

function toHex(color) {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  return "#1d4ed8";
}

async function saveCat(id) {
  const row = $(`.cat-row[data-id="${id}"]`);
  const [icon, name] = row.querySelectorAll('input[type="text"]');
  const color = row.querySelector('input[type="color"]').value;
  try {
    await api("/api/categories/" + id, {
      method: "PUT",
      body: JSON.stringify({ icon: icon.value || "📁", name: name.value.trim(), color }),
    });
    await loadData(); renderCatList();
  } catch (e) { showCatError(e.message); }
}

async function deleteCat(id) {
  const c = catById(id);
  if (!confirm(`Excluir a categoria "${c?.name}"?`)) return;
  try { await api("/api/categories/" + id, { method: "DELETE" }); await loadData(); renderCatList(); }
  catch (e) { showCatError(e.message); }
}

$("#catAdd").addEventListener("click", async () => {
  const name = $("#c-name").value.trim();
  if (!name) return showCatError("Informe o nome da categoria.");
  try {
    await api("/api/categories", {
      method: "POST",
      body: JSON.stringify({ name, icon: $("#c-icon").value || "📁", color: $("#c-color").value }),
    });
    $("#c-name").value = ""; $("#c-icon").value = "";
    await loadData(); renderCatList();
  } catch (e) { showCatError(e.message); }
});

function showCatError(msg) { const el = $("#catError"); el.textContent = msg; el.classList.remove("hidden"); }

// ---------- Modais utilidades ----------
function showModal(id) { $("#" + id).classList.remove("hidden"); }
function hideModals() { document.querySelectorAll(".modal").forEach((m) => m.classList.add("hidden")); }
document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", hideModals));
document.querySelectorAll(".modal").forEach((m) =>
  m.addEventListener("click", (e) => { if (e.target === m) hideModals(); }));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideModals(); });

// ---------- Busca e view ----------
$("#search").addEventListener("input", (e) => { searchTerm = e.target.value; render(); });
document.body.dataset.view = view;

// ---------- Init ----------
(async function init() {
  try { CONFIG = { ...CONFIG, ...(await (await fetch("/api/config")).json()) }; } catch { /* segue com o padrão */ }
  const marca = CONFIG.org ? `${CONFIG.org} · InfraHub` : "InfraHub";
  document.title = marca;
  $("#loginNome").textContent = marca;
  $("#topNome").textContent = marca;
  if (!CONFIG.kuma) document.querySelector('.mode-toggle [data-mode="links"]')?.remove(); // sem Uptime Kuma configurado
  try {
    const me = await api("/api/me");
    authed = true;
    $("#userName").textContent = me.nome || me.usuario;
    setAuthed(true);
    await loadData();
  } catch {
    authed = false;
    setAuthed(false);
  }
  setInterval(() => {
    if (mode === "ips") checkIpsStatus();
    else if (mode === "links") renderLinks();
    else if (mode === "cards") checkVisibleStatus();
  }, STATUS_TTL);
})();
