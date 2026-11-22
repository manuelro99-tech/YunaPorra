// Prueba la sincronización con Supabase y API-Football simulados
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://sb.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.API_FOOTBALL_KEY = 'af';

const fx = (id, league, round, home, away, extra = {}) => ({
  fixture: { id, date: '2026-12-05T20:00:00+00:00', status: { short: 'NS' } },
  league: { id: league, round },
  teams: { home: { id: home, name: `T${home}` }, away: { id: away, name: `T${away}` } },
  goals: { home: null, away: null },
  score: { fulltime: { home: null, away: null }, penalty: { home: null, away: null } },
  ...extra,
});

const API = {
  140: [fx(1, 140, 'Regular Season - 15', 541, 529), fx(2, 140, 'Regular Season - 15', 530, 532)],
  2: [
    fx(10, 2, 'League Stage - 6', 541, 50),   // equipo español → entra
    fx(11, 2, 'League Stage - 6', 40, 50),    // sin españoles → fuera
    fx(12, 2, '3rd Qualifying Round', 541, 1),// previa → fuera
    fx(13, 2, 'Round of 16', 40, 50),         // eliminatoria → entra siempre
  ],
  3: [fx(20, 3, 'League Stage - 5', 532, 70)],
  848: [],
  5: [fx(30, 5, 'League A - 6', 9, 10), fx(31, 5, 'League C - 6', 200, 201), fx(32, 5, 'Final', 9, 2)],
};

const db = { matches: [], app_state: {}, calls: [] };

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const json = (obj, headers = {}) => new Response(JSON.stringify(obj), { status: 200, headers });
  if (u.host === 'v3.football.api-sports.io') {
    db.calls.push(u.pathname + u.search);
    const league = Number(u.searchParams.get('league'));
    return json({ errors: [], response: API[league] || [] }, { 'x-ratelimit-requests-remaining': '95' });
  }
  const path = u.pathname.replace('/rest/v1/', '');
  if (path === 'app_state') {
    if ((opts.method || 'GET') === 'GET') {
      const key = u.searchParams.get('key').replace('eq.', '');
      return json(db.app_state[key] !== undefined ? [{ value: db.app_state[key] }] : []);
    }
    for (const r of JSON.parse(opts.body)) db.app_state[r.key] = r.value;
    return new Response('', { status: 201 });
  }
  if (path === 'matches') {
    if ((opts.method || 'GET') === 'GET') return json([]);
    for (const r of JSON.parse(opts.body)) {
      const i = db.matches.findIndex((m) => m.id === r.id);
      if (i >= 0) db.matches[i] = { ...db.matches[i], ...r }; else db.matches.push(r);
    }
    return new Response('', { status: 201 });
  }
  throw new Error('URL inesperada ' + url);
};

const { default: handler } = await import('../api/sync.js');

const call = async (url = '/api/sync', headers = {}) => {
  let status, body;
  const res = { setHeader() {}, status(s) { status = s; return this; }, json(b) { body = b; return this; } };
  await handler({ url, headers }, res);
  return { status, body };
};

test('primera llamada: importación completa con filtros', async () => {
  const { status, body } = await call();
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.mode, 'full');
  const ids = db.matches.map((m) => m.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [1, 2, 10, 13, 20, 30, 32]);
  assert.equal(db.calls.length, 5);
  assert.equal(db.matches.find((m) => m.id === 13).ko_round, 'R16');
  assert.ok(!('_include' in db.matches[0]));
  assert.equal(db.app_state.sync.quota, 95);
});

test('segunda llamada inmediata: no gasta peticiones', async () => {
  const before = db.calls.length;
  const { body } = await call();
  assert.equal(body.mode, 'skip');
  assert.equal(db.calls.length, before);
});

test('forzar sin ser admin está prohibido', async () => {
  const { status } = await call('/api/sync?force=1');
  assert.equal(status, 403);
});
