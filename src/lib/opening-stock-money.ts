import { cache } from "react"
import { prisma } from "@/lib/prisma"
import { OPENING_STOCK_METHOD, UPLOAD_STOCK_SOURCE } from "@/lib/upload-purchase"
import {
  isTrueOpeningStockNotes,
  openingStockPurchaseWhere,
  openingStockSupplierWhere,
  paymentFromUploadNotes,
} from "@/lib/purchase-money"
import { money } from "@/lib/utils"

/**
 * Opening stock must never sit as money owed. Older loads could save UNPAID
 * and post a supplier payment. This puts those bills back to value only.
 *
 * Supplier carton uploads share the UPLOAD_STOCK source. They are not opening
 * stock. If an earlier heal marked them paid as opening stock, this restores
 * the paid / unpaid state from the bill notes so Reports and Money in and out
 * show the same balance as Goods from supplier.
 *
 * Item costs are left alone here. This runs on every Home, Reports and Money
 * page load, and it used to put every item's cost back to its opening-stock
 * cost and rewrite the cost on sales already made: a restock at a new price
 * was undone the next time anyone opened Home. Opening stock corrections set
 * the cost themselves, when they are made.
 */
export const healOpeningStockBills = cache(async () => {
  await restoreMisclassifiedSupplierBills()

  // The one opening stock rule (see purchase-money): OPEN- bills, bills with
  // an OpeningStock record, and every bill under an opening stock supplier
  // name ("Opening Stock", "OPENING STOCK (FAULTY)") however it was loaded.
  // Bills of that kind entered any other way used to stay "owed", which is
  // how opening stock read as ₦103m owed to suppliers on Home.
  const bills = await prisma.purchase.findMany({
    where: openingStockPurchaseWhere,
    select: { id: true, invoiceNumber: true, totalAmount: true, paidAmount: true, paymentMethod: true },
  })
  const refs: string[] = []
  for (const bill of bills) {
    const total = money(bill.totalAmount)
    if (bill.paymentMethod === OPENING_STOCK_METHOD && Math.abs(money(bill.paidAmount) - total) < 0.005) {
      refs.push(bill.invoiceNumber)
      continue
    }
    await prisma.purchase.update({
      where: { id: bill.id },
      data: {
        paymentMethod: OPENING_STOCK_METHOD,
        paidAmount: total.toFixed(2),
      },
    })
    refs.push(bill.invoiceNumber)
  }
  if (refs.length) {
    await prisma.financeEntry.deleteMany({
      where: {
        account: "SUPPLIER_PAYMENTS",
        type: "EXPENSE",
        reference: { in: refs },
      },
    })
  }
})

async function restoreMisclassifiedSupplierBills() {
  const rows = await prisma.purchase.findMany({
    where: {
      source: UPLOAD_STOCK_SOURCE,
      paymentMethod: OPENING_STOCK_METHOD,
      status: { not: "CANCELLED" },
      invoiceNumber: { not: { startsWith: "OPEN-" } },
      openingStock: { is: null },
      // Bills under an opening stock name are opening stock whatever their
      // notes say. Restoring them here only for the heal to undo it was a
      // flip on every page load.
      NOT: { supplier: openingStockSupplierWhere },
    },
    select: {
      id: true,
      invoiceNumber: true,
      notes: true,
      totalAmount: true,
      branchId: true,
    },
  })

  for (const row of rows) {
    if (isTrueOpeningStockNotes(row.notes)) continue
    const restored = paymentFromUploadNotes(row.notes, money(row.totalAmount))
    if (restored.method === OPENING_STOCK_METHOD) continue
    await prisma.purchase.update({
      where: { id: row.id },
      data: {
        paymentMethod: restored.method,
        paidAmount: restored.paid.toFixed(2),
      },
    })
    if (restored.paid <= 0.005) continue
    const exists = await prisma.financeEntry.findFirst({
      where: {
        account: "SUPPLIER_PAYMENTS",
        type: "EXPENSE",
        reference: row.invoiceNumber,
      },
      select: { id: true },
    })
    if (exists) continue
    await prisma.financeEntry.create({
      data: {
        branchId: row.branchId,
        account: "SUPPLIER_PAYMENTS",
        type: "EXPENSE",
        amount: restored.paid.toFixed(2),
        reference: row.invoiceNumber,
        description: `Supplier payment on upload for ${row.invoiceNumber}`,
      },
    })
  }
}
