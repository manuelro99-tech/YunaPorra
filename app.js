// =====================================================================
//  YUNA PORRA · Web
// =====================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import {
  COMPETITIONS, COMP_ORDER, KO_POINTS, KO_NAMES, SIGN_POINTS, FAV_EXACT_POINTS, FAV_KO_BONUS, PICK_POINTS,
  annotate, pointsFor, ranking, predictionKind, isFinal, isLive, hasStarted, pickPoints, signOf,
  VOID_STATUSES, isFavMatch,
} from './logic.js';

const S = {
  sb: null, session: null, profile: null,
  profiles: [], matches: [], info: new Map(), preds: [], myPreds: new Map(),
  picks: [], settings: [],
  view: 'home', predComp: 'ALL', predMode: 'next', predDays: 14, rankComp: 'ALL',
  draft: new Map(), open: new Set(), authMode: 'login', loaded: false,
};
const app = document.getElementById('app');

// ---------------------------------------------------------------------
//  Utilidades
// ---------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TZ = 'Europe/Madrid';
const fmtDay = (d) => new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ }).format(new Date(d));
const fmtTime = (d) => new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: TZ }).format(new Date(d));
const fmtShort = (d) => new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: TZ }).format(new Date(d));
const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(d));

function toast(msg, bad = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

function roundLabel(m, i) {
  if (m.stage === 'ko') {
    const leg = i?.leg === 1 ? ' · Ida' : i?.leg === 2 ? ' · Vuelta' : '';
    return (KO_NAMES[m.ko_round] || m.ko_round) + leg;
  }
  const r = m.round || '';
  let n;
  if ((n = r.match(/Regular Season - (\d+)/i))) return `Jornada ${n[1]}`;
  if ((n = r.match(/League (?:Stage|Phase) - (\d+)/i))) return `Fase de liga · J${n[1]}`;
  if ((n = r.match(/League ([A-D]) - (\d+)/i))) return `Liga ${n[1]} · J${n[2]}`;
  return r;
}

// Nombres en español para selecciones y algunos clubes
const NAME_ES = {
  Spain: 'España', France: 'Francia', Germany: 'Alemania', Italy: 'Italia', England: 'Inglaterra',
  Netherlands: 'Países Bajos', Belgium: 'Bélgica', Croatia: 'Croacia', Denmark: 'Dinamarca',
  Switzerland: 'Suiza', Poland: 'Polonia', Scotland: 'Escocia', Hungary: 'Hungría', 'Czech Republic': 'Chequia',
  Czechia: 'Chequia', Norway: 'Noruega', Sweden: 'Suecia', Turkey: 'Turquía', 'Türkiye': 'Turquía', Greece: 'Grecia',
  Wales: 'Gales', Ukraine: 'Ucrania', Slovenia: 'Eslovenia', Slovakia: 'Eslovaquia', Romania: 'Rumanía',
  Ireland: 'Irlanda', 'Northern Ireland': 'Irlanda del Norte', Iceland: 'Islandia', Finland: 'Finlandia',
  'Bosnia & Herzegovina': 'Bosnia', 'Bosnia and Herzegovina': 'Bosnia', 'North Macedonia': 'Macedonia del Norte',
  Albania: 'Albania', Georgia: 'Georgia', Serbia: 'Serbia', Portugal: 'Portugal', Austria: 'Austria',
  'Atletico Madrid': 'Atlético de Madrid', 'Athletic Club': 'Athletic Club', Alaves: 'Alavés', 'Cadiz': 'Cádiz',
  Almeria: 'Almería', Leganes: 'Leganés',
};
const es = (n) => (n && NAME_ES[n]) || n;

const teamName = (m, side) => (side === 'home' ? m.home : m.away) || 'Por definir';
const logo = (url) => (url ? `<img src="${esc(url)}" alt="" loading="lazy">` : '');

async function fetchAll(table, build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(S.sb.from(table).select('*')).range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

// ---------------------------------------------------------------------
//  Arranque y sesión
// ---------------------------------------------------------------------
async function boot() {
  let cfg;
  try {
    cfg = await (await fetch('/api/config')).json();
    if (cfg.error) throw new Error(cfg.error);
  } catch (e) {
    app.innerHTML = `<main><div class="card"><h2>Falta configurar</h2><p class="muted">${esc(e.message)}</p>
      <p class="small muted">Revisa las variables de entorno en Vercel (mira el README del repositorio).</p></div></main>`;
    return;
  }
  S.sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  S.sb.auth.onAuthStateChange((event, session) => {
    S.session = session;
    if (event === 'PASSWORD_RECOVERY') { S.view = 'newpass'; render(); }
    if (event === 'SIGNED_OUT') { S.profile = null; S.loaded = false; render(); }
  });
  const { data } = await S.sb.auth.getSession();
  S.session = data.session;
  await afterLogin();
}

async function afterLogin() {
  if (!S.session) { render(); return; }
  const { data: prof } = await S.sb.from('profiles').select('*').eq('id', S.session.user.id).maybeSingle();
  S.profile = prof;
  await loadAll();
  render();
  runSync();
}

async function loadAll() {
  const [matches, profiles, preds, picks, settings] = await Promise.all([
    fetchAll('matches', (q) => q.order('kickoff', { ascending: true })),
    fetchAll('profiles', (q) => q.order('name')),
    fetchAll('predictions', (q) => q.order('match_id').order('user_id')),
    fetchAll('picks', (q) => q.order('competition').order('user_id')),
    fetchAll('comp_settings', (q) => q),
  ]);
  for (const m of matches) { m.home = es(m.home); m.away = es(m.away); }
  S.matches = matches;
  S.info = annotate(matches);
  S.profiles = profiles;
  S.preds = preds;
  S.myPreds = new Map(preds.filter((p) => p.user_id === S.session.user.id).map((p) => [p.match_id, p]));
  S.picks = picks;
  S.settings = settings;
  S.profile = profiles.find((p) => p.id === S.session.user.id) || S.profile;
  S.loaded = true;
}

let syncing = false;
async function runSync(force = false) {
  if (syncing) return;
  syncing = true;
  try {
    const headers = force && S.session ? { Authorization: `Bearer ${S.session.access_token}` } : {};
    const r = await fetch('/api/sync' + (force ? '?force=1' : ''), { headers });
    const out = await r.json().catch(() => ({}));
    if (force) {
      if (out.error) toast('Error: ' + out.error, true);
      else toast(out.mode === 'full' ? `Sincronizado: ${out.saved} partidos` : 'Sincronizado');
    }
    if (r.ok && out.mode && out.mode !== 'skip' && S.session) { await loadAll(); render(); }
  } catch (e) {
    if (force) toast('Error al sincronizar', true);
  } finally { syncing = false; }
}

// ---------------------------------------------------------------------
//  Render general
// ---------------------------------------------------------------------
function render() {
  if (S.view === 'newpass') return renderNewPass();
  if (!S.session) return renderAuth();
  if (!S.profile) return renderSetup();
  if (!S.loaded) { app.innerHTML = '<div class="loading">⚽ Cargando…</div>'; return; }

  const views = { home: viewHome, predict: viewPredict, rank: viewRank, extras: viewExtras, rules: viewRules, admin: viewAdmin, me: viewMe };
  const body = (views[S.view] || viewHome)();
  app.innerHTML = `
    <header class="top">
      <div class="brand"><b>YUNA</b> PORRA<small>⚽ LaLiga · Europa · Naciones</small></div>
      <div class="me">${esc(S.profile.name)} <button class="icon-btn" data-go="me" aria-label="Ajustes">⚙️</button></div>
    </header>
    <main>${body}</main>
    <nav class="bottom">
      ${navBtn('home', '⚽', 'Inicio')}${navBtn('predict', '🔮', 'Predice')}${navBtn('rank', '🏆', 'Ranking')}
      ${navBtn('extras', '🥇', 'Campeón')}${navBtn('rules', '📖', 'Reglas')}
    </nav>`;
}
const navBtn = (v, i, l) => `<button class="${S.view === v ? 'on' : ''}" data-go="${v}"><span class="i">${i}</span>${l}</button>`;

// ---------------------------------------------------------------------
//  Acceso
// ---------------------------------------------------------------------
function renderAuth(msg = '', ok = '') {
  const reg = S.authMode === 'register';
  app.innerHTML = `
    <main style="padding-top:40px">
      <div class="center" style="margin-bottom:24px">
        <div class="brand" style="font-size:34px"><b>YUNA</b> PORRA</div>
        <div class="muted">LaLiga · Champions · Europa · Conference · Naciones</div>
      </div>
      <div class="seg">
        <button class="chip ${!reg ? 'on' : ''}" data-auth="login">Entrar</button>
        <button class="chip ${reg ? 'on' : ''}" data-auth="register">Crear cuenta</button>
      </div>
      <form class="card" id="authForm">
        <label>Email</label><input type="email" name="email" autocomplete="email" required>
        <label>Contraseña</label><input type="password" name="password" minlength="6" autocomplete="${reg ? 'new-password' : 'current-password'}" required>
        <button class="btn" type="submit">${reg ? 'Crear cuenta' : 'Entrar'}</button>
        ${!reg ? '<button class="linkbtn" type="button" data-action="forgot">¿Has olvidado la contraseña?</button>' : ''}
        ${msg ? `<div class="err">${esc(msg)}</div>` : ''}${ok ? `<div class="ok">${esc(ok)}</div>` : ''}
      </form>
    </main>`;
}

async function submitAuth(form) {
  const email = form.email.value.trim();
  const password = form.password.value;
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    if (S.authMode === 'register') {
      const { data, error } = await S.sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin } });
      if (error) throw error;
      if (!data.session) { S.authMode = 'login'; return renderAuth('', 'Cuenta creada. Revisa tu correo para confirmarla y después entra.'); }
      S.session = data.session;
    } else {
      const { data, error } = await S.sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      S.session = data.session;
    }
    await afterLogin();
  } catch (e) {
    const m = /Invalid login/i.test(e.message) ? 'Email o contraseña incorrectos' : e.message;
    renderAuth(m);
  }
}

async function forgot() {
  const email = document.querySelector('#authForm input[name=email]').value.trim();
  if (!email) return renderAuth('Escribe tu email arriba y vuelve a pulsar.');
  const { error } = await S.sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
  if (error) return renderAuth(error.message);
  renderAuth('', 'Te hemos enviado un correo para cambiar la contraseña.');
}

function renderNewPass(msg = '') {
  app.innerHTML = `<main style="padding-top:40px"><form class="card" id="newPassForm">
    <h2>Nueva contraseña</h2>
    <input type="password" name="password" minlength="6" required autocomplete="new-password">
    <button class="btn" type="submit">Guardar</button>${msg ? `<div class="err">${esc(msg)}</div>` : ''}
  </form></main>`;
}

// ---------------------------------------------------------------------
//  Primer acceso: nombre y equipo favorito
// ---------------------------------------------------------------------
function laligaTeams() {
  const map = new Map();
  for (const m of S.matches) {
    if (m.competition !== 'LALIGA') continue;
    if (m.home_id) map.set(m.home_id, m.home);
    if (m.away_id) map.set(m.away_id, m.away);
  }
  return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], 'es'));
}

function teamSelect(name, teams, selected, placeholder = '— Elige —') {
  return `<select name="${name}"><option value="">${placeholder}</option>${teams.map(([id, n]) =>
    `<option value="${id}" ${String(selected) === String(id) ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
}

function renderSetup(msg = '') {
  const teams = laligaTeams();
  app.innerHTML = `<main style="padding-top:30px">
    <form class="card" id="setupForm">
      <h2>¡Bienvenido! 👋</h2>
      <label>¿Cómo te llamamos en la clasificación?</label>
      <input type="text" name="name" maxlength="24" minlength="2" required>
      <label>Tu equipo de LaLiga</label>
      ${teams.length ? teamSelect('team', teams, '') : '<p class="small muted">Los equipos aún se están cargando. Podrás elegirlo luego en ⚙️.</p>'}
      <p class="small muted">En los partidos de tu equipo pones el marcador exacto y puedes ganar puntos extra.
      <b>Solo se elige una vez.</b></p>
      <button class="btn" type="submit">Empezar</button>
      ${msg ? `<div class="err">${esc(msg)}</div>` : ''}
    </form></main>`;
}

async function submitSetup(form) {
  const name = form.name.value.trim();
  const sel = form.team ? form.team.value : '';
  const teams = new Map(laligaTeams());
  const row = { id: S.session.user.id, name };
  if (sel) { row.fav_team_id = Number(sel); row.fav_team_name = teams.get(Number(sel)); }
  const { error } = await S.sb.from('profiles').insert(row);
  if (error) return renderSetup(error.message);
  await loadAll();
  S.view = 'home';
  render();
}

// ---------------------------------------------------------------------
//  INICIO
// ---------------------------------------------------------------------
function myRow(comp = null) {
  const rows = ranking({ profiles: S.profiles, matches: S.matches, predictions: S.preds, picks: S.picks, settings: S.settings, competition: comp });
  return { rows, me: rows.find((r) => r.id === S.profile.id) };
}

function viewHome() {
  const { rows, me } = myRow();
  const now = Date.now();
  const upcoming = S.matches.filter((m) => !hasStarted(m, now) && m.home_id && m.away_id);
  const soon = upcoming.filter((m) => new Date(m.kickoff) - now < 7 * 86400e3);
  const missing = soon.filter((m) => !S.myPreds.has(m.id));
  const today = S.matches.filter((m) => dayKey(m.kickoff) === dayKey(now));
  const recent = S.matches.filter((m) => isFinal(m) && S.myPreds.has(m.id)).slice(-5).reverse();

  let html = `
    <div class="stats">
      <div class="card stat"><div class="n">#${me ? me.pos : '-'}</div><div class="l">de ${rows.length}</div></div>
      <div class="card stat"><div class="n g">${me ? me.pts : 0}</div><div class="l">puntos</div></div>
      <div class="card stat"><div class="n">${me ? me.predicted : 0}</div><div class="l">predic.</div></div>
    </div>`;

  if (!S.matches.length) {
    html += `<div class="card gold"><b>⏳ Cargando el calendario…</b><p class="small muted">La primera vez tarda un poco. Si no aparece nada en unos minutos, avisa al administrador.</p></div>`;
  } else if (missing.length) {
    html += `<div class="card gold row between" data-go="predict" style="cursor:pointer">
      <div><b>Te faltan ${missing.length} predicciones</b><div class="small muted">Partidos de los próximos 7 días</div></div><div>→</div></div>`;
  } else if (soon.length) {
    html += `<div class="card green"><b>✅ Lo tienes todo predicho</b><div class="small muted">para los próximos 7 días</div></div>`;
  }

  if (!S.profile.fav_team_id) {
    html += `<div class="card row between" data-go="me" style="cursor:pointer"><div><b>Elige tu equipo</b><div class="small muted">Para jugar con marcador exacto y bonus</div></div><div>→</div></div>`;
  }

  if (today.length) html += `<h3>Hoy</h3>${today.map((m) => matchCard(m, true)).join('')}`;
  if (recent.length) html += `<h3>Tus últimos resultados</h3>${recent.map((m) => matchCard(m, true)).join('')}`;

  const top = rows.slice(0, 3);
  if (top.length && top[0].pts > 0) {
    html += `<h3>Podio</h3>${top.map((r) => rankRow(r)).join('')}`;
  }
  if (S.profile.is_admin) html += `<button class="btn secondary" data-go="admin">🛠️ Panel de administrador</button>`;
  return html;
}

// ---------------------------------------------------------------------
//  PREDICE
// ---------------------------------------------------------------------
function compChips(current, attr, withAll = true, allLabel = 'Todas') {
  const list = withAll ? [['ALL', allLabel]] : [];
  for (const c of COMP_ORDER) list.push([c, `${COMPETITIONS[c].icon} ${COMPETITIONS[c].short}`]);
  return `<div class="chips">${list.map(([k, l]) => `<button class="chip ${current === k ? 'on' : ''}" data-${attr}="${k}">${l}</button>`).join('')}</div>`;
}

function viewPredict() {
  const now = Date.now();
  let list = S.matches.filter((m) => S.predComp === 'ALL' || m.competition === S.predComp);
  let html = `<h2>🔮 Predicciones</h2>${compChips(S.predComp, 'pcomp')}
    <div class="seg"><button class="chip ${S.predMode === 'next' ? 'on' : ''}" data-pmode="next">Próximos</button>
    <button class="chip ${S.predMode === 'past' ? 'on' : ''}" data-pmode="past">Jugados</button></div>`;

  if (S.predMode === 'next') {
    const limit = now + S.predDays * 86400e3;
    const all = list.filter((m) => !hasStarted(m, now) || isLive(m));
    list = all.filter((m) => new Date(m.kickoff) <= limit || m.stage === 'ko');
    if (!list.length) return html + `<div class="empty">No hay partidos próximos aquí.</div>`;
    let last = '';
    for (const m of list) {
      const d = dayKey(m.kickoff);
      if (d !== last) { html += `<h3>${esc(fmtDay(m.kickoff))}</h3>`; last = d; }
      html += matchCard(m);
    }
    if (all.length > list.length) html += `<button class="btn secondary" data-action="more">Ver más partidos</button>`;
  } else {
    list = list.filter((m) => hasStarted(m, now) && !isLive(m)).reverse().slice(0, 80);
    if (!list.length) return html + `<div class="empty">Todavía no se ha jugado nada.</div>`;
    html += list.map((m) => matchCard(m)).join('');
  }
  return html;
}

function predText(m, i, p) {
  if (!p) return '—';
  const kind = i?.decisive ? 'ko' : (p.is_fav ? 'score' : 'sign');
  if (kind === 'sign') return p.sign || '—';
  const sc = p.home_goals != null ? `${p.home_goals}-${p.away_goals}` : (p.sign || '—');
  if (kind === 'ko' && p.advance) return `${sc} · pasa ${p.advance === 'home' ? m.home : m.away}`;
  return sc;
}

function matchCard(m, compact = false) {
  const i = S.info.get(m.id) || {};
  const started = hasStarted(m);
  const p = S.myPreds.get(m.id);
  const comp = COMPETITIONS[m.competition];
  const live = isLive(m);
  const fav = isFavMatch(m, S.profile);

  let score = 'vs';
  let scoreCls = '';
  if (VOID_STATUSES.includes(m.status)) score = '<span class="small">Anulado</span>';
  else if (m.status === 'PST') score = '<span class="small">Aplazado</span>';
  else if (live) { score = `${m.total_home ?? 0}-${m.total_away ?? 0}`; scoreCls = 'live'; }
  else if (isFinal(m)) score = `${m.ft_home}-${m.ft_away}`;
  else if (!started) score = `<span class="small muted">${fmtTime(m.kickoff)}</span>`;

  let extra = '';
  if (isFinal(m) && (m.total_home !== m.ft_home || m.total_away !== m.ft_away || m.pen_home != null)) {
    extra = `<div class="hint">Final: ${m.total_home}-${m.total_away}${m.pen_home != null ? ` (pen. ${m.pen_home}-${m.pen_away})` : ''}</div>`;
  }

  let body = '';
  if (!started && m.home_id && m.away_id && !compact) {
    body = predictForm(m, i);
  } else if (!started && !compact) {
    body = `<div class="hint">Equipos por definir</div>`;
  } else {
    const r = pointsFor(m, i, p);
    const badge = !p ? '<span class="tag grey">Sin predicción</span>'
      : r.done ? (r.pts ? `<span class="tag ${r.exact ? 'gold' : ''}">+${r.pts} pts</span>` : '<span class="tag red">0 pts</span>')
      : '<span class="tag grey">En juego</span>';
    body = `<div class="row between small" style="margin-top:10px"><span class="muted">Tu predicción: <b style="color:var(--text)">${esc(predText(m, i, p))}</b></span>${badge}</div>`;
    if (!compact) {
      const open = S.open.has(m.id);
      body += `<button class="linkbtn" data-others="${m.id}">${open ? 'Ocultar' : 'Ver'} predicciones de todos</button>`;
      if (open) body += othersList(m, i);
    }
  }

  return `<div class="card match">
    <div class="meta"><span>${comp.icon} ${comp.short} · ${esc(roundLabel(m, i))}</span>
      <span>${fav ? '<span class="tag gold">Tu equipo</span> ' : ''}${started ? fmtShort(m.kickoff) : ''}</span></div>
    <div class="teams">
      <div class="team">${logo(m.home_logo)}<span>${esc(teamName(m, 'home'))}</span></div>
      <div class="score ${scoreCls}">${score}</div>
      <div class="team away">${logo(m.away_logo)}<span>${esc(teamName(m, 'away'))}</span></div>
    </div>${extra}${body}</div>`;
}

function othersList(m, i) {
  const byUser = new Map(S.profiles.map((u) => [u.id, u.name]));
  const list = S.preds.filter((p) => p.match_id === m.id);
  if (!list.length) return '<div class="others muted">Nadie predijo este partido.</div>';
  return `<div class="others">${list.map((p) => {
    const r = pointsFor(m, i, p);
    return `<div><span>${esc(byUser.get(p.user_id) || '?')}</span><span>${esc(predText(m, i, p))} ${r.done ? `· <b>${r.pts}</b>` : ''}</span></div>`;
  }).join('')}</div>`;
}

function currentDraft(m) {
  if (S.draft.has(m.id)) return S.draft.get(m.id);
  const p = S.myPreds.get(m.id);
  return p ? { sign: p.sign, home_goals: p.home_goals, away_goals: p.away_goals, advance: p.advance }
    : { sign: null, home_goals: null, away_goals: null, advance: null };
}

function predictForm(m, i) {
  const kind = predictionKind(m, i, S.profile);
  const d = currentDraft(m);
  const saved = S.myPreds.has(m.id);
  if (kind === 'sign') {
    const b = (s, l) => `<button class="sign ${d.sign === s ? 'on' : ''}" data-sign="${s}" data-mid="${m.id}">${s}<small>${l}</small></button>`;
    return `<div class="signs">${b('1', 'Local')}${b('X', 'Empate')}${b('2', 'Visitante')}</div>`;
  }
  const h = d.home_goals ?? 0, a = d.away_goals ?? 0;
  const stepper = (side, v) => `<div class="stepper">
      <button data-step="${side}" data-delta="-1" data-mid="${m.id}" aria-label="menos">−</button>
      <div class="v">${v}</div>
      <button data-step="${side}" data-delta="1" data-mid="${m.id}" aria-label="más">+</button></div>`;
  let html = `<div class="scorebox">${stepper('home', h)}<span class="muted">-</span>${stepper('away', a)}</div>`;
  if (kind === 'ko') {
    const [base, full] = KO_POINTS[m.ko_round] || [0, 0];
    const single = i.leg == null;
    html += `<div class="hint">${single ? 'Marcador a los 90 minutos y quién gana el partido (con prórroga o penaltis)' : 'Marcador de la vuelta a los 90\' y quién pasa la eliminatoria'}</div>
      <div class="adv">
        <button class="${d.advance === 'home' ? 'on' : ''}" data-adv="home" data-mid="${m.id}">Pasa ${esc(m.home)}</button>
        <button class="${d.advance === 'away' ? 'on' : ''}" data-adv="away" data-mid="${m.id}">Pasa ${esc(m.away)}</button>
      </div><div class="hint">${base} pts si aciertas quién pasa · ${full} si además clavas el marcador</div>`;
  } else {
    html += `<div class="hint">⭐ Tu equipo: marcador exacto = ${FAV_EXACT_POINTS} pts · signo = ${SIGN_POINTS}</div>`;
  }
  const dirty = S.draft.has(m.id);
  html += `<button class="btn ${dirty || !saved ? '' : 'secondary'}" data-save="${m.id}">${saved && !dirty ? 'Guardado ✓' : 'Guardar'}</button>`;
  return html;
}

async function savePrediction(mid, payload) {
  const m = S.matches.find((x) => x.id === mid);
  if (!m || hasStarted(m)) { toast('Este partido ya ha empezado', true); return; }
  const row = { user_id: S.session.user.id, match_id: mid, sign: null, home_goals: null, away_goals: null, advance: null, ...payload };
  const { data, error } = await S.sb.from('predictions').upsert(row, { onConflict: 'user_id,match_id' }).select().single();
  if (error) { toast(error.message, true); return; }
  S.myPreds.set(mid, data);
  const idx = S.preds.findIndex((p) => p.user_id === data.user_id && p.match_id === mid);
  if (idx >= 0) S.preds[idx] = data; else S.preds.push(data);
  S.draft.delete(mid);
  toast('Guardado ✓');
  render();
}

// ---------------------------------------------------------------------
//  RANKING
// ---------------------------------------------------------------------
function rankRow(r) {
  const medal = r.pos === 1 ? '🥇' : r.pos === 2 ? '🥈' : r.pos === 3 ? '🥉' : '';
  return `<div class="card rank ${r.id === S.profile.id ? 'me' : ''}">
    <div class="pos">${medal ? `<span class="medal">${medal}</span>` : r.pos}</div>
    <div class="grow"><b>${esc(r.name)}</b>
      <div class="small muted">🎯 ${r.hits} acierto${r.hits === 1 ? '' : 's'} · ⭐ ${r.exacts} exacto${r.exacts === 1 ? '' : 's'}${r.pickPts ? ` · 🥇 +${r.pickPts}` : ''}${r.fav ? ` · ${esc(r.fav)}` : ''}</div></div>
    <div class="pts">${r.pts} <small>pts</small></div></div>`;
}

function viewRank() {
  const comp = S.rankComp === 'ALL' ? null : S.rankComp;
  const { rows, me } = myRow(comp);
  let html = `<h2>🏆 Clasificación</h2>${compChips(S.rankComp, 'rcomp', true, 'General')}`;
  if (me && me.pos > 1) {
    const above = rows.filter((r) => r.pts > me.pts).pop();
    if (above) html += `<div class="card small">🎯 A <b style="color:var(--green)">${above.pts - me.pts} pts</b> de superar a <b>${esc(above.name)}</b></div>`;
  }
  html += rows.map(rankRow).join('');
  return html;
}

// ---------------------------------------------------------------------
//  CAMPEÓN Y PICHICHI
// ---------------------------------------------------------------------
function compTeams(comp) {
  const map = new Map();
  for (const m of S.matches) {
    if (m.competition !== comp) continue;
    if (m.home_id) map.set(m.home_id, m.home);
    if (m.away_id) map.set(m.away_id, m.away);
  }
  return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], 'es'));
}

function viewExtras() {
  let html = `<h2>🥇 Campeón y pichichi</h2>
    <p class="small muted">Una apuesta fija por competición: ${PICK_POINTS} pts si aciertas el campeón y ${PICK_POINTS} si aciertas el máximo goleador (LaLiga y Champions).</p>`;
  for (const c of COMP_ORDER) {
    const st = S.settings.find((s) => s.competition === c);
    if (!st) continue;
    const mine = S.picks.find((p) => p.user_id === S.profile.id && p.competition === c) || {};
    const open = new Date(st.picks_deadline) > new Date();
    const teams = compTeams(c);
    const info = COMPETITIONS[c];
    html += `<div class="card"><div class="row between"><b>${info.icon} ${info.name}</b>
      <span class="tag ${open ? '' : 'grey'}">${open ? 'Hasta ' + fmtShort(st.picks_deadline) : 'Cerrado'}</span></div>`;
    if (open) {
      html += `<form data-pickform="${c}">
        <label>Campeón</label>${teams.length ? teamSelect('champion', teams, mine.champion_id) : '<p class="small muted">Aún no hay equipos cargados.</p>'}
        ${info.scorer ? `<label>Pichichi (máximo goleador)</label><input type="text" name="scorer" maxlength="60" placeholder="Ej: Kylian Mbappé" value="${esc(mine.scorer || '')}">` : ''}
        <button class="btn" type="submit">Guardar</button></form>`;
    } else {
      const pp = pickPoints({ ...mine, competition: c }, st);
      html += `<p class="small">Tu campeón: <b>${esc(mine.champion || '—')}</b> ${st.champion_id != null ? (pp.champion ? '<span class="tag">+15</span>' : '<span class="tag red">0</span>') : ''}</p>`;
      if (info.scorer) html += `<p class="small">Tu pichichi: <b>${esc(mine.scorer || '—')}</b> ${st.top_scorers?.length ? (pp.scorer ? '<span class="tag">+15</span>' : '<span class="tag red">0</span>') : ''}</p>`;
      if (st.champion) html += `<p class="small muted">🏆 Campeón oficial: <b>${esc(st.champion)}</b></p>`;
      if (st.top_scorers?.length) html += `<p class="small muted">👟 Pichichi oficial: <b>${esc(st.top_scorers.join(', '))}</b></p>`;
      const others = S.picks.filter((p) => p.competition === c && p.user_id !== S.profile.id);
      if (others.length) {
        const names = new Map(S.profiles.map((u) => [u.id, u.name]));
        html += `<div class="others">${others.map((p) => `<div><span>${esc(names.get(p.user_id) || '?')}</span><span>${esc(p.champion || '—')}${info.scorer ? ' · ' + esc(p.scorer || '—') : ''}</span></div>`).join('')}</div>`;
      }
    }
    html += `</div>`;
  }
  return html;
}

async function savePick(form, comp) {
  const teams = new Map(compTeams(comp));
  const champId = form.champion && form.champion.value ? Number(form.champion.value) : null;
  const row = {
    user_id: S.session.user.id, competition: comp,
    champion_id: champId, champion: champId ? teams.get(champId) : null,
    scorer: form.scorer ? form.scorer.value.trim() || null : null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await S.sb.from('picks').upsert(row, { onConflict: 'user_id,competition' }).select().single();
  if (error) return toast(/row-level/i.test(error.message) ? 'El plazo ya está cerrado' : error.message, true);
  S.picks = S.picks.filter((p) => !(p.user_id === data.user_id && p.competition === comp)).concat(data);
  toast('Guardado ✓');
  render();
}

// ---------------------------------------------------------------------
//  REGLAS
// ---------------------------------------------------------------------
function viewRules() {
  const ko = Object.entries(KO_POINTS).map(([k, [b, f]]) => `<tr><td>${KO_NAMES[k]}</td><td class="n">${b}</td><td class="n gold">${f}</td></tr>`).join('');
  return `<div class="rules"><h2>📖 Reglas</h2>
  <div class="card"><h3 style="margin-top:0">De qué va esto</h3>
    <p>Predices los partidos de <b>LaLiga</b> (todos), la <b>fase de liga</b> de Champions, Europa League y Conference (los de equipos españoles), <b>todas las eliminatorias europeas</b> y la <b>Liga de Naciones</b> (Liga A y fase final). Hay una clasificación general y otra por cada competición.</p>
    <p>La predicción se cierra sola cuando empieza el partido. Las predicciones de los demás se ven en cuanto empieza.</p></div>

  <div class="card"><h3 style="margin-top:0">🔮 Liga y fases de liga</h3>
    <table><tr><td>Aciertas el signo (1/X/2)</td><td class="n">${SIGN_POINTS}</td></tr>
    <tr><td>⭐ Partido de tu equipo: marcador exacto</td><td class="n gold">${FAV_EXACT_POINTS}</td></tr></table>
    <p class="small">${FAV_EXACT_POINTS} = 2 signo + 2 exacto + 3 bonus. "Tu equipo" es el club de LaLiga que eliges al registrarte; en la Liga de Naciones, tu equipo es España.</p>
    <p class="small">El partido de ida de una eliminatoria a doble partido se juega como un partido de liga (1/X/2).</p></div>

  <div class="card"><h3 style="margin-top:0">⚔️ Eliminatorias</h3>
    <p class="small">En la vuelta (o en el partido único) pones el <b>marcador a los 90'</b> y <b>quién pasa</b>. Acertar quién pasa da los puntos base; si además clavas el marcador, los puntos totales.</p>
    <table><tr><th>Ronda</th><th style="text-align:right">Quién pasa</th><th style="text-align:right">+ exacto 90'</th></tr>${ko}</table>
    <p class="small">⭐ Si es tu equipo y clavas el marcador: +${FAV_KO_BONUS} extra.</p></div>

  <div class="card"><h3 style="margin-top:0">🥇 Campeón y pichichi</h3>
    <p class="small">Por cada competición eliges campeón (+${PICK_POINTS}). En LaLiga y Champions también el máximo goleador (+${PICK_POINTS}). Si varios empatan en goles, vale cualquiera de ellos. Hay un plazo para elegir; después no se puede cambiar.</p></div>

  <div class="card"><h3 style="margin-top:0">🤝 Empates en la clasificación</h3>
    <p class="small">Si dos jugadores tienen los mismos puntos, va delante quien tenga más marcadores exactos y, después, más aciertos.</p></div>

  <div class="card"><p class="small muted center">Resultados automáticos desde API-Football. Si algún dato falla, el administrador lo corrige a mano.<br>¡Suerte! ⚽</p></div>
  <p class="small muted center">Próximamente: bote del grupo, duelos 1v1 y badges.</p></div>`;
}

// ---------------------------------------------------------------------
//  AJUSTES
// ---------------------------------------------------------------------
function viewMe() {
  const teams = laligaTeams();
  return `<h2>⚙️ Ajustes</h2>
    <form class="card" id="meForm">
      <label>Tu nombre</label><input type="text" name="name" maxlength="24" minlength="2" value="${esc(S.profile.name)}" required>
      <label>Tu equipo</label>
      ${S.profile.fav_team_id ? `<p><b>${esc(S.profile.fav_team_name)}</b> <span class="small muted">(para cambiarlo, pídeselo al administrador)</span></p>`
        : teams.length ? teamSelect('team', teams, '') + '<p class="small muted">Solo se elige una vez.</p>' : '<p class="small muted">Equipos aún no cargados.</p>'}
      <button class="btn" type="submit">Guardar</button>
    </form>
    <div class="card small muted">📱 <b>Instálala en el móvil:</b> en Safari pulsa Compartir → "Añadir a pantalla de inicio". En Android/Chrome, menú ⋮ → "Instalar aplicación".</div>
    ${S.profile.is_admin ? '<button class="btn secondary" data-go="admin">🛠️ Panel de administrador</button>' : ''}
    <button class="btn secondary" data-action="logout">Cerrar sesión</button>`;
}

async function submitMe(form) {
  const upd = { name: form.name.value.trim() };
  if (form.team && form.team.value) {
    const teams = new Map(laligaTeams());
    upd.fav_team_id = Number(form.team.value);
    upd.fav_team_name = teams.get(upd.fav_team_id);
  }
  const { error } = await S.sb.from('profiles').update(upd).eq('id', S.profile.id);
  if (error) return toast(error.message, true);
  await loadAll();
  toast('Guardado ✓');
  render();
}

// ---------------------------------------------------------------------
//  ADMIN
// ---------------------------------------------------------------------
let adminStatus = null;
function viewAdmin() {
  if (!S.profile.is_admin) return '<div class="empty">Solo para el administrador.</div>';
  if (!adminStatus) {
    fetch('/api/status').then((r) => r.json()).catch(() => ({ error: 'Sin conexión' }))
      .then((s) => { adminStatus = s; if (S.view === 'admin') render(); });
  }
  const st = adminStatus || {};
  const fmtTs = (t) => (t ? fmtShort(t) : '—');
  let html = `<h2>🛠️ Administrador</h2>
    <div class="card"><b>Sincronización</b>
      <p class="small muted">Última completa: ${fmtTs(st.last_full)} · Última rápida: ${fmtTs(st.last_quick)}<br>
      Peticiones API-Football que quedan hoy: <b>${st.quota ?? '—'}</b> de 100
      ${st.missing?.length ? `<br><span style="color:var(--red)">Faltan variables: ${esc(st.missing.join(', '))}</span>` : ''}
      ${st.last_error ? `<br><span style="color:var(--red)">Último error: ${esc(st.last_error)}</span>` : ''}</p>
      <p class="small muted">Partidos en la base de datos: <b>${S.matches.length}</b> (${COMP_ORDER.map((c) => `${COMPETITIONS[c].short} ${S.matches.filter((m) => m.competition === c).length}`).join(' · ')})</p>
      <button class="btn" data-action="forcesync">Sincronizar ahora (gasta 5 peticiones)</button></div>`;

  html += `<h3>Campeón y pichichi</h3>`;
  for (const c of COMP_ORDER) {
    const s = S.settings.find((x) => x.competition === c);
    if (!s) continue;
    const local = new Date(s.picks_deadline);
    const dl = new Date(local.getTime() - local.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    html += `<form class="card" data-setform="${c}"><b>${COMPETITIONS[c].icon} ${COMPETITIONS[c].name}</b>
      <label>Plazo para elegir</label><input type="datetime-local" name="deadline" value="${dl}">
      <label>Campeón oficial</label>${teamSelect('champion', compTeams(c), s.champion_id, '— Aún no —')}
      ${COMPETITIONS[c].scorer ? `<label>Pichichi oficial (si empatan, sepáralos con comas)</label><input type="text" name="scorers" value="${esc((s.top_scorers || []).join(', '))}">` : ''}
      <button class="btn secondary" type="submit">Guardar</button></form>`;
  }

  const now = Date.now();
  const recent = S.matches.filter((m) => hasStarted(m, now) && now - new Date(m.kickoff) < 21 * 86400e3).reverse();
  html += `<h3>Corregir resultados (últimas 3 semanas)</h3>
    <p class="small muted">Solo si la API falla. Un resultado puesto a mano ya no lo cambia la sincronización hasta que pulses "Automático".</p>`;
  for (const m of recent) {
    const i = S.info.get(m.id) || {};
    html += `<form class="card" data-resform="${m.id}">
      <div class="small muted">${COMPETITIONS[m.competition].short} · ${esc(roundLabel(m, i))} · ${fmtShort(m.kickoff)} · ${esc(m.status)}${m.manual ? ' · <b style="color:var(--gold)">MANUAL</b>' : ''}</div>
      <div><b>${esc(m.home)}</b> – <b>${esc(m.away)}</b></div>
      <label>90' · Final (con prórroga) · Penaltis</label>
      <div class="mini">
        <input type="number" name="fh" min="0" placeholder="90' L" value="${m.ft_home ?? ''}"><input type="number" name="fa" min="0" placeholder="90' V" value="${m.ft_away ?? ''}">
        <input type="number" name="th" min="0" placeholder="Fin L" value="${m.total_home ?? ''}"><input type="number" name="ta" min="0" placeholder="Fin V" value="${m.total_away ?? ''}">
        <input type="number" name="ph" min="0" placeholder="Pen L" value="${m.pen_home ?? ''}"><input type="number" name="pa" min="0" placeholder="Pen V" value="${m.pen_away ?? ''}">
        <select name="adv" style="grid-column: span 2"><option value="">Pasa: automático</option>
          <option value="home" ${m.advance === 'home' ? 'selected' : ''}>Pasa ${esc(m.home)}</option>
          <option value="away" ${m.advance === 'away' ? 'selected' : ''}>Pasa ${esc(m.away)}</option></select>
      </div>
      <div class="row"><button class="btn secondary" type="submit">Guardar a mano</button>
      ${m.manual ? `<button class="btn secondary" type="button" data-release="${m.id}">Automático</button>` : ''}</div>
    </form>`;
  }
  if (!recent.length) html += '<div class="empty">No hay partidos recientes.</div>';

  html += `<h3>Jugadores (${S.profiles.length})</h3>`;
  const teams = laligaTeams();
  for (const u of S.profiles) {
    html += `<form class="card" data-favform="${u.id}"><b>${esc(u.name)}</b>${u.is_admin ? ' <span class="tag gold">admin</span>' : ''}
      <label>Equipo favorito</label>${teamSelect('team', teams, u.fav_team_id, '— Sin equipo —')}
      <button class="btn secondary" type="submit">Cambiar equipo</button></form>`;
  }
  return html;
}

const num = (v) => (v === '' || v == null ? null : Number(v));

async function adminSaveResult(form, id) {
  const fh = num(form.fh.value), fa = num(form.fa.value);
  if (fh == null || fa == null) return toast('Pon al menos el resultado a los 90\'', true);
  const { error } = await S.sb.rpc('admin_set_result', {
    p_id: id, p_ft_home: fh, p_ft_away: fa,
    p_total_home: num(form.th.value), p_total_away: num(form.ta.value),
    p_pen_home: num(form.ph.value), p_pen_away: num(form.pa.value),
    p_advance: form.adv.value || null,
    p_status: num(form.ph.value) != null ? 'PEN' : (num(form.th.value) != null && (num(form.th.value) !== fh || num(form.ta.value) !== fa) ? 'AET' : 'FT'),
  });
  if (error) return toast(error.message, true);
  await loadAll(); toast('Resultado guardado'); render();
}

async function adminSaveSettings(form, comp) {
  const teams = new Map(compTeams(comp));
  const champId = form.champion.value ? Number(form.champion.value) : null;
  const scorers = form.scorers ? form.scorers.value.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const { error } = await S.sb.rpc('admin_set_settings', {
    p_comp: comp, p_deadline: new Date(form.deadline.value).toISOString(),
    p_champion_id: champId, p_champion: champId ? teams.get(champId) : null, p_scorers: scorers,
  });
  if (error) return toast(error.message, true);
  await loadAll(); toast('Guardado ✓'); render();
}

async function adminSaveFav(form, uid) {
  const teams = new Map(laligaTeams());
  const id = form.team.value ? Number(form.team.value) : null;
  const { error } = await S.sb.rpc('admin_set_fav', { p_user: uid, p_team_id: id, p_team_name: id ? teams.get(id) : null });
  if (error) return toast(error.message, true);
  await loadAll(); toast('Equipo cambiado'); render();
}

// ---------------------------------------------------------------------
//  Eventos
// ---------------------------------------------------------------------
app.addEventListener('click', async (e) => {
  const el = e.target.closest('button, [data-go]');
  if (!el) return;
  const ds = el.dataset;

  if (ds.go) { S.view = ds.go; if (ds.go === 'admin') adminStatus = null; render(); window.scrollTo(0, 0); return; }
  if (ds.auth) { S.authMode = ds.auth; renderAuth(); return; }
  if (ds.pcomp) { S.predComp = ds.pcomp; S.predDays = 14; render(); return; }
  if (ds.pmode) { S.predMode = ds.pmode; render(); return; }
  if (ds.rcomp) { S.rankComp = ds.rcomp; render(); return; }
  if (ds.others) { const id = Number(ds.others); S.open.has(id) ? S.open.delete(id) : S.open.add(id); render(); return; }
  if (ds.release) { const { error } = await S.sb.rpc('admin_release_match', { p_id: Number(ds.release) }); if (error) toast(error.message, true); else { await loadAll(); runSync(); render(); } return; }

  if (ds.sign) { await savePrediction(Number(ds.mid), { sign: ds.sign }); return; }

  if (ds.step) {
    const mid = Number(ds.mid);
    const m = S.matches.find((x) => x.id === mid);
    const d = { ...currentDraft(m) };
    const key = ds.step === 'home' ? 'home_goals' : 'away_goals';
    d.home_goals = d.home_goals ?? 0; d.away_goals = d.away_goals ?? 0;
    d[key] = Math.max(0, Math.min(15, d[key] + Number(ds.delta)));
    const i = S.info.get(mid) || {};
    if (i.decisive && i.leg == null && d.home_goals !== d.away_goals) d.advance = d.home_goals > d.away_goals ? 'home' : 'away';
    S.draft.set(mid, d);
    render();
    return;
  }
  if (ds.adv) {
    const mid = Number(ds.mid);
    const m = S.matches.find((x) => x.id === mid);
    const d = { ...currentDraft(m), advance: ds.adv };
    d.home_goals = d.home_goals ?? 0; d.away_goals = d.away_goals ?? 0;
    S.draft.set(mid, d); render(); return;
  }
  if (ds.save) {
    const mid = Number(ds.save);
    const m = S.matches.find((x) => x.id === mid);
    const i = S.info.get(mid) || {};
    const d = currentDraft(m);
    const h = d.home_goals ?? 0, a = d.away_goals ?? 0;
    const payload = { home_goals: h, away_goals: a, sign: signOf(h, a) };
    if (i.decisive) {
      if (!d.advance) return toast('Elige quién pasa', true);
      if (i.leg == null && h !== a && d.advance !== (h > a ? 'home' : 'away')) return toast('Si gana a los 90\', pasa ese equipo', true);
      payload.advance = d.advance;
    }
    await savePrediction(mid, payload);
    return;
  }
  if (ds.action === 'more') { S.predDays += 21; render(); return; }
  if (ds.action === 'forgot') { forgot(); return; }
  if (ds.action === 'logout') { await S.sb.auth.signOut(); S.session = null; S.view = 'home'; render(); return; }
  if (ds.action === 'forcesync') { el.disabled = true; await runSync(true); adminStatus = null; await loadAll(); render(); return; }
});

app.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.id === 'authForm') return submitAuth(f);
  if (f.id === 'setupForm') return submitSetup(f);
  if (f.id === 'meForm') return submitMe(f);
  if (f.id === 'newPassForm') {
    const { error } = await S.sb.auth.updateUser({ password: f.password.value });
    if (error) return renderNewPass(error.message);
    S.view = 'home'; toast('Contraseña cambiada'); return afterLogin();
  }
  if (f.dataset.pickform) return savePick(f, f.dataset.pickform);
  if (f.dataset.setform) return adminSaveSettings(f, f.dataset.setform);
  if (f.dataset.resform) return adminSaveResult(f, Number(f.dataset.resform));
  if (f.dataset.favform) return adminSaveFav(f, f.dataset.favform);
});

// Al volver a la app, refresca datos y resultados
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && S.session && S.profile && S.loaded) {
    await loadAll(); render(); runSync();
  }
});

boot();
