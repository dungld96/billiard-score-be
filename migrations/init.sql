-- init.sql
create extension if not exists "pgcrypto";

create table if not exists games (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  status text default 'pending',
  max_players int check (max_players between 2 and 5),
  title text
);

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  game_id uuid references games(id) on delete cascade,
  name text not null,
  seat int,
  score int default 0
);

create table if not exists score_updates (
  id uuid primary key default gen_random_uuid(),
  game_id uuid references games(id) on delete cascade,
  player_id uuid references players(id) on delete cascade,
  delta int not null,
  created_at timestamptz default now(),
  note text
);
