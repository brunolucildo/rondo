-- 0026-connections-images: a connection can also be an image (JPG, JPEG or PNG).
--
-- The image is turned into text by a vision model and the text goes to the vector index like any
-- other connection; only the `kind` check of `public.connections` changes. No column, no grant:
-- the table, its ownership and the privileges of `rondo_app` stay as 0023 created them.
--
-- Rollback (run manually; the rows of kind `image` must be deleted first, or the check fails):
--   delete from public.connections where kind = 'image';
--   alter table public.connections drop constraint connections_kind_check;
--   alter table public.connections
--     add constraint connections_kind_check check (kind in ('pdf', 'txt', 'md'));

alter table public.connections drop constraint if exists connections_kind_check;

alter table public.connections
  add constraint connections_kind_check check (kind in ('pdf', 'txt', 'md', 'image'));
