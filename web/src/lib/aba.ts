// The ABA (Cemtex) direct entry file every Australian bank accepts for bulk payments.
// Fixed-width 120-character records: a descriptive record (0), one detail record per
// payment (1), an optional balancing debit, and a file total record (7), each ending CRLF.

export interface AbaPayment { bsb: string; account: string; name: string; cents: number; reference: string }

export interface AbaFile {
  bankCode: string       // 3 letters, e.g. CBA
  userName: string       // as registered with the bank, max 26
  apcaId: string         // 6-digit user ID number
  description: string    // max 12, e.g. 'WAGES'
  processDate: string    // YYYY-MM-DD
  fromBsb: string        // the account the money comes from (trace account)
  fromAccount: string
  remitter: string       // shown on the payee's statement, max 16
  balancing: boolean     // add a debit line from the trace account for the total
  payments: AbaPayment[]
}

/** Banks accept plain printable ASCII only. */
const clean = (s: string) => s.normalize('NFKD').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim()
const left = (s: string, n: number) => clean(s).slice(0, n).padEnd(n, ' ')
const right = (s: string | number, n: number, fill = ' ') => String(s).slice(-n).padStart(n, fill)
const blank = (n: number) => ' '.repeat(n)

export const bsbOk = (b: string) => /^\d{3}-?\d{3}$/.test(b.trim())
const bsb = (b: string) => { const d = b.replace(/\D/g, ''); return `${d.slice(0, 3)}-${d.slice(3, 6)}` }
const ddmmyy = (d: string) => `${d.slice(8, 10)}${d.slice(5, 7)}${d.slice(2, 4)}`

function detail(code: '13' | '53', to: { bsb: string; account: string; name: string }, cents: number, reference: string, f: AbaFile) {
  return '1' + bsb(to.bsb) + right(to.account.replace(/\D/g, ''), 9) + ' ' + code + right(cents, 10, '0') +
    left(to.name, 32) + left(reference, 18) + bsb(f.fromBsb) + right(f.fromAccount.replace(/\D/g, ''), 9) + left(f.remitter, 16) + '00000000'
}

export function abaFile(f: AbaFile): string {
  const lines: string[] = []
  lines.push('0' + blank(17) + '01' + left(f.bankCode.toUpperCase(), 3) + blank(7) + left(f.userName, 26) +
    right(f.apcaId, 6, '0') + left(f.description, 12) + ddmmyy(f.processDate) + blank(40))
  let credit = 0
  for (const p of f.payments) {
    lines.push(detail('53', p, p.cents, p.reference, f))
    credit += p.cents
  }
  let debit = 0
  if (f.balancing && credit > 0) {
    lines.push(detail('13', { bsb: f.fromBsb, account: f.fromAccount, name: f.userName }, credit, f.description, f))
    debit = credit
  }
  const count = lines.length - 1
  lines.push('7' + '999-999' + blank(12) + right(Math.abs(credit - debit), 10, '0') + right(credit, 10, '0') + right(debit, 10, '0') +
    blank(24) + right(count, 6, '0') + blank(40))
  return lines.join('\r\n') + '\r\n'
}
