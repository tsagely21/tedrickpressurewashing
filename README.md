# Tedrick Mobile Pressure Washing, LLC – website

Marketing site, guided quote builder, booking requests, and a protected owner dashboard.
No npm dependencies: it runs on **Node.js 22.5+** (built-in SQLite and fetch).

## Run it

```
copy .env.example .env      # then set OWNER_PASSWORD
npm start                   # http://localhost:3000   (owner dashboard: /admin/)
npm test                    # API tests incl. overlapping-approval checks
node test/browser.mjs       # drives Chrome/Edge through the full customer + owner flow, saves screenshots
```

## What to edit

| To change… | Edit |
|---|---|
| Business name, phone, tagline, payment methods, minister's discount line | `config/site.config.json` → `business` |
| **Prices** (per-sq-ft / per-linear-ft / flat rate, minimum charge, dirt-level multipliers) | `config/site.config.json` → `pricing.services`. Leave `rate: null` to show "Submit for a free personalized quote". |
| Business hours, time windows, lead time, how far ahead people can book | `config/site.config.json` → `scheduling` (set `"placeholder": false` once real) |
| Quote-builder services, fields, measurement help text | `config/site.config.json` → `services` |
| Service cards on the page | `config/site.config.json` → `serviceCards` |
| Gallery projects and photos | `config/site.config.json` → `gallery`; put images in `public/img/` |
| Colors | `:root` in `public/css/styles.css` |
| FAQ / About copy | `public/index.html` |

Restart the server after editing the config. Gallery entries with `"before": null` show a labeled placeholder.
Set `"compare": true` on a project only when its before/after photos show the **same view**; that turns on the draggable slider.

## How booking works

1. A customer submits a quote request and gets a private link/token.
2. They request a date + window. It is saved as **Pending owner approval** and blocks nothing.
3. In `/admin/` the owner can accept, decline, or propose another time (the customer then accepts or declines on the site).
4. Only **accepted** appointments block time. Approval runs inside a SQLite `BEGIN IMMEDIATE` transaction, so two simultaneous approvals can never overlap. A full-day appointment blocks the whole day.
5. All scheduling is in `America/Chicago`. The public calendar exposes only available/unavailable flags, never customer data.

## Going live checklist

- Host that can run Node 22.5+ with a **persistent disk** for `DATA_DIR` (database + uploaded photos). Static/serverless hosts will not work.
- Serve over HTTPS (cookies are marked `Secure` when `X-Forwarded-Proto: https`).
- Set `OWNER_PASSWORD`, `SESSION_SECRET`, `PUBLIC_URL`.
- Email: create a Resend account, verify a sending domain, set `RESEND_API_KEY`, `MAIL_FROM`, `OWNER_EMAIL`. Without these the site is in demo mode for email (see `data/outbox.log`).
- Back up the `data/` folder.
- Replace the placeholder business hours and add real photos / prices (see above).
