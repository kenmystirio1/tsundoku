-- Tsundoku: run once in Supabase → SQL Editor → New query → Run
create table if not exists public.items (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists items_user on public.items(user_id);
create table if not exists public.meta (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  key text not null,
  data jsonb not null,
  primary key (user_id, key)
);
alter table public.items enable row level security;
alter table public.meta enable row level security;
create policy "own items" on public.items for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own meta" on public.meta for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
alter publication supabase_realtime add table public.items;

insert into storage.buckets (id, name, public) values ('covers', 'covers', true) on conflict do nothing;
create policy "covers upload own" on storage.objects for insert to authenticated with check (bucket_id = 'covers' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "covers delete own" on storage.objects for delete to authenticated using (bucket_id = 'covers' and (storage.foldername(name))[1] = auth.uid()::text);
