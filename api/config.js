// /api/config — datos públicos que necesita la web para conectarse a Supabase.
// (La clave "anon" es pública por diseño; la seguridad la ponen las reglas de la base de datos.)
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) {
    return res.status(500).json({ error: 'Faltan SUPABASE_URL o SUPABASE_ANON_KEY en Vercel' });
  }
  res.status(200).json({ supabaseUrl: url, supabaseAnonKey: anon, season: process.env.SEASON || '2026' });
}
