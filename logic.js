// =====================================================================
//  YUNA PORRA · Reglas y puntuación
//  Este archivo lo usan tanto la web (navegador) como la sincronización (servidor).
// =====================================================================

export const COMPETITIONS = {
  LALIGA: { name: 'LaLiga',            short: 'LaLiga',     apiId: 140, icon: '🇪🇸', scorer: true },
  UCL:    { name: 'Champions League',  short: 'Champions',  apiId: 2,   icon: '⭐', scorer: true },
  UEL:    { name: 'Europa League',     short: 'Europa',     apiId: 3,   icon: '🟠', scorer: false },
  UECL:   { name: 'Conference League', short: 'Conference', apiId: 848, icon: '🟢', scorer: false },
  UNL:    { name: 'Liga de Naciones',  short: 'Naciones',   apiId: 5,   icon: '🌍', scorer: false },
};
export const COMP_ORDER = ['LALIGA', 'UCL', 'UEL', 'UECL', 'UNL'];
export const SPAIN_TEAM_ID = 9; // España en API-Football

// Eliminatorias: [puntos por acertar quién pasa, puntos si además clavas el marcador de 90']
export const KO_POINTS = {
  PO:   [3, 6],
  R16:  [4, 7],
  QF:   [5, 9],
  SF:   [6, 11],
  '3P': [6, 11],
  F:    [8, 14],
};
export const KO_NAMES = {
  PO: 'Playoff', R16: 'Octavos', QF: 'Cuartos', SF: 'Semifinal', '3P': 'Tercer puesto', F: 'Final',
};
export const SIGN_POINTS = 2;      // aciertas 1/X/2
export const FAV_EXACT_POINTS = 7; // marcador exacto de tu equipo (2 signo + 2 exacto + 3 bonus)
export const FAV_KO_BONUS = 3;     // bonus extra si clavas el marcador de tu equipo en eliminatoria
export const PICK_POINTS = 15;     // campeón / pichichi

export const FINAL_STATUSES = ['FT', 'AET', 'PEN', 'AWD', 'WO'];
export const VOID_STATUSES = ['CANC', 'ABD'];
export const LIVE_STATUSES = ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT', 'LIVE'];

export const isFinal = (m) => FINAL_STATUSES.includes(m.status) && m.ft_home != null && m.ft_away != null;
export const isLive = (m) => LIVE_STATUSES.includes(m.status);
export const hasStarted = (m, now = Date.now()) => new Date(m.kickoff).getTime() <= now;

// ---------------------------------------------------------------------
//  Qué partidos entran y de qué tipo son, según el texto de la ronda
// ---------------------------------------------------------------------
export function classifyRound(competition, round = '') {
  const r = String(round);
  const ko = (code) => ({ include: true, stage: 'ko', ko_round: code });
  const league = { include: true, stage: 'league', ko_round: null };
  const out = { include: false, stage: 'league', ko_round: null };

  if (competition === 'LALIGA') return /Regular Season/i.test(r) ? league : out;

  if (/Qualifying|Preliminary/i.test(r)) return out;
  if (/Knockout Round Play-?offs/i.test(r)) return ko('PO');
  if (/Round of 16|8th Finals/i.test(r)) return ko('R16');
  if (/Quarter-?finals/i.test(r)) return ko('QF');
  if (/Semi-?finals/i.test(r)) return ko('SF');
  if (/3rd Place/i.test(r)) return ko('3P');
  if (/^Final$/i.test(r.trim())) return ko('F');

  if (competition === 'UNL') {
    // Fase de liga: solo la Liga A (la de España). La sync añade además cualquier partido de España.
    return /League A/i.test(r) ? league : out;
  }
  // Champions / Europa / Conference: fase de liga (la sync filtra a equipos españoles)
  return /League Stage|League Phase|Group/i.test(r) ? league : out;
}

const TWO_LEG_ROUNDS = {
  UCL: ['PO', 'R16', 'QF', 'SF'],
  UEL: ['PO', 'R16', 'QF', 'SF'],
  UECL: ['PO', 'R16', 'QF', 'SF'],
  UNL: ['QF'],
};
export const isTwoLegRound = (m) => (TWO_LEG_ROUNDS[m.competition] || []).includes(m.ko_round);

// ---------------------------------------------------------------------
//  Ida / vuelta y quién pasa
//  Devuelve Map<id, { leg, decisive, firstLeg, advance }>
//    leg: null | 1 | 2       decisive: true si este partido decide quién pasa
// ---------------------------------------------------------------------
export function annotate(matches) {
  const info = new Map();
  const ties = new Map();
  for (const m of matches) {
    if (m.stage !== 'ko') { info.set(m.id, { leg: null, decisive: false }); continue; }
    if (!isTwoLegRound(m) || m.home_id == null || m.away_id == null) {
      info.set(m.id, { leg: null, decisive: true });
      continue;
    }
    const key = [m.competition, m.ko_round, Math.min(m.home_id, m.away_id), Math.max(m.home_id, m.away_id)].join('|');
    if (!ties.has(key)) ties.set(key, []);
    ties.get(key).push(m);
  }
  for (const list of ties.values()) {
    list.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
    if (list.length === 1) {
      // Solo conocemos un partido de la eliminatoria: lo tratamos como ida
      info.set(list[0].id, { leg: 1, decisive: false });
    } else {
      info.set(list[0].id, { leg: 1, decisive: false });
      info.set(list[1].id, { leg: 2, decisive: true, firstLeg: list[0] });
    }
  }
  for (const m of matches) {
    const i = info.get(m.id);
    if (i && i.decisive) i.advance = actualAdvance(m, i.firstLeg);
  }
  return info;
}

// Quién pasó realmente ('home' | 'away' | null si aún no se sabe)
export function actualAdvance(m, firstLeg) {
  if (m.advance) return m.advance; // fijado a mano por el admin
  if (!isFinal(m)) return null;
  const th = m.total_home ?? m.ft_home;
  const ta = m.total_away ?? m.ft_away;
  let h = th, a = ta;
  if (firstLeg) {
    if (!isFinal(firstLeg)) return null;
    // En la ida, el local de la vuelta jugaba fuera
    h += firstLeg.total_away ?? firstLeg.ft_away;
    a += firstLeg.total_home ?? firstLeg.ft_home;
  }
  if (h > a) return 'home';
  if (a > h) return 'away';
  if (m.pen_home != null && m.pen_away != null && m.pen_home !== m.pen_away) {
    return m.pen_home > m.pen_away ? 'home' : 'away';
  }
  return null;
}

export const signOf = (h, a) => (h > a ? '1' : h < a ? '2' : 'X');

// ¿Este partido es de "tu equipo"? (tu club favorito, o España en Liga de Naciones)
export function isFavMatch(m, profile) {
  if (!m) return false;
  if (m.competition === 'UNL' && (m.home_id === SPAIN_TEAM_ID || m.away_id === SPAIN_TEAM_ID || ['Spain', 'España'].includes(m.home) || ['Spain', 'España'].includes(m.away))) return true;
  return !!(profile && profile.fav_team_id != null && (m.home_id === profile.fav_team_id || m.away_id === profile.fav_team_id));
}

// Qué hay que rellenar en cada partido
//   'sign'  → 1/X/2
//   'score' → marcador exacto (partidos de tu equipo)
//   'ko'    → marcador de 90' + quién pasa
export function predictionKind(m, i, profile) {
  if (i && i.decisive) return 'ko';
  return isFavMatch(m, profile) ? 'score' : 'sign';
}

// ---------------------------------------------------------------------
//  Puntos de una predicción
// ---------------------------------------------------------------------
export function pointsFor(m, i, p) {
  const zero = { pts: 0, hit: false, exact: false, done: false };
  if (!p || !m) return zero;
  if (VOID_STATUSES.includes(m.status)) return { ...zero, done: true };
  if (!isFinal(m)) return zero;
  const exact = p.home_goals != null && p.away_goals != null &&
    p.home_goals === m.ft_home && p.away_goals === m.ft_away;

  if (!i || !i.decisive) {
    const sign = signOf(m.ft_home, m.ft_away);
    const predSign = p.sign || (p.home_goals != null && p.away_goals != null ? signOf(p.home_goals, p.away_goals) : null);
    if (predSign !== sign) return { ...zero, done: true };
    if (p.is_fav && exact) return { pts: FAV_EXACT_POINTS, hit: true, exact: true, done: true };
    return { pts: SIGN_POINTS, hit: true, exact: false, done: true };
  }

  const [base, full] = KO_POINTS[m.ko_round] || [0, 0];
  if (!i.advance) return zero; // aún no se sabe quién pasa
  if (p.advance !== i.advance) return { ...zero, done: true };
  if (exact) return { pts: full + (p.is_fav ? FAV_KO_BONUS : 0), hit: true, exact: true, done: true };
  return { pts: base, hit: true, exact: false, done: true };
}

// ---------------------------------------------------------------------
//  Campeón y pichichi
// ---------------------------------------------------------------------
export const normalizeName = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

export function scorerMatches(pick, official) {
  const a = normalizeName(pick);
  if (!a) return false;
  return (official || []).some((o) => {
    const b = normalizeName(o);
    if (!b) return false;
    if (a === b) return true;
    // "Mbappe" vale por "Kylian Mbappe" y al revés, si coincide el apellido completo
    const la = a.split(' ').pop(), lb = b.split(' ').pop();
    return la === lb && la.length >= 4;
  });
}

export function pickPoints(pick, setting) {
  if (!pick || !setting) return { champion: 0, scorer: 0 };
  const champion = setting.champion_id != null && pick.champion_id === setting.champion_id ? PICK_POINTS : 0;
  const scorer = COMPETITIONS[pick.competition]?.scorer && scorerMatches(pick.scorer, setting.top_scorers) ? PICK_POINTS : 0;
  return { champion, scorer };
}

// ---------------------------------------------------------------------
//  Clasificación (general o de una competición)
// ---------------------------------------------------------------------
export function ranking({ profiles, matches, predictions, picks = [], settings = [], competition = null }) {
  const info = annotate(matches);
  const byId = new Map(matches.map((m) => [m.id, m]));
  const settingBy = new Map(settings.map((s) => [s.competition, s]));
  const rows = new Map(profiles.map((u) => [u.id, {
    id: u.id, name: u.name, fav: u.fav_team_name,
    pts: 0, matchPts: 0, pickPts: 0, hits: 0, exacts: 0, played: 0, predicted: 0,
  }]));

  for (const p of predictions) {
    const m = byId.get(p.match_id);
    const row = rows.get(p.user_id);
    if (!m || !row) continue;
    if (competition && m.competition !== competition) continue;
    row.predicted++;
    const r = pointsFor(m, info.get(m.id), p);
    if (r.done) row.played++;
    row.matchPts += r.pts;
    if (r.hit) row.hits++;
    if (r.exact) row.exacts++;
  }
  for (const pk of picks) {
    const row = rows.get(pk.user_id);
    if (!row) continue;
    if (competition && pk.competition !== competition) continue;
    const r = pickPoints(pk, settingBy.get(pk.competition));
    row.pickPts += r.champion + r.scorer;
  }
  const list = [...rows.values()];
  for (const r of list) r.pts = r.matchPts + r.pickPts;
  list.sort((a, b) => b.pts - a.pts || b.exacts - a.exacts || b.hits - a.hits || a.name.localeCompare(b.name, 'es'));
  let pos = 0, prev = null;
  list.forEach((r, idx) => {
    const key = `${r.pts}|${r.exacts}|${r.hits}`;
    if (key !== prev) pos = idx + 1;
    r.pos = pos; prev = key;
  });
  return list;
}

// ---------------------------------------------------------------------
//  Convierte un partido de API-Football al formato de la tabla "matches"
// ---------------------------------------------------------------------
export function fromApiFixture(fx, competition) {
  const cls = classifyRound(competition, fx.league?.round);
  const s = fx.score || {};
  const ft = s.fulltime || {};
  const pen = s.penalty || {};
  return {
    id: fx.fixture.id,
    competition,
    round: fx.league?.round || null,
    stage: cls.stage,
    ko_round: cls.ko_round,
    kickoff: fx.fixture.date,
    home_id: fx.teams?.home?.id ?? null,
    home: fx.teams?.home?.name ?? null,
    home_logo: fx.teams?.home?.logo ?? null,
    away_id: fx.teams?.away?.id ?? null,
    away: fx.teams?.away?.name ?? null,
    away_logo: fx.teams?.away?.logo ?? null,
    status: fx.fixture?.status?.short || 'NS',
    ft_home: ft.home ?? null,
    ft_away: ft.away ?? null,
    total_home: fx.goals?.home ?? null,
    total_away: fx.goals?.away ?? null,
    pen_home: pen.home ?? null,
    pen_away: pen.away ?? null,
    _include: cls.include,
  };
}

export function competitionForLeagueId(id) {
  return Object.keys(COMPETITIONS).find((k) => COMPETITIONS[k].apiId === id) || null;
}
