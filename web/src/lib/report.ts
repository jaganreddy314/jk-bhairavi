// Reading another app's sales report into rows of (product, numbers).
//
// A PDF with column headings (the till's "Product sales detail" is one) is read by
// position: each number lands under its heading, the product code to the left of the
// description is kept apart, and Department / Group lines are carried down as the group.
// Anything else — pasted text, a CSV, a PDF without headings — is read line by line as a
// name followed by numbers. Either way the person confirms which column is units and which
// is sales before anything is saved.

import type { StockItem } from './types'

export interface ReportRow {
  /** The product name as the report prints it. */
  name: string
  /** The till's own code for it, when the report has one. */
  code?: string
  /** Where the report files it (Department › Group), when it says. */
  group?: string
  /** One number per column, left to right; 0 where a column is blank. */
  nums: number[]
}

export interface Report {
  rows: ReportRow[]
  /** Column headings, when the report has them; otherwise columns are just numbered. */
  columns: string[] | null
  /** The period's first day as printed in the report, if it says. */
  date: string | null
}

/** A number cell: 12, 1,234.50, $12.00, (3.00), -4. Percentages are dropped, not read. */
const NUM = /^\(?-?\$?-?\d[\d,]*(\.\d+)?\)?$|^\(?-?\$?-?\.\d+\)?$/
const PCT = /^-?[\d.,]+%$/
const toNum = (t: string) => {
  const neg = t.startsWith('(') || t.includes('-')
  const n = Number(t.replace(/[$,()-]/g, ''))
  return neg ? -n : n
}

/** Totals, headings and footers: not products. */
const NOT_A_PRODUCT = /^(grand\s*)?(sub\s*)?totals?\b|totals?:?$|^gst\b|^tax\b|^discount|^surcharge|^refund|^page\s*\d|^printed|^report\b|^item(s)?$|^product(s)?$|^description$|^name$/i

/** Same name twice (a report split across pages) is added up. */
function merge(rows: ReportRow[]): ReportRow[] {
  const byName = new Map<string, ReportRow>()
  for (const r of rows) {
    const key = normalise(r.name)
    const prev = byName.get(key)
    if (!prev) byName.set(key, { ...r, nums: [...r.nums] })
    else if (prev.nums.length === r.nums.length) prev.nums = prev.nums.map((n, k) => n + r.nums[k])
  }
  return [...byName.values()]
}

/** Lines of plain text: a name, then the numbers that trail it. */
export function parseLines(lines: string[]): Report {
  const rows: ReportRow[] = []
  for (const line of lines) {
    const tokens = line.trim().split(/\s+/).filter(Boolean)
    const nums: number[] = []
    let i = tokens.length - 1
    for (; i >= 0; i--) {
      const t = tokens[i]
      if (PCT.test(t)) continue
      if (!NUM.test(t)) break
      nums.unshift(toNum(t))
    }
    const name = tokens.slice(0, i + 1).join(' ').replace(/[\s:–-]+$/, '').trim()
    if (!nums.length || !/[a-z]/i.test(name) || NOT_A_PRODUCT.test(name)) continue
    rows.push({ name, nums })
  }
  // Rows with fewer numbers line up from the right: reports usually end with the money.
  const cols = columnCount(rows)
  const aligned = rows.map((r) => ({ ...r, nums: Array.from({ length: cols }, (_, c) => r.nums[r.nums.length - cols + c] ?? 0) }))
  return { rows: merge(aligned), columns: null, date: findDate(lines) }
}

/** How many number columns most rows have. */
function columnCount(rows: ReportRow[]): number {
  const counts = new Map<number, number>()
  for (const r of rows) counts.set(r.nums.length, (counts.get(r.nums.length) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0
}

/** A row's number in a column. The sign is kept: a refund outweighing the week's sales is negative. */
export const valueAt = (row: ReportRow, col: number) => {
  const v = row.nums[col]
  return v == null || !Number.isFinite(v) ? 0 : v
}

/**
 * Default columns. With headings: the one called Qty (not an average), and Sales inc /
 * Sales / Amount. Without: the first whole-number column, and the last column.
 */
export function guessColumns(report: Report): { qty: number; amount: number } {
  const n = report.rows[0]?.nums.length ?? 0
  const h = report.columns
  if (h) {
    const find = (re: RegExp) => h.findIndex((c) => re.test(c) && !/avg|average|\/day|%/i.test(c))
    const qty = [/^qty$|quantity|units|sold/i, /qty/i].map(find).find((k) => k >= 0)
    const amount = [/sales\s*inc|incl/i, /^sales$|amount|total|value|revenue/i, /sales/i].map(find).find((k) => k >= 0)
    if (qty != null && amount != null) return { qty, amount }
  }
  let qty = 0
  for (let c = 0; c < n - 1; c++) {
    if (report.rows.every((r) => Number.isInteger(valueAt(r, c)))) { qty = c; break }
  }
  return { qty: n > 1 ? qty : 0, amount: Math.max(0, n - 1) }
}

/** Compare names loosely: case, punctuation and “&” vs “and” don't matter. */
export const normalise = (s: string) => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()

/** The key a till code is remembered under — kept apart from names so the two never collide. */
export const codeKey = (code: string) => `#${code.toLowerCase().replace(/\s+/g, '')}`

/** A code worth matching on: has a digit, isn't a "deleted" marker, and only one row uses it. */
export const usableCode = (code: string | undefined, rows: ReportRow[]): code is string =>
  !!code && /\d/.test(code) && code.replace(/\D/g, '').length >= 3 && !/^(zz)?del\b/i.test(code)
  && rows.filter((r) => r.code === code).length === 1

/** The catalogue item a report row means: remembered first (by code, then name), then the same name, then one that contains it. */
export function matchItem(row: ReportRow, items: StockItem[], aliases: Map<string, string>, codeOk: boolean): string | null {
  const live = (id: string | undefined) => (id && items.some((i) => i.id === id) ? id : null)
  const n = normalise(row.name)
  const remembered = (codeOk && row.code ? live(aliases.get(codeKey(row.code))) : null) ?? live(aliases.get(n))
  if (remembered) return remembered
  const exact = items.find((i) => normalise(i.name) === n)
  if (exact) return exact.id
  const close = items.filter((i) => {
    const m = normalise(i.name)
    return m.length > 2 && (n.includes(m) || m.includes(n))
  })
  return close.length === 1 ? close[0].id : null
}

/**
 * The period's start as printed: a date beside "from", "starting", "period" or "week" first
 * (the printed-on date usually comes before it), else the first date anywhere.
 */
export function findDate(lines: string[]): string | null {
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  const pad = (n: number) => String(n).padStart(2, '0')
  const dateIn = (line: string) => {
    let m = line.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
    if (m) return `${m[1]}-${m[2]}-${m[3]}`
    m = line.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/)
    if (m && Number(m[2]) <= 12) return `${m[3].length === 2 ? 2000 + Number(m[3]) : m[3]}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`
    m = line.match(/\b(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})\b/)
    if (m && months.includes(m[2].toLowerCase())) return `${m[3]}-${pad(months.indexOf(m[2].toLowerCase()) + 1)}-${pad(Number(m[1]))}`
    return null
  }
  for (const line of lines) if (/from|start|period|week/i.test(line) && !/printed/i.test(line)) { const d = dateIn(line); if (d) return d }
  for (const line of lines) { const d = dateIn(line); if (d) return d }
  return null
}

// ---------- PDFs ----------

interface Cell { x: number; r: number; s: string }
interface Line { y: number; cells: Cell[] }
interface Header { y: number; nameX: number; nameEnd: number; cols: { label: string; r: number }[] }

const NAME_HEADING = /description|^product$|^item$|^name$/i
const NUMBER_HEADING = /qty|quantity|units|sales|amount|total|price|value/i

/** A page's lines, top to bottom, each word with where it starts and ends. */
async function pdfPages(file: File): Promise<Line[][]> {
  // Loaded on demand: the PDF reader is big, and only this screen needs it.
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
  const pages: Line[][] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent()
    const lines: Line[] = []
    for (const it of content.items) {
      if (!('str' in it) || !it.str.trim()) continue
      const [, , , , x, y] = it.transform as number[]
      // Words within a couple of points of the same height are one line.
      let line = lines.find((l) => Math.abs(l.y - y) < 2.5)
      if (!line) lines.push((line = { y, cells: [] }))
      line.cells.push({ x, r: x + it.width, s: it.str.trim() })
    }
    for (const l of lines) l.cells.sort((a, b) => a.x - b.x)
    pages.push(lines.sort((a, b) => b.y - a.y))
  }
  return pages
}

/** The heading row: a description column and at least two number columns. Two-line headings are joined. */
function findHeader(lines: Line[]): Header | null {
  for (let k = 0; k < lines.length; k++) {
    const cells = lines[k].cells
    const name = cells.find((c) => NAME_HEADING.test(c.s))
    if (!name || cells.filter((c) => NUMBER_HEADING.test(c.s)).length < 2) continue
    const after = cells.filter((c) => c.x > name.x)
    const above = k > 0 && lines[k - 1].y - lines[k].y < 16 ? lines[k - 1].cells : []
    const label = (c: Cell) => [...above.filter((a) => a.x < c.r && a.r > c.x).map((a) => a.s), c.s].join(' ')
    return { y: lines[k].y, nameX: name.x, nameEnd: after[0]?.x ?? Infinity, cols: after.map((c) => ({ label: label(c), r: c.r })) }
  }
  return null
}

/** Read a PDF report. Uses column headings when it finds them; otherwise reads it as text lines. */
export async function readPdf(file: File): Promise<Report> {
  const pages = await pdfPages(file)
  const text = pages.flatMap((p) => p.map((l) => l.cells.map((c) => c.s).join(' ')))
  let header: Header | null = null
  let dept = ''
  let group = ''
  const rows: ReportRow[] = []

  for (const lines of pages) {
    const here = findHeader(lines)
    header = here ?? header
    if (!header) continue
    const h = header
    for (const line of lines) {
      if (here && line.y >= here.y) continue // the page heading and anything above it
      const words = line.cells.map((c) => c.s).join(' ')
      const m = words.match(/^(department|dept|group|category)\s*:\s*(?:\d+\s+)?(.*)$/i)
      if (m) {
        if (/^(department|dept)/i.test(m[1])) { dept = m[2]; group = '' } else group = m[2]
        continue
      }
      const code = line.cells.filter((c) => c.x < h.nameX - 2).map((c) => c.s).join(' ')
      const name = line.cells.filter((c) => c.x >= h.nameX - 2 && c.x < h.nameEnd - 2).map((c) => c.s).join(' ').replace(/\s+/g, ' ').trim()
      const nums = h.cols.map(() => 0)
      let found = false
      for (const c of line.cells) {
        if (c.x < h.nameEnd - 2 || !NUM.test(c.s)) continue
        // Numbers are right-aligned: each belongs to the heading whose right edge is nearest.
        let best = 0
        for (let k = 1; k < h.cols.length; k++) if (Math.abs(h.cols[k].r - c.r) < Math.abs(h.cols[best].r - c.r)) best = k
        if (Math.abs(h.cols[best].r - c.r) > 40) continue
        nums[best] = toNum(c.s)
        found = true
      }
      // A name that's only a barcode is still a product when the till gave it a code.
      if (!found || !name || (!/[a-z]/i.test(name) && !code) || NOT_A_PRODUCT.test(name) || /totals?:?\s*$/i.test(words)) continue
      rows.push({ name, code: code || undefined, group: [dept, group].filter(Boolean).join(' › ') || undefined, nums })
    }
  }

  if (!header) return parseLines(text)
  return { rows: merge(rows), columns: header.cols.map((c) => c.label), date: findDate(text) }
}

/**
 * Pasted text or a CSV file. Pasted tables come with tabs or spaces between cells;
 * a CSV separates them with commas, where a comma inside quotes ("1,234.50") is part of the value.
 */
export function readText(text: string, csv = false): Report {
  return parseLines(text.split(/\r?\n/).map((l) =>
    csv
      ? l.replace(/"([^"]*)"/g, (_, q: string) => q.replace(/,/g, '')).replace(/,/g, ' ')
      : l.replace(/\t+/g, ' '),
  ))
}
