-- ============================================================================
-- 達人への道 — Supabase テーブル定義
-- わんにゃんメモリーと同じプロジェクトに相乗りするため、
-- 「authenticated に grant / anon から revoke / RLS＋ポリシー」を毎回明示する。
-- Supabase ダッシュボード → SQL Editor に貼って実行する。
-- 何度実行しても壊れないように書いてある。
-- ============================================================================

-- ── 1) 分野の構造（改名・削除を端末間で伝えるための小さな箱。1ユーザー1行） ──
create table if not exists public.tatsujin_state (
  user_id    uuid        primary key references auth.users(id) on delete cascade,
  doc        jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ── 2) セッション（追加しか起きないので端末間で衝突しない） ──
create table if not exists public.tatsujin_sessions (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  id         text        not null,             -- アプリが作るID
  field      text        not null,
  started_at timestamptz not null,
  ended_at   timestamptz not null,
  hours      double precision not null,
  device_id  text        not null,
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists tatsujin_sessions_user_started_idx
  on public.tatsujin_sessions (user_id, started_at desc);

-- ── 3) 端末ごとの「いま記録中」（端末ごとに1行なので上書き競合しない） ──
create table if not exists public.tatsujin_live (
  user_id     uuid        not null references auth.users(id) on delete cascade,
  device_id   text        not null,
  device_name text        not null default '',
  field       text,
  started_at  timestamptz,
  active      boolean     not null default false,
  updated_at  timestamptz not null default now(),
  primary key (user_id, device_id)
);

-- ── RLS ──
alter table public.tatsujin_state    enable row level security;
alter table public.tatsujin_sessions enable row level security;
alter table public.tatsujin_live     enable row level security;

drop policy if exists tatsujin_state_own    on public.tatsujin_state;
drop policy if exists tatsujin_sessions_own on public.tatsujin_sessions;
drop policy if exists tatsujin_live_own     on public.tatsujin_live;

create policy tatsujin_state_own on public.tatsujin_state
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy tatsujin_sessions_own on public.tatsujin_sessions
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy tatsujin_live_own on public.tatsujin_live
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── 権限（anon は完全に締め出す。自動設定に頼らず明示する） ──
revoke all on public.tatsujin_state    from anon;
revoke all on public.tatsujin_sessions from anon;
revoke all on public.tatsujin_live     from anon;

grant select, insert, update, delete on public.tatsujin_state    to authenticated;
grant select, insert, update, delete on public.tatsujin_sessions to authenticated;
grant select, insert, update, delete on public.tatsujin_live     to authenticated;

-- ── 確認用（anon で叩くと permission denied になるのが正しい） ──
-- select * from public.tatsujin_sessions limit 1;
