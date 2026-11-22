// Utilidades de servidor (los archivos que empiezan por "_" no son páginas de la API)
import {
  COMPETITIONS, COMP_ORDER, fromApiFixture, SPAIN_TEAM_ID, FINAL_STATUSES, VOID_STATUSES,
} from '../logic.js';

export const env = () => ({
  SB: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
  KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  AF: process.env.API_FOOTBALL_KEY || '',
  SEASON: process.env.SEASON || '2026',
  CRON_SECRET: process.env.CRON_SECRET || '',
});

export function missingEnv() {
  const e = env();
  return [
    !e.SB && 'SUPABASE_URL',
    !e.KEY && 'SUPABASE_SERVICE_ROLE_KEY',
    !e.AF && 'API_FOOTBALL_KEY',
  ].filter(Boolean);
}

// ---------- Supabase (con la clave de servicio: salta la seguridad, solo en servidor) ----------
export async function sb(path, { method = 'GET', body, prefer } = {}) {
  const { SB, KEY } = env();
  // Las claves antiguas (JWT "eyJ…") van también en Authorization; las nuevas (sb_secret_…) solo en apikey
  const headers = { apikey: KEY, 'Content-Type': 'application/json' };
  if (KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${KEY}`;
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${SB}/rest/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export async function getState(key) {
  const rows = await sb(`app_state?key=eq.${encodeURIComponent(key)}&select=value`);
  return rows && rows[0] ? rows[0].value : null;
}
export async function setState(key, value) {
  await sb('app_state?on_conflict=key', {
    method: 'POST', body: [{ key, value }], prefer: 'resolution=merge-duplicates,return=minimal',
  });
}

// ¿El token pertenece a un administrador?
export async function isAdminToken(token) {
  if (!token) return false;
  const { SB, KEY } = env();
  const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
  if (!r.ok) return false;
  const user = await r.json();
  if (!user?.id) return false;
  const rows = await sb(`profiles?id=eq.${user.id}&select=is_admin`);
  return !!(rows && rows[0] && rows[0].is_admin);
}

// ---------- API-Football ----------
let quota = null;
export const lastQuota = () => quota;

export async function af(path) {
  const { AF } = env();
  const r = await fetch(`https://v3.football.api-sports.io/${path}`, { headers: { 'x-apisports-key': AF } });
  const rem = r.headers.get('x-ratelimit-requests-remaining');
  if (rem != null) quota = Number(rem);
  const j = await r.json().catch(() => ({}));
  const errs = j.errors;
  const hasErr = errs && (Array.isArray(errs) ? errs.length : Object.keys(errs).length);
  if (!r.ok || hasErr) throw new Error(`API-Football: ${JSON.stringify(errs || r.status)}`);
  return j.response || [];
}

// ---------- Guardar partidos sin pisar los resultados puestos a mano ----------
const RESULT_FIELDS = ['status', 'ft_home', 'ft_away', 'total_home', 'total_away', 'pen_home', 'pen_away'];

async function saveMatches(rows) {
  if (!rows.length) return 0;
  const manual = new Set((await sb('matches?select=id&manual=eq.true')).map((r) => r.id));
  const clean = rows.map((r) => {
    const { _include, ...row } = r;
    if (manual.has(row.id)) for (const f of RESULT_FIELDS) delete row[f];
    row.updated_at = new Date().toISOString();
    return row;
  });
  // PostgREST exige que todas las filas de un lote tengan las mismas columnas
  const groups = new Map();
  for (const row of clean) {
    const k = Object.keys(row).sort().join(',');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(row);
  }
  for (const list of groups.values()) {
    for (let i = 0; i < list.length; i += 400) {
      await sb('matches?on_conflict=id', {
        method: 'POST', body: list.slice(i, i + 400), prefer: 'resolution=merge-duplicates,return=minimal',
      });
    }
  }
  return clean.length;
}

const involvesSpain = (r) => r.home_id === SPAIN_TEAM_ID || r.away_id === SPAIN_TEAM_ID;

// Importación completa: calendario de toda la temporada (5 peticiones)
export async function fullImport() {
  const { SEASON } = env();
  const all = {};
  for (const comp of COMP_ORDER) {
    const list = await af(`fixtures?league=${COMPETITIONS[comp].apiId}&season=${SEASON}`);
    all[comp] = list.map((fx) => fromApiFixture(fx, comp));
  }
  const spanishClubs = new Set();
  for (const r of all.LALIGA) { if (r.home_id) spanishClubs.add(r.home_id); if (r.away_id) spanishClubs.add(r.away_id); }

  const keep = [];
  const counts = {};
  for (const comp of COMP_ORDER) {
    let n = 0;
    for (const r of all[comp]) {
      let ok = r._include;
      if (ok && ['UCL', 'UEL', 'UECL'].includes(comp) && r.stage === 'league') {
        // Fase de liga europea: solo partidos con equipos españoles
        ok = spanishClubs.has(r.home_id) || spanishClubs.has(r.away_id);
      }
      if (!ok && comp === 'UNL' && involvesSpain(r) && !/Qualifying|Play-?offs?$/i.test(r.round || '')) ok = true;
      if (ok) { keep.push(r); n++; }
    }
    counts[comp] = n;
  }
  const saved = await saveMatches(keep);
  await setState('laliga_teams', [...spanishClubs]);
  return { saved, counts };
}

// Actualización rápida: solo los partidos que están en juego o acaban de terminar
export async function quickSync() {
  const now = Date.now();
  const from = new Date(now - 5 * 3600e3).toISOString();
  const to = new Date(now).toISOString();
  const done = [...FINAL_STATUSES, ...VOID_STATUSES].join(',');
  const pending = await sb(
    `matches?select=id,competition&manual=eq.false&kickoff=gte.${from}&kickoff=lte.${to}&status=not.in.(${done})`,
  );
  if (!pending.length) return { checked: 0 };
  const compById = new Map(pending.map((p) => [p.id, p.competition]));
  const ids = pending.map((p) => p.id);
  const rows = [];
  for (let i = 0; i < ids.length; i += 20) {
    const list = await af(`fixtures?ids=${ids.slice(i, i + 20).join('-')}`);
    for (const fx of list) rows.push(fromApiFixture(fx, compById.get(fx.fixture.id)));
  }
  await saveMatches(rows);
  return { checked: ids.length, updated: rows.length };
}
