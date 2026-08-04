(function () {
  const CHAVE = "multi_ph_senha";
  let senha = sessionStorage.getItem(CHAVE) || "";

  const originalFetch = window.fetch;

  async function tentarLogin(mostrarErro) {
    return new Promise(resolve => {
      let overlay = document.getElementById("authOverlay");
      if (overlay) { overlay.remove(); }
      overlay = document.createElement("div");
      overlay.id = "authOverlay";
      overlay.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(4,8,18,0.92);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);";
      overlay.innerHTML = `
        <div style="background:#111C31;border:1px solid #1F2C45;border-radius:16px;padding:30px 34px;max-width:360px;width:90%;text-align:center">
          <div style="font-size:40px;margin-bottom:8px">🔒</div>
          <h2 style="color:#F3F7FA;margin:0 0 4px;font-size:22px">Multi PH</h2>
          <p style="color:#A9BAC9;font-size:13px;margin:0 0 18px">Área restrita. Digite a senha para acessar.</p>
          <input id="authInput" type="password" placeholder="Senha" autocomplete="current-password"
            style="width:100%;padding:12px;border-radius:10px;border:1px solid #1F2C45;background:#0B1220;color:#F3F7FA;font-size:15px;outline:none;margin-bottom:12px">
          <div id="authErro" style="color:#F87171;font-size:12px;min-height:16px;margin-bottom:8px"></div>
          <button id="authBtn" style="width:100%;padding:12px;border:none;border-radius:10px;background:#8B5CF6;color:#fff;font-weight:800;font-size:15px;cursor:pointer">Entrar</button>
        </div>`;
      document.body.appendChild(overlay);

      const input = document.getElementById("authInput");
      const btn = document.getElementById("authBtn");
      const erro = document.getElementById("authErro");

      if (mostrarErro) erro.textContent = "Senha incorreta. Tente de novo.";

      function enviar() {
        const tentativa = input.value;
        if (!tentativa) { erro.textContent = "Digite a senha."; return; }
        btn.disabled = true;
        btn.textContent = "Entrando...";
        originalFetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ senha: tentativa })
        }).then(r => {
          if (r.status === 200) {
            senha = tentativa;
            sessionStorage.setItem(CHAVE, senha);
            overlay.remove();
            resolve(true);
          } else {
            btn.disabled = false;
            btn.textContent = "Entrar";
            erro.textContent = "Senha incorreta. Tente de novo.";
          }
        }).catch(() => {
          btn.disabled = false;
          btn.textContent = "Entrar";
          erro.textContent = "Erro de conexão. Tente novamente.";
        });
      }

      btn.addEventListener("click", enviar);
      input.addEventListener("keydown", e => { if (e.key === "Enter") enviar(); });
      input.focus();
    });
  }

  window.fetch = function (url, opcoes) {
    opcoes = opcoes || {};
    opcoes.headers = Object.assign({}, opcoes.headers);
    if (senha) opcoes.headers["x-senha"] = senha;
    return originalFetch(url, opcoes).then(async r => {
      if (r.status === 401) {
        if (senha) {
          sessionStorage.removeItem(CHAVE);
          senha = "";
        }
        const ok = await tentarLogin(true);
        if (!ok) return r;
        opcoes.headers["x-senha"] = senha;
        const r2 = await originalFetch(url, opcoes);
        return r2;
      }
      return r;
    });
  };

  document.addEventListener("DOMContentLoaded", async () => {
    if (!senha) {
      const ok = await tentarLogin(false);
      if (ok) location.reload();
    }
  });
})();
