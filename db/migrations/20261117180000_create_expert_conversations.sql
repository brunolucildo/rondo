-- 0020-experts-chat-history: one conversation per (user, expert) and its messages.
--
-- The conversation of the user with an expert lives on the server: the API reads the context
-- from here (the client no longer sends `history`) and writes both sides of every turn. An
-- answer that stopped half way is kept with `status = 'incomplete'`.
--
-- Retention (BUSINESS.md, health data may be in here): a conversation keeps at most
-- 200 messages. Writing the 201st removes the oldest one in the same transaction, so the
-- append is the SQL function `expert_append_message` (atomicity to guarantee). Messages stay
-- until the user clears the conversation (`delete` on the conversation cascades to them) or
-- the user is deleted.
--
-- Security model (same as users, auth_tokens and sessions, see the 0004 migration):
--   * both tables belong to `rondo_migrator`; the API connects as `rondo_app` with DML only
--     (no DDL: `create`, `alter` and `drop` fail with SQLSTATE 42501) and `execute` on the function;
--   * the API always takes `user_id` from the session; there is no RLS, PostgREST or `anon`.
--
-- The message content is never logged by the API (nor by this file): it is free text from users.
-- Citations of the answers (0024) will add their own column by a later migration.
--
-- Rollback (run manually, in this order; it erases every conversation):
--   drop function if exists public.expert_append_message(uuid, text, text, text, text, integer);
--   drop table if exists public.expert_messages;
--   drop table if exists public.expert_conversations;

create table if not exists public.expert_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  -- An id of the catalog in code (for example `head-coach`); the API validates it.
  expert_id text not null check (expert_id ~ '^[a-z][a-z0-9-]{0,62}$'),
  created_at timestamptz not null default now(),
  -- One conversation per user and expert.
  constraint expert_conversations_user_expert_key unique (user_id, expert_id)
);

create table if not exists public.expert_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.expert_conversations (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) > 0),
  status text not null default 'complete' check (status in ('complete', 'incomplete')),
  -- `clock_timestamp()`, not `now()`: two messages of one turn never share an instant.
  created_at timestamptz not null default clock_timestamp()
);

-- Reading a page (newest first, cursor by `(created_at, id)`) and trimming the oldest.
create index if not exists expert_messages_conversation_created_idx
  on public.expert_messages (conversation_id, created_at, id);

grant select, insert, update, delete on table public.expert_conversations to rondo_app;
grant select, insert, update, delete on table public.expert_messages to rondo_app;

-- Appends one message to the conversation of the user with the expert (creating it on the
-- first message) and removes the oldest messages beyond `p_max_messages`, all in one
-- transaction. The `on conflict ... do update` takes the lock of the conversation row, so two
-- simultaneous appends to the same conversation run one after the other.
-- Returns the id and the instant of the new message. Fails with 23503 for an unknown user.
create or replace function public.expert_append_message(
  p_user_id uuid,
  p_expert_id text,
  p_role text,
  p_content text,
  p_status text,
  p_max_messages integer
)
returns table (message_id uuid, message_created_at timestamptz)
language plpgsql
set search_path = ''
as $$
declare
  v_conversation_id uuid;
  v_message_id uuid;
  v_created_at timestamptz;
begin
  if p_max_messages is null or p_max_messages < 1 then
    raise exception 'p_max_messages must be at least 1' using errcode = '22023';
  end if;

  insert into public.expert_conversations as c (user_id, expert_id)
  values (p_user_id, p_expert_id)
  on conflict on constraint expert_conversations_user_expert_key
    do update set expert_id = excluded.expert_id
  returning c.id into v_conversation_id;

  insert into public.expert_messages as m (conversation_id, role, content, status)
  values (v_conversation_id, p_role, p_content, p_status)
  returning m.id, m.created_at into v_message_id, v_created_at;

  delete from public.expert_messages d
  where d.conversation_id = v_conversation_id
    and d.id in (
      select o.id
      from public.expert_messages o
      where o.conversation_id = v_conversation_id
      order by o.created_at desc, o.id desc
      offset p_max_messages
    );

  return query select v_message_id, v_created_at;
end;
$$;

revoke all on function public.expert_append_message(uuid, text, text, text, text, integer)
  from public;
grant execute on function public.expert_append_message(uuid, text, text, text, text, integer)
  to rondo_app;
