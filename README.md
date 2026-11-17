# QueryPulse — SQL Performance Studio

QueryPulse is an interactive SQL workspace that runs entirely in the browser. Build a
query visually, read it as SQL, inspect an execution plan, and get concrete
optimisation advice — no database connection required. Every run is a deterministic
local simulation, so it is safe to experiment with.

**Live demo:** deploy with Vercel (see [Deploying](#deploying)) — the app is a single
static page.

## What you can do

### Visual query builder
- Switch the base table (`users`, `orders`, `products`, `analytics`) and the builder
  rewrites the projection, join, filters, and sort for the new table.
- Toggle a join, pick the join type, and choose the `ON` columns from the discovered
  relationships.
- Add, edit, and remove `WHERE` filters with `=`, `!=`, `>`, `<`, `>=`, `<=`, and `LIKE`
  (automatic `%value%` wrapping).
- Order by any projected column, and cap the result with a row limit.
- Every change compiles to SQL live; the editor drops into manual mode as soon as you
  type, and **Sync builder** restores it.

### SQL editor
- Syntax highlighting, line numbers, and tab handling on a real textarea layer.
- Dialect-aware formatting (`PostgreSQL`, `MySQL`, `SQLite`, `Snowflake`) via
  `sql-formatter`, with `⌘/Ctrl + Shift + F`.
- Run with `⌘/Ctrl + Enter`; commands stop at the local simulator instead of a
  database.

### Execution insights
- Hierarchical plan tree with per-node cost bars and row estimates, adapted to the
  shape of the query (scans, joins, aggregation, sort, limit).
- Optimisation score gauge, plan cost, latency, and returned rows.
- Optimizer drawer with prioritised recommendations and a generated `CREATE INDEX`
  or Snowflake `CLUSTER BY` script you can copy.

### Static analysis (new)
A dependency-free SQL linter (`src/lib/lint.ts`) runs on every keystroke and reports:

| Severity | Rule examples |
| --- | --- |
| Critical | `DELETE`/`UPDATE` without `WHERE`, `JOIN` without `ON` (cartesian product) |
| Warning | `SELECT *`, missing `WHERE`, unbounded result, non-sargable functions on filtered columns, leading-wildcard `LIKE`, numeric keys compared as strings |
| Advisory | `DISTINCT`, `NOT IN` subqueries, `OR` across columns, comma joins, multi-statement scripts |

Each finding carries the line number, why it matters, and a concrete rewrite.

### Run history (new)
- The last 12 simulations are kept in `localStorage` with latency, row count, score,
  and the builder snapshot that produced them.
- A latency sparkline plus last / average / best stats highlight regressions.
- One click loads a run back into the builder or re-runs it.

### Share links (new)
**Share** encodes the current builder state, dialect, and custom SQL into a URL
fragment (`#q=…`). Opening the link restores the exact workspace, so a review
comment can point at a reproducible query.

### Results preview
- Table and JSON views over simulated rows, with click-to-sort columns and a sort
  indicator in the footer.
- CSV export of the (sorted) preview and one-click JSON copy.

### Reports and workspace
- Markdown report export with the SQL, plan, recommendations, static-analysis
  findings, and recent runs.
- Draft and history persistence in the browser; **Reset workspace** returns to the
  starter query.
- Command palette (`⌘/Ctrl + K`) for every action: run, format, share, export, open
  recommendations, jump to history, switch dialect, swap the base table, and more.
- Responsive layout down to small phones, keyboard focus states, and
  `prefers-reduced-motion` support.

## Getting started

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production bundle in dist/ (single self-contained HTML file)
npm run preview    # serve the production build
npm run typecheck  # tsc --noEmit
```

## Project structure

```
src/
  App.tsx           # workspace shell, builder, editor, insights, palette
  index.css         # design system + component styles
  lib/lint.ts       # SQL static-analysis rules
  utils/cn.ts       # class-name helper
index.html
vercel.json         # Vite preset + SPA rewrite
```

## Deploying

The repository is Vercel-ready (`vercel.json` pins the Vite preset, `dist` output, and
an SPA rewrite). Either:

1. Import the repository in Vercel and deploy — build `npm run build`, output `dist`.
2. Or deploy from the CLI: `npx vercel --prod`.

## Notes

Execution plans, costs, row counts, latencies, and recommendations are **simulated**
for teaching and exploration. Validate indexes against your real workload and
`EXPLAIN (ANALYZE, BUFFERS)` output before applying them.
