// Gera o hash de uma senha para a variável LOCAL_USERS.
// Uso:  npm run hash-senha -- ana.silva      (pede a senha sem mostrar na tela)
//       npm run hash-senha -- ana.silva --stdin   (lê a senha da entrada padrão; para scripts)
import { gerarHashSenha, USUARIO_RE } from "../auth.js";

const usuario = process.argv[2];
if (!usuario || !USUARIO_RE.test(usuario)) {
  console.error("Uso: npm run hash-senha -- <usuario> [--stdin]\n(usuário: letras, números, ponto, hífen e sublinhado)");
  process.exit(1);
}

function lerStdin() {
  return new Promise((ok) => { let d = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => ok(d.replace(/\r?\n$/, ""))); });
}

function lerSenhaOculta(pergunta) {
  return new Promise((ok) => {
    process.stdout.write(pergunta);
    const stdin = process.stdin;
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding("utf8");
    let senha = "";
    const aoTeclar = (c) => {
      for (const ch of c) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") { stdin.setRawMode(false); stdin.pause(); stdin.off("data", aoTeclar); process.stdout.write("\n"); return ok(senha); }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f" || ch === "\b") senha = senha.slice(0, -1); else senha += ch;
      }
    };
    stdin.on("data", aoTeclar);
  });
}

const senha = process.argv.includes("--stdin") ? await lerStdin() : await lerSenhaOculta(`Senha de ${usuario}: `);
if (senha.length < 10) { console.error("Use uma senha com pelo menos 10 caracteres."); process.exit(1); }
console.log(`\nAdicione ao .env (separe vários usuários por vírgula):\nLOCAL_USERS=${usuario}:${await gerarHashSenha(senha)}`);
