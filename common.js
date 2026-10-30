// Funções compartilhadas entre background, content script, popup e histórico.
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

const DEFAULT_SETTINGS = { dailyGoal: 20, weeklyGoal: 100, pendingWarn: 200, connectionsBaseline: null };

// Cada convite é { id, ts, name, headline, company, profileUrl, source }.
// Versões antigas guardavam só o timestamp (número): convertemos aqui.
function normalizeInvites(list) {
  return (list || []).map((x, i) =>
    typeof x === "number" ? { id: "m" + x + "_" + i, ts: x, source: "antigo" } : x
  );
}

function startOfToday(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function computeStats(invites, now = Date.now()) {
  const ts = normalizeInvites(invites).map((i) => i.ts);
  const today = startOfToday(now);
  const weekStart = now - WEEK_MS;
  const todayCount = ts.filter((t) => t >= today).length;
  const weekList = ts.filter((t) => t > weekStart).sort((a, b) => a - b);
  const nextSlotAt = weekList.length ? weekList[0] + WEEK_MS : null;
  return { todayCount, weekCount: weekList.length, nextSlotAt };
}

function levelFor(count, goal) {
  if (count >= goal) return "over";
  if (count >= goal * 0.8) return "warn";
  return "ok";
}

// Tenta achar a empresa no título/linha "Atual:" do perfil. É um palpite:
// dá para corrigir na página de histórico.
function guessCompany(...texts) {
  for (const raw of texts) {
    if (!raw) continue;
    const t = raw.replace(/\s+/g, " ").trim();
    let m = t.match(/^(?:Atual|Current|Presente)\s*:\s*(.+)$/i);
    const body = m ? m[1] : t;
    m = body.match(/(?:\s|^)(?:at|na|no|em|en)\s+([A-ZÀ-Ý0-9i].+)$/) || body.match(/@\s*(.+)$/);
    if (m) {
      const c = m[1].split(/\s[|•·–—]\s|\s\|\s?|\s-\s|,|\(/)[0].trim();
      if (c && c.length <= 60 && !/^[a-z]{4,}$/.test(c)) return c;
    }
  }
  return "";
}

// ---- Convites pendentes e taxa de aceite ----
// network = { pending: {n, ts, source}, connections: {n, ts, source} }
function networkStats(network, settings) {
  const pending = network?.pending?.n ?? null;
  const conns = network?.connections?.n ?? null;
  const base = settings?.connectionsBaseline;
  let accepted = null, acceptRate = null;
  if (conns != null && base != null && pending != null) {
    accepted = Math.max(0, conns - base);
    const sent = accepted + pending;
    acceptRate = sent ? Math.round((accepted / sent) * 100) : null;
  }
  const warn = settings?.pendingWarn || DEFAULT_SETTINGS.pendingWarn;
  return { pending, conns, accepted, acceptRate, pendingLevel: pending == null ? null : levelFor(pending, warn), pendingWarn: warn };
}

// ---- Aprendizado com os avisos de limite do LinkedIn ----
const SAFETY = 0.8; // metas sugeridas ficam 20% abaixo do ponto em que o aviso apareceu

// Foto da atividade nos 7 dias anteriores a um aviso.
function snapshotAt(invites, ts) {
  const list = normalizeInvites(invites).map((i) => i.ts).filter((t) => t <= ts && t > ts - WEEK_MS);
  const dayStart = startOfToday(ts);
  const perDay = [];
  for (let k = 6; k >= 0; k--) {
    const s = new Date(dayStart); s.setDate(s.getDate() - k);
    const e = new Date(s); e.setDate(e.getDate() + 1);
    perDay.push({ day: s.getTime(), n: list.filter((t) => t >= s.getTime() && t < e.getTime()).length });
  }
  const active = perDay.filter((d) => d.n > 0);
  return {
    weekCount: list.length,
    todayCount: list.filter((t) => t >= dayStart).length,
    perDay,
    activeDays: active.length,
    avgPerActiveDay: active.length ? +(list.length / active.length).toFixed(1) : 0,
    maxDay: Math.max(0, ...perDay.map((d) => d.n)),
    firstInWindow: list.length ? Math.min(...list) : null,
  };
}

// Usa o aviso mais "apertado" (menor contagem de 7 dias) como limite observado.
function suggestFromAlerts(alerts) {
  const valid = (alerts || []).filter((a) => a.weekCount > 0);
  if (!valid.length) return null;
  const observed = Math.min(...valid.map((a) => a.weekCount));
  const weekly = Math.max(5, Math.floor(observed * SAFETY));
  const daily = Math.max(3, Math.floor(weekly / 5)); // espalhado em ~5 dias úteis
  return { observed, weekly, daily, basedOn: valid.length };
}

if (typeof module !== "undefined") {
  module.exports = { networkStats, snapshotAt, suggestFromAlerts, computeStats, levelFor, startOfToday, normalizeInvites, guessCompany, DAY_MS, WEEK_MS, DEFAULT_SETTINGS };
}
