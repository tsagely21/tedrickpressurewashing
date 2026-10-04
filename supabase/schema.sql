-- Tedrick Mobile Pressure Washing: Supabase schema
-- Run once in the Supabase dashboard: SQL Editor > New query > paste this whole file > Run.
-- It is safe to run again later (it updates functions and policies in place and never drops data).
--
-- Security model
--   * Every table has Row Level Security ON and NO policies, and anon/authenticated have no table
--     privileges, so the tables cannot be read or written directly from the browser.
--   * The website talks to the database only through the functions below (SECURITY DEFINER).
--     Customer functions need no login; owner_* functions require a logged-in owner (see owners table).
--   * Confirmed appointments cannot overlap: enforced by an exclusion constraint inside the database,
--     so even simultaneous approvals cannot both succeed.

create extension if not exists btree_gist;

-- ============================================================ tables

create table if not exists public.settings (
  id int primary key default 1 check (id = 1),
  scheduling jsonb not null,
  updated_at timestamptz not null default now()
);

-- Default scheduling (placeholders). The owner dashboard re-syncs this from config/site.config.json.
insert into public.settings (id, scheduling) values (1, $json$
{"timezone":"America/Chicago","placeholder":true,
 "businessHours":{"0":null,"1":{"open":"08:00","close":"17:00"},"2":{"open":"08:00","close":"17:00"},"3":{"open":"08:00","close":"17:00"},"4":{"open":"08:00","close":"17:00"},"5":{"open":"08:00","close":"17:00"},"6":{"open":"08:00","close":"17:00"}},
 "windows":[{"id":"morning","label":"Morning","start":"08:00","end":"12:00"},{"id":"afternoon","label":"Afternoon","start":"12:00","end":"17:00"},{"id":"full-day","label":"Full day","start":"08:00","end":"17:00","fullDay":true}],
 "leadDays":1,"horizonDays":90}
$json$::jsonb) on conflict (id) do nothing;

create table if not exists public.owners (
  user_id uuid primary key references auth.users (id) on delete cascade
);

create table if not exists public.quotes (
  id uuid primary key,
  ref text not null unique,
  token text not null unique,
  created_at timestamptz not null default now(),
  status text not null default 'new' check (status in ('new', 'contacted', 'closed')),
  data jsonb not null,
  submitter text
);
create index if not exists quotes_created_idx on public.quotes (created_at desc);

create table if not exists public.photos (
  id bigint generated always as identity primary key,
  quote_id uuid not null references public.quotes (id) on delete cascade,
  path text not null unique,
  original_name text
);

-- Times are minutes after midnight in the business time zone. slot_* is the confirmed (or proposed) time.
create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes (id) on delete cascade,
  status text not null check (status in ('pending', 'proposed', 'confirmed', 'declined', 'cancelled')),
  req_date date not null,
  req_window text not null,
  note text,
  slot_date date,
  slot_start int,
  slot_end int,
  full_day boolean not null default false,
  owner_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  slot_range int4range generated always as (
    case when full_day then int4range(0, 1440)
         when slot_start is null then null
         else int4range(slot_start, slot_end) end
  ) stored,
  constraint slot_valid check (slot_start is null or (slot_start >= 0 and slot_end <= 1440 and slot_end > slot_start)),
  -- The key safeguard: no two confirmed appointments may overlap on the same date.
  constraint no_overlapping_confirmed exclude using gist (slot_date with =, slot_range with &&) where (status = 'confirmed')
);
create unique index if not exists one_active_booking_per_quote on public.bookings (quote_id) where status in ('pending', 'proposed', 'confirmed');
create index if not exists bookings_slot_idx on public.bookings (slot_date) where status = 'confirmed';

-- start_min/end_min NULL = whole day blocked.
create table if not exists public.blocks (
  id bigint generated always as identity primary key,
  date date not null,
  start_min int,
  end_min int,
  reason text,
  created_at timestamptz not null default now(),
  check ((start_min is null) = (end_min is null)),
  check (start_min is null or (start_min >= 0 and end_min <= 1440 and end_min > start_min))
);
create index if not exists blocks_date_idx on public.blocks (date);

alter table public.settings enable row level security;
alter table public.owners enable row level security;
alter table public.quotes enable row level security;
alter table public.photos enable row level security;
alter table public.bookings enable row level security;
alter table public.blocks enable row level security;
revoke all on public.settings, public.owners, public.quotes, public.photos, public.bookings, public.blocks from anon, authenticated;

-- ============================================================ internal helpers (not callable from the browser)

create or replace function public.fail(p_msg text, p_field text default null, p_code text default 'P0001')
returns void language plpgsql as $$
begin
  raise exception '%', p_msg using detail = coalesce(p_field, ''), errcode = p_code;
end $$;

create or replace function public.to_min(t text) returns int language sql immutable as $$
  select split_part(t, ':', 1)::int * 60 + split_part(t, ':', 2)::int
$$;

create or replace function public.jnum(j jsonb) returns numeric language sql immutable as $$
  select case when jsonb_typeof(j) = 'number' then (j #>> '{}')::numeric end
$$;

create or replace function public.sched() returns jsonb language sql stable security definer set search_path = public as $$
  select scheduling from settings where id = 1
$$;

create or replace function public.biz_tz() returns text language sql stable security definer set search_path = public as $$
  select scheduling ->> 'timezone' from settings where id = 1
$$;

create or replace function public.is_owner() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from owners where user_id = auth.uid())
$$;

create or replace function public.require_owner() returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not is_owner() then
    raise exception 'Not authorized.' using errcode = '42501';
  end if;
end $$;

create or replace function public.booking_json(b public.bookings) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'id', b.id, 'status', b.status,
    'requested', jsonb_build_object('date', b.req_date, 'windowId', b.req_window),
    'note', coalesce(b.note, ''),
    'slot', case when b.slot_date is null then null
                 else jsonb_build_object('date', b.slot_date, 'start', b.slot_start, 'end', b.slot_end, 'fullDay', b.full_day) end,
    'ownerMessage', coalesce(b.owner_message, ''),
    'createdAt', b.created_at, 'updatedAt', b.updated_at)
$$;

-- True when [p_start, p_end) on p_date overlaps a confirmed appointment or a blocked time.
create or replace function public.slot_conflict(p_date date, p_start int, p_end int, p_ignore uuid default null)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
           select 1 from bookings b
           where b.status = 'confirmed' and b.slot_date = p_date and b.id is distinct from p_ignore
             and b.slot_range && int4range(p_start, p_end))
      or exists (
           select 1 from blocks k
           where k.date = p_date and (k.start_min is null or int4range(k.start_min, k.end_min) && int4range(p_start, p_end)))
$$;

-- Confirm a booking. Takes a global lock, re-checks for conflicts, and relies on the exclusion constraint as a backstop.
create or replace function public.confirm_internal(p_id uuid, p_date date, p_start int, p_end int, p_full boolean, p_msg text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b bookings;
begin
  perform pg_advisory_xact_lock(7001);
  select * into b from bookings where id = p_id for update;
  if not found then perform fail('Booking not found.', null, 'P0002'); end if;
  if b.status not in ('pending', 'proposed') then
    perform fail('This request is already ' || b.status || '.');
  end if;
  if slot_conflict(p_date, case when p_full then 0 else p_start end, case when p_full then 1440 else p_end end, p_id) then
    perform fail('That time overlaps a confirmed appointment or a blocked time.');
  end if;
  begin
    update bookings
       set status = 'confirmed', slot_date = p_date, slot_start = case when p_full then 0 else p_start end,
           slot_end = case when p_full then 1440 else p_end end, full_day = p_full,
           owner_message = coalesce(p_msg, owner_message), updated_at = now()
     where id = p_id returning * into b;
  exception when exclusion_violation then
    perform fail('That time overlaps a confirmed appointment.');
  end;
  return booking_json(b);
end $$;

-- ============================================================ customer functions (no login needed)

create or replace function public.get_availability(p_from date default null, p_to date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  s jsonb := sched();
  tz text := s ->> 'timezone';
  local_now timestamp := now() at time zone tz;
  today date := local_now::date;
  nowmin int := extract(hour from local_now)::int * 60 + extract(minute from local_now)::int;
  mn date := today + (s ->> 'leadDays')::int;
  mx date := today + (s ->> 'horizonDays')::int;
  d date; v_last date; hrs jsonb; w jsonb; wins jsonb; days jsonb := '{}'::jsonb;
  anyopen boolean; ok boolean; o int; c int; ws int; we int; v_full boolean;
begin
  d := greatest(coalesce(p_from, mn), mn);
  v_last := least(coalesce(p_to, d + 41), mx, d + 100);
  while d <= v_last loop
    hrs := s -> 'businessHours' -> (extract(dow from d)::int)::text;
    wins := '{}'::jsonb;
    anyopen := false;
    if hrs is not null and jsonb_typeof(hrs) = 'object' then
      o := to_min(hrs ->> 'open');
      c := to_min(hrs ->> 'close');
      for w in select value from jsonb_array_elements(s -> 'windows') loop
        ws := to_min(w ->> 'start');
        we := to_min(w ->> 'end');
        v_full := coalesce((case when jsonb_typeof(w -> 'fullDay') = 'boolean' then (w -> 'fullDay')::boolean end), false);
        ok := ws >= o and we <= c and (d > today or ws > nowmin)
              and not slot_conflict(d, case when v_full then 0 else ws end, case when v_full then 1440 else we end);
        wins := wins || jsonb_build_object(w ->> 'id', ok);
        anyopen := anyopen or ok;
      end loop;
    end if;
    days := days || jsonb_build_object(to_char(d, 'YYYY-MM-DD'), jsonb_build_object('open', anyopen, 'windows', wins));
    d := d + 1;
  end loop;
  return jsonb_build_object(
    'timezone', tz, 'today', today, 'min', mn, 'max', mx, 'days', days,
    'windows', (select jsonb_agg(jsonb_build_object('id', x ->> 'id', 'label', x ->> 'label', 'start', x ->> 'start',
                  'end', x ->> 'end', 'fullDay', coalesce((case when jsonb_typeof(x -> 'fullDay') = 'boolean' then (x -> 'fullDay')::boolean end), false)))
                from jsonb_array_elements(s -> 'windows') x));
end $$;

create or replace function public.submit_quote(p_id uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_headers json := nullif(current_setting('request.headers', true), '')::json;
  v_ip text := coalesce(v_headers ->> 'cf-connecting-ip', v_headers ->> 'x-real-ip', v_headers ->> 'x-forwarded-for');
  it jsonb; v_items jsonb := '[]'::jsonb; v_seen text[] := '{}';
  v_id text; v_unsure boolean; v_area numeric; v_lin numeric; v_len numeric; v_wid numeric; v_fields jsonb;
  c jsonb := p_data -> 'contact';
  v_name text; v_phone text; v_email text; v_addr text; v_zip text; v_pref text;
  v_ref text; v_token text;
begin
  if p_id is null or p_data is null then perform fail('Could not submit this request.'); end if;
  if coalesce(p_data ->> 'website', '') <> '' then perform fail('Could not submit this request.', 'website'); end if;
  if octet_length(p_data::text) > 60000 then perform fail('That request is too large.'); end if;
  if v_ip is not null and (select count(*) from quotes where submitter = v_ip and created_at > now() - interval '1 hour') >= 10 then
    perform fail('Too many requests. Please call us instead.');
  end if;

  if p_data ->> 'propertyType' not in ('residential', 'commercial') or p_data ->> 'propertyType' is null then
    perform fail('Choose residential or commercial.', 'propertyType');
  end if;
  if coalesce(jsonb_typeof(p_data -> 'items'), '') <> 'array' then perform fail('Select at least one service.', 'services'); end if;
  if jsonb_array_length(p_data -> 'items') not between 1 and 12 then perform fail('Select at least one service.', 'services'); end if;

  for it in select value from jsonb_array_elements(p_data -> 'items') loop
    v_id := it ->> 'id';
    if v_id is null or v_id !~ '^[a-z][a-z-]{1,39}$' then perform fail('Unknown service.', 'services'); end if;
    if v_id = any (v_seen) then perform fail('Duplicate service.', 'services'); end if;
    v_seen := v_seen || v_id;
    v_unsure := coalesce((case when jsonb_typeof(it -> 'unsure') = 'boolean' then (it -> 'unsure')::boolean end), false);
    v_area := null; v_lin := null; v_len := jnum(it -> 'length'); v_wid := jnum(it -> 'width');
    if not v_unsure then
      v_area := jnum(it -> 'areaSqft');
      v_lin := jnum(it -> 'linearFt');
      if v_area is null and v_lin is null and v_len > 0 and v_wid > 0 then v_area := round(v_len * v_wid); end if;
      if not (coalesce(v_area, v_lin, 0) > 0 and coalesce(v_area, v_lin) < 1000000) then
        perform fail('Enter an approximate size for each service, or choose "I''m not sure".', v_id);
      end if;
    end if;
    v_fields := '{}'::jsonb;
    if jsonb_typeof(it -> 'fields') = 'object' then
      select coalesce(jsonb_object_agg(key, left(value, 200)), '{}'::jsonb) into v_fields
        from (select * from jsonb_each_text(it -> 'fields') limit 10) t;
    end if;
    v_items := v_items || jsonb_build_object(
      'id', v_id, 'unsure', v_unsure,
      'condition', case when it ->> 'condition' in ('light', 'moderate', 'heavy') then it ->> 'condition' else 'moderate' end,
      'areaSqft', v_area, 'length', case when v_unsure then null else v_len end, 'width', case when v_unsure then null else v_wid end,
      'linearFt', v_lin, 'heightFt', case when v_unsure then null else jnum(it -> 'heightFt') end,
      'fields', v_fields, 'notes', left(trim(coalesce(it ->> 'notes', '')), 1000));
  end loop;

  v_name := trim(coalesce(c ->> 'name', ''));
  v_phone := trim(coalesce(c ->> 'phone', ''));
  v_email := trim(coalesce(c ->> 'email', ''));
  v_addr := trim(coalesce(c ->> 'address', ''));
  v_zip := trim(coalesce(c ->> 'zip', ''));
  v_pref := case when c ->> 'preferred' in ('phone', 'text', 'email') then c ->> 'preferred' else 'phone' end;
  if length(v_name) < 2 or length(v_name) > 100 then perform fail('Please enter your name.', 'name'); end if;
  if length(regexp_replace(v_phone, '\D', '', 'g')) < 10 or length(v_phone) > 30 then perform fail('Enter a phone number with area code.', 'phone'); end if;
  if v_email <> '' and (length(v_email) > 150 or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$') then perform fail('Enter a valid email address.', 'email'); end if;
  if v_pref = 'email' and v_email = '' then perform fail('Add an email address, or choose another contact method.', 'email'); end if;
  if v_addr = '' or length(v_addr) > 200 then perform fail('Enter the address where the work will be done.', 'address'); end if;
  if v_zip !~ '^\d{5}(-\d{4})?$' then perform fail('Enter a 5-digit ZIP code.', 'zip'); end if;

  v_ref := 'TMPW-' || upper(substr(md5(gen_random_uuid()::text), 1, 8));
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  begin
    insert into quotes (id, ref, token, data, submitter) values (
      p_id, v_ref, v_token,
      jsonb_build_object('propertyType', p_data ->> 'propertyType', 'items', v_items,
        'notes', left(trim(coalesce(p_data ->> 'notes', '')), 2000),
        'contact', jsonb_build_object('name', v_name, 'phone', v_phone, 'email', v_email, 'address', v_addr, 'zip', v_zip, 'preferred', v_pref)),
      v_ip);
  exception when unique_violation then
    perform fail('Could not submit this request. Please try again.');
  end;
  return jsonb_build_object('id', p_id, 'ref', v_ref, 'token', v_token);
end $$;

-- Storage helper: may an anonymous visitor upload this object? Only into the folder of a quote created in the last hour.
create or replace function public.can_upload_photo(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[1-8]\.(jpg|png|webp)$'
     and exists (select 1 from quotes q where q.id::text = split_part(p_name, '/', 1) and q.created_at > now() - interval '1 hour')
$$;

create or replace function public.attach_photos(p_token text, p_files jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare q quotes; f jsonb;
begin
  select * into q from quotes where token = p_token;
  if not found then perform fail('We could not find that request.', null, 'P0002'); end if;
  if jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) > 8 then perform fail('You can upload up to 8 photos.', 'photos'); end if;
  for f in select value from jsonb_array_elements(p_files) loop
    if (f ->> 'path') !~ ('^' || q.id::text || '/[1-8]\.(jpg|png|webp)$') then perform fail('Invalid photo.', 'photos'); end if;
    if exists (select 1 from storage.objects where bucket_id = 'quote-photos' and name = f ->> 'path') then
      insert into photos (quote_id, path, original_name) values (q.id, f ->> 'path', left(coalesce(f ->> 'name', ''), 120))
      on conflict (path) do nothing;
    end if;
  end loop;
end $$;

create or replace function public.get_request(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare q quotes; b bookings;
begin
  select * into q from quotes where token = p_token;
  if not found then perform fail('We could not find that request.', null, 'P0002'); end if;
  select * into b from bookings where quote_id = q.id order by created_at desc, id limit 1;
  return jsonb_build_object('ref', q.ref, 'name', q.data -> 'contact' ->> 'name', 'items', q.data -> 'items',
    'booking', case when b.id is null then null else booking_json(b) end);
end $$;

create or replace function public.request_booking(p_token text, p_date date, p_window text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q quotes; b bookings; v_ok boolean;
begin
  perform pg_advisory_xact_lock(7001);
  select * into q from quotes where token = p_token;
  if not found then perform fail('We could not find that quote request.', null, 'P0002'); end if;
  if p_date is null or not exists (select 1 from jsonb_array_elements(sched() -> 'windows') x where x ->> 'id' = p_window) then
    perform fail('Choose a date and time window.');
  end if;
  if exists (select 1 from bookings where quote_id = q.id and status in ('pending', 'proposed', 'confirmed')) then
    perform fail('You already have a booking request for this quote.');
  end if;
  v_ok := coalesce(((get_availability(p_date, p_date) -> 'days' -> to_char(p_date, 'YYYY-MM-DD') -> 'windows') ->> p_window)::boolean, false);
  if not v_ok then perform fail('Sorry, that time is no longer available. Please choose another.'); end if;
  insert into bookings (quote_id, status, req_date, req_window, note)
  values (q.id, 'pending', p_date, p_window, nullif(left(trim(coalesce(p_note, '')), 500), '')) returning * into b;
  return jsonb_build_object('booking', booking_json(b));
end $$;

create or replace function public.cancel_booking(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare q quotes; b bookings;
begin
  select * into q from quotes where token = p_token;
  if not found then perform fail('No booking request found.', null, 'P0002'); end if;
  select * into b from bookings where quote_id = q.id order by created_at desc, id limit 1 for update;
  if not found then perform fail('No booking request found.', null, 'P0002'); end if;
  if b.status not in ('pending', 'proposed') then
    perform fail('Only a pending request can be cancelled online. Please call us to change a confirmed appointment.');
  end if;
  update bookings set status = 'cancelled', updated_at = now() where id = b.id returning * into b;
  return jsonb_build_object('booking', booking_json(b));
end $$;

create or replace function public.respond_proposal(p_token text, p_action text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare q quotes; b bookings; result jsonb;
begin
  select * into q from quotes where token = p_token;
  if not found then perform fail('No booking request found.', null, 'P0002'); end if;
  select * into b from bookings where quote_id = q.id order by created_at desc, id limit 1;
  if not found or b.status <> 'proposed' then perform fail('There is no proposed time to respond to.'); end if;
  if p_action = 'accept' then
    result := confirm_internal(b.id, b.slot_date, b.slot_start, b.slot_end, b.full_day, null);
  elsif p_action = 'decline' then
    update bookings set status = 'cancelled', updated_at = now() where id = b.id returning * into b;
    result := booking_json(b);
  else
    perform fail('Choose accept or decline.');
  end if;
  return jsonb_build_object('booking', result);
end $$;

-- ============================================================ owner functions (login + owners table required)

create or replace function public.owner_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_owner();
  return jsonb_build_object(
    'today', (now() at time zone biz_tz())::date,
    'scheduling', sched(),
    'quotes', coalesce((
      select jsonb_agg(
        q.data || jsonb_build_object(
          'id', q.id, 'ref', q.ref, 'createdAt', q.created_at, 'status', q.status,
          'photos', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'path', p.path, 'name', p.original_name) order by p.id), '[]'::jsonb)
                     from photos p where p.quote_id = q.id),
          'bookings', (select coalesce(jsonb_agg(booking_json(b) order by b.created_at desc, b.id), '[]'::jsonb)
                       from bookings b where b.quote_id = q.id))
        order by q.created_at desc)
      from (select * from quotes order by created_at desc limit 500) q), '[]'::jsonb),
    'blocks', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'date', k.date, 'start', k.start_min, 'end', k.end_min, 'reason', k.reason) order by k.date, k.start_min)
                        from blocks k), '[]'::jsonb),
    'appointments', coalesce((
      select jsonb_agg(jsonb_build_object('id', b.id, 'date', b.slot_date, 'start', b.slot_start, 'end', b.slot_end, 'fullDay', b.full_day,
                                          'ref', q.ref, 'name', q.data -> 'contact' ->> 'name') order by b.slot_date, b.slot_start)
      from bookings b join quotes q on q.id = b.quote_id where b.status = 'confirmed'), '[]'::jsonb));
end $$;

create or replace function public.owner_set_quote_status(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_owner();
  if p_status not in ('new', 'contacted', 'closed') then perform fail('Invalid status.'); end if;
  update quotes set status = p_status where id = p_id;
end $$;

create or replace function public.owner_delete_quote(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_owner();
  delete from quotes where id = p_id;
end $$;

-- p_action: accept | propose | decline | cancel.
-- p_slot: {"date":"YYYY-MM-DD","start":"HH:MM","end":"HH:MM","fullDay":bool}; omitted = the customer's requested window.
create or replace function public.owner_booking_action(p_id uuid, p_action text, p_slot jsonb default null, p_message text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  b bookings; w jsonb; d date; s int; e int; f boolean := false;
  today date := (now() at time zone biz_tz())::date;
  msg text := nullif(left(trim(coalesce(p_message, '')), 500), '');
  tre constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
begin
  perform require_owner();
  if p_action not in ('accept', 'propose', 'decline', 'cancel') then perform fail('Unknown action.'); end if;
  perform pg_advisory_xact_lock(7001);
  select * into b from bookings where id = p_id for update;
  if not found then perform fail('Booking not found.', null, 'P0002'); end if;

  if p_action in ('accept', 'propose') then
    if coalesce(p_slot ->> 'date', '') <> '' then
      begin
        d := (p_slot ->> 'date')::date;
      exception when others then
        perform fail('Choose a valid date.');
      end;
      f := coalesce((case when jsonb_typeof(p_slot -> 'fullDay') = 'boolean' then (p_slot -> 'fullDay')::boolean end), false);
      if not f then
        if coalesce(p_slot ->> 'start', '') !~ tre or coalesce(p_slot ->> 'end', '') !~ tre then
          perform fail('Choose a valid start and end time.');
        end if;
        s := to_min(p_slot ->> 'start');
        e := to_min(p_slot ->> 'end');
        if e <= s then perform fail('End time must be after the start time.'); end if;
      end if;
    else
      select x into w from jsonb_array_elements(sched() -> 'windows') x where x ->> 'id' = b.req_window;
      if w is null then perform fail('That time window no longer exists. Choose a time manually.'); end if;
      d := b.req_date;
      f := coalesce((case when jsonb_typeof(w -> 'fullDay') = 'boolean' then (w -> 'fullDay')::boolean end), false);
      s := to_min(w ->> 'start');
      e := to_min(w ->> 'end');
    end if;
    if f then s := 0; e := 1440; end if;
    if d < today then perform fail('That date is in the past.'); end if;
  end if;

  if p_action = 'accept' then
    return jsonb_build_object('booking', confirm_internal(b.id, d, s, e, f, msg));
  elsif p_action = 'propose' then
    if b.status not in ('pending', 'proposed') then perform fail('This request is already ' || b.status || '.'); end if;
    if slot_conflict(d, s, e) then perform fail('That time overlaps a confirmed appointment or a blocked time.'); end if;
    update bookings set status = 'proposed', slot_date = d, slot_start = s, slot_end = e, full_day = f,
           owner_message = msg, updated_at = now() where id = b.id returning * into b;
  elsif p_action = 'decline' then
    if b.status not in ('pending', 'proposed') then perform fail('This request is already ' || b.status || '.'); end if;
    update bookings set status = 'declined', owner_message = msg, updated_at = now() where id = b.id returning * into b;
  else
    if b.status <> 'confirmed' then perform fail('Only confirmed appointments can be cancelled.'); end if;
    update bookings set status = 'cancelled', owner_message = msg, updated_at = now() where id = b.id returning * into b;
  end if;
  return jsonb_build_object('booking', booking_json(b));
end $$;

create or replace function public.owner_add_block(p_date date, p_all_day boolean, p_start text default null, p_end text default null, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare s int; e int; tre constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
begin
  perform require_owner();
  perform pg_advisory_xact_lock(7001);
  if p_date is null then perform fail('Choose a valid date.'); end if;
  if p_date < (now() at time zone biz_tz())::date then perform fail('That date is in the past.'); end if;
  if not coalesce(p_all_day, false) then
    if coalesce(p_start, '') !~ tre or coalesce(p_end, '') !~ tre then perform fail('Choose a valid start and end time.'); end if;
    s := to_min(p_start);
    e := to_min(p_end);
    if e <= s then perform fail('End time must be after the start time.'); end if;
  end if;
  if exists (select 1 from bookings b where b.status = 'confirmed' and b.slot_date = p_date
             and b.slot_range && int4range(coalesce(s, 0), coalesce(e, 1440))) then
    perform fail('That overlaps a confirmed appointment. Cancel the appointment first.');
  end if;
  insert into blocks (date, start_min, end_min, reason) values (p_date, s, e, nullif(left(trim(coalesce(p_reason, '')), 200), ''));
end $$;

create or replace function public.owner_remove_block(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform require_owner();
  delete from blocks where id = p_id;
end $$;

-- Pushes scheduling settings from config/site.config.json into the database (the dashboard calls this automatically).
create or replace function public.owner_sync_settings(p_scheduling jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare w jsonb;
begin
  perform require_owner();
  if coalesce(jsonb_typeof(p_scheduling -> 'businessHours'), '') <> 'object' or coalesce(jsonb_typeof(p_scheduling -> 'windows'), '') <> 'array'
     or jnum(p_scheduling -> 'leadDays') is null or jnum(p_scheduling -> 'horizonDays') is null
     or coalesce(p_scheduling ->> 'timezone', '') = '' then
    perform fail('Invalid scheduling settings.');
  end if;
  if jsonb_array_length(p_scheduling -> 'windows') = 0 then perform fail('Invalid scheduling settings.'); end if;
  for w in select value from jsonb_array_elements(p_scheduling -> 'windows') loop
    if (w ->> 'id') is null or (w ->> 'start') !~ '^\d{2}:\d{2}$' or (w ->> 'end') !~ '^\d{2}:\d{2}$' then
      perform fail('Invalid time window in settings.');
    end if;
  end loop;
  perform (now() at time zone (p_scheduling ->> 'timezone'));  -- raises if the time zone is unknown
  update settings set scheduling = p_scheduling, updated_at = now() where id = 1;
end $$;

-- ============================================================ photo storage (private bucket)

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('quote-photos', 'quote-photos', false, 4194304, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = 4194304, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists "customers upload quote photos" on storage.objects;
create policy "customers upload quote photos" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'quote-photos' and public.can_upload_photo(name));

drop policy if exists "owner reads quote photos" on storage.objects;
create policy "owner reads quote photos" on storage.objects for select to authenticated
  using (bucket_id = 'quote-photos' and public.is_owner());

drop policy if exists "owner deletes quote photos" on storage.objects;
create policy "owner deletes quote photos" on storage.objects for delete to authenticated
  using (bucket_id = 'quote-photos' and public.is_owner());

-- ============================================================ who can call what

revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.get_availability(date, date), public.submit_quote(uuid, jsonb), public.attach_photos(text, jsonb),
  public.get_request(text), public.request_booking(text, date, text, text), public.cancel_booking(text),
  public.respond_proposal(text, text), public.can_upload_photo(text)
  to anon, authenticated;

grant execute on function
  public.is_owner(), public.owner_overview(), public.owner_set_quote_status(uuid, text), public.owner_delete_quote(uuid),
  public.owner_booking_action(uuid, text, jsonb, text), public.owner_add_block(date, boolean, text, text, text),
  public.owner_remove_block(bigint), public.owner_sync_settings(jsonb)
  to authenticated;
