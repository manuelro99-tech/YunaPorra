-- =====================================================================
--  YUNA PORRA · Esquema de base de datos (Supabase / Postgres)
--  Pega TODO este archivo en Supabase → SQL Editor → New query → Run.
--  Se puede ejecutar más de una vez sin romper nada.
-- =====================================================================

-- ---------- Perfiles de jugador ----------
create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  name          text not null check (char_length(name) between 2 and 24),
  fav_team_id   integer,
  fav_team_name text,
  is_admin      boolean not null default false,
  created_at    timestamptz not null default now()
);

-- ---------- Partidos (los rellena /api/sync desde API-Football) ----------
create table if not exists public.matches (
  id          bigint primary key,            -- id del partido en API-Football
  competition text   not null,               -- LALIGA | UCL | UEL | UECL | UNL
  round       text,                          -- texto original de la ronda
  stage       text   not null default 'league', -- league | ko
  ko_round    text,                          -- PO | R16 | QF | SF | 3P | F
  kickoff     timestamptz not null,
  home_id     integer,  home text, home_logo text,
  away_id     integer,  away text, away_logo text,
  status      text not null default 'NS',    -- NS, 1H, HT, 2H, ET, P, FT, AET, PEN, PST, CANC…
  ft_home     integer,  ft_away integer,     -- resultado a los 90'
  total_home  integer,  total_away integer,  -- resultado final (con prórroga)
  pen_home    integer,  pen_away integer,    -- penaltis
  advance     text check (advance in ('home','away')), -- solo si el admin lo fija a mano
  manual      boolean not null default false, -- true = el admin tocó el resultado; la sync no lo pisa
  updated_at  timestamptz not null default now()
);
create index if not exists matches_kickoff_idx on public.matches (kickoff);
create index if not exists matches_comp_idx on public.matches (competition);

-- ---------- Predicciones ----------
create table if not exists public.predictions (
  user_id    uuid   not null default auth.uid() references public.profiles (id) on delete cascade,
  match_id   bigint not null references public.matches (id) on delete cascade,
  sign       text check (sign in ('1','X','2')),
  home_goals integer check (home_goals between 0 and 20),
  away_goals integer check (away_goals between 0 and 20),
  advance    text check (advance in ('home','away')),
  is_fav     boolean not null default false,  -- lo calcula la base de datos, no el móvil
  updated_at timestamptz not null default now(),
  primary key (user_id, match_id)
);

-- ---------- Ajustes por competición (plazos y resultados de campeón/pichichi) ----------
create table if not exists public.comp_settings (
  competition    text primary key,
  picks_deadline timestamptz not null,
  champion_id    integer,
  champion       text,
  top_scorers    text[] not null default '{}'
);

-- ---------- Apuestas fijas: campeón y pichichi ----------
create table if not exists public.picks (
  user_id     uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  competition text not null references public.comp_settings (competition) on delete cascade,
  champion_id integer,
  champion    text,
  scorer      text check (char_length(scorer) <= 60),
  updated_at  timestamptz not null default now(),
  primary key (user_id, competition)
);

-- ---------- Estado interno (marcas de tiempo de la sincronización) ----------
create table if not exists public.app_state (
  key   text primary key,
  value jsonb
);

-- Plazos iniciales para campeón y pichichi (el admin los puede cambiar)
insert into public.comp_settings (competition, picks_deadline) values
  ('LALIGA', '2026-12-07 21:00+01'),
  ('UCL',    '2026-12-07 21:00+01'),
  ('UEL',    '2026-12-07 21:00+01'),
  ('UECL',   '2026-12-07 21:00+01'),
  ('UNL',    '2027-03-01 21:00+01')
on conflict (competition) do nothing;

-- =====================================================================
--  Funciones auxiliares
-- =====================================================================
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- El equipo favorito solo se elige una vez (si hace falta cambiarlo, lo hace el admin)
create or replace function public.lock_fav_team() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.fav_team_id is not null
     and new.fav_team_id is distinct from old.fav_team_id
     and not public.is_admin()
     and coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'El equipo favorito ya está elegido. Pídeselo al administrador si quieres cambiarlo.';
  end if;
  return new;
end $$;
drop trigger if exists profiles_lock_fav on public.profiles;
create trigger profiles_lock_fav before update on public.profiles
  for each row execute function public.lock_fav_team();

-- Antes de guardar una predicción: marca si es partido de tu equipo y limpia datos
create or replace function public.prepare_prediction() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m public.matches;
  fav integer;
begin
  select * into m from public.matches where id = new.match_id;
  if m.id is null then raise exception 'Partido no encontrado'; end if;
  if m.kickoff <= now() then raise exception 'Este partido ya ha empezado'; end if;

  select fav_team_id into fav from public.profiles where id = new.user_id;
  new.is_fav := (fav is not null and fav in (m.home_id, m.away_id))
                or (m.competition = 'UNL' and (9 in (m.home_id, m.away_id) or 'Spain' in (m.home, m.away)));

  -- Si hay marcador, el signo sale del marcador
  if new.home_goals is not null and new.away_goals is not null then
    new.sign := case when new.home_goals > new.away_goals then '1'
                     when new.home_goals < new.away_goals then '2'
                     else 'X' end;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists predictions_prepare on public.predictions;
create trigger predictions_prepare before insert or update on public.predictions
  for each row execute function public.prepare_prediction();

-- ---------- Funciones del administrador ----------
create or replace function public.admin_set_result(
  p_id bigint, p_ft_home int, p_ft_away int,
  p_total_home int default null, p_total_away int default null,
  p_pen_home int default null, p_pen_away int default null,
  p_advance text default null, p_status text default 'FT'
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Solo el administrador'; end if;
  update public.matches set
    ft_home = p_ft_home, ft_away = p_ft_away,
    total_home = coalesce(p_total_home, p_ft_home),
    total_away = coalesce(p_total_away, p_ft_away),
    pen_home = p_pen_home, pen_away = p_pen_away,
    advance = p_advance, status = p_status,
    manual = true, updated_at = now()
  where id = p_id;
end $$;

create or replace function public.admin_release_match(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Solo el administrador'; end if;
  update public.matches set manual = false, advance = null where id = p_id;
end $$;

create or replace function public.admin_set_settings(
  p_comp text, p_deadline timestamptz, p_champion_id int, p_champion text, p_scorers text[]
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Solo el administrador'; end if;
  update public.comp_settings set
    picks_deadline = p_deadline, champion_id = p_champion_id,
    champion = p_champion, top_scorers = coalesce(p_scorers, '{}')
  where competition = p_comp;
end $$;

create or replace function public.admin_set_fav(p_user uuid, p_team_id int, p_team_name text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Solo el administrador'; end if;
  update public.profiles set fav_team_id = p_team_id, fav_team_name = p_team_name where id = p_user;
end $$;

-- =====================================================================
--  Seguridad (Row Level Security)
-- =====================================================================
alter table public.profiles      enable row level security;
alter table public.matches       enable row level security;
alter table public.predictions   enable row level security;
alter table public.comp_settings enable row level security;
alter table public.picks         enable row level security;
alter table public.app_state     enable row level security;

-- Perfiles: todos los jugadores se ven; cada uno crea y edita el suyo
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (true);
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles for insert to authenticated
  with check (id = auth.uid() and is_admin = false);
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
-- Nadie puede hacerse admin a sí mismo: solo se pueden editar estas columnas
revoke update on public.profiles from authenticated, anon;
grant update (name, fav_team_id, fav_team_name) on public.profiles to authenticated;

-- Partidos y ajustes: lectura para todos; escritura solo con funciones de admin o la sync
drop policy if exists matches_read on public.matches;
create policy matches_read on public.matches for select using (true);
drop policy if exists settings_read on public.comp_settings;
create policy settings_read on public.comp_settings for select using (true);

-- Predicciones: las tuyas siempre; las de los demás solo cuando el partido ha empezado
drop policy if exists predictions_read on public.predictions;
create policy predictions_read on public.predictions for select to authenticated using (
  user_id = auth.uid()
  or exists (select 1 from public.matches m where m.id = match_id and m.kickoff <= now())
);
drop policy if exists predictions_insert on public.predictions;
create policy predictions_insert on public.predictions for insert to authenticated
  with check (user_id = auth.uid());
drop policy if exists predictions_update on public.predictions;
create policy predictions_update on public.predictions for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Campeón y pichichi: los tuyos siempre; los de los demás cuando se cierra el plazo
drop policy if exists picks_read on public.picks;
create policy picks_read on public.picks for select to authenticated using (
  user_id = auth.uid()
  or exists (select 1 from public.comp_settings s
             where s.competition = picks.competition and s.picks_deadline <= now())
);
drop policy if exists picks_write on public.picks;
create policy picks_write on public.picks for insert to authenticated with check (
  user_id = auth.uid()
  and exists (select 1 from public.comp_settings s
              where s.competition = picks.competition and s.picks_deadline > now())
);
drop policy if exists picks_update on public.picks;
create policy picks_update on public.picks for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.comp_settings s
                where s.competition = picks.competition and s.picks_deadline > now())
  );

-- app_state: solo la sincronización (clave secreta) lo toca; nadie más lo lee
-- (sin políticas = sin acceso para usuarios normales)

grant execute on function public.admin_set_result(bigint,int,int,int,int,int,int,text,text) to authenticated;
grant execute on function public.admin_release_match(bigint) to authenticated;
grant execute on function public.admin_set_settings(text,timestamptz,int,text,text[]) to authenticated;
grant execute on function public.admin_set_fav(uuid,int,text) to authenticated;
