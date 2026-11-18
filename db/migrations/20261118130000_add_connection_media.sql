-- 0028-connections-audio-video: audio (MP3) and video (MP4) connections.
--
-- * `connections.kind` accepts `audio` and `video`. The check constraint is dropped and recreated
--   under its usual name (`connections_kind_check`) with the whole list of kinds of the epic
--   (the image and URL kinds of the neighbouring specs are named here too), so the order in which
--   the migrations of those specs run does not matter: the last one to run leaves every kind valid.
-- * `connections.duration_seconds`: the length of the media, read from its metadata when it was
--   sent (null for documents). The listing shows it.
-- * `connection_media_usage`: the ledger behind the daily limit of media processing (100 minutes
--   per user in a rolling 24 hours). A row is written when a media is accepted for processing and
--   it outlives the connection: deleting a media does not give the minutes back, so the limit
--   cannot be bypassed by deleting and sending again. It holds seconds and an instant only (no
--   file name, no hash, no content) and is removed with the user.
--
-- Same security model as `connections` (0023): the tables belong to `rondo_migrator`; the API
-- connects as `rondo_app` with DML only; every query carries the `user_id` of the session.
--
-- Rollback (run manually, in this order; it forgets the durations and the day's usage; delete the
-- audio and video connections first, or the check below fails):
--   drop table if exists public.connection_media_usage;
--   alter table public.connections drop column if exists duration_seconds;
--   alter table public.connections drop constraint if exists connections_kind_check;
--   alter table public.connections add constraint connections_kind_check
--     check (kind in ('pdf', 'txt', 'md'));

alter table public.connections drop constraint if exists connections_kind_check;

alter table public.connections
  add constraint connections_kind_check
  check (kind in ('pdf', 'txt', 'md', 'image', 'url', 'audio', 'video'));

alter table public.connections
  add column if not exists duration_seconds integer
    constraint connections_duration_seconds_positive
      check (duration_seconds is null or duration_seconds > 0);

create table if not exists public.connection_media_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  seconds integer not null check (seconds > 0),
  used_at timestamptz not null default now()
);

-- The daily limit sums the last 24 hours of one user.
create index if not exists connection_media_usage_user_used_idx
  on public.connection_media_usage (user_id, used_at);

grant select, insert, update, delete on table public.connection_media_usage to rondo_app;
