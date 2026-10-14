import { money } from "@/lib/utils"

/** Cash stays cash. Anything else (Bank, transfer, POS) is bank money. */
export function shopPayChannel(raw: string): "CASH" | "TRANSFER" {
  const value = String(raw || "").trim().toUpperCase()
  if (value === "CASH") return "CASH"
  return "TRANSFER"
}

/**
 * How money on a sale is counted for the books.
 *
 * Credit sales = what is still owed (invoice minus already paid).
 * Cash = cash till. Bank = transfer or POS (both land in a bank account).
 * A ₦180,000 sale with ₦120,000 bank paid is Bank received ₦120,000
 * and Credit sales ₦60,000, even though the sale itself is labelled CREDIT.
 */
export type SaleTenderRow = {
  paymentMethod: string
  totalAmount: unknown
  paidAmount: unknown
  payments?: Array<{ method: string; amount: unknown }> | null
  /** Settled from a credit note: part of paidAmount, but not money received. */
  creditNoteUsed?: unknown
}

export function saleTenders(sale: SaleTenderRow) {
  let cash = 0
  let transfer = 0
  let pos = 0
  const lines = sale.payments?.length ? sale.payments : null
  if (lines) {
    for (const payment of lines) {
      const amount = money(payment.amount)
      if (payment.method === "CASH") cash += amount
      else if (payment.method === "TRANSFER") transfer += amount
      else if (payment.method === "POS") pos += amount
    }
  } else {
    const paid = Math.max(0, money(sale.paidAmount) - money(sale.creditNoteUsed))
    if (sale.paymentMethod === "CASH") cash = paid
    else if (sale.paymentMethod === "TRANSFER") transfer = paid
    else if (sale.paymentMethod === "POS") pos = paid
  }

  const revenue = money(sale.totalAmount)
  const collected = money(sale.paidAmount)
  const credit = Math.max(0, revenue - collected)
  // Bank = every non-cash tender. Old POS lines and new bank (TRANSFER) sales both count here.
  const bank = transfer + pos
  let received = cash + bank
  // Older credit sales may have a deposit on paidAmount with no payment rows.
  // Count that money in Total payments received, but do not guess the channel.
  const creditNote = money(sale.creditNoteUsed)
  if (!lines && received === 0 && collected - creditNote > 0 && (sale.paymentMethod === "CREDIT" || sale.paymentMethod === "SPLIT_PAYMENT")) {
    received = collected - creditNote
  }

  return { cash, transfer, pos, bank, credit, creditNote, revenue, collected, received }
}

export function sumSaleTenders(rows: SaleTenderRow[]) {
  return rows.reduce(
    (acc, sale) => {
      const row = saleTenders(sale)
      acc.cash += row.cash
      acc.transfer += row.transfer
      acc.pos += row.pos
      acc.bank += row.bank
      acc.credit += row.credit
      acc.creditNote += row.creditNote
      acc.revenue += row.revenue
      acc.collected += row.collected
      acc.received += row.received
      acc.count += 1
      return acc
    },
    { cash: 0, transfer: 0, pos: 0, bank: 0, credit: 0, creditNote: 0, revenue: 0, collected: 0, received: 0, count: 0 }
  )
}

/**
 * What one sale line really brought in once the whole-order discount is shared
 * out across the invoice, in proportion to each line's value.
 *
 * Lines carry their price before that discount (they add up to the subtotal),
 * so profit read straight off the lines ignored it: a ₦345,000 basket sold for
 * ₦340,000 after ₦5,000 off showed ₦5,000 more profit than the shop made.
 */
export function lineValueAfterOrderDiscount(
  lineTotal: unknown,
  sale: { subtotal: unknown; discount: unknown }
) {
  const value = money(lineTotal)
  const subtotal = money(sale.subtotal)
  const discount = money(sale.discount)
  if (discount <= 0 || subtotal <= 0) return value
  return value - (discount * value) / subtotal
}
