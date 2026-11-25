"""
Turn wholesalers' tobacco price files into SQL that loads them into the shared price tables
(migration 025). Prints the SQL; review it, then run it against the database with psql.

    pip install openpyxl pypdf
    python3 scripts/wholesale_prices.py \
        --trax "CIGARETTES Trax Distribution.pdf" "TOBACCO Trax Distribution.pdf" ... --trax-date 2026-11-25 \
        --metcash "Metcash Tobacco 02.11.26 - 29.11.26.xlsx" --metcash-from 2026-11-02 --metcash-to 2026-11-29 \
        --one "One Distribution Price File 16.11.2026.xlsx" --one-date 2026-11-16 > prices.sql

What each source looks like:
  Trax         the web shop's category pages saved as PDF. Prices inc GST, per carton ("20/200" = 10 packs),
               per pouch for tobacco, per outer for filters/papers/lighters ("140/1400" = 10 boxes).
  Metcash      monthly tobacco workbook, one sheet per manufacturer. Prices ex GST, for "Metcash Pack Qty"
               units (cigarette cartons count 1 = 10 packs). "Other Updated" replaces "Other".
  One          price file. Prices inc GST. ":CT" codes are cartons/outers (cigarettes 10 packs, 30g tobacco
               5 pouches, 15g 10 pouches); cigars come both single and boxed.

Every price is compared per retail unit (a pack of 20, a pouch, a box of filters, a booklet, a lighter).
Products are matched across wholesalers by barcode first, then by a normalised name (match_key).
"""
from __future__ import annotations
import argparse, re, sys
from pathlib import Path

GST = 1.1

# ---------- names → match keys ----------

# Whole-phrase rewrites, applied in order before splitting into words.
PHRASES = [
    (r'BEN/HEDGES', 'BENSON HEDGES'), (r'P/JACKSON', 'PETER JACKSON'), (r'^PJ\b', 'PETER JACKSON'),
    (r'LAMB&BUTLER', 'LAMBERT BUTLER'), (r'PARK&SIMPS', 'PARKER SIMPSON'), (r'\bBOND ST\b', 'BOND STREET'),
    (r'TALLY-HO', 'TALLY HO'), (r"'S\b", 'S'), (r'\bG V\b', 'GV'), (r'^ROTHMANS REGULAR\b', 'ROTHMANS'),
    (r'^MAKERS BLEND CAPSTAN\b', 'CAPSTAN MAKERS ORIGINAL'), (r'\bHARMONY BY\b', 'HARMONY'),
    (r'\(OUTER\)|\(BOX\)', ''), (r'&', ' '),
]
WORDS = {
    'CLAS': 'CLASSIC', 'CLS': 'CLASSIC', 'ORIG': 'ORIGINAL', 'REG': 'REGULAR', 'VIRG': 'VIRGINIA',
    'VIRGINA': 'VIRGINIA', 'SIG': 'SIGNATURE', 'BLENDED': 'BLEND', 'ELECT': 'ELECTRIC', 'FEST': 'FESTIVAL',
    'NEONB': 'NEON', 'SUPA': 'SUPER', 'SLIMS': 'SLIM',
}
# Pack colour letters ("Original B"), and words that only say what kind of product it is.
DROP = {'B', 'G', 'R', 'Y', 'S', 'W', 'RYO', 'TOBACCO', 'UNPLUGGED', 'GM', 'CIGAR'}
# Sizes: dropped from cigarette and tobacco names (the category says it), kept for the rest.
SIZE = re.compile(r'\b(20/200|200X20|20/60|30GM|30/150|30|15|20)\b')

# The same product under names the rules above can't line up. Value: the name it should match.
SAME_AS = {
    'HOWLING WOLF 30 TOBACCO': 'HOWLING WOLF RYO 30 ORIGINAL',
    'PORT ROYAL 30 TOBACCO': 'PORT ROYAL RYO 30 ORIGINAL',
    'STUYVESANT RYO 30 ORIGINAL': 'STUYVESANT RYO 30',
    'ALBANY RYO 30': 'ALBANY RYO 30 ORIGINAL',
    'OLD HOLBORN 30 TOBACCO': 'OLD HOLBORN RYO 30',
    'TYCOON CIGAR CLASSIC HLP 20S': 'TYCOON HLP 20 CLASSIC',
    # Metcash's accessory names → Trax's: same pack, Metcash price × GST = Trax price.
    # Ranch filters and BIC lighters are left apart: their barcodes differ and so do the prices.
    'TALLY HO FILTER SUPER SLIM140S': 'TALLY HO FILTERS 140/1400 SUPER SLIM',
    'TALLY HO FILTER MICRO SLIM140S': 'TALLY HO FILTERS 140/1400 MICRO SLIM',
    'PAPERS RYO PAPERS 60S': 'PAPERS PAPERS 60/3000',
    'TALLY-HO 50S': 'TALLY HO PAPERS 50/5000 SINGLES',
    'TALLY-HO 5PACK 250S': 'TALLY HO MULTI PACK PAPERS 250/12500',
    'RIZLA BLUE DOUBLE PAPERS 100S': 'RIZLA PAPERS 100/2500 BLUE DOUBLES',
}

UNIT = {'cigarettes': 'pack', 'tobacco': 'pouch', 'cigars': 'pack', 'filters': 'box', 'papers': 'booklet', 'lighters': 'lighter'}


def match_key(category: str, description: str) -> str:
    s = ' '.join(re.sub(r'\(OUTER\)|\(BOX\)', '', description.upper()).split())
    s = SAME_AS.get(s, s)
    for pat, rep in PHRASES:
        s = re.sub(pat, rep, s)
    if category in ('cigarettes', 'tobacco', 'cigars'):
        s = SIZE.sub(' ', s)
    words = [WORDS.get(w, w) for w in s.split()]
    return category + ':' + ' '.join(sorted(w for w in words if w not in DROP))


def size_of(category: str, description: str) -> str | None:
    d = description.upper()
    if category == 'cigarettes':
        return '20s'
    if category == 'tobacco':
        return '15g' if re.search(r'\b15\b', d) else '30g'
    return None


def pretty(category: str, description: str) -> str:
    """'BOND STREET CLASSIC 20/200 ORIGINAL B' → 'Bond Street Classic Original B'."""
    s = re.sub(r'\(OUTER\)|\(BOX\)', '', description, flags=re.I)
    if category == 'cigarettes':
        s = re.sub(r'\b20/60\b', '3-pack', s)
        s = re.sub(r'\b(20/200|200X20|20)\b', '', s, flags=re.I)
    if category == 'tobacco':
        s = re.sub(r'\b(30/150|30GM|30|15|TOBACCO)\b', '', s, flags=re.I)
    words = []
    for w in s.split():
        up = w.upper()
        if up in ('JPS', 'BIC', 'RAW', 'SMK', 'GV', 'XL', 'RYO', 'HLP', 'DBL'):
            words.append(up)
        elif len(w) == 1:
            words.append(up)
        else:
            words.append(re.sub(r"'S\b", "'s", re.sub(r'(\d)S\b', r'\1s', w.title())))
    return ' '.join(words)


# ---------- readers ----------

def read_trax(paths):
    import pypdf
    stop = re.compile(r'^(Cart|to|Add|-|Inc GST|View as:.*|.*\(\d+\)|)$')
    junk = re.compile(r'^.*(displayMode=line \d+/\d+|All rights reserved\.|LIGHTERS)\s*')
    for path in paths:
        text = '\n'.join(p.extract_text() for p in pypdf.PdfReader(path).pages)
        m = re.search(r'\b(CIGARETTES|TOBACCO|FILTERS|CIGARS|PAPERS|LIGHTERS) Trax Distribution', text)
        if not m:
            sys.exit(f'{path}: not a Trax category page')
        category = m[1].lower()
        lines = [l.strip() for l in text.split('\n')]
        for i, l in enumerate(lines):
            if 'GTIN:' not in l:
                continue
            before = l.split('GTIN:')[0].strip()
            name = [before] if before else []
            j = i - 1
            while j >= 0 and not stop.match(lines[j]):
                name.insert(0, lines[j]); j -= 1
            desc = ' '.join(junk.sub('', re.sub(r'[\ue000-\uf8ff]', '', ' '.join(name))).split())  # icon-font glyphs
            gtin = re.sub(r'\D', '', l.split('GTIN:')[1]) or re.sub(r'\D', '', lines[i + 1])
            k = i + 1
            while not lines[k].startswith('AU$'):
                k += 1
            price = float(lines[k][3:].replace(',', ''))
            if category == 'tobacco':
                units = 1
            else:
                a, b = map(int, re.search(r'\b(\d+)/(\d+)\b', desc).groups())
                units = b // a
            yield dict(category=category, code=None, gtin=gtin, description=desc, units=units,
                       price_inc=price, price_ex=round(price / GST, 2))


def metcash_category(desc, sheet_desc):
    d = desc.upper()
    if '200X20' in d: return 'cigarettes'
    if '30GM' in d: return 'tobacco'
    if 'FILTER' in d: return 'filters'
    if 'LIGHTER' in d or 'GASMATCH' in d: return 'lighters'
    if 'CIGAR' in d: return 'cigars'
    if 'PAPER' in d or 'TALLY' in d: return 'papers'
    sys.exit(f'Metcash: no category for {desc!r} ({sheet_desc})')


def read_metcash(path):
    import openpyxl
    wb = openpyxl.load_workbook(path, data_only=True)
    rows = {}
    # Read "Other Updated" after "Other" so its prices win.
    for sheet in sorted(wb.sheetnames, key=lambda s: s == 'Other Updated'):
        hdr = None
        for r in wb[sheet].iter_rows(values_only=True):
            if 'APN' in r:
                hdr = [str(c).strip() if c else c for c in r]
                continue
            if not hdr:
                continue
            g = lambda k: r[hdr.index(k)]
            if g('APN') is None or g('Metcash Code') is None:
                continue
            desc = ' '.join(str(g('Metcash Product Description')).split())
            category = metcash_category(desc, g('Description') if 'Description' in hdr else None)
            qty = int(g('Metcash Pack Qty'))
            ex = round(float(g('Price ex GST') if 'Price ex GST' in hdr else g('Carton Cost ex GST')), 2)
            rows[str(g('Metcash Code'))] = dict(
                category=category, code=str(g('Metcash Code')), gtin=str(int(g('APN'))), description=desc,
                units=qty * 10 if category == 'cigarettes' else qty, price_ex=ex, price_inc=round(ex * GST, 2))
    return rows.values()


def read_one(path):
    import openpyxl
    ws = openpyxl.load_workbook(path, data_only=True).active
    raw = [(str(r[0]).strip(), str(r[1]).strip(), round(float(r[3]), 2)) for r in ws.iter_rows(min_row=2, values_only=True) if r[0]]
    single = {code: price for _, code, price in raw if not code.endswith(':CT')}
    for desc, code, price in raw:
        d = desc.upper()
        boxed = code.endswith(':CT')
        if re.search(r'20/200|^(MUZA|BOND STREET SLAB|PETER JACKSON SLAB|PALL MALL SIGNATURE) 20\b', d):
            category, units = 'cigarettes', 10
        elif re.search(r'\b(30|15)\b.*\(OUTER\)', d) and 'CIGAR' not in d and 'SAILORS' not in d:
            category, units = 'tobacco', 10 if re.search(r'\b15\b', d) else 5
        else:
            category = 'cigars'
            units = round(price / single[code.removesuffix(':CT')]) if boxed else 1
        yield dict(category=category, code=code, gtin=None, description=desc, units=units,
                   price_inc=price, price_ex=round(price / GST, 2))


# ---------- SQL ----------

def q(v):
    if v is None:
        return 'null'
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--trax', nargs='*', default=[]); ap.add_argument('--trax-date')
    ap.add_argument('--metcash'); ap.add_argument('--metcash-from'); ap.add_argument('--metcash-to')
    ap.add_argument('--one'); ap.add_argument('--one-date')
    a = ap.parse_args()

    lists = []  # (wholesaler, effective_from, effective_to, source, rows)
    if a.trax:
        lists.append(('Trax Distribution', a.trax_date, None, ', '.join(Path(p).name for p in a.trax), list(read_trax(a.trax))))
    if a.metcash:
        lists.append(('Metcash', a.metcash_from, a.metcash_to, Path(a.metcash).name, list(read_metcash(a.metcash))))
    if a.one:
        lists.append(('One Distribution', a.one_date, None, Path(a.one).name, list(read_one(a.one))))
    if not lists:
        ap.error('give at least one price file')

    # Barcodes shared within this import tie names together (Metcash's short names adopt Trax's).
    key_by_gtin = {}
    for *_, rows in lists:
        for r in rows:
            r['key'] = key_by_gtin.get(r['gtin']) or match_key(r['category'], r['description'])
            if r['gtin']:
                key_by_gtin.setdefault(r['gtin'], r['key'])

    out = [
        '-- Generated by scripts/wholesale_prices.py. Loads one price list per wholesaler.',
        'begin;',
        'create temp table _import (wholesaler text, effective_from date, effective_to date, source text, pos int,',
        '  category text, code text, gtin text, description text, units int, price_ex numeric, price_inc numeric,',
        '  match_key text, name text, size text, unit text) on commit drop;',
    ]
    pos = 0
    for wholesaler, frm, to, source, rows in lists:
        vals = []
        for r in rows:
            pos += 1
            vals.append('(' + ', '.join(q(v) for v in (
                wholesaler, frm, to, source, pos, r['category'], r['code'], r['gtin'], r['description'], r['units'],
                r['price_ex'], r['price_inc'], r['key'], pretty(r['category'], r['description']),
                size_of(r['category'], r['description']), UNIT[r['category']])) + ')')
        out.append('insert into _import values\n  ' + ',\n  '.join(vals) + ';')

    out.append(Path(__file__).with_name('wholesale_prices_load.sql').read_text())
    out.append('commit;')
    print('\n'.join(out))
    for wholesaler, *_, rows in lists:
        print(f'-- {wholesaler}: {len(rows)} prices', file=sys.stderr)


if __name__ == '__main__':
    main()
