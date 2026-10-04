-- Makes one login the owner of the dashboard. Run AFTER schema.sql.
--
-- 1. Supabase dashboard > Authentication > Users > Add user > "Create new user".
--    Enter the owner's email and a strong password; tick "Auto Confirm User".
-- 2. Replace the email below with that same email, then run this in the SQL Editor.
--
-- Only users listed in the owners table can see requests, photos, or manage bookings.
-- (Recommended: Authentication > Sign In / Providers > turn OFF "Allow new users to sign up".)

insert into public.owners (user_id)
select id from auth.users where email = 'OWNER_EMAIL_HERE'
on conflict do nothing;

-- Check it worked: this should return one row.
select u.email, o.user_id from public.owners o join auth.users u on u.id = o.user_id;
