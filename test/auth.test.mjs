import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  USUARIO_RE, Limitador, autenticarLdap, carregarSegredo, criarToken, emGrupo, escaparRdn, gerarHashSenha, lerCookie, lerToken,
  lerUsuariosLocais, origemOk, verificarSenhaLocal,
} from "../auth.js";

const SEGREDO = "x".repeat(40);

test("token: ida e volta, com os dados da sessão", () => {
  const t = criarToken(SEGREDO, "ana.silva", "Ana Silva", 1000, 1000);
  assert.deepEqual(lerToken(SEGREDO, t, 900, 28800, 1100), { u: "ana.silva", n: "Ana Silva", i: 1000, l: 1000 });
});

test("token: recusa assinatura errada, adulterado e lixo", () => {
  const t = criarToken(SEGREDO, "ana", "Ana", 1000, 1000);
  assert.equal(lerToken("y".repeat(40), t, 900, 28800, 1100), null);
  const [corpo, ass] = t.split(".");
  const falso = Buffer.from(JSON.stringify({ u: "root", n: "x", i: 1000, l: 1000 })).toString("base64url");
  assert.equal(lerToken(SEGREDO, `${falso}.${ass}`, 900, 28800, 1100), null);
  assert.equal(lerToken(SEGREDO, corpo, 900, 28800, 1100), null);
  for (const lixo of ["", "abc", ".", "a.b.c", undefined, null]) assert.equal(lerToken(SEGREDO, lixo, 900, 28800, 1100), null);
});

test("token: expira por inatividade (15 min) e por vida máxima (8 h)", () => {
  const t = criarToken(SEGREDO, "ana", "Ana", 1000, 1000);
  assert.ok(lerToken(SEGREDO, t, 900, 28800, 1900));
  assert.equal(lerToken(SEGREDO, t, 900, 28800, 1901), null);
  const renovado = criarToken(SEGREDO, "ana", "Ana", 1000, 29000);
  assert.ok(lerToken(SEGREDO, renovado, 900, 28800, 29500));
  assert.equal(lerToken(SEGREDO, renovado, 900, 28800, 29801), null); // passou de 8 h desde a emissão
});

test("limitador: bloqueia na 5ª falha e libera depois da janela ou do sucesso", () => {
  const l = new Limitador(5, 300);
  const k = ["i:1.2.3.4", "u:ana"];
  for (let i = 0; i < 4; i++) l.falha(k, 100 + i);
  assert.equal(l.bloqueado(k, 110), false);
  l.falha(k, 104);
  assert.equal(l.bloqueado(k, 110), true);
  assert.equal(l.bloqueado(["u:outro"], 110), false);
  assert.equal(l.bloqueado(k, 405), false); // 300 s depois
  l.falha(k, 500); l.ok(k);
  assert.equal(l.bloqueado(k, 501), false);
});

test("limitador: usuário bloqueado mesmo vindo de IPs diferentes", () => {
  const l = new Limitador(5, 300);
  for (let i = 0; i < 5; i++) l.falha([`i:198.51.100.${i}`, "u:ana"], 100);
  assert.equal(l.bloqueado(["i:203.0.113.9", "u:ana"], 101), true);
});

test("origemOk: mesma origem passa; outra, 'null' sem Referer e Sec-Fetch-Site cruzado não", () => {
  const host = "192.0.2.6:5010";
  assert.equal(origemOk({ origin: `http://${host}`, host }), true);
  assert.equal(origemOk({ origin: "http://evil.example", host }), false);
  assert.equal(origemOk({ origin: "null", referer: `http://${host}/x`, host }), true);
  assert.equal(origemOk({ origin: "null", referer: "http://evil.example/x", host }), false);
  assert.equal(origemOk({ host, "sec-fetch-site": "same-origin" }), true);
  assert.equal(origemOk({ host, "sec-fetch-site": "cross-site" }), false);
  assert.equal(origemOk({ origin: "lixo", host }), false);
});

test("login: só letras, números, ponto, hífen e sublinhado (anti injeção)", () => {
  for (const ok of ["ana.silva", "carlos.medeiros", "a_b-c.9"]) assert.ok(USUARIO_RE.test(ok), ok);
  for (const ruim of ["", "ana,ou=outro", "*)(uid=*", "a\b", "a b", "ana\n", "x".repeat(65), "ana;"]) assert.ok(!USUARIO_RE.test(ruim), ruim);
  assert.equal(escaparRdn("a,b+c"), String.raw`a\,b\+c`);
});

test("login: senha vazia ou usuário inválido nem chegam ao LDAP", async () => {
  const cfgInalcancavel = { host: "127.0.0.1", porta: 1, base: "ou=people,dc=exemplo,dc=com", ca: "nao-existe.crt" };
  assert.deepEqual(await autenticarLdap(cfgInalcancavel, "ana", ""), { ok: false });
  assert.deepEqual(await autenticarLdap(cfgInalcancavel, "ana,ou=x", "senha"), { ok: false });
  assert.deepEqual(await autenticarLdap(cfgInalcancavel, "", "senha"), { ok: false });
});

test("cookie: lê o valor certo entre vários", () => {
  assert.equal(lerCookie("a=1; infrahub_session=abc.def; b=2", "infrahub_session"), "abc.def");
  assert.equal(lerCookie("xinfrahub_session=1", "infrahub_session"), null);
  assert.equal(lerCookie(undefined, "infrahub_session"), null);
});

test("segredo: gera arquivo 600 na 1ª vez e reaproveita; rejeita variável curta", () => {
  const dir = mkdtempSync(join(tmpdir(), "ih-"));
  const arq = join(dir, "sub", ".session-secret");
  const a = carregarSegredo("", arq);
  assert.ok(a.length >= 64 && existsSync(arq));
  assert.equal(carregarSegredo("", arq), a);
  assert.equal(readFileSync(arq, "utf-8").trim(), a);
  assert.equal(carregarSegredo("z".repeat(32), arq), "z".repeat(32));
  assert.throws(() => carregarSegredo("curto", arq));
});

test("grupo: confere o DN do memberOf sem diferenciar maiúsculas nem espaços", () => {
  const g = "cn=ti,ou=groups,dc=exemplo,dc=com";
  assert.equal(emGrupo(["cn=ti,ou=groups,dc=exemplo,dc=com"], g), true);
  assert.equal(emGrupo(["CN=Ti, OU=groups, DC=exemplo, DC=com"], g), true);
  assert.equal(emGrupo(["cn=suporte,ou=groups,dc=exemplo,dc=com", g], g), true);
  assert.equal(emGrupo(["cn=ti2,ou=groups,dc=exemplo,dc=com"], g), false);
  assert.equal(emGrupo(["cn=ti,ou=outro,dc=exemplo,dc=com"], g), false);
  assert.equal(emGrupo([], g), false);
  assert.equal(emGrupo(undefined, g), false);
});

test("lembrar de mim: limites maiores só para token marcado", () => {
  const lem = { idle: 7 * 86400, maxLife: 30 * 86400 };
  const t = criarToken(SEGREDO, "ana", "Ana", 1000, 1000, true);
  assert.ok(lerToken(SEGREDO, t, 900, 28800, 1000 + 5 * 86400, lem));
  assert.equal(lerToken(SEGREDO, t, 900, 28800, 1000 + 8 * 86400, lem), null);
  const normal = criarToken(SEGREDO, "ana", "Ana", 1000, 1000);
  assert.equal(lerToken(SEGREDO, normal, 900, 28800, 1000 + 3600, lem), null);
});

test("usuários locais: hash scrypt confere a senha certa e recusa a errada", async () => {
  const hash = await gerarHashSenha("uma senha longa 123");
  assert.match(hash, /^scrypt\.\d+\.[\w-]+\.[\w-]+$/);
  assert.ok(!hash.includes("$") && !hash.includes("uma senha"));
  assert.equal(await verificarSenhaLocal(hash, "uma senha longa 123"), true);
  assert.equal(await verificarSenhaLocal(hash, "outra senha"), false);
  assert.equal(await verificarSenhaLocal(hash, ""), false);
  assert.equal(await verificarSenhaLocal(null, "qualquer"), false); // usuário inexistente
  assert.notEqual(hash, await gerarHashSenha("uma senha longa 123")); // sal diferente a cada vez
});

test("usuários locais: lê a lista e rejeita registro malformado", async () => {
  const h = await gerarHashSenha("x");
  const mapa = lerUsuariosLocais(`ana.silva:${h}, carlos:${h}`);
  assert.deepEqual([...mapa.keys()], ["ana.silva", "carlos"]);
  assert.equal(lerUsuariosLocais("").size, 0);
  assert.equal(lerUsuariosLocais(undefined).size, 0);
  for (const ruim of ["ana", "ana:senha123", ":scrypt.1.a.b", `ana,ou=x:${h}`, "ana:scrypt.16384.so-sal"])
    assert.throws(() => lerUsuariosLocais(ruim), /LOCAL_USERS/, ruim);
});
