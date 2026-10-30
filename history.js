const $ = (id) => document.getElementById(id);
const state = { network: {}, alerts: [], suggestion: null, settings: null, tab: "convites", period: "month", anchor: new Date(), q: "", company: "", invites: [] };
const NO_COMPANY = "(sem empresa)";

const fmtDate = (ts) => new Date(ts).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
const fmtDay = (d) => d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const companyKey = (c) => (c || "").trim().toLowerCase();

function range() {
  const a = new Date(state.anchor); a.setHours(0, 0, 0, 0);
  if (state.period === "day") { const e = new Date(a); e.setDate(e.getDate() + 1); return [a, e]; }
  if (state.period === "week") {
    const s = new Date(a); s.setDate(s.getDate() - ((s.getDay() + 6) % 7)); // segunda-feira
    const e = new Date(s); e.setDate(e.getDate() + 7); return [s, e];
  }
  if (state.period === "month") { const s = new Date(a.getFullYear(), a.getMonth(), 1); return [s, new Date(a.getFullYear(), a.getMonth() + 1, 1)]; }
  return [new Date(0), new Date(8.64e15)];
}

function periodLabel() {
  const [s, e] = range();
  if (state.period === "day") return s.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" });
  if (state.period === "week") { const last = new Date(e); last.setDate(last.getDate() - 1); return `Semana de ${fmtDay(s)} a ${fmtDay(last)}`; }
  if (state.period === "month") return s.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  return "Todo o histórico";
}

function shift(dir) {
  const a = new Date(state.anchor);
  if (state.period === "day") a.setDate(a.getDate() + dir);
  if (state.period === "week") a.setDate(a.getDate() + 7 * dir);
  if (state.period === "month") a.setMonth(a.getMonth() + dir, 1);
  state.anchor = a; render();
}

function inPeriod() {
  const [s, e] = range();
  return state.invites.filter((i) => i.ts >= s.getTime() && i.ts < e.getTime());
}

function filtered() {
  const q = state.q.trim().toLowerCase();
  return inPeriod().filter((i) => {
    if (state.company) {
      if (state.company === NO_COMPANY ? i.company : companyKey(i.company) !== state.company) return false;
    }
    if (q && ![i.name, i.headline, i.company].some((v) => (v || "").toLowerCase().includes(q))) return false;
    return true;
  }).sort((a, b) => b.ts - a.ts);
}

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}

function renderCompanySelect() {
  const sel = $("companyFilter");
  const names = new Map();
  let none = false;
  for (const i of state.invites) {
    if (i.company) names.set(companyKey(i.company), names.get(companyKey(i.company)) || i.company.trim());
    else none = true;
  }
  const opts = [...names.entries()].sort((a, b) => a[1].localeCompare(b[1], "pt-BR"));
  sel.textContent = "";
  sel.append(el("option", { value: "" }, "Todas as empresas"));
  for (const [k, v] of opts) sel.append(el("option", { value: k }, v));
  if (none) sel.append(el("option", { value: NO_COMPANY }, NO_COMPANY));
  sel.value = state.company;
  if (sel.value !== state.company) { state.company = ""; sel.value = ""; }
}

function renderInvites(list) {
  const tb = $("rows"); tb.textContent = "";
  $("emptyInv").hidden = list.length > 0;
  for (const i of list) {
    const person = el("td", { class: "person" },
      i.name
        ? (i.profileUrl ? el("a", { href: i.profileUrl, target: "_blank", rel: "noopener" }, i.name) : el("span", { class: "nm" }, i.name))
        : el("span", { class: "hl" }, i.source === "manual" || i.source === "antigo" ? "Lançado manualmente (sem nome)" : "Nome não capturado"),
      i.headline ? el("div", { class: "hl" }, i.headline) : null);
    const inp = el("input", { value: i.company || "", placeholder: "adicionar empresa", "aria-label": "Empresa" });
    inp.addEventListener("change", () => chrome.runtime.sendMessage({ type: "update-invite", id: i.id, patch: { company: inp.value } }));
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") inp.blur(); });
    const del = el("button", { class: "del", title: "Excluir do histórico", "aria-label": "Excluir", onclick: () => {
      if (confirm(`Excluir ${i.name || "este convite"} do histórico? Ele também deixa de contar nas metas.`)) chrome.runtime.sendMessage({ type: "delete-invite", id: i.id });
    } }, "✕");
    tb.append(el("tr", {}, el("td", { class: "date" }, fmtDate(i.ts)), person, el("td", { class: "company" }, inp), el("td", {}, del)));
  }
}

function groupCompanies(list) {
  const g = new Map();
  for (const i of list) {
    const k = i.company ? companyKey(i.company) : NO_COMPANY;
    if (!g.has(k)) g.set(k, { key: k, name: i.company ? i.company.trim() : NO_COMPANY, people: [], first: i.ts, last: i.ts });
    const c = g.get(k);
    c.people.push(i); c.first = Math.min(c.first, i.ts); c.last = Math.max(c.last, i.ts);
  }
  return [...g.values()].sort((a, b) => (a.key === NO_COMPANY) - (b.key === NO_COMPANY) || b.people.length - a.people.length || a.name.localeCompare(b.name, "pt-BR"));
}

function renderCompanies(list) {
  const tb = $("companyRows"); tb.textContent = "";
  const groups = groupCompanies(list);
  $("emptyComp").hidden = groups.length > 0;
  for (const c of groups) {
    const names = c.people.map((p) => p.name).filter(Boolean);
    const who = names.slice(0, 6).join(", ") + (names.length > 6 ? ` e mais ${names.length - 6}` : "") + (names.length < c.people.length ? ` (${c.people.length - names.length} sem nome)` : "");
    const btn = el("button", { class: "co-name", onclick: () => { state.company = c.key; switchTab("convites"); } }, c.name);
    const dates = c.first === c.last ? fmtDate(c.first).slice(0, 8) : `${fmtDate(c.first).slice(0, 8)} → ${fmtDate(c.last).slice(0, 8)}`;
    tb.append(el("tr", {}, el("td", {}, btn), el("td", { class: "num" }, String(c.people.length)), el("td", { class: "who" }, who || "—"), el("td", { class: "date" }, dates)));
  }
}

function render() {
  if (!state.settings) return;
  document.querySelectorAll("#period button").forEach((b) => b.classList.toggle("on", b.dataset.p === state.period));
  $("dayInput").hidden = !(state.period === "day" || state.period === "week");
  $("monthInput").hidden = state.period !== "month";
  $("prev").hidden = $("next").hidden = $("todayBtn").hidden = state.period === "all";
  $("dayInput").value = ymd(state.anchor);
  $("monthInput").value = ymd(state.anchor).slice(0, 7);
  $("periodLabel").textContent = periodLabel();
  renderCompanySelect();

  const list = filtered();
  const companies = new Set(list.filter((i) => i.company).map((i) => companyKey(i.company)));
  $("summary").innerHTML = "";
  $("summary").append(el("b", {}, String(list.length)), list.length === 1 ? " convite" : " convites",
    " · ", el("b", {}, String(companies.size)), companies.size === 1 ? " empresa" : " empresas", ` · ${periodLabel()}`);

  const att = state.tab === "atencao";
  document.querySelector(".filters").hidden = att;
  $("summary").hidden = att;
  $("csv").hidden = att;
  if (state.tab === "convites") renderInvites(list);
  else if (state.tab === "empresas") renderCompanies(list);
  else renderAlerts();
  const pend = state.suggestion && state.suggestion.status === "pending";
  $("alertBadge").hidden = !pend && !state.alerts.length;
  $("alertBadge").textContent = String(state.alerts.length);
  $("alertBadge").style.background = pend ? "#915907" : "rgba(0,0,0,.45)";
}

function renderAlerts() {
  const st = state.settings;
  const sug = state.suggestion;
  if (document.activeElement !== $("gDaily")) $("gDaily").value = st.dailyGoal;
  if (document.activeElement !== $("gWeekly")) $("gWeekly").value = st.weeklyGoal;
  if (!$("maTs").value) {
    const n = new Date(); n.setMinutes(n.getMinutes() - n.getTimezoneOffset());
    $("maTs").value = n.toISOString().slice(0, 16);
  }

  $("learnText").textContent = !state.alerts.length
    ? "O LinkedIn não diz qual é o seu limite. Cada vez que ele mostrar o aviso de limite, a extensão anota quantos convites você tinha mandado no dia e nos 7 dias anteriores. Com isso ela estima o seu limite real e sugere metas 20% abaixo."
    : `${state.alerts.length} aviso(s) registrados. O menor volume em 7 dias que já gerou aviso foi ${sug ? sug.observed : "—"} convites. Esse é o limite observado, e as metas sugeridas ficam 20% abaixo dele.`;

  const area = $("sugArea"); area.textContent = "";
  if (sug) {
    const applied = st.dailyGoal === sug.daily && st.weeklyGoal === sug.weekly;
    const box = el("div", { class: "sug" + (applied ? " applied" : "") },
      el("div", {}, applied ? "Metas sugeridas em uso: " : "Sugestão: ", el("b", {}, `${sug.daily} por dia · ${sug.weekly} por semana`),
        applied ? "" : ` (atual: ${st.dailyGoal} e ${st.weeklyGoal})`));
    if (!applied) box.append(el("button", { class: "solid", onclick: () => chrome.runtime.sendMessage({ type: "apply-suggestion" }) }, "Aplicar sugestão"));
    area.append(box);
  }

  const net = networkStats(state.network, st);
  const at = (x) => x ? `${x.source === "auto" ? "lido" : "digitado"} em ${new Date(x.ts).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}` : "ainda não lido";
  $("nPend").textContent = net.pending ?? "—"; $("nPend").className = net.pendingLevel || "";
  $("nPendAt").textContent = at(state.network.pending) + ` · alerta em ${net.pendingWarn}`;
  $("nConn").textContent = net.conns ?? "—"; $("nConnAt").textContent = at(state.network.connections);
  $("nAcc").textContent = net.accepted ?? "—";
  $("nRate").textContent = net.acceptRate != null ? net.acceptRate + "%" : "—";
  const focus = document.activeElement && document.activeElement.closest(".goals");
  if (!focus) {
    $("iPend").value = net.pending ?? ""; $("iConn").value = net.conns ?? "";
    $("iBase").value = st.connectionsBaseline ?? ""; $("iWarn").value = net.pendingWarn;
  }

  const tb = $("alertRows"); tb.textContent = "";
  $("emptyAlert").hidden = state.alerts.length > 0;
  for (const a of [...state.alerts].reverse()) {
    const max = Math.max(1, ...a.perDay.map((d) => d.n));
    const mini = el("div", { class: "mini" });
    for (const d of a.perDay) {
      const i = el("i", { title: `${new Date(d.day).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" })}: ${d.n}` });
      i.style.height = (d.n / max) * 30 + 1 + "px";
      if (d.n === a.maxDay && d.n > 0) i.className = "hot";
      mini.append(i);
    }
    const when = el("td", {}, new Date(a.ts).toLocaleString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }),
      a.manual ? el("span", { class: "manual-tag" }, "manual") : null);
    const del = el("button", { class: "del", title: "Excluir aviso", onclick: () => { if (confirm("Excluir este aviso? A sugestão de metas será recalculada.")) chrome.runtime.sendMessage({ type: "delete-alert", id: a.id }); } }, "✕");
    tb.append(el("tr", {}, when, el("td", { class: "num" }, String(a.todayCount)), el("td", { class: "num" }, el("b", {}, String(a.weekCount))),
      el("td", { class: "num" }, `${a.avgPerActiveDay} (${a.activeDays} dias)`), el("td", {}, mini), el("td", {}, del)));
  }
}

function switchTab(t) {
  state.tab = t;
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
  $("tab-convites").hidden = t !== "convites";
  $("tab-empresas").hidden = t !== "empresas";
  $("tab-atencao").hidden = t !== "atencao";
  render();
}

function exportCsv() {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["data", "nome", "titulo", "empresa", "perfil"]].concat(
    filtered().map((i) => [new Date(i.ts).toLocaleString("pt-BR"), i.name, i.headline, i.company, i.profileUrl]));
  const blob = new Blob(["﻿" + rows.map((r) => r.map(esc).join(";")).join("\n")], { type: "text/csv;charset=utf-8" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `convites-linkedin-${ymd(new Date())}.csv` });
  document.body.append(a); a.click(); a.remove();
}

async function load() {
  const s = await chrome.storage.local.get(["invites", "limitAlerts", "suggestion", "settings", "network"]);
  state.network = s.network || {};
  state.invites = normalizeInvites(s.invites);
  state.alerts = s.limitAlerts || [];
  state.suggestion = s.suggestion || null;
  state.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
  render();
}

document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
document.querySelectorAll("#period button").forEach((b) => b.addEventListener("click", () => { state.period = b.dataset.p; render(); }));
$("prev").addEventListener("click", () => shift(-1));
$("next").addEventListener("click", () => shift(1));
$("todayBtn").addEventListener("click", () => { state.anchor = new Date(); render(); });
$("dayInput").addEventListener("change", (e) => { if (e.target.value) { const [y, m, d] = e.target.value.split("-").map(Number); state.anchor = new Date(y, m - 1, d); render(); } });
$("monthInput").addEventListener("change", (e) => { if (e.target.value) { const [y, m] = e.target.value.split("-").map(Number); state.anchor = new Date(y, m - 1, 1); render(); } });
$("q").addEventListener("input", (e) => { state.q = e.target.value; render(); });
$("companyFilter").addEventListener("change", (e) => { state.company = e.target.value; render(); });
$("csv").addEventListener("click", exportCsv);

// Backup: um JSON com tudo que a extensão guarda.
$("backup").addEventListener("click", async () => {
  const all = await chrome.storage.local.get(["invites", "settings", "limitAlerts", "suggestion", "network"]);
  const blob = new Blob([JSON.stringify({ app: "linkedin-contagem-conexoes", version: 1, exportedAt: new Date().toISOString(), ...all }, null, 2)], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `backup-convites-linkedin-${ymd(new Date())}.json` });
  document.body.append(a); a.click(); a.remove();
});
$("restoreBtn").addEventListener("click", () => $("restoreFile").click());
$("restoreFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!Array.isArray(data.invites)) throw new Error("arquivo sem convites");
    const cur = normalizeInvites((await chrome.storage.local.get("invites")).invites);
    // Junta com o que já existe, sem duplicar (mesmo id, ou mesma pessoa no mesmo minuto).
    const key = (i) => i.id + "|" + (i.name || "") + "|" + Math.floor(i.ts / 60000);
    const seen = new Set(cur.map(key));
    const merged = cur.concat(normalizeInvites(data.invites).filter((i) => !seen.has(key(i)))).sort((a, b) => a.ts - b.ts);
    const added = merged.length - cur.length;
    const patch = { invites: merged };
    if (data.settings) patch.settings = data.settings;
    if (Array.isArray(data.limitAlerts)) {
      const curA = (await chrome.storage.local.get("limitAlerts")).limitAlerts || [];
      const ids = new Set(curA.map((a) => a.id));
      patch.limitAlerts = curA.concat(data.limitAlerts.filter((a) => !ids.has(a.id))).sort((a, b) => a.ts - b.ts);
      const sg = suggestFromAlerts(patch.limitAlerts);
      if (sg) patch.suggestion = { ...sg, createdAt: Date.now(), status: "pending" };
    }
    await chrome.storage.local.set(patch);
    alert(`Backup restaurado: ${added} convite(s) adicionados. Total agora: ${merged.length}.`);
  } catch (err) {
    alert("Não consegui ler esse arquivo de backup: " + err.message);
  }
});
$("gSave").addEventListener("click", async () => {
  const dailyGoal = Math.max(1, parseInt($("gDaily").value, 10) || state.settings.dailyGoal);
  const weeklyGoal = Math.max(1, parseInt($("gWeekly").value, 10) || state.settings.weeklyGoal);
  await chrome.storage.local.set({ settings: { ...state.settings, dailyGoal, weeklyGoal } });
  $("gSaved").hidden = false; setTimeout(() => ($("gSaved").hidden = true), 1500);
});
$("netSave").addEventListener("click", async () => {
  const num = (id) => { const v = $(id).value.trim(); return v === "" ? null : Math.max(0, parseInt(v, 10)); };
  const p = num("iPend"), c = num("iConn"), b = num("iBase"), w = num("iWarn");
  if (p != null && p !== state.network.pending?.n) await chrome.runtime.sendMessage({ type: "network", kind: "pending", n: p, source: "manual" });
  if (c != null && c !== state.network.connections?.n) await chrome.runtime.sendMessage({ type: "network", kind: "connections", n: c, source: "manual" });
  await chrome.storage.local.set({ settings: { ...state.settings, connectionsBaseline: b, pendingWarn: w || DEFAULT_SETTINGS.pendingWarn } });
  $("netSaved").hidden = false; setTimeout(() => ($("netSaved").hidden = true), 1500);
});
$("maAdd").addEventListener("click", async () => {
  const v = $("maTs").value; if (!v) return;
  const ts = new Date(v).getTime();
  await chrome.runtime.sendMessage({ type: "manual-alert", ts });
});
if (location.hash === "#atencao") switchTab("atencao");

chrome.storage.onChanged.addListener((c) => {
  if (!c.invites && !c.limitAlerts && !c.suggestion && !c.settings && !c.network) return;
  // Não redesenha enquanto o usuário edita uma empresa.
  if (document.activeElement && document.activeElement.closest(".company")) return;
  load();
});
load();
