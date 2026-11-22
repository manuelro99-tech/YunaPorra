// /api/sync — trae calendario y resultados de API-Football a la base de datos.
// La web lo llama sola al abrirse; Vercel lo llama además una vez al día (vercel.json).
// Cuida el límite gratuito de API-Football (100 peticiones/día).
import {
  env, missingEnv, getState, setState, isAdminToken, fullImport, quickSync, lastQuota,
} from './_server.js';

const QUICK_EVERY_MS = 10 * 60e3;   // como mucho cada 10 minutos
const FULL_EVERY_MS = 20 * 3600e3;  // calendario completo una vez al día
const MIN_QUOTA = 10;               // si quedan menos peticiones, no gastamos más hoy

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const missing = missingEnv();
  if (missing.length) return res.status(500).json({ error: `Faltan variables en Vercel: ${missing.join(', ')}` });

  try {
    const url = new URL(req.url, 'http://localhost');
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const { CRON_SECRET } = env();
    const isCron = !!CRON_SECRET && token === CRON_SECRET;
    const wantsForce = url.searchParams.get('force') === '1';
    const force = isCron || (wantsForce && await isAdminToken(token));
    if (wantsForce && !force) return res.status(403).json({ error: 'Solo el administrador puede forzar la sincronización' });

    const st = (await getState('sync')) || {};
    const now = Date.now();
    const quotaLow = st.quota != null && st.quota < MIN_QUOTA && st.quota_day === new Date().toISOString().slice(0, 10);
    const out = { mode: 'skip' };

    if (force || !st.last_full || now - st.last_full > FULL_EVERY_MS) {
      if (quotaLow && !force) { out.reason = 'quota'; }
      else {
        await setState('sync', { ...st, last_full: now, last_quick: now });
        out.mode = 'full';
        Object.assign(out, await fullImport());
      }
    } else if (!st.last_quick || now - st.last_quick > QUICK_EVERY_MS) {
      if (quotaLow) { out.reason = 'quota'; }
      else {
        await setState('sync', { ...st, last_quick: now });
        out.mode = 'quick';
        Object.assign(out, await quickSync());
      }
    }

    const q = lastQuota();
    if (q != null) {
      const fresh = (await getState('sync')) || {};
      await setState('sync', { ...fresh, quota: q, quota_day: new Date().toISOString().slice(0, 10), last_error: null });
      out.quota = q;
    }
    return res.status(200).json(out);
  } catch (e) {
    try {
      const st = (await getState('sync')) || {};
      await setState('sync', { ...st, last_error: String(e.message || e).slice(0, 300), last_error_at: Date.now() });
    } catch { /* nada */ }
    return res.status(500).json({ error: String(e.message || e) });
  }
}
