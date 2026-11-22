// /api/status — para el panel de admin: estado de la última sincronización
import { missingEnv, getState } from './_server.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const missing = missingEnv();
  if (missing.length) return res.status(200).json({ ok: false, missing });
  try {
    const st = (await getState('sync')) || {};
    res.status(200).json({ ok: true, ...st });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e.message || e) });
  }
}
