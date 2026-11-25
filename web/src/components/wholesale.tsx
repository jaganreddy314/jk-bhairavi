import { qtyLabel } from '../lib/wholesale'
import type { WholesaleProduct } from '../lib/types'

/** − 2 cartons +: steps by the product's usual lot; stepping below one lot takes it off the list. */
export function Stepper({ product, qty, step, onQty }: { product: WholesaleProduct; qty: number; step: number; onQty: (n: number) => void }) {
  return (
    <div className="flex items-center gap-1">
      <button type="button" className="btn btn-sm w-8 px-0" aria-label="Less" onClick={() => onQty(qty - step)}>−</button>
      <span className="num min-w-[84px] text-center text-[13px] font-medium">{qtyLabel(product, qty)}</span>
      <button type="button" className="btn btn-sm w-8 px-0" aria-label="More" onClick={() => onQty(qty + step)}>+</button>
    </div>
  )
}
