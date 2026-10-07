# JK Bhairavi — Sales & Expenses

A small web app for tracking a shop's takings and costs: enter daily takings (EFTPOS, cash, Uber, online) and expenses (food orders, wages, rent, utilities, equipment), and see sales vs expenses vs profit at any time. Raise purchase orders with your suppliers, count the stock each week, and get the week's real food cost.

It holds **more than one business**. Every record belongs to one business, people are given access per business, and a switcher in the header chooses which one you're looking at. Businesses never share data — separate suppliers, staff, partners, costs and figures.

- `web/` — React + Vite + TypeScript + Tailwind, Recharts, TanStack Query, React Router
- `supabase/schema.sql` — tables, views, row-level security (current schema; run this on a new project)
- `supabase/migrations/` — changes to apply to a database that already holds data, in order
- `supabase/seed.sql` — the shop's real data from the old Google Sheet. **Kept out of git** (this repo is public); ask Jagan for a copy.

## Pages

| Page | What it's for |
|---|---|
| **Dashboard** `/` | Pick a range (this week / last 4 weeks / this month / all / custom). KPI tiles, weekly sales vs expenses, weekly profit, where the money goes (tap a category for its items), daily sales, average by weekday, payment split, and a warning when a week has sales but no wages or food entered. |
| **Enter sales** `/sales` | One day at a time (big number inputs for the phone), or a **week grid**. The fields depend on the business: card / cash / Uber / online, or total sales + cash collected. |
| **Add expense** `/expenses/new` | Category first. Food needs a supplier. Labour picks a staff member and hours, and the amount is filled in from hours × rate. "Save + add another" keeps the date and category. |
| **Expenses** `/expenses` | Filter by range, category or supplier. Edit and delete (delete asks for a second tap). |
| **Purchase orders** `/orders` | One order per supplier: pick items, quantities and prices. Copy it as text to send on WhatsApp or email. Marking it received records the food expense for you. "Order again" copies an order and reprices it. |
| **Stock counts** `/stock` | A weekly count sheet laid out by where stock lives, priced at what you last paid. Shows last week's figure beside each item. Only finished counts are used. |
| **Food cost** `/food-cost` | The real food cost per week: opening stock + what you bought − closing stock, as a figure and as a share of sales. Weeks with no count say so instead of guessing. |
| **Standard expenses** `/recurring` | Rent and other repeating costs: set once and they're counted every week, fortnight or month. Pause instead of delete to keep history. |
| **Settings** `/settings` | The business (rename it, who can sign in, add another business), plus suppliers, stock items and their units, count-sheet sections, staff and hourly rates, partners, setup costs, contributions, and who owes whom between the partners. |

## How the numbers work

- **Profit** = sales − (food + labour + rent + utilities + other). **Equipment** is shown separately with an "after equipment" figure. **Setup costs** never touch profit.
- **Two ways to record a day**, set per business in Settings:
  - **Card / cash / Uber / online** — the four figures add up to the day's takings (JK Bhairavi).
  - **Total sales + cash collected** — one sales figure, plus the cash in hand that day (Caltex kedron). At a service station the till also takes fuel money, so **cash collected is never counted as sales**: it's reported on its own tile, its own weekly card and as a second line on the daily chart, and it never touches profit.
- **Day total** = the total written in the old sheet if there is one, otherwise EFTPOS + cash + Uber + online. When the two disagree the day shows **≠**. Once you edit that day's channel amounts in the app, the app's sum is used from then on.
- **Standard expenses** are calculated, not stored: a monthly item repeats on the same day each month (31st → last day of short months), up to today (Brisbane time).
- Weeks start on Monday. All money is AUD.
- **Partner balance**: each partner should have put in their ownership % of everything contributed. The difference is what one owes the other.

### Food cost

**Food cost = opening stock + what you bought − closing stock.** What you *bought* is already in the books; the stock counts supply the other two.

- A stock count is the stock on hand at **close of trade** on its date. Count after shutting on Sunday and leave the date alone; count on Monday morning and it still belongs to Sunday. The page suggests the right date.
- A week's **opening** stock is the last finished count before the week began. Its **closing** stock must be a count taken *inside* that week — a week nobody counted gets no closing figure rather than a stale one, and the page falls back to purchases and says so plainly.
- Only counts marked **finished** are used, so a half-done sheet can never move a figure.
- Each item is valued at the **last price actually paid** for it (from a received order), falling back to the standard cost in Settings. That price is frozen onto the count sheet when it's started, so a later price change can't move a week that's already closed.
- **Receiving a purchase order writes one food expense** and keeps a link to it, so a delivery is never typed twice. The total is editable at that point, because invoices don't always match the order. That expense can't be deleted on its own — use "Undo receive" on the order, which removes it properly.
- A received order always books as **food**, whatever the supplier is usually used for: an order buys stock, and stock is what the count values, so both sides of the sum have to draw on the same category.
- The dashboard's **Food bought** tile is purchases only, and links through to the Food cost page for the real figure.

## Who can see what

- `business_users` lists, per business, the email addresses that may open it. Order and count *lines* get their business from their parent order or count through a database trigger, not from the browser, so lines can't be hung off another business's records. Everything else is enforced by the database: each table only returns rows whose business you belong to, so nobody can reach another business's figures even outside the app.
- Anyone can request a sign-in link, but an address that isn't in `business_users` lands on a "No access yet" screen and can read nothing.
- People are added and removed in **Settings → Business**. Anyone with access to a business can add others to it. A business always keeps at least one person.
- **Add another business** in Settings creates an empty business with you as its only member. Existing data is untouched.

## Setup

### 1. Supabase project
1. Create a project at [supabase.com](https://supabase.com) (Sydney region is closest).
2. **SQL Editor** → run `supabase/schema.sql`, then `supabase/seed.sql` if you have it.
3. Create the first business and allow your emails to sign in (from then on, use Settings):
   ```sql
   insert into businesses(name) values ('JK Bhairavi');
   insert into business_users(email, business_id, display_name)
   select 'jagan@example.com', id, 'Jagan' from businesses where name = 'JK Bhairavi';
   ```
   (`seed.sql` already creates the business; just add the people.)
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

## Applying the purchasing & stock update

The database needs `supabase/migrations/006_purchasing_stock.sql` run once. In Supabase, open the **SQL Editor**, paste the file in and run it — it's wrapped in a transaction, so it either all lands or none of it does. Nothing existing is altered: it only adds tables, views and functions. A brand new project gets all of it from `schema.sql` instead.

Then, in the app:

1. **Settings → Count sheet sections** — where stock lives (cool room, freezer, dry store), lowest number first. This is the order you'll walk the shop in.
2. **Settings → Stock items** — what you buy and count, each with its unit (kg, box, carton…), its section, who you usually buy it from, and roughly what it costs. The cost is only a starting point; once you've received an order the real price takes over.
3. **Stock counts** — count once to set the opening stock. Food cost needs a second count a week later before it has anything to compare.

## Still to confirm
The open questions about the imported sheet data (the unlabelled Monday column, undated Amex items, how often rent is paid, the shop purchase figure) are listed in the private handover notes. The dashboard warns about every week with no wages until they're entered.
