-- READ. - Additive migration fuer geteilte Buchabschluesse und Emoji-Reaktionen.
-- Im Supabase SQL Editor nach supabase_friends_setup.sql ausfuehren.
-- Pro Person ist je Beitrag eine Reaktion moeglich; Hover zeigt die Namen.
-- Bei erneutem Ausfuehren wird auch die Reaktionsfunktion aktualisiert.
-- Bestehende Profile, Freundschaften und Lesedaten bleiben unveraendert.

create table if not exists public.friend_reading_posts (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    book_title text not null check (char_length(btrim(book_title)) between 1 and 300),
    created_at timestamptz not null default now()
);

create index if not exists friend_reading_posts_created_at_idx
    on public.friend_reading_posts (created_at desc);

create table if not exists public.friend_reading_post_reactions (
    post_id uuid not null references public.friend_reading_posts (id) on delete cascade,
    user_id uuid not null references auth.users (id) on delete cascade,
    emoji text not null check (emoji in ('❤️', '👏', '😂', '🔥', '📚', '😮', '👍', '🚀', '🤔', '🎉', '💡', '🙏', '💯')),
    created_at timestamptz not null default now(),
    primary key (post_id, user_id)
);

with ranked_reactions as (
    select
        ctid,
        row_number() over (
            partition by post_id, user_id
            order by created_at desc, emoji
        ) as reaction_rank
    from public.friend_reading_post_reactions
)
delete from public.friend_reading_post_reactions as post_reaction
using ranked_reactions
where post_reaction.ctid = ranked_reactions.ctid
  and ranked_reactions.reaction_rank > 1;

alter table public.friend_reading_post_reactions
    drop constraint if exists friend_reading_post_reactions_pkey;
alter table public.friend_reading_post_reactions
    add constraint friend_reading_post_reactions_pkey primary key (post_id, user_id);

alter table public.friend_reading_posts enable row level security;
alter table public.friend_reading_post_reactions enable row level security;

revoke all on public.friend_reading_posts from anon, authenticated;
revoke all on public.friend_reading_post_reactions from anon, authenticated;

create or replace function public.get_my_friend_reading_posts()
returns table (
    post_id uuid,
    author_name text,
    book_title text,
    posted_at timestamptz,
    is_own boolean,
    reactions jsonb,
    my_reactions jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
    select
        reading_post.id,
        coalesce(
            nullif(author.raw_user_meta_data ->> 'full_name', ''),
            nullif(author.raw_user_meta_data ->> 'name', ''),
            nullif(author.raw_user_meta_data ->> 'given_name', ''),
            nullif(split_part(author.email, '@', 1), ''),
            'Leser'
        ),
        reading_post.book_title,
        reading_post.created_at,
        reading_post.user_id = (select auth.uid()),
        coalesce((
            select jsonb_agg(
                jsonb_build_object(
                    'emoji', grouped_reactions.emoji,
                    'count', grouped_reactions.reaction_count,
                    'reactors', grouped_reactions.reactor_names
                )
                order by grouped_reactions.emoji
            )
            from (
                select
                    reaction_names.emoji,
                    count(*)::integer as reaction_count,
                    jsonb_agg(reaction_names.display_name order by reaction_names.display_name) as reactor_names
                from (
                    select
                        post_reaction.emoji,
                        coalesce(
                            nullif(reactor.raw_user_meta_data ->> 'full_name', ''),
                            nullif(reactor.raw_user_meta_data ->> 'name', ''),
                            nullif(reactor.raw_user_meta_data ->> 'given_name', ''),
                            nullif(split_part(reactor.email, '@', 1), ''),
                            'Leser'
                        ) as display_name
                    from public.friend_reading_post_reactions as post_reaction
                    join auth.users as reactor
                        on reactor.id = post_reaction.user_id
                    where post_reaction.post_id = reading_post.id
                ) as reaction_names
                group by reaction_names.emoji
            ) as grouped_reactions
        ), '[]'::jsonb),
        coalesce((
            select jsonb_agg(own_reaction.emoji order by own_reaction.emoji)
            from public.friend_reading_post_reactions as own_reaction
            where own_reaction.post_id = reading_post.id
              and own_reaction.user_id = (select auth.uid())
        ), '[]'::jsonb)
    from public.friend_reading_posts as reading_post
    join auth.users as author
        on author.id = reading_post.user_id
    where reading_post.user_id = (select auth.uid())
       or exists (
            select 1
            from public.friendships as friendship
            where (friendship.user_id = (select auth.uid()) and friendship.friend_id = reading_post.user_id)
               or (friendship.friend_id = (select auth.uid()) and friendship.user_id = reading_post.user_id)
       )
    order by reading_post.created_at desc
    limit 100;
$$;

create or replace function public.share_finished_book(p_book_title text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_user_id uuid := auth.uid();
    new_post_id uuid;
begin
    if current_user_id is null then
        raise exception 'Du musst angemeldet sein, um ein Buch zu teilen.';
    end if;
    if p_book_title is null or char_length(btrim(p_book_title)) not between 1 and 300 then
        raise exception 'Der Buchtitel muss zwischen 1 und 300 Zeichen lang sein.';
    end if;

    insert into public.friend_reading_posts (user_id, book_title)
    values (current_user_id, btrim(p_book_title))
    returning id into new_post_id;

    return new_post_id;
end;
$$;

create or replace function public.toggle_friend_reading_post_reaction(p_post_id uuid, p_emoji text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_user_id uuid := auth.uid();
    existing_emoji text;
begin
    if current_user_id is null then
        raise exception 'Du musst angemeldet sein, um zu reagieren.';
    end if;
    if p_emoji is null or p_emoji not in ('❤️', '👏', '😂', '🔥', '📚', '😮', '👍', '🚀', '🤔', '🎉', '💡', '🙏', '💯') then
        raise exception 'Diese Emoji-Reaktion ist nicht verfuegbar.';
    end if;
    if not exists (
        select 1
        from public.friend_reading_posts as reading_post
        where reading_post.id = p_post_id
          and (
              reading_post.user_id = current_user_id
              or exists (
                select 1
                from public.friendships as friendship
                where (friendship.user_id = current_user_id and friendship.friend_id = reading_post.user_id)
                   or (friendship.friend_id = current_user_id and friendship.user_id = reading_post.user_id)
              )
          )
    ) then
        raise exception 'Auf diesen Beitrag hast du keinen Zugriff.';
    end if;

    select post_reaction.emoji
    into existing_emoji
    from public.friend_reading_post_reactions as post_reaction
    where post_reaction.post_id = p_post_id
      and post_reaction.user_id = current_user_id
    for update;

    if existing_emoji = p_emoji then
        delete from public.friend_reading_post_reactions as post_reaction
        where post_reaction.post_id = p_post_id
          and post_reaction.user_id = current_user_id;
        return false;
    end if;

    insert into public.friend_reading_post_reactions (post_id, user_id, emoji)
    values (p_post_id, current_user_id, p_emoji)
    on conflict (post_id, user_id) do update
        set emoji = excluded.emoji,
            created_at = now();
    return true;
end;
$$;

revoke all on function public.get_my_friend_reading_posts() from public, anon;
revoke all on function public.share_finished_book(text) from public, anon;
revoke all on function public.toggle_friend_reading_post_reaction(uuid, text) from public, anon;

grant execute on function public.get_my_friend_reading_posts() to authenticated;
grant execute on function public.share_finished_book(text) to authenticated;
grant execute on function public.toggle_friend_reading_post_reaction(uuid, text) to authenticated;
