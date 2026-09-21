# JK Bhairavi — Sales & Expenses

A small web app for the JK Bhairavi food counter: enter daily takings (EFTPOS, cash, Uber, online) and expenses (food orders, wages, rent, utilities, equipment), and see sales vs expenses vs profit at any time.

- `web/` — React + Vite + TypeScript + Tailwind, Recharts, TanStack Query, React Router
- `supabase/schema.sql` — tables, views, row-level security
- `supabase/seed.sql` — the shop's real data from the old Google Sheet. **Kept out of git** (this repo is public); ask Jagan for a copy.

## Pages

| Page | What it's for |
|---|---|
| **Dashboard** `/` | Pick a range (this week / last 4 weeks / this month / all / custom). KPI tiles, weekly sales vs expenses, weekly profit, where the money goes (tap a category for its items), daily sales, average by weekday, payment split, and a warning when a week has sales but no wages or food entered. |
| **Enter sales** `/sales` | One day at a time (big number inputs for the phone), or a **week grid** that looks like the old sheet. |
| **Add expense** `/expenses/new` | Category first. Food needs a supplier. Labour picks a staff member and hours, and the amount is filled in from hours × rate. "Save + add another" keeps the date and category. |
| **Expenses** `/expenses` | Filter by range, category or supplier. Edit and delete (delete asks for a second tap). |
| **Standard expenses** `/recurring` | Rent and other repeating costs: set once and they're counted every week, fortnight or month. Pause instead of delete to keep history. |
| **Settings** `/settings` | Suppliers, staff and hourly rates, partners, setup costs, contributions, and who owes whom between the partners. |

## How the numbers work

- **Profit** = sales − (food + labour + rent + utilities + other). **Equipment** is shown separately with an "after equipment" figure. **Setup costs** never touch profit.
- **Day total** = the total written in the old sheet if there is one, otherwise EFTPOS + cash + Uber + online. When the two disagree the day shows **≠**. Once you edit that day's channel amounts in the app, the app's sum is used from then on.
- **Standard expenses** are calculated, not stored: a monthly item repeats on the same day each month (31st → last day of short months), up to today (Brisbane time).
- Weeks start on Monday. All money is AUD.
- **Partner balance**: each partner should have put in their ownership % of everything contributed. The difference is what one owes the other.

## Setup

### 1. Supabase project
1. Create a project at [supabase.com](https://supabase.com) (Sydney region is closest).
2. **SQL Editor** → run `supabase/schema.sql`, then `supabase/seed.sql` if you have it.
3. Allow your emails to sign in (only listed emails can read or write anything):
   ```sql
   insert into app_users(email, display_name) values
     ('jagan@example.com', 'Jagan'),
     ('krishna@example.com', 'Krishna');
   ```
4. **Authentication → URL Configuration**: set *Site URL* to your deployed URL and add `http://localhost:5173` to *Redirect URLs* for local development. (`supabase/config.toml` holds these; `supabase config push` applies them.)
5. **Project Settings → API**: copy the *Project URL* and the *anon public* key.

### 2. Run locally
```bash
cd web
cp .env.example .env    # paste the URL and anon key
npm install
npm run dev             # http://localhost:5173
```
Sign in with an email from `app_users`; you'll get a magic link.

### 3. Deploy (GitHub Pages)
Every push to `main` builds and deploys the app with `.github/workflows/deploy.yml`.
- Repo **Settings → Pages → Source**: *GitHub Actions*.
- Repo **Settings → Secrets and variables → Actions → Variables**: `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. The anon key is public by design and ends up in the browser bundle anyway; access is controlled by `app_users` and row-level security.
- The app is served from `https://<user>.github.io/<repo>/`. That URL must be in Supabase's Site URL / Redirect URLs, or sign-in links won't come back to the app.
- Pages has no single-page-app fallback, so the workflow copies `index.html` to `404.html` to make links like `/expenses` work when opened directly.

Never put the **service-role** key in the frontend or commit it. The app only needs the anon key; row-level security does the rest.

### Types
`web/src/lib/types.ts` is written by hand to match `schema.sql`. If you change the schema, regenerate with:
```bash
supabase gen types typescript --project-id <ref> > web/src/lib/database.types.ts
```

## Still to confirm
The open questions about the imported sheet data (the unlabelled Monday column, undated Amex items, how often rent is paid, the shop purchase figure) are listed in the private handover notes. The dashboard warns about every week with no wages until they're entered.
