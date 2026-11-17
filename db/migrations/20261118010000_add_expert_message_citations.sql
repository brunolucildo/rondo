-- 0024-experts-grounded-answers: the sources an answer of an expert was grounded on.
--
-- `expert_messages.citations` is built by the server from the chunks it retrieved for the
-- question (never copied from the model's text) and stored with the answer. Its three states:
--   * `null`  -> no retrieval ran (a message of the user, a user without ready connections, or a
--                message written before this migration);
--   * `[]`    -> retrieval ran and no connected source covers the question (the "gap" answer);
--   * `[...]` -> the sources used. Each element is an object with only these keys:
--                `connectionId` (uuid text), `sourceName` (text), `page` (integer or null) and
--                `position` (integer).
-- The text of a chunk is never stored here: a deleted source must not leave its content behind
-- in the history (LGPD). The API validates the shape on write and on read.
--
-- `expert_append_message` gains `p_citations jsonb default null`. The old six-argument function
-- is dropped and replaced (same grants), so a call with six arguments still resolves to the new
-- one and keeps working.
--
-- Rollback (run manually, in this order; it drops the stored citations):
--   drop function if exists public.expert_append_message(uuid, text, text, text, text, integer, jsonb);
--   alter table public.expert_messages drop column if exists citations;
--   -- then recreate the six-argument function from 20261117180000_create_expert_conversations.sql

alter table public.expert_messages
  add column if not exists citations jsonb
    constraint expert_messages_citations_is_array
      check (citations is null or jsonb_typeof(citations) = 'array');

drop function if exists public.expert_append_message(uuid, text, text, text, text, integer);

create or replace function public.expert_append_message(
  p_user_id uuid,
  p_expert_id text,
  p_role text,
  p_content text,
  p_status text,
  p_max_messages integer,
  p_citations jsonb default null
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

  insert into public.expert_messages as m (conversation_id, role, content, status, citations)
  values (v_conversation_id, p_role, p_content, p_status, p_citations)
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

revoke all on function public.expert_append_message(uuid, text, text, text, text, integer, jsonb)
  from public;
grant execute on function public.expert_append_message(uuid, text, text, text, text, integer, jsonb)
  to rondo_app;
