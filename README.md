# ⚽ Yuna Porra

Porra entre amigos de **LaLiga, Champions, Europa League, Conference y Liga de Naciones**.
Predicciones 1/X/2, marcador exacto en los partidos de tu equipo, eliminatorias con "quién pasa",
campeón y pichichi, clasificación general y por competición. Resultados automáticos desde API-Football.

- Web: HTML + JavaScript sin compilar (Vercel la sirve tal cual)
- Base de datos y usuarios: Supabase
- Resultados: API-Football (plan gratis, 100 peticiones/día)

---

## Puesta en marcha (una sola vez)

### 1. Supabase (base de datos)
1. Entra en https://supabase.com → **New project**. Ponle nombre (ej. `yunaporra`), una contraseña de base de datos (guárdala) y región **Europe (Frankfurt o Paris)**.
2. Cuando termine de crearse: menú izquierdo **SQL Editor** → **New query** → pega todo el contenido de [`supabase/schema.sql`](supabase/schema.sql) → **Run**. Debe decir *Success*.
3. **Authentication → Sign In / Providers → Email**: desactiva **Confirm email** y guarda. (Si no, cada amigo tiene que confirmar por correo y Supabase solo envía unos pocos correos por hora.)
4. **Project Settings → API Keys** (o *Data API*): apunta estas tres cosas:
   - **Project URL** (`https://xxxx.supabase.co`)
   - la clave pública: **anon** / **publishable**
   - la clave secreta: **service_role** / **secret** ⚠️ esta no se comparte nunca

### 2. API-Football (resultados)
1. Regístrate en https://dashboard.api-football.com/register (plan gratis).
2. En el panel copia tu **API Key**.

### 3. Vercel (publicar la web)
1. https://vercel.com/new → importa el repositorio **YunaPorra**.
2. *Framework Preset*: **Other**. No toques nada más.
3. Abre **Environment Variables** y añade:

| Nombre | Valor |
|---|---|
| `SUPABASE_URL` | Project URL de Supabase |
| `SUPABASE_ANON_KEY` | clave anon / publishable |
| `SUPABASE_SERVICE_ROLE_KEY` | clave service_role / secret |
| `API_FOOTBALL_KEY` | tu API Key de API-Football |
| `SEASON` | `2026` (temporada 2026-27) |

4. **Deploy**. Al terminar tendrás una dirección tipo `https://yunaporra.vercel.app`.
5. Vuelve a Supabase → **Authentication → URL Configuration** → en **Site URL** pon esa dirección (sirve para los correos de "he olvidado la contraseña").

### 4. Primer uso
1. Abre la web, crea tu cuenta y elige nombre y equipo. (La primera vez el calendario tarda unos segundos en cargarse.)
2. Hazte administrador: en Supabase → **SQL Editor** ejecuta
   ```sql
   update public.profiles set is_admin = true where name = 'TU_NOMBRE';
   ```
3. Recarga la web: en ⚙️ Ajustes verás **Panel de administrador**. Pulsa **Sincronizar ahora** y comprueba que aparecen partidos de las cinco competiciones.
4. Comparte la dirección con tus amigos. En el móvil: Safari → Compartir → **Añadir a pantalla de inicio**.

---

## Cómo se actualizan los resultados
- Cada vez que alguien abre la web, se consultan los partidos que están en juego o acaban de terminar (como mucho cada 10 minutos).
- Una vez al día se recarga el calendario completo (aplazamientos, sorteos de eliminatorias…).
- Si la API falla o un resultado está mal, el administrador lo corrige en el panel.

## Qué partidos entran
- **LaLiga**: todos.
- **Champions, Europa League y Conference**: fase de liga solo con equipos españoles; todas las eliminatorias (playoff, octavos, cuartos, semis y final). Las rondas previas no.
- **Liga de Naciones**: Liga A, cualquier partido de España y la fase final.

Se cambia en `classifyRound` (logic.js) y en `fullImport` (api/_server.js).

## Puntuación
Ver la pestaña **Reglas** de la web o `logic.js`. Pruebas: `npm test`.

## Próximamente
Bote del grupo, duelos 1v1 y badges.
