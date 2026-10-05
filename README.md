# Tedrick Mobile Pressure Washing, LLC – website

A static website (no server to run) backed by **Supabase**: marketing pages, a guided quote builder, booking requests,
and a protected owner dashboard at `/admin/`.

```
public/        the website (HTML, CSS, JS)           config/site.config.json   all business/pricing/scheduling settings
build.mjs      builds public/ + config into dist/    supabase/schema.sql       the whole database (tables, security, functions)
```

## One-time Supabase setup

1. **Create the database.** Supabase dashboard → *SQL Editor* → *New query* → paste all of `supabase/schema.sql` → *Run*.
   (Safe to run again after updates.)
2. **Create the owner login.** *Authentication → Users → Add user → Create new user* (email + strong password, tick
   *Auto Confirm User*). Then put that email into `supabase/make-owner.sql` and run it in the SQL Editor.
3. **Recommended:** *Authentication → Sign In / Providers → Email* → turn **off** "Allow new users to sign up".
4. Your project URL and publishable key are already in `config/site.config.json` (`supabase`). The publishable key is
   meant to be public; the database only exposes the functions in `schema.sql`, and the tables are locked.

## Preview and deploy

```
npm run dev      # builds and previews at http://localhost:3000 using your real Supabase project
npm run build    # writes the deployable site to dist/
```

Deploy `dist/` to any static host. For **Netlify**: add the GitHub repo, branch `supabase`; `netlify.toml` already sets
build command `node build.mjs` and publish folder `dist`. Cloudflare Pages works the same way (it reads the generated
`_headers` file for security headers). After deploying, add the site's address under *Authentication → URL
Configuration → Site URL* in Supabase.

## What to edit

| To change… | Edit |
|---|---|
| Business name, phone, tagline, payment methods, minister's discount line | `config/site.config.json` → `business` |
| **Prices** (per sq ft / linear ft / flat, minimum charge, dirt multipliers) | `pricing.services`. `rate: null` shows "Submit for a free personalized quote". |
| Business hours, time windows, lead time, booking horizon | `scheduling` (set `"placeholder": false` once real) |
| Quote-builder services and fields | `services`; service cards: `serviceCards` |
| Gallery projects and photos | `gallery`; put images in `public/img/`. `"compare": true` only for same-view photos (enables the slider) |
| Colors | `:root` in `public/css/styles.css` |
| FAQ / About copy | `public/index.html` |

After editing, rebuild/redeploy. **Scheduling settings** are copied into the database automatically the next time the
owner opens the dashboard (you'll see a notice).

## How booking works

1. A customer submits a quote request and gets a private link. Photos go to a private storage bucket.
2. They request a date + window. It is saved as **Pending owner approval** and blocks nothing.
3. In `/admin/` the owner accepts, declines, or proposes another time (the customer then accepts/declines on the site).
4. Only **accepted** appointments block time. A database constraint makes overlapping confirmed appointments impossible,
   even when approvals happen at the same instant. A full-day appointment blocks the whole day.
5. Scheduling uses `America/Chicago`. The public calendar gets only available/unavailable flags, never customer data.

## Tests

```
npm install      # one time (installs a test-only in-process Postgres)
npm test         # database tests (access control, validation, overlaps) + a Chrome-driven end-to-end run
```

The tests never touch your real Supabase project: they run `schema.sql` in a local Postgres and use a local stand-in for
the Supabase API. Needs Chrome or Edge installed for the browser part.

## Accessibility

The site targets WCAG 2.1/2.2 AA: skip link, landmarks and heading order, keyboard operation everywhere (including the photo viewer, calendar and slider), visible focus, labelled form fields with announced errors, alt text on photos, reduced-motion and forced-colors support, and pinch-zoom is never blocked. `npm test` runs axe-core on every screen the browser test visits and fails on any violation. Automated checks catch only part of the problem: also try the site with a screen reader (NVDA on Windows, VoiceOver on iPhone) and browser zoom at 200%.

## Known limitations

- **Owner emails** go through Formspree (`notifications.ownerEmail.endpoint` in the config): every new quote request, booking request and proposal reply
  sends a summary. It is best effort: if Formspree is down the request is still saved and shows in the dashboard.
- **Customers are not emailed.** They check their private status link, and the site says so (`notifications.customerEmail` stays `false`).
- Spam protection is a hidden field, size limits, and a per-IP limit of 10 quote requests/hour (best effort).
- Supabase's free plan pauses projects after about a week of no activity, which would take booking offline.
