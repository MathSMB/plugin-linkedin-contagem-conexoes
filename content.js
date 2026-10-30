// Só LÊ a página: não clica em nada e não envia nada. Guarda localmente o nome,
// o título e a empresa de quem você convidou, para o seu histórico.
(() => {
  const SENT_RE = [
    /convite\b.*\benviado/i,            // "Convite enviado", "Seu convite para X foi enviado"
    /invitation\b.*\bsent/i,            // "Invitation sent", "Your invitation to X was sent"
    /invitaci[oó]n\b.*\benviada/i,      // espanhol
  ];
  const NOT_SENT_RE = /\b(retirad\w*|withdrawn?|cancelad\w*|aceit\w*|accepted|n[aã]o foi|not sent|couldn.t|erro|error)\b/i;
  const LIMIT_RE = /limite semanal de convites|weekly invitation limit|limite de convites/i;
  const SEND_BTN_RE = /^(enviar|enviar sem nota|enviar agora|send|send now|send without a note|enviar sin nota)$/i;
  const INVITE_DIALOG_RE = /convite|invitation|invitaci/i;

  const TOAST_SELECTOR = [
    ".artdeco-toast-item",
    "[data-test-artdeco-toast-item-type]",
    "[role='alert']",
    "[role='status']",
    "[aria-live]",
  ].join(",");

  const seen = new WeakMap(); // elemento -> último texto já tratado

  function textOf(el) {
    return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg);
    } catch (e) {
      // Extensão recarregada: a aba precisa de F5. Ignora em silêncio.
      return Promise.resolve(null);
    }
  }

  // ---- Contexto do último "Conectar" clicado (nome, título, empresa, perfil) ----
  let lastCtx = null;
  const CONNECT_LABEL_RE = /^(?:Convidar|Invite|Invitar a)\s+(.+?)\s+(?:para se conectar|to connect|a conectar)/i;
  const CONNECT_TEXT_RE = /^(conectar|connect|conectar-se)$/i;
  const NOISE_RE = /^(?:[•·]\s*)?(?:\d+\s*[ºo°]|1st|2nd|3rd\+?|1º|2º|3º\+?)|conex(?:ão|ões) em comum|mutual|^(?:conectar|connect|seguir|follow|mensagem|message|pendente|pending|enviar inmail|premium)$|ver perfil|view .*profile|^status|é uma conexão|seguidores|followers|^\s*[•·]\s*$/i;

  function lines(el) {
    return (el.innerText || "").split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  }

  function cleanName(n) {
    return (n || "").replace(/\s*(?:[•·].*|\(.*\)|,.*)$/, "").replace(/^Ver perfil de\s+|^View\s+/i, "").trim();
  }

  function captureContext(btn, path) {
    const aria = btn.getAttribute("aria-label") || "";
    let name = (aria.match(CONNECT_LABEL_RE) || [])[1] || "";
    let headline = "", company = "", profileUrl = "", current = "";

    if (/^\/in\//.test(location.pathname) && !path.some((n) => n.tagName === "LI")) {
      // Página do perfil
      profileUrl = location.origin + location.pathname.split("/").slice(0, 3).join("/") + "/";
      const h1 = document.querySelector("main h1");
      name = name || (h1 ? h1.innerText.trim() : "");
      const hl = document.querySelector("main .text-body-medium");
      headline = hl ? hl.innerText.trim() : "";
      const cur = document.querySelector("main [aria-label^='Empresa atual'], main [aria-label^='Current company']");
      if (cur) company = cur.getAttribute("aria-label").replace(/^(Empresa atual|Current company)\s*:?\s*/i, "").replace(/\.\s.*$/, "").trim();
    } else {
      // Cartão numa lista (busca, Minha Rede, "pessoas que você talvez conheça")
      let card = null;
      for (const n of path) {
        if (!n.querySelector) continue;
        if (n.querySelector("a[href*='/in/']") && (n.innerText || "").length < 1500) { card = n; }
        if (card && (n.tagName === "LI" || n.matches?.("[data-chameleon-result-urn], [data-view-name*='search-entity'], .artdeco-card"))) { card = n; break; }
        if ((n.innerText || "").length > 1500) break;
      }
      if (card) {
        const a = card.querySelector("a[href*='/in/']");
        if (a) profileUrl = a.href.split("?")[0];
        const ls = lines(card);
        name = name || cleanName(ls[0]);
        const rest = ls.filter((l) => cleanName(l) !== name && !l.startsWith(name) && !NOISE_RE.test(l));
        current = rest.find((l) => /^(Atual|Current)\s*:/i.test(l)) || "";
        headline = rest.find((l) => l !== current && l.length > 3) || "";
      }
    }
    company = company || guessCompany(current, headline);
    lastCtx = { name: cleanName(name), headline, company, profileUrl, at: Date.now() };
  }

  function countInvite(source, toastName) {
    const ctx = lastCtx && Date.now() - lastCtx.at < 90 * 1000 ? lastCtx : null;
    const match = ctx && (!toastName || toastName.toLowerCase() === ctx.name.toLowerCase() || !ctx.name);
    const data = match ? { ...ctx, name: toastName || ctx.name } : { name: toastName || "" };
    send({ type: "invite-sent", ts: Date.now(), source, ...data, at: undefined }).then((r) => {
      if (r) showNotice();
    }).catch(() => {});
  }

  function nameFromToast(txt) {
    const m = txt.match(/convite para (.+?) (?:foi )?enviado/i) ||
      txt.match(/invitation to (.+?) (?:was |has been )?sent/i) ||
      txt.match(/invitaci[oó]n a (.+?) (?:fue |se ha )?enviada/i);
    return m ? m[1].trim() : "";
  }

  // ---- Modo teste: registra tudo o que a extensão lê, para conferir sem mandar convite ----
  let diag = false;
  chrome.storage.local.get("diagMode").then((r) => { diag = !!r.diagMode; }).catch(() => {});
  function diagLog(kind, text, verdict) {
    if (!diag) return;
    send({ type: "diag-log", entry: { ts: Date.now(), kind, text: (text || "").slice(0, 160), verdict, page: location.pathname.slice(0, 60) } })?.catch?.(() => {});
  }

  function checkToast(el) {
    const txt = textOf(el);
    if (!txt || txt.length > 400) return;
    if (seen.get(el) === txt) return;
    seen.set(el, txt);
    if (LIMIT_RE.test(txt)) {
      diagLog("Aviso", txt, "Reconhecido como AVISO DE LIMITE");
      send({ type: "limit-warning", ts: Date.now() })?.catch?.(() => {});
      return;
    }
    if (SENT_RE.some((re) => re.test(txt)) && !NOT_SENT_RE.test(txt)) {
      diagLog("Notificação", txt, "Reconhecido como CONVITE ENVIADO");
      countInvite("toast", nameFromToast(txt));
    } else {
      diagLog("Notificação", txt, "Lida (não é convite, não conta)");
    }
  }

  // Lê os números da própria página do LinkedIn quando você abre:
  // Minha rede > Gerenciar convites > Enviados  -> "Pessoas (79)"
  // Minha rede (painel "Gerenciar minha rede") -> "Conexões 113"
  const lastNet = {};
  function readNetworkNumbers() {
    const path = location.pathname;
    const body = document.body ? document.body.innerText : "";
    const report = (kind, n) => {
      if (!Number.isFinite(n) || lastNet[kind] === n) return;
      lastNet[kind] = n;
      diagLog("Número da rede", `${kind === "pending" ? "Convites enviados pendentes" : "Conexões"}: ${n}`, "Número lido e salvo");
      send({ type: "network", kind, n, source: "auto" })?.catch?.(() => {});
    };
    if (/\/invitation-manager\/sent/.test(path)) {
      const m = body.match(/(?:Pessoas|People|Personas)\s*\((\d[\d.,]*)\)/i);
      if (m) report("pending", parseInt(m[1].replace(/[.,]/g, ""), 10));
    }
    if (/^\/mynetwork\/?($|grow|invitation-manager)/.test(path) || /^\/mynetwork\/?$/.test(path)) {
      const m = body.match(/(?:^|\n)\s*(?:Conexões|Connections|Contactos)\s*\n?\s*(\d[\d.,]*)\s*(?:\n|$)/i);
      if (m) report("connections", parseInt(m[1].replace(/[.,]/g, ""), 10));
    }
  }
  let netTimer;
  function scheduleNetRead() { clearTimeout(netTimer); netTimer = setTimeout(readNetworkNumbers, 800); }

  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    if (root === document.body) scheduleNetRead();
    if (root.matches && root.matches(TOAST_SELECTOR)) checkToast(root);
    root.querySelectorAll(TOAST_SELECTOR).forEach(checkToast);
    // O aviso de limite costuma vir num modal, não num toast.
    root.querySelectorAll("[role='dialog'], .artdeco-modal").forEach((d) => {
      const txt = textOf(d);
      if (!txt) return;
      if (LIMIT_RE.test(txt) && seen.get(d) !== "limit") {
        seen.set(d, "limit");
        diagLog("Janela", txt, "Reconhecido como AVISO DE LIMITE");
        send({ type: "limit-warning", ts: Date.now() })?.catch?.(() => {});
      } else if (diag && !seen.has(d)) {
        seen.set(d, "dialog");
        diagLog("Janela", txt, INVITE_DIALOG_RE.test(txt) ? "Janela de convite lida" : "Janela lida (não conta)");
      }
    });
  }

  // Partes novas do LinkedIn renderizam modais dentro de shadow DOM aberto.
  const observedRoots = new WeakSet();
  function observe(root) {
    if (!root || observedRoots.has(root)) return;
    observedRoots.add(root);
    let pending = false;
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        scan(root);
        findShadowRoots(root);
      }, 300);
    }).observe(root, { childList: true, subtree: true, characterData: true });
    scan(root);
  }
  function findShadowRoots(root) {
    root.querySelectorAll("#interop-outlet, [data-testid='interop-shadowdom']").forEach((h) => {
      if (h.shadowRoot) observe(h.shadowRoot);
    });
  }

  // Plano B: clique em "Enviar"/"Enviar sem nota" dentro do modal de convite.
  // Se o toast também aparecer, o background descarta o duplicado.
  document.addEventListener("click", (e) => {
    const path = e.composedPath ? e.composedPath() : [e.target];
    const btn = path.find((n) => n.tagName === "BUTTON" || (n.getAttribute && n.getAttribute("role") === "button"));
    if (!btn) return;
    const label = (btn.getAttribute("aria-label") || textOf(btn)).trim();
    if (CONNECT_LABEL_RE.test(label) || CONNECT_TEXT_RE.test(textOf(btn))) {
      try { captureContext(btn, path); } catch (err) { console.debug("[contador]", err); }
      if (lastCtx) diagLog("Clique em Conectar", `${lastCtx.name || "?"} · ${lastCtx.company || "empresa não identificada"} · ${lastCtx.headline || ""}`, "Dados da pessoa capturados");
      return;
    }
    if (!SEND_BTN_RE.test(label)) return;
    const dialog = path.find((n) => n.getAttribute && (n.getAttribute("role") === "dialog" || (n.classList && n.classList.contains("artdeco-modal"))));
    if (!dialog || !INVITE_DIALOG_RE.test(textOf(dialog))) return;
    // Espera um pouco: se o LinkedIn bloquear o envio, o toast/aviso aparece em vez disso.
    setTimeout(() => countInvite("click"), 1500);
  }, true);

  // Contador fixo no canto, igual em todas as abas: atualiza sozinho quando
  // qualquer aba conta um convite (chrome.storage.onChanged).
  let pill, flashTimer;
  const LI = {
    blue: "#0a66c2", blueDark: "#004182", text: "rgba(0,0,0,.9)", muted: "rgba(0,0,0,.6)",
    track: "#e8e5df", green: "#057642", amber: "#c37d16", red: "#cc1016",
    font: '-apple-system, system-ui, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Fira Sans", Ubuntu, Oxygen, "Oxygen Sans", Cantarell, "Droid Sans", "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Lucida Grande", Helvetica, Arial, sans-serif',
  };
  const LEVEL_COLOR = { ok: LI.green, warn: LI.amber, over: LI.red };

  function ensurePill() {
    if (pill && pill.isConnected) return pill;
    pill = document.createElement("div");
    pill.id = "ccl-pill";
    pill.title = "Clique para minimizar / expandir";
    Object.assign(pill.style, {
      position: "fixed", right: "16px", bottom: "16px", zIndex: 2147483647,
      font: `14px/1.35 ${LI.font}`, color: LI.text, background: "#fff",
      borderRadius: "8px", overflow: "hidden", width: "280px",
      boxShadow: "0 0 0 1px rgba(140,140,140,.2), 0 4px 16px rgba(0,0,0,.18)",
      cursor: "pointer", userSelect: "none", transition: "transform .2s",
    });
    pill.addEventListener("click", async () => {
      const { pillMin } = await chrome.storage.local.get("pillMin");
      chrome.storage.local.set({ pillMin: !pillMin });
    });
    document.documentElement.appendChild(pill);
    return pill;
  }

  function h(tag, style, text) {
    const e = document.createElement(tag);
    Object.assign(e.style, style);
    if (text != null) e.textContent = text;
    return e;
  }

  function row(label, count, goal) {
    const lvl = levelFor(count, goal);
    const wrap = h("div", { padding: "8px 12px 0" });
    const line = h("div", { display: "flex", alignItems: "baseline", justifyContent: "space-between" });
    line.append(
      h("span", { color: LI.muted, fontSize: "13px" }, label),
      (() => {
        const v = h("span", { fontWeight: "600", fontSize: "16px", color: lvl === "ok" ? LI.text : LEVEL_COLOR[lvl] }, String(count));
        v.append(h("span", { fontWeight: "400", fontSize: "13px", color: LI.muted }, ` / ${goal}`));
        return v;
      })()
    );
    const track = h("div", { height: "4px", background: LI.track, borderRadius: "2px", marginTop: "4px", overflow: "hidden" });
    track.append(h("div", { height: "100%", width: Math.min(100, (count / goal) * 100) + "%", background: lvl === "ok" ? LI.blue : LEVEL_COLOR[lvl] }));
    wrap.append(line, track);
    return wrap;
  }

  async function renderPill(flash) {
    let s;
    try { s = await chrome.storage.local.get(["invites", "settings", "pillMin", "suggestion", "diagMode", "diagLog", "network", "updateInfo"]); } catch { return; }
    diag = !!s.diagMode;
    const settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
    const { todayCount, weekCount } = computeStats(s.invites || []);
    const lvToday = levelFor(todayCount, settings.dailyGoal);
    const lvWeek = levelFor(weekCount, settings.weeklyGoal);
    const over = lvToday === "over" || lvWeek === "over";
    const el = ensurePill();
    el.textContent = "";

    if (s.pillMin) {
      const pend = s.suggestion && s.suggestion.status === "pending";
      Object.assign(el.style, { width: "auto", borderRadius: "20px", background: over ? LI.red : pend ? "#915907" : LI.blue, color: "#fff" });
      el.append(h("div", { padding: "6px 12px", fontWeight: "600", fontSize: "13px" }, `${pend ? "⚠ " : ""}Convites hoje: ${todayCount}/${settings.dailyGoal}`));
    } else {
      Object.assign(el.style, { width: "280px", borderRadius: "8px", background: "#fff", color: LI.text });
      const head = h("div", { background: LI.blue, color: "#fff", padding: "8px 12px", display: "flex", justifyContent: "space-between", alignItems: "center" });
      const title = h("div", {});
      title.append(
        h("div", { fontWeight: "600", fontSize: "14px", whiteSpace: "nowrap" }, "LinkedIn · Contagem de Conexões"),
        h("div", { fontSize: "11px", opacity: ".85" }, "Convites de conexão enviados")
      );
      head.append(title, h("span", { fontSize: "16px", opacity: ".8", marginLeft: "8px" }, "–"));
      el.append(head, row("Hoje", todayCount, settings.dailyGoal), row("Últimos 7 dias", weekCount, settings.weeklyGoal));
      const net = networkStats(s.network, settings);
      if (net.pending != null) el.append(row("Pendentes (sem resposta)", net.pending, net.pendingWarn));
      const netSt = networkStats(s.network, settings);
      const msg = netSt.pendingLevel === "over" ? "Muitos pendentes: retire os mais antigos (+3 semanas)."
        : lvWeek === "over" ? "Meta semanal atingida. Espere a janela andar."
        : lvToday === "over" ? "Meta do dia atingida. Volte amanhã."
        : `Pode enviar mais ${Math.min(settings.dailyGoal - todayCount, settings.weeklyGoal - weekCount)} hoje.`;
      el.append(h("div", { padding: "8px 12px 10px", fontSize: "12px", fontWeight: "600", color: over || netSt.pendingLevel === "over" ? LI.red : LI.green }, msg));
      const up = s.updateInfo;
      if (up && up.available && up.latest !== chrome.runtime.getManifest().version) {
        el.append(h("div", { background: "#eef6f0", borderTop: `1px solid ${LI.green}`, padding: "6px 12px", fontSize: "12px", color: LI.green, fontWeight: "600" },
          `Nova versão ${up.latest} disponível: git pull + recarregar.`));
      }
      if (s.diagMode) {
        const box = h("div", { background: "#f3eefb", borderTop: "1px solid #8344cc", padding: "8px 12px 10px", fontSize: "12px", cursor: "default" });
        box.addEventListener("click", (e) => e.stopPropagation());
        box.append(h("div", { fontWeight: "600", color: "#5f2ba0", marginBottom: "4px" }, "🧪 Modo teste ligado: o que a extensão leu"));
        const log = (s.diagLog || []).slice(-3).reverse();
        if (!log.length) box.append(h("div", { color: LI.muted }, "Nada ainda. Salve uma publicação ou abra \"Começar publicação\"."));
        for (const e of log) {
          const line = h("div", { marginTop: "4px", lineHeight: "1.3" });
          line.append(h("b", { color: /CONVITE|LIMITE|capturados/.test(e.verdict) ? LI.green : LI.text }, e.verdict), h("div", { color: LI.muted }, `${e.kind}: “${e.text.slice(0, 70)}${e.text.length > 70 ? "…" : ""}”`));
          box.append(line);
        }
        el.append(box);
      }
      const sug = s.suggestion;
      if (sug && sug.status === "pending") {
        const box = h("div", { background: "#fdf5e6", borderTop: "1px solid #e7a33e", padding: "8px 12px 10px", fontSize: "12px", color: LI.text, cursor: "default" });
        box.addEventListener("click", (e) => e.stopPropagation());
        box.append(
          h("div", { fontWeight: "600", color: "#915907", marginBottom: "2px" }, "⚠ LinkedIn avisou: perto do limite"),
          h("div", {}, `Aviso com ${sug.observed} convites em 7 dias. Sugestão: ${sug.daily}/dia e ${sug.weekly}/semana.`)
        );
        const btns = h("div", { display: "flex", gap: "6px", marginTop: "6px" });
        const mk = (label, primary, type) => {
          const b = h("button", {
            flex: "1", padding: "4px 8px", borderRadius: "14px", font: `600 12px ${LI.font}`, cursor: "pointer",
            border: `1px solid ${LI.blue}`, background: primary ? LI.blue : "#fff", color: primary ? "#fff" : LI.blue,
          }, label);
          b.addEventListener("click", (e) => { e.stopPropagation(); send({ type })?.catch?.(() => {}); });
          return b;
        };
        btns.append(mk("Aplicar", true, "apply-suggestion"), mk("Agora não", false, "dismiss-suggestion"));
        box.append(btns);
        el.append(box);
      }
    }
    if (flash) {
      el.style.transform = "scale(1.06)";
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => (el.style.transform = "scale(1)"), 400);
    }
  }

  function showNotice() { renderPill(true); }

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.diagMode) diag = !!changes.diagMode.newValue;
    if (changes.invites || changes.settings || changes.pillMin || changes.suggestion || changes.diagMode || changes.diagLog || changes.network || changes.updateInfo) renderPill(!!changes.invites);
  });
  // Virada do dia e convites saindo da janela de 7 dias.
  setInterval(() => renderPill(false), 60 * 1000);
  renderPill(false);

  observe(document.body);
  findShadowRoots(document);
})();
