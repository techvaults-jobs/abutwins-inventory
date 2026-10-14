import { DocumentLetterhead, DocumentPaperFooter } from "@/components/document-letterhead"
import type { LetterheadBrand } from "@/lib/letterhead"
import { formatCurrency, formatDateTime } from "@/lib/utils"

type Line = {
  name: string
  imei?: string | null
  quantity: number
  amount: number
  warranty?: string | null
  storage?: string | null
  condition?: string | null
  color?: string | null
}

export function Receipt({
  brand,
  invoiceNumber,
  branch,
  cashier,
  customer,
  phone,
  soldAt,
  items,
  total,
  discount = 0,
  paid,
  creditNoteUsed = 0,
  method,
  paymentReference,
  notes,
}: {
  brand: LetterheadBrand
  invoiceNumber: string
  branch: string
  cashier: string
  customer: string
  phone?: string | null
  soldAt: Date
  items: Line[]
  total: number
  /** Money taken off the whole order. Shown so the lines and the total add up. */
  discount?: number
  paid: number
  /** Part of what was paid that came off the buyer's credit note. */
  creditNoteUsed?: number
  method: string
  /** Transfer description or POS approval code for bank payments. */
  paymentReference?: string | null
  notes?: string | null
}) {
  const due = Math.max(0, total - paid)
  return (
    <section className="invoice mx-auto w-full max-w-[190mm] overflow-hidden bg-white text-slate-900">
      <DocumentLetterhead
        brand={brand}
        documentKind="Sales invoice"
        documentTitle={invoiceNumber}
        meta={[branch, formatDateTime(soldAt)]}
      />

      <div className="grid gap-4 border-b border-slate-200 px-6 py-4 text-sm md:grid-cols-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Bill to</p>
          <p className="mt-1 font-semibold">{customer}</p>
          {phone ? <p className="text-slate-600">{phone}</p> : null}
        </div>
        <div className="md:text-right">
          <p className="font-mono text-base font-semibold">{invoiceNumber}</p>
          <p className="text-slate-600">{formatDateTime(soldAt)}</p>
          <p className="text-slate-600">Served by {cashier}</p>
        </div>
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-left text-[11px] uppercase tracking-wider text-slate-500">
            <th className="px-6 py-2">Item</th>
            <th className="px-3 py-2">IMEI / serial</th>
            <th className="px-3 py-2 text-right">Qty</th>
            <th className="px-6 py-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={`${item.name}-${index}`} className="border-b border-slate-100">
              <td className="px-6 py-3">
                <p className="font-medium text-slate-900">{item.name}</p>
                {item.storage || item.condition || item.color ? (
                  <p className="text-[11px] font-medium text-slate-600">
                    {[item.storage, item.condition, item.color].filter(Boolean).join(" · ")}
                  </p>
                ) : null}
                {item.warranty ? <span className="block text-[10px] text-slate-500">{item.warranty}</span> : null}
              </td>
              <td className="px-3 py-3 font-mono text-xs">{item.imei ?? "-"}</td>
              <td className="px-3 py-3 text-right">{item.quantity}</td>
              <td className="px-6 py-3 text-right">{formatCurrency(item.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="grid gap-4 px-6 py-5 md:grid-cols-2">
        <div className="text-xs text-slate-500">
          <p>Payment: {method}</p>
          {paymentReference ? <p className="mt-0.5">Ref: {paymentReference}</p> : null}
          {notes ? <p className="mt-1">{notes}</p> : null}
          <p className="mt-3">This paper shows what was sold. Any money paid later, and any return or swap, is written down on its own. Nobody can change this invoice.</p>
          <p className="mt-2 print:hidden">If a receipt printer is connected, printing this can open the cash drawer.</p>
        </div>
        <div className="space-y-1 text-sm">
          {discount > 0 ? (
            <>
              <div className="flex justify-between text-slate-500">
                <span>Items</span>
                <span>{formatCurrency(total + discount)}</span>
              </div>
              <div className="flex justify-between text-slate-500">
                <span>Discount</span>
                <span>-{formatCurrency(discount)}</span>
              </div>
            </>
          ) : null}
          <div className="flex justify-between"><span>Total</span><span className="font-semibold">{formatCurrency(total)}</span></div>
          {creditNoteUsed > 0 ? (
            <div className="flex justify-between"><span>From credit note</span><span>{formatCurrency(creditNoteUsed)}</span></div>
          ) : null}
          <div className="flex justify-between"><span>{creditNoteUsed > 0 ? "Paid in money" : "Paid"}</span><span>{formatCurrency(paid - creditNoteUsed)}</span></div>
          <div className="flex justify-between border-t border-slate-200 pt-1 font-semibold">
            <span>Balance</span>
            <span>{formatCurrency(due)}</span>
          </div>
        </div>
      </div>

      <DocumentPaperFooter brand={brand} extra={branch} />
    </section>
  )
}
