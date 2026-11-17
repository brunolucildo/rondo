-- 0023-connections-text-files: documents a user connected to the experts (PDF, TXT and Markdown).
--
-- A row is the identity of one connected content for one user: `content_hash` is the SHA-256 of
-- the file bytes, and `(user_id, content_hash)` is unique, so connecting the same bytes twice (even
-- from two tabs at once) resolves to one row and one processing. The original file is never kept:
-- the extracted text lives as chunks in the vector index (Weaviate, one tenant per user); this
-- table only holds the metadata and the status the interface follows.
--
-- Security model (same as users, sessions and auth_tokens): the table belongs to `rondo_migrator`;
-- the API connects as `rondo_app`, which gets DML; there is no RLS, so every query of the API
-- carries `user_id` from the session. The file name is the user's own text: it never goes to logs.
--
-- Rollback (run manually; it forgets every connection, the chunks stay in the index until the
-- tenant is purged):
--   drop table if exists public.connections;

create table if not exists public.connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  kind text not null check (kind in ('pdf', 'txt', 'md')),
  name text not null check (char_length(name) between 1 and 255),
  size_bytes bigint not null check (size_bytes > 0),
  -- SHA-256 of the bytes, lower-case hex.
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('processing', 'ready', 'failed')),
  chunk_count integer not null default 0 check (chunk_count >= 0),
  -- Closed set written by the API; set exactly when the status is `failed`.
  error_code text check (error_code is null or error_code ~ '^[A-Z_]{1,64}$'),
  created_at timestamptz not null default now(),
  -- Starts the 15 minute clock of a connection stuck in `processing`.
  updated_at timestamptz not null default now(),
  constraint connections_error_code_matches_status check ((status = 'failed') = (error_code is not null)),
  -- One connection per user and content: the database settles concurrent uploads of the same file.
  constraint connections_user_id_content_hash_key unique (user_id, content_hash)
);

grant select, insert, update, delete on table public.connections to rondo_app;
