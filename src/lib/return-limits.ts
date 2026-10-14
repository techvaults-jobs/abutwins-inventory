import type { Prisma, PrismaClient } from "@prisma/client"
import { lineValueAfterOrderDiscount } from "@/lib/sale-money"
import { money } from "@/lib/utils"

type Db = PrismaClient | Prisma.TransactionClient

/** Half a kobo: the slack allowed when comparing typed money to a limit. */
const EPSILON = 0.005

/**
 * How many pieces a return brought back. Returns logged from an invoice line
 * store it; older ones wrote "Qty: N" into their notes right after the item
 * name, and only that spot is read, so a note the cashier typed that happens
 * to say "Qty: 50" cannot put 50 pieces back on the shelf.
 */
export function returnQtyOf(row: { quantity?: number | null; notes?: string | null }) {
  if (row.quantity != null && row.quantity > 0) return row.quantity
  const legacy = row.notes?.match(/^Item: [^·]*· Qty: (\d+)/)
  return legacy ? Math.max(1, Number(legacy[1])) : 1
}

/**
 * What other returns have already taken from a sale, and from one of its
 * lines. Every return that was not rejected counts, open ones included, so
 * two returns raced against the same invoice cannot both fit.
 */
export async function returnedSoFar(db: Db, args: { saleId: string; saleItemId?: string | null; excludeReturnId?: string }) {
  const rows = await db.stockReturn.findMany({
    where: {
      saleId: args.saleId,
      status: { not: "REJECTED" },
      ...(args.excludeReturnId ? { id: { not: args.excludeReturnId } } : {}),
    },
    select: { saleItemId: true, quantity: true, notes: true, returnValue: true, refundAmount: true },
  })
  let saleValue = 0
  let lineValue = 0
  let lineQty = 0
  for (const row of rows) {
    const value = money(row.returnValue) || money(row.refundAmount)
    saleValue += value
    if (args.saleItemId && row.saleItemId === args.saleItemId) {
      lineValue += value
      lineQty += returnQtyOf(row)
    }
  }
  return { saleValue, lineValue, lineQty }
}

/**
 * The most a return may be worth: what the returned pieces sold for on the
 * invoice (the order discount shared out), less what earlier returns already
 * took from that line and from the invoice as a whole. A return can be worth
 * less (one item of three, a restocking deduction) but never more than was
 * sold: a ₦5,000 item used to accept a ₦10,000 return.
 */
export function returnValueLimit(args: {
  sale: { subtotal: unknown; discount: unknown; totalAmount: unknown }
  /** The invoice line coming back (its full line total and quantity). */
  line: { totalPrice: unknown; quantity: number }
  /** Pieces coming back on this return. */
  quantity: number
  already: { saleValue: number; lineValue: number }
}) {
  const lineSold = lineValueAfterOrderDiscount(args.line.totalPrice, args.sale)
  const unitSold = lineSold / Math.max(1, args.line.quantity)
  const forThesePieces = unitSold * args.quantity
  const lineLeft = Math.max(0, lineSold - args.already.lineValue)
  const saleLeft = Math.max(0, money(args.sale.totalAmount) - args.already.saleValue)
  return { unitSold, lineSold, limit: money(Math.max(0, Math.min(forThesePieces, lineLeft, saleLeft))) }
}

/** True when a typed value is over the limit by more than rounding. */
export function overLimit(value: number, limit: number) {
  return value - limit > EPSILON
}

/**
 * What earlier finished refunds and credit notes on a sale already settled:
 * the value they took off it, and the cash actually paid back out.
 */
export async function earlierReturnMoney(db: Db, saleId: string, excludeReturnId: string) {
  const rows = await db.stockReturn.findMany({
    where: { saleId, status: "COMPLETED", outcome: { in: ["REFUND", "CREDIT_NOTE"] }, id: { not: excludeReturnId } },
    select: { returnNumber: true, returnValue: true, refundAmount: true },
  })
  const value = rows.reduce((sum, row) => sum + (money(row.returnValue) || money(row.refundAmount)), 0)
  const paidOut = rows.length
    ? await db.financeEntry.aggregate({
        where: { type: "EXPENSE", reference: { in: rows.map((row) => row.returnNumber) } },
        _sum: { amount: true },
      })
    : null
  return { value, cashOut: money(paidOut?._sum.amount) }
}

/**
 * How a refund or credit note of `asked` splits on its sale, after what
 * earlier returns already did. The value first clears what is still owed on
 * the sale; only the rest can come back as money, and never more than the
 * customer paid less what earlier refunds already handed back. The value
 * itself is held to what is left of the invoice.
 *
 * Without the earlier returns, a second return on a part-paid sale cleared
 * the same debt twice, and repeat refunds could pay out more than was paid.
 */
export function refundSplit(args: {
  asked: number
  outcome: string
  sale: { totalAmount: unknown; paidAmount: unknown; creditNoteUsed?: unknown } | null
  earlier: { value: number; cashOut: number }
}) {
  if (!args.sale) {
    return { value: args.asked, debtRelief: 0, cashOut: args.outcome === "REFUND" ? args.asked : 0, creditBack: 0 }
  }
  const total = money(args.sale.totalAmount)
  const settled = money(args.sale.paidAmount)
  // Part of a sale settled from a credit note was never money: it can only go
  // back as credit, never out of the till or the bank.
  const fromCredit = Math.min(settled, money(args.sale.creditNoteUsed))
  const paid = settled - fromCredit
  const value = money(Math.min(args.asked, Math.max(0, total - args.earlier.value)))
  const stillOwed = Math.max(0, total - settled - args.earlier.value)
  const debtRelief = money(Math.min(stillOwed, value))
  const paidLeft = Math.max(0, paid - args.earlier.cashOut)
  const cashOut = args.outcome === "REFUND" ? money(Math.min(value - debtRelief, paidLeft)) : 0
  const creditBack = args.outcome === "REFUND" ? money(Math.max(0, Math.min(value - debtRelief - cashOut, fromCredit))) : 0
  return { value, debtRelief, cashOut, creditBack }
}

/** For the return form: what can still come back on each line of a sale. */
export type SaleReturnRoom = {
  /** Value left on the invoice after every return so far. */
  saleLeft: number
  /** Value of every return so far. */
  returned: number
  lines: Record<string, { unitSold: number; qtyLeft: number; valueLeft: number }>
}

export async function saleReturnRoom(
  db: Db,
  sale: { id: string; subtotal: unknown; discount: unknown; totalAmount: unknown; items: Array<{ id: string; totalPrice: unknown; quantity: number }> }
): Promise<SaleReturnRoom> {
  const rows = await db.stockReturn.findMany({
    where: { saleId: sale.id, status: { not: "REJECTED" } },
    select: { saleItemId: true, quantity: true, notes: true, returnValue: true, refundAmount: true },
  })
  const returned = rows.reduce((sum, row) => sum + (money(row.returnValue) || money(row.refundAmount)), 0)
  const saleLeft = Math.max(0, money(sale.totalAmount) - returned)
  const lines: SaleReturnRoom["lines"] = {}
  for (const line of sale.items) {
    const mine = rows.filter((row) => row.saleItemId === line.id)
    const lineValue = mine.reduce((sum, row) => sum + (money(row.returnValue) || money(row.refundAmount)), 0)
    const lineQty = mine.reduce((sum, row) => sum + returnQtyOf(row), 0)
    const cap = returnValueLimit({ sale, line, quantity: line.quantity, already: { saleValue: returned, lineValue } })
    lines[line.id] = {
      unitSold: money(cap.unitSold),
      qtyLeft: Math.max(0, line.quantity - lineQty),
      valueLeft: cap.limit,
    }
  }
  return { saleLeft: money(saleLeft), returned: money(returned), lines }
}
