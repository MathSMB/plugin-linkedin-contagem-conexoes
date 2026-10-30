importScripts("common.js");

const DEDUP_MS = 4000; // o mesmo envio pode ser visto pelo clique e pelo aviso

async function getState() {
  const s = await chrome.storage.local.get(["invites", "settings", "limitWarnings"]);
  return {
    invites: normalizeInvites(s.invites),
    settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) },
    limitWarnings: s.limitWarnings || [],
  };
}

async function updateBadge() {
  const { invites, settings } = await getState();
  const { todayCount, weekCount } = computeStats(invites);
  const lvl = [levelFor(todayCount, settings.dailyGoal), levelFor(weekCount, settings.weeklyGoal)];
  const color = lvl.includes("over") ? "#cc1016" : lvl.includes("warn") ? "#c37d16" : "#0a66c2";
  await chrome.action.setBadgeText({ text: String(todayCount) });
  await chrome.action.setBadgeBackgroundColor({ color });
}

// Fila simples para não perder escrita quando chegam eventos juntos (várias abas).
let queue = Promise.resolve();
function enqueue(fn) {
  const p = queue.then(fn);
  queue = p.catch((e) => console.error("[contador]", e));
  return p;
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const FIELDS = ["name", "headline", "company", "profileUrl"];

async function addInvite(data, skipDedup = false) {
  const { invites, settings } = await getState();
  const ts = data.ts || Date.now();
  const last = invites[invites.length - 1];
  const sameName = !data.name || !last?.name || data.name === last.name;
  if (!skipDedup && last && Math.abs(ts - last.ts) < DEDUP_MS && sameName) {
    // Mesmo envio visto por outro caminho: só completa os dados que faltavam.
    for (const f of FIELDS) if (!last[f] && data[f]) last[f] = data[f];
    await chrome.storage.local.set({ invites });
    return null;
  }
  const inv = { id: newId(), ts, source: data.source || "auto" };
  for (const f of FIELDS) if (data[f]) inv[f] = data[f];
  invites.push(inv);
  await chrome.storage.local.set({ invites });
  return { ...computeStats(invites), settings };
}

// Aviso de limite: tira uma foto da atividade e gera uma sugestão de metas.
async function addLimitAlert(ts, manual = false) {
  const { invites } = await getState();
  const s = await chrome.storage.local.get(["limitAlerts"]);
  const alerts = s.limitAlerts || [];
  // O LinkedIn pode repetir o aviso várias vezes seguidas: 1 registro a cada 12h.
  if (!manual && alerts.some((a) => Math.abs(ts - a.ts) < 12 * 60 * 60 * 1000)) return null;
  const alert = { id: newId(), ts, manual, ...snapshotAt(invites, ts) };
  alerts.push(alert);
  alerts.sort((a, b) => a.ts - b.ts);
  const sug = suggestFromAlerts(alerts);
  await chrome.storage.local.set({
    limitAlerts: alerts,
    suggestion: sug ? { ...sug, alertId: alert.id, createdAt: Date.now(), status: "pending" } : null,
  });
  return alert;
}

async function recomputeSuggestion(keepStatus) {
  const s = await chrome.storage.local.get(["limitAlerts", "suggestion"]);
  const sug = suggestFromAlerts(s.limitAlerts);
  const prev = s.suggestion;
  const same = prev && sug && prev.weekly === sug.weekly && prev.daily === sug.daily;
  await chrome.storage.local.set({
    suggestion: sug ? { ...sug, createdAt: Date.now(), status: same && keepStatus ? prev.status : "pending" } : null,
  });
}

const handlers = {
  "invite-sent": (m) => addInvite(m),
  "network": async (m) => {
    // m.kind = "pending" | "connections", m.n = número lido na página ou digitado
    const { network } = await chrome.storage.local.get("network");
    const cur = network || {};
    const prev = cur[m.kind];
    if (prev && prev.n === m.n && m.source === "auto" && Date.now() - prev.ts < 60 * 1000) return;
    cur[m.kind] = { n: m.n, ts: Date.now(), source: m.source || "auto" };
    await chrome.storage.local.set({ network: cur });
  },
  "diag-log": async (m) => {
    const { diagLog } = await chrome.storage.local.get("diagLog");
    await chrome.storage.local.set({ diagLog: (diagLog || []).concat(m.entry).slice(-40) });
  },
  "limit-warning": (m) => addLimitAlert(m.ts || Date.now()),
  "manual-alert": (m) => addLimitAlert(m.ts || Date.now(), true),
  "delete-alert": async (m) => {
    const s = await chrome.storage.local.get("limitAlerts");
    await chrome.storage.local.set({ limitAlerts: (s.limitAlerts || []).filter((a) => a.id !== m.id) });
    await recomputeSuggestion(true);
  },
  "apply-suggestion": async () => {
    const { suggestion, settings } = await chrome.storage.local.get(["suggestion", "settings"]);
    if (!suggestion) return;
    await chrome.storage.local.set({
      settings: { ...DEFAULT_SETTINGS, ...(settings || {}), dailyGoal: suggestion.daily, weeklyGoal: suggestion.weekly },
      suggestion: { ...suggestion, status: "applied" },
    });
  },
  "dismiss-suggestion": async () => {
    const { suggestion } = await chrome.storage.local.get("suggestion");
    if (suggestion) await chrome.storage.local.set({ suggestion: { ...suggestion, status: "dismissed" } });
  },
  "manual-add": (m) => addInvite({ ...m, ts: Date.now(), source: "manual" }, true),
  "manual-backfill": async (m) => {
    const { invites } = await getState();
    for (let i = 0; i < m.n; i++) invites.push({ id: newId() + i, ts: m.ts + i * 1000, source: "manual" });
    invites.sort((a, b) => a.ts - b.ts);
    await chrome.storage.local.set({ invites });
  },
  "manual-remove": async () => {
    const { invites } = await getState();
    invites.sort((a, b) => a.ts - b.ts).pop();
    await chrome.storage.local.set({ invites });
  },
  "update-invite": async (m) => {
    const { invites } = await getState();
    const inv = invites.find((i) => i.id === m.id);
    if (inv) for (const f of FIELDS) if (f in m.patch) inv[f] = String(m.patch[f] || "").trim();
    await chrome.storage.local.set({ invites });
  },
  "delete-invite": async (m) => {
    const { invites } = await getState();
    await chrome.storage.local.set({ invites: invites.filter((i) => i.id !== m.id) });
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const h = handlers[msg.type];
  if (!h) return;
  enqueue(() => h(msg)).then((r) => sendResponse(r ?? true), () => sendResponse(null));
  return true;
});

// Migra formatos antigos: convites só com número e avisos só com horário.
async function migrate() {
  const s = await chrome.storage.local.get(["invites", "limitWarnings"]);
  if ((s.invites || []).some((x) => typeof x === "number")) {
    await chrome.storage.local.set({ invites: normalizeInvites(s.invites) });
  }
  if ((s.limitWarnings || []).length) {
    for (const ts of s.limitWarnings) await addLimitAlert(ts);
    await chrome.storage.local.remove("limitWarnings");
  }
}

// ---- Aviso de nova versão: compara com o manifest.json publicado no GitHub ----
const REPO_MANIFEST = "https://raw.githubusercontent.com/MathSMB/plugin-linkedin-contagem-conexoes/main/manifest.json";
const newer = (a, b) => {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
async function checkUpdate(force = false) {
  const { updateInfo } = await chrome.storage.local.get("updateInfo");
  if (!force && updateInfo && Date.now() - updateInfo.checkedAt < 6 * 60 * 60 * 1000) return updateInfo;
  const current = chrome.runtime.getManifest().version;
  let info = { checkedAt: Date.now(), current, latest: updateInfo?.latest || null, available: false, error: null };
  try {
    const r = await fetch(REPO_MANIFEST + "?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    info.latest = (await r.json()).version;
    info.available = newer(info.latest, current);
  } catch (e) {
    info.error = String(e.message || e); // repositório privado ou sem internet: só não avisa
  }
  await chrome.storage.local.set({ updateInfo: info });
  return info;
}
handlers["check-update"] = (m) => checkUpdate(!!m.force);

chrome.storage.onChanged.addListener(() => updateBadge());
chrome.runtime.onStartup.addListener(() => { updateBadge(); checkUpdate(); });
chrome.runtime.onInstalled.addListener(() => { enqueue(migrate).then(updateBadge); checkUpdate(true); });
setInterval(updateBadge, 60 * 1000);
updateBadge();
