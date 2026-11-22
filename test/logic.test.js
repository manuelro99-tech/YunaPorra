// Ejecutar con:  node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRound, annotate, pointsFor, ranking, scorerMatches, fromApiFixture, predictionKind,
} from '../logic.js';

const M = (o) => ({
  competition: 'LALIGA', stage: 'league', ko_round: null, status: 'FT',
  kickoff: '2026-12-01T20:00:00Z', home_id: 1, away_id: 2, home: 'A', away: 'B', ...o,
});

test('clasifica rondas', () => {
  assert.deepEqual(classifyRound('LALIGA', 'Regular Season - 14'), { include: true, stage: 'league', ko_round: null });
  assert.equal(classifyRound('UCL', 'League Stage - 3').stage, 'league');
  assert.equal(classifyRound('UCL', '3rd Qualifying Round').include, false);
  assert.equal(classifyRound('UCL', 'Play-offs').include, false); // previa de agosto
  assert.equal(classifyRound('UCL', 'Knockout Round Play-offs').ko_round, 'PO');
  assert.equal(classifyRound('UEL', 'Round of 16').ko_round, 'R16');
  assert.equal(classifyRound('UECL', 'Quarter-finals').ko_round, 'QF');
  assert.equal(classifyRound('UCL', 'Final').ko_round, 'F');
  assert.equal(classifyRound('UNL', 'League A - 4').stage, 'league');
  assert.equal(classifyRound('UNL', 'League C - 4').include, false);
  assert.equal(classifyRound('UNL', '3rd Place Final').ko_round, '3P');
});

test('liga: 1X2 = 2 pts, partido de tu equipo con exacto = 7', () => {
  const m = M({ id: 1, ft_home: 2, ft_away: 1 });
  const i = { decisive: false };
  assert.equal(pointsFor(m, i, { sign: '1' }).pts, 2);
  assert.equal(pointsFor(m, i, { sign: 'X' }).pts, 0);
  assert.equal(pointsFor(m, i, { sign: '1', home_goals: 2, away_goals: 1, is_fav: true }).pts, 7);
  assert.equal(pointsFor(m, i, { sign: '1', home_goals: 3, away_goals: 1, is_fav: true }).pts, 2);
  // sin ser favorito, el exacto no suma extra
  assert.equal(pointsFor(m, i, { sign: '1', home_goals: 2, away_goals: 1, is_fav: false }).pts, 2);
});

test('partido sin terminar no puntúa', () => {
  const m = M({ id: 1, status: 'NS', ft_home: null, ft_away: null });
  assert.equal(pointsFor(m, { decisive: false }, { sign: '1' }).pts, 0);
});

test('eliminatoria a doble partido: ida es 1X2 y la vuelta decide', () => {
  const ida = M({ id: 10, competition: 'UCL', stage: 'ko', ko_round: 'R16', kickoff: '2027-03-03T20:00:00Z',
    home_id: 1, away_id: 2, ft_home: 2, ft_away: 0, total_home: 2, total_away: 0 });
  const vuelta = M({ id: 11, competition: 'UCL', stage: 'ko', ko_round: 'R16', kickoff: '2027-03-10T20:00:00Z',
    home_id: 2, away_id: 1, ft_home: 1, ft_away: 0, total_home: 1, total_away: 0 });
  const info = annotate([vuelta, ida]);
  assert.equal(info.get(10).leg, 1);
  assert.equal(info.get(10).decisive, false);
  assert.equal(info.get(11).leg, 2);
  assert.equal(info.get(11).decisive, true);
  // Global: equipo 1 gana 2-1 → pasa el visitante de la vuelta
  assert.equal(info.get(11).advance, 'away');
  assert.equal(pointsFor(vuelta, info.get(11), { home_goals: 1, away_goals: 0, advance: 'away' }).pts, 7);
  assert.equal(pointsFor(vuelta, info.get(11), { home_goals: 0, away_goals: 0, advance: 'away' }).pts, 4);
  assert.equal(pointsFor(vuelta, info.get(11), { home_goals: 1, away_goals: 0, advance: 'home' }).pts, 0);
});

test('eliminatoria decidida en penaltis', () => {
  const ida = M({ id: 20, competition: 'UEL', stage: 'ko', ko_round: 'QF', kickoff: '2027-04-08T19:00:00Z',
    home_id: 5, away_id: 6, ft_home: 1, ft_away: 1, total_home: 1, total_away: 1 });
  const vuelta = M({ id: 21, competition: 'UEL', stage: 'ko', ko_round: 'QF', kickoff: '2027-04-15T19:00:00Z',
    home_id: 6, away_id: 5, status: 'PEN', ft_home: 0, ft_away: 0, total_home: 0, total_away: 0, pen_home: 4, pen_away: 5 });
  const info = annotate([ida, vuelta]);
  assert.equal(info.get(21).advance, 'away');
  assert.equal(pointsFor(vuelta, info.get(21), { home_goals: 0, away_goals: 0, advance: 'away' }).pts, 9);
});

test('final a partido único con prórroga', () => {
  const f = M({ id: 30, competition: 'UCL', stage: 'ko', ko_round: 'F', status: 'AET',
    ft_home: 1, ft_away: 1, total_home: 2, total_away: 1 });
  const info = annotate([f]);
  assert.equal(info.get(30).decisive, true);
  assert.equal(info.get(30).advance, 'home');
  assert.equal(pointsFor(f, info.get(30), { home_goals: 1, away_goals: 1, advance: 'home' }).pts, 14);
  assert.equal(pointsFor(f, info.get(30), { home_goals: 1, away_goals: 1, advance: 'home', is_fav: true }).pts, 17);
  assert.equal(pointsFor(f, info.get(30), { home_goals: 2, away_goals: 1, advance: 'home' }).pts, 8);
});

test('el admin puede fijar quién pasa a mano', () => {
  const f = M({ id: 31, competition: 'UCL', stage: 'ko', ko_round: 'F', ft_home: 0, ft_away: 0, advance: 'away' });
  const info = annotate([f]);
  assert.equal(info.get(31).advance, 'away');
});

test('pichichi tolera tildes y nombre corto', () => {
  assert.ok(scorerMatches('mbappé', ['Kylian Mbappe']));
  assert.ok(scorerMatches('Kylian Mbappé', ['Mbappe']));
  assert.ok(!scorerMatches('Vinicius', ['Kylian Mbappe']));
  assert.ok(!scorerMatches('', ['Kylian Mbappe']));
});

test('clasificación suma partidos y apuestas fijas, y ordena', () => {
  const profiles = [{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Bea' }];
  const matches = [M({ id: 1, ft_home: 1, ft_away: 0 }), M({ id: 2, competition: 'UCL', ft_home: 0, ft_away: 0 })];
  const predictions = [
    { user_id: 'a', match_id: 1, sign: '1' },
    { user_id: 'a', match_id: 2, sign: 'X' },
    { user_id: 'b', match_id: 1, sign: '2' },
  ];
  const settings = [{ competition: 'LALIGA', champion_id: 541, top_scorers: ['Mbappe'] }];
  const picks = [{ user_id: 'b', competition: 'LALIGA', champion_id: 541, scorer: 'Kylian Mbappé' }];
  const all = ranking({ profiles, matches, predictions, picks, settings });
  assert.equal(all[0].name, 'Bea');
  assert.equal(all[0].pts, 30);
  assert.equal(all[1].pts, 4);
  const ucl = ranking({ profiles, matches, predictions, picks, settings, competition: 'UCL' });
  assert.equal(ucl[0].name, 'Ana');
  assert.equal(ucl[0].pts, 2);
});

test('convierte un partido de API-Football', () => {
  const fx = {
    fixture: { id: 99, date: '2027-05-29T19:00:00+00:00', status: { short: 'PEN' } },
    league: { id: 2, round: 'Final' },
    teams: { home: { id: 541, name: 'Real Madrid', logo: 'x' }, away: { id: 50, name: 'Man City', logo: 'y' } },
    goals: { home: 1, away: 1 },
    score: { fulltime: { home: 1, away: 1 }, extratime: { home: 0, away: 0 }, penalty: { home: 5, away: 3 } },
  };
  const m = fromApiFixture(fx, 'UCL');
  assert.equal(m.ko_round, 'F');
  assert.equal(m.pen_home, 5);
  const info = annotate([m]);
  assert.equal(info.get(99).advance, 'home');
});

test('tipo de predicción según partido', () => {
  const liga = M({ id: 1, home_id: 541 });
  assert.equal(predictionKind(liga, { decisive: false }, { fav_team_id: 541 }), 'score');
  assert.equal(predictionKind(liga, { decisive: false }, { fav_team_id: 529 }), 'sign');
  assert.equal(predictionKind(liga, { decisive: true }, { fav_team_id: 529 }), 'ko');
  const unl = M({ id: 2, competition: 'UNL', home_id: 9, home: 'Spain' });
  assert.equal(predictionKind(unl, { decisive: false }, { fav_team_id: 529 }), 'score');
});
