-- 0027-connections-url: a connection can be a link (an external page the user pasted).
--
-- `kind` accepts `url`. `url_hash` is the SHA-256 (lower-case hex) of the CANONICAL URL (scheme and
-- host in lower case, no fragment, no default port, no `utm_*`, sorted query): it lets the API
-- recognise a link it already connected before making any request. The URL itself is never stored
-- (its query may hold a token); `name` holds the display name (the page title, or `host/path`
-- without query or fragment). `(user_id, url_hash)` is unique when the hash is not null, so two
-- simultaneous requests for the same link resolve to one row. File connections keep `url_hash`
-- null and their `(user_id, content_hash)` identity; a link also has a `content_hash` (SHA-256 of
-- the extracted text), so two different links with the same text are one connection.
--
-- The `kind` check is rebuilt from the kinds it already allows plus `url`, so this migration does
-- not undo the kinds that other specs add to the same check (images, audio, video), whatever the
-- order they are applied in.
--
-- Rollback (run manually; delete the links first, or the old check fails):
--   delete from public.connections where kind = 'url';
--   drop index if exists public.connections_user_id_url_hash_key;
--   alter table public.connections drop column if exists url_hash;
--   -- then rebuild connections_kind_check without 'url' (keep the other kinds it lists).

alter table public.connections
  add column if not exists url_hash text
  constraint connections_url_hash_format check (url_hash is null or url_hash ~ '^[0-9a-f]{64}$');

do $$
declare
  definition text;
  kinds text[];
begin
  select pg_get_constraintdef(oid)
    into definition
    from pg_constraint
   where conrelid = 'public.connections'::regclass
     and conname = 'connections_kind_check';

  if definition is null then
    kinds := array['pdf', 'txt', 'md'];
  else
    select coalesce(array_agg(match[1]), array[]::text[])
      into kinds
      from regexp_matches(definition, '''([a-z_]+)''', 'g') as match;
  end if;

  if not ('url' = any (kinds)) then
    kinds := kinds || 'url';
  end if;

  alter table public.connections drop constraint if exists connections_kind_check;
  execute format(
    'alter table public.connections add constraint connections_kind_check check (kind in (%s))',
    (select string_agg(quote_literal(kind), ', ') from unnest(kinds) as kind)
  );
end
$$;

create unique index if not exists connections_user_id_url_hash_key
  on public.connections (user_id, url_hash)
  where url_hash is not null;
