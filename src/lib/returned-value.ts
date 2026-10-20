import type { Prisma, PrismaClient } from "@prisma/client"
import { returnQtyOf } from "@/lib/return-limits"
import { money } from "@/lib/utils"

type Db = PrismaClient | Prisma.TransactionClient

/** Returns that take money value off a sale: a refund, or a credit note. */
const MONEY_OUTCOMES = ["REFUND", "CREDIT_NOTE"] as const

/**
 * What finished refunds and credit notes have already taken off each sale.
 *
 * A return never edits the original invoice, so the invoice alone still reads
 * as owing after its phone came back: Lovety's ₦520,000 credit sale at Iwo
 * Road would have kept showing ₦520,000 due, with a form to collect it, after
 * the return had cleared that debt. Anything that works out what is still due
 * on a sale takes this off first.
 */
export async function returnedValueBySale(db: Db, saleIds: string[]) {
  const out = new Map<string, number>()
  if (saleIds.length === 0) return out
  const rows = await db.stockReturn.findMany({
    where: { saleId: { in: saleIds }, status: "COMPLETED", outcome: { in: [...MONEY_OUTCOMES] } },
    select: { saleId: true, returnValue: true, refundAmount: true },
  })
  for (const row of rows) {
    if (!row.saleId) continue
    const value = money(row.returnValue) || money(row.refundAmount)
    out.set(row.saleId, (out.get(row.saleId) ?? 0) + value)
  }
  return out
}

/** Still due on a sale once finished refunds and credit notes are taken off. */
export function dueAfterReturns(sale: { totalAmount: unknown; paidAmount: unknown }, returned: number) {
  return Math.max(0, money(sale.totalAmount) - money(sale.paidAmount) - returned)
}

/**
 * Sale lines that came back for a refund or a credit note. Profit leaves them
 * out: the phone is back on the shelf, so the sale it made is undone.
 */
export async function returnedSaleLineIds(db: Db) {
  const rows = await db.stockReturn.findMany({
    where: { status: "COMPLETED", outcome: { in: [...MONEY_OUTCOMES] } },
    select: { saleItemId: true, imeiId: true, saleId: true, quantity: true, notes: true },
  })
  // Pieces back per line. Two cords back off a line of five leaves three sold.
  const qtyBySaleItem = new Map<string, number>()
  for (const row of rows) {
    if (!row.saleItemId) continue
    qtyBySaleItem.set(row.saleItemId, (qtyBySaleItem.get(row.saleItemId) ?? 0) + returnQtyOf(row))
  }
  return {
    saleItemIds: new Set(rows.map((row) => row.saleItemId).filter((id): id is string => Boolean(id))),
    qtyBySaleItem,
    // Older returns name the phone rather than the line.
    imeiOnSale: new Set(rows.filter((row) => row.imeiId && row.saleId).map((row) => `${row.saleId}:${row.imeiId}`)),
  }
}

/**
 * How many pieces of a sale line are still sold once finished refunds and
 * credit notes are taken off: 0 for a line that came back in full.
 */
export function piecesStillSold(
  returned: Awaited<ReturnType<typeof returnedSaleLineIds>>,
  saleId: string,
  item: { id: string; imeiId: string | null; quantity: number }
) {
  if (item.imeiId && returned.imeiOnSale.has(`${saleId}:${item.imeiId}`)) return 0
  return Math.max(0, item.quantity - (returned.qtyBySaleItem.get(item.id) ?? 0))
}
