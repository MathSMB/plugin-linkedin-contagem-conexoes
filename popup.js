const $ = (id) => document.getElementById(id);
const WEEKDAYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

function fmt(ts) {
  return new Date(ts).toLocaleString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function setBar(el, count, goal) {
  el.style.width = Math.min(100, (count / goal) * 100) + "%";
  el.className = levelFor(count, goal);
}

async function render() {
  const s = await chrome.storage.local.get(["invites", "settings", "limitAlerts", "suggestion", "diagMode", "diagLog", "network", "updateInfo"]);
  const invites = normalizeInvites(s.invites).map((i) => i.ts);
  const settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
  const { todayCount, weekCount, nextSlotAt } = computeStats(invites);

  $("today").textContent = todayCount;
  $("week").textContent = weekCount;
  $("dailyGoalLbl").textContent = settings.dailyGoal;
  $("weeklyGoalLbl").textContent = settings.weeklyGoal;
  if (document.activeElement !== $("dailyGoal")) $("dailyGoal").value = settings.dailyGoal;
  if (document.activeElement !== $("weeklyGoal")) $("weeklyGoal").value = settings.weeklyGoal;
  setBar($("todayBar"), todayCount, settings.dailyGoal);
  setBar($("weekBar"), weekCount, settings.weeklyGoal);

  $("nextSlot").textContent = nextSlotAt
    ? `O convite mais antigo da janela sai dos 7 dias em ${fmt(nextSlotAt)}.`
    : "Nenhum convite nos últimos 7 dias.";

  const st = $("status");
  const leftDay = settings.dailyGoal - todayCount;
  const leftWeek = settings.weeklyGoal - weekCount;
  if (leftWeek <= 0) { st.className = "status over"; st.textContent = "Meta semanal atingida. Espere a janela de 7 dias andar."; }
  else if (leftDay <= 0) { st.className = "status over"; st.textContent = "Meta do dia atingida. Volte amanhã."; }
  else {
    const left = Math.min(leftDay, leftWeek);
    st.className = "status " + (left <= Math.ceil(settings.dailyGoal * 0.2) ? "warn" : "ok");
    st.textContent = `Ainda pode enviar ${left} hoje dentro das suas metas.`;
  }

  // Barras por dia
  const days = $("days");
  days.textContent = "";
  const today = startOfToday();
  const counts = [];
  for (let i = 6; i >= 0; i--) {
    const start = new Date(today); start.setDate(start.getDate() - i);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    counts.push({ d: start, n: invites.filter((t) => t >= start.getTime() && t < end.getTime()).length });
  }
  const max = Math.max(settings.dailyGoal, ...counts.map((c) => c.n));
  for (const c of counts) {
    const col = document.createElement("div"); col.className = "day";
    const b = document.createElement("b"); b.textContent = c.n;
    const bar = document.createElement("i"); bar.style.height = (c.n / max) * 45 + "px";
    if (c.n > settings.dailyGoal) bar.style.background = "var(--over)";
    const lbl = document.createElement("span"); lbl.textContent = WEEKDAYS[c.d.getDay()];
    col.append(b, bar, lbl); days.append(col);
  }

  const alerts = s.limitAlerts || [];
  $("limitBox").hidden = alerts.length === 0;
  if (alerts.length) {
    const a = alerts[alerts.length - 1];
    $("limitInfo").textContent = `Último aviso: ${fmt(a.ts)}, com ${a.weekCount} convites em 7 dias e ${a.todayCount} no dia (${alerts.length} aviso(s) registrados).`;
  }
  const up = s.updateInfo;
  const cur = chrome.runtime.getManifest().version;
  $("updBox").hidden = !(up && up.available && up.latest && up.latest !== cur);
  if (up && up.latest) $("updTitle").textContent = `Nova versão ${up.latest} disponível (você tem a ${cur}).`;
  $("verInfo").textContent = `Versão ${cur}` + (up ? (up.error ? " · não deu para checar atualizações" : up.available ? ` · nova: ${up.latest}` : " · está atualizada") : "");
  const net = networkStats(s.network, settings);
  $("pendBox").hidden = net.pending == null;
  if (net.pending != null) {
    $("pending").textContent = net.pending;
    $("pendingWarnLbl").textContent = net.pendingWarn;
    setBar($("pendBar"), net.pending, net.pendingWarn);
    const p = s.network.pending;
    let t = `Atualizado ${fmt(p.ts)} (${p.source === "auto" ? "lido do LinkedIn" : "digitado"}).`;
    if (net.acceptRate != null) t += ` Taxa de aceite estimada: ${net.acceptRate}%.`;
    if (net.pendingLevel === "over") t = "Muitos pendentes: retire os mais antigos (mais de 3 semanas) em Minha rede > Gerenciar convites > Enviados. " + t;
    $("pendHint").textContent = t;
  }
  $("diagMode").checked = !!s.diagMode;
  const dl = (s.diagLog || []).slice().reverse();
  $("diagList").hidden = $("diagClear").hidden = !s.diagMode || !dl.length;
  $("diagList").textContent = "";
  for (const e of dl.slice(0, 15)) {
    const li = document.createElement("li");
    const v = document.createElement("div"); v.className = "v" + (/CONVITE|LIMITE|capturados/.test(e.verdict) ? " hit" : ""); v.textContent = `${new Date(e.ts).toLocaleTimeString("pt-BR")} · ${e.verdict}`;
    const t = document.createElement("div"); t.className = "t"; t.textContent = `${e.kind}: “${e.text}”`;
    li.append(v, t); $("diagList").append(li);
  }
  const sug = s.suggestion;
  $("sugBox").hidden = !(sug && sug.status === "pending");
  if (sug && sug.status === "pending") {
    $("sugText").textContent = `O aviso apareceu com ${sug.observed} convites em 7 dias. Metas sugeridas, 20% abaixo disso: ${sug.daily} por dia e ${sug.weekly} por semana (hoje: ${settings.dailyGoal} e ${settings.weeklyGoal}).`;
  }
}

async function saveSettings() {
  const dailyGoal = Math.max(1, parseInt($("dailyGoal").value, 10) || DEFAULT_SETTINGS.dailyGoal);
  const weeklyGoal = Math.max(1, parseInt($("weeklyGoal").value, 10) || DEFAULT_SETTINGS.weeklyGoal);
  const cur = (await chrome.storage.local.get("settings")).settings || {};
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...cur, dailyGoal, weeklyGoal } });
}

$("dailyGoal").addEventListener("change", saveSettings);
$("weeklyGoal").addEventListener("change", saveSettings);
$("add").addEventListener("click", () => chrome.runtime.sendMessage({ type: "manual-add" }));
$("remove").addEventListener("click", () => chrome.runtime.sendMessage({ type: "manual-remove" }));
$("bfDate").valueAsDate = new Date();
$("bfAdd").addEventListener("click", async () => {
  const [y, m, d] = ($("bfDate").value || "").split("-").map(Number);
  const n = parseInt($("bfN").value, 10);
  if (!y || !n || n < 1) return;
  const noon = new Date(y, m - 1, d, 12, 0, 0).getTime();
  await chrome.runtime.sendMessage({ type: "manual-backfill", ts: noon, n: Math.min(n, 200) });
  $("bfN").value = "";
});
$("sugApply").addEventListener("click", () => chrome.runtime.sendMessage({ type: "apply-suggestion" }));
$("sugDismiss").addEventListener("click", () => chrome.runtime.sendMessage({ type: "dismiss-suggestion" }));
$("diagMode").addEventListener("change", (e) => chrome.storage.local.set({ diagMode: e.target.checked }));
$("diagClear").addEventListener("click", () => chrome.storage.local.set({ diagLog: [] }));
$("pendOpen").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("history.html#atencao") }));
$("openAlerts").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("history.html#atencao") }));
$("openHistory").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("history.html") }));
chrome.runtime.sendMessage({ type: "check-update" }).catch(() => {});
chrome.storage.onChanged.addListener(render);
render();
