import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useItemAliases, useItemSalesRows, useSaveItemSales, useStockGroups, useStockItems, type SalesLine } from '../lib/api'
import { addDays, fmtDay, fmtLong, todayStr, weekStart } from '../lib/dates'
import { aud, cents, parseMoney } from '../lib/format'
import { qtyStr } from '../lib/purchasing'
import { guessColumns, matchItem, normalise, readPdf, readText, usableCode, valueAt, type Report } from '../lib/report'
import type { ItemSale, StockGroup, StockItem } from '../lib/types'
import { bySection, CategoryChips, FoodHeader } from '../components/catalogue'
import { ErrorBox, Loading, Segmented } from '../components/ui'

type Kind = 'week' | 'day'
type Source = 'file' | 'paste' | 'manual'

const SKIP = ''
const NEW = '__new'

/** Enter one week's or one day's sales per item: from the till's report, or typed in. */
export default function ItemSalesEntry() {
  const [params] = useSearchParams()
  const [kind, setKind] = useState<Kind>(params.get('kind') === 'day' ? 'day' : 'week')
  const [date, setDate] = useState(params.get('date') ?? addDays(weekStart(todayStr()), -7))
  const [source, setSource] = useState<Source>(params.get('source') === 'manual' ? 'manual' : 'file')
  const items = useStockItems()
  const groups = useStockGroups()

  const start = kind === 'week' ? weekStart(date) : date
  const end = kind === 'week' ? addDays(start, 6) : start
  const existing = useItemSalesRows(start, start)
  const already = (existing.data ?? []).filter((r) => r.period_end === end)

  return (
    <div className="mx-auto max-w-3xl">
      <FoodHeader sub="Add what each product sold — a week's till report, or one day's figures." />
      <div className="mb-4 flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Add item sales</h2>
        <Link to="/food/sales" className="text-sm font-medium text-accent">Item sales →</Link>
      </div>

      <section className="card mb-4 grid gap-3 p-4 sm:grid-cols-[auto_1fr] sm:items-end">
        <div>
          <span className="label">Sales for</span>
          <Segmented ariaLabel="Period" value={kind} onChange={setKind}
            options={[{ value: 'week', label: 'A week (Mon–Sun)' }, { value: 'day', label: 'One day' }]} />
        </div>
        <div>
          <label className="label" htmlFor="is-date">{kind === 'week' ? 'Any day in the week' : 'Day'}</label>
          <input id="is-date" type="date" className="field !w-auto" value={date} max={todayStr()}
            onChange={(e) => e.target.value && setDate(e.target.value)} />
        </div>
        <p className="text-sm font-semibold sm:col-span-2">
          {kind === 'week' ? `${fmtDay(start)} – ${fmtDay(end)}` : fmtLong(start)}
          {already.length > 0 && (
            <span className="ml-2 font-normal text-warn-ink">
              · already has {already.length} {already.length === 1 ? 'product' : 'products'} ({aud(cents(already.reduce((s, r) => s + r.amount, 0)))}) — saving replaces them
            </span>
          )}
        </p>
      </section>

      <div className="mb-3">
        <Segmented ariaLabel="How" value={source} onChange={setSource}
          options={[{ value: 'file', label: 'Upload report' }, { value: 'paste', label: 'Paste report' }, { value: 'manual', label: 'Type it in' }]} />
      </div>

      {items.isLoading || groups.isLoading || existing.isLoading ? <Loading /> : source === 'manual' ? (
        // Remount per period so the boxes start from what that period already holds.
        <ManualEntry key={start + end} start={start} end={end} items={items.data ?? []} groups={groups.data ?? []} existing={already} />
      ) : (
        <ImportEntry key={source} source={source} start={start} end={end} kind={kind}
          onUseDate={(d) => setDate(d)} items={items.data ?? []} groups={groups.data ?? []} />
      )}
    </div>
  )
}

function useSaveAndReturn() {
  const save = useSaveItemSales()
  const nav = useNavigate()
  return {
    save,
    run: async (start: string, end: string, lines: SalesLine[]) => {
      await save.mutateAsync({ start, end, lines })
      nav('/food/sales')
    },
  }
}

/** Every active product with a units box and a sales box. */
function ManualEntry({ start, end, items, groups, existing }: {
  start: string; end: string; items: StockItem[]; groups: StockGroup[]; existing: ItemSale[]
}) {
  const { save, run } = useSaveAndReturn()
  const [vals, setVals] = useState<Record<string, { qty: string; amount: string }>>(() =>
    Object.fromEntries(existing.map((r) => [r.item_id, { qty: r.qty ? qtyStr(r.qty) : '', amount: r.amount ? String(r.amount) : '' }])))
  const [cat, setCat] = useState('all')

  // Hidden products still show if this period already has figures for them.
  const list = items.filter((i) => i.active || vals[i.id])
  const sections = bySection(list, groups)
  const current = sections.some((s) => s.key === cat) ? cat : 'all'
  const shown = current === 'all' ? sections : sections.filter((s) => s.key === current)
  const lines = Object.entries(vals)
    .map(([item_id, v]) => ({ item_id, qty: parseMoney(v.qty), amount: parseMoney(v.amount) }))
    .filter((l) => l.qty !== 0 || l.amount !== 0)
  const set = (id: string, k: 'qty' | 'amount', v: string) => setVals({ ...vals, [id]: { ...(vals[id] ?? { qty: '', amount: '' }), [k]: v } })

  return (
    <section className="card p-4">
      <ErrorBox error={save.error} />
      {list.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">
          No products yet — add them in <Link className="font-semibold text-accent" to="/food/catalogue">Catalogue</Link>.
        </p>
      ) : (
        <>
          <CategoryChips
            sections={sections.map((s) => ({ key: s.key, label: s.label, count: s.items.length, marked: s.items.filter((i) => lines.some((l) => l.item_id === i.id)).length }))}
            value={current} onChange={setCat} total={list.length} />
          {shown.map((s) => (
            <div key={s.key} className="mt-3">
              {current === 'all' && <h3 className="py-1 text-xs font-semibold uppercase tracking-wide text-muted">{s.label}</h3>}
              <div className="grid grid-cols-[1fr_5rem_6.5rem] gap-2 py-1 text-xs text-muted">
                <span /><span className="text-right">Units</span><span className="text-right">Sales $</span>
              </div>
              <ul className="divide-y divide-line">
                {s.items.map((i) => (
                  <li key={i.id} className="grid grid-cols-[1fr_5rem_6.5rem] items-center gap-2 py-1.5">
                    <span className="min-w-0 truncate font-medium">{i.name}</span>
                    <input aria-label={`Units of ${i.name} sold`} className="field num !py-1.5 text-right" inputMode="decimal" placeholder="0"
                      value={vals[i.id]?.qty ?? ''} onChange={(e) => set(i.id, 'qty', e.target.value)} />
                    <input aria-label={`Sales of ${i.name} in dollars`} className="field num !py-1.5 text-right" inputMode="decimal" placeholder="0.00"
                      value={vals[i.id]?.amount ?? ''} onChange={(e) => set(i.id, 'amount', e.target.value)} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
      <SaveBar lines={lines} busy={save.isPending} onSave={() => run(start, end, lines)} start={start} end={end} />
    </section>
  )
}

/** Read a report, match its names to the catalogue, check the numbers, save. */
function ImportEntry({ source, start, end, kind, onUseDate, items, groups }: {
  source: 'file' | 'paste'; start: string; end: string; kind: Kind; onUseDate: (d: string) => void; items: StockItem[]; groups: StockGroup[]
}) {
  const aliases = useItemAliases()
  const { save, run } = useSaveAndReturn()
  const [report, setReport] = useState<Report | null>(null)
  const [pasted, setPasted] = useState('')
  const [reading, setReading] = useState(false)
  const [readError, setReadError] = useState<unknown>(null)
  const [cols, setCols] = useState({ qty: 0, amount: 0 })
  const [match, setMatch] = useState<Record<number, string>>({})
  const [edits, setEdits] = useState<Record<number, { qty?: string; amount?: string }>>({})
  const [filter, setFilter] = useState<'all' | 'unmatched'>('all')

  const aliasMap = useMemo(() => new Map((aliases.data ?? []).map((a) => [a.alias, a.item_id])), [aliases.data])

  function load(parsed: Report) {
    if (!parsed.rows.length) {
      setReport(null)
      setReadError('No product lines found. Each line needs a product name followed by its numbers — try pasting the report text instead.')
      return
    }
    setCols(guessColumns(parsed))
    setMatch(Object.fromEntries(parsed.rows.map((r, k) => [k, matchItem(r, items, aliasMap, usableCode(r.code, parsed.rows)) ?? SKIP])))
    setEdits({})
    setReport(parsed)
  }

  async function readFile(file: File) {
    setReadError(null)
    setReading(true)
    try {
      if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') load(await readPdf(file))
      else load(readText(await file.text(), /\.csv$/i.test(file.name)))
    } catch (e) {
      setReadError(e)
    } finally {
      setReading(false)
    }
  }

  const rows = report?.rows ?? null
  const n = rows?.[0]?.nums.length ?? 0
  const qtyOf = (k: number) => edits[k]?.qty != null ? parseMoney(edits[k].qty!) : rows ? valueAt(rows[k], cols.qty) : 0
  const amountOf = (k: number) => edits[k]?.amount != null ? parseMoney(edits[k].amount!) : rows ? cents(valueAt(rows[k], cols.amount)) : 0
  const lines: SalesLine[] = (rows ?? []).flatMap((r, k) => {
    const m = match[k]
    if (!m) return []
    return [{
      item_id: m === NEW ? null : m, newName: m === NEW ? r.name : undefined, qty: qtyOf(k), amount: amountOf(k),
      reportName: r.name, reportCode: usableCode(r.code, rows!) ? r.code : undefined,
    }]
  })
  const unmatched = (rows ?? []).filter((_, k) => !match[k]).length
  const reportDate = report?.date
  const suggested = reportDate && (kind === 'week' ? weekStart(reportDate) !== start : reportDate !== start) ? reportDate : null

  const sections = bySection(items.filter((i) => i.active), groups)
  const colLabel = (c: number) =>
    `${report?.columns?.[c] ?? `Column ${c + 1}`} (e.g. ${rows ? rows.slice(0, 2).map((r) => valueAt(r, c)).join(', ') : ''})`
  const itemName = (id: string) => items.find((i) => i.id === id)?.name

  return (
    <section className="card p-4">
      <ErrorBox error={readError || save.error || aliases.error} />

      {source === 'file' ? (
        <div className="rounded-xl border border-dashed border-line p-4 text-center">
          <label className="btn btn-primary cursor-pointer">
            {reading ? 'Reading…' : rows ? 'Choose another file' : 'Choose the report (PDF or CSV)'}
            <input type="file" accept=".pdf,.csv,.txt,application/pdf,text/csv,text/plain" className="sr-only"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); e.target.value = '' }} />
          </label>
          <p className="mt-2 text-xs text-muted">The file is read on this device. Only the figures you save are stored.</p>
        </div>
      ) : (
        <div>
          <label className="label" htmlFor="paste">Paste the report — product name, then its numbers, one product per line</label>
          <textarea id="paste" className="field font-mono text-sm" rows={6} value={pasted} onChange={(e) => setPasted(e.target.value)}
            placeholder={'Fish & chips   42   $588.00\nCoke 600ml   30   $135.00'} />
          <button type="button" className="btn mt-2" disabled={!pasted.trim()} onClick={() => { setReadError(null); load(readText(pasted)) }}>Read it</button>
        </div>
      )}

      {rows && (
        <>
          {suggested && (
            <p className="mt-3 rounded-lg border border-warn-line bg-warn-bg px-3 py-2 text-sm text-warn-ink">
              The report mentions {fmtLong(suggested)}.{' '}
              <button type="button" className="font-semibold underline" onClick={() => onUseDate(suggested)}>
                Use {kind === 'week' ? `the week of ${fmtDay(weekStart(suggested))}` : 'that day'}
              </button>
            </p>
          )}

          {n > 1 && (
            <div className="mt-4 grid gap-3 rounded-xl bg-surface-2 p-3 sm:grid-cols-2">
              <p className="text-sm text-ink-2 sm:col-span-2">Each line has {n} numbers. Which is which?</p>
              <label className="label">Units sold
                <select className="field mt-1.5 !py-2" value={cols.qty} onChange={(e) => { setCols({ ...cols, qty: Number(e.target.value) }); setEdits({}) }}>
                  {Array.from({ length: n }, (_, c) => <option key={c} value={c}>{colLabel(c)}</option>)}
                </select>
              </label>
              <label className="label">Sales amount ($)
                <select className="field mt-1.5 !py-2" value={cols.amount} onChange={(e) => { setCols({ ...cols, amount: Number(e.target.value) }); setEdits({}) }}>
                  {Array.from({ length: n }, (_, c) => <option key={c} value={c}>{colLabel(c)}</option>)}
                </select>
              </label>
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Segmented ariaLabel="Show" value={filter} onChange={setFilter}
              options={[{ value: 'all', label: `All ${rows.length}` }, { value: 'unmatched', label: `Not matched (${unmatched})` }]} />
            <span className="text-xs text-muted">Lines left on “Skip” aren’t saved. Matches are remembered for next time.</span>
          </div>

          <div className="mt-2 hidden grid-cols-[1fr_minmax(10rem,14rem)_5rem_6.5rem] gap-2 py-1 text-xs text-muted md:grid">
            <span>In the report</span><span>Catalogue product</span><span className="text-right">Units</span><span className="text-right">Sales $</span>
          </div>
          <ul className="divide-y divide-line">
            {rows.map((r, k) => (filter === 'unmatched' && match[k] ? null : (
              <li key={k} className={`grid grid-cols-[1fr_5rem_6.5rem] items-center gap-2 py-2 md:grid-cols-[1fr_minmax(10rem,14rem)_5rem_6.5rem] ${match[k] ? '' : 'opacity-70'}`}>
                <span className="col-span-3 min-w-0 md:col-span-1">
                  <span className="block truncate font-medium">{r.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {[r.code, r.group].filter(Boolean).join(' · ') || <span className="num">{r.nums.join('  ·  ')}</span>}
                    {match[k] && match[k] !== NEW && normalise(itemName(match[k]) ?? '') !== normalise(r.name) && (
                      <span className="text-warn-ink"> · matched to {itemName(match[k])}</span>
                    )}
                  </span>
                </span>
                <select aria-label={`Catalogue product for ${r.name}`} className={`field !py-1.5 !text-sm ${match[k] ? '' : 'border-warn-line'}`}
                  value={match[k] ?? SKIP} onChange={(e) => setMatch({ ...match, [k]: e.target.value })}>
                  <option value={SKIP}>— Skip —</option>
                  <option value={NEW}>+ Add “{r.name}” as a new product</option>
                  {sections.map((s) => (
                    <optgroup key={s.key} label={s.label}>
                      {s.items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                    </optgroup>
                  ))}
                </select>
                <input aria-label={`Units of ${r.name}`} className="field num !py-1.5 text-right" inputMode="decimal"
                  value={edits[k]?.qty ?? qtyStr(qtyOf(k))} onChange={(e) => setEdits({ ...edits, [k]: { ...edits[k], qty: e.target.value } })} />
                <input aria-label={`Sales of ${r.name}`} className="field num !py-1.5 text-right" inputMode="decimal"
                  value={edits[k]?.amount ?? amountOf(k).toFixed(2)} onChange={(e) => setEdits({ ...edits, [k]: { ...edits[k], amount: e.target.value } })} />
              </li>
            )))}
          </ul>
          <SaveBar lines={lines} busy={save.isPending} onSave={() => run(start, end, lines)} start={start} end={end} />
        </>
      )}
    </section>
  )
}

function SaveBar({ lines, busy, onSave, start, end }: { lines: SalesLine[]; busy: boolean; onSave: () => void; start: string; end: string }) {
  const units = lines.reduce((s, l) => s + l.qty, 0)
  const total = cents(lines.reduce((s, l) => s + l.amount, 0))
  return (
    <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-10 mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-3 shadow-lg md:bottom-4">
      <span className="num min-w-0 flex-1 text-sm">
        <b>{lines.length}</b> {lines.length === 1 ? 'product' : 'products'} · <b>{qtyStr(units)}</b> units · <b>{aud(total)}</b>
      </span>
      <button type="button" className="btn btn-primary" disabled={busy || !lines.length} onClick={onSave}>
        {busy ? 'Saving…' : start === end ? `Save ${fmtDay(start)}` : `Save week of ${fmtDay(start)}`}
      </button>
    </div>
  )
}
