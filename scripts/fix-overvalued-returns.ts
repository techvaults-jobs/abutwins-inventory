/**
 * Find returns recorded for more than their item sold for, and put the
 * recorded value right.
 *
 * Before returns were limited to the invoice, a cashier could type any value:
 * a ₦5,000 item took a ₦10,000 return. The cash paid out was already capped
 * at what the customer paid, so the money is right; the RECORD is wrong, and
 * it overstates Sales returns and pushes the sale's real value below zero.
 *
 * This lists every such return with what it should be and the cash actually
 * paid out on it. With --apply it sets the recorded value to the limit and
 * writes the change to Who did what. It never touches money entries, stock or
 * the customer's balance. Invoices where several returns together pass the
 * invoice total are listed for a person to look at, and left alone.
 *
 *   npx tsx scripts/fix-overvalued-returns.ts            # dry run
 *   npx tsx scripts/fix-overvalued-returns.ts --apply    # correct the records
 */
import { PrismaClient } from "@prisma/client"
import { stampHash } from "../src/lib/audit-meta"
import { returnQtyOf } from "../src/lib/return-limits"
import { lineValueAfterOrderDiscount } from "../src/lib/sale-money"

const prisma = new PrismaClient()
const apply = process.argv.includes("--apply")
const naira = (value: number) => `₦${value.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const n = (value: unknown) => Math.round(Number(value ?? 0) * 100) / 100

async function main() {
  const returns = await prisma.stockReturn.findMany({
    where: { status: { not: "REJECTED" }, saleId: { not: null } },
    select: {
      id: true,
      returnNumber: true,
      status: true,
      outcome: true,
      saleId: true,
      saleItemId: true,
      imeiId: true,
      // Not `quantity`: the live database gets that column on the next
      // deploy. Returns from before it carry the number in their notes.
      notes: true,
      returnValue: true,
      refundAmount: true,
      createdAt: true,
      branchId: true,
      branch: { select: { code: true } },
      user: { select: { name: true } },
    },
    orderBy: { createdAt: "asc" },
  })
  const sales = await prisma.sale.findMany({
    where: { id: { in: [...new Set(returns.map((row) => row.saleId!))] } },
    select: {
      id: true,
      invoiceNumber: true,
      subtotal: true,
      discount: true,
      totalAmount: true,
      paidAmount: true,
      items: { select: { id: true, imeiId: true, quantity: true, totalPrice: true, product: { select: { name: true } } } },
    },
  })
  const saleById = new Map(sales.map((sale) => [sale.id, sale]))
  const paidOut = await prisma.financeEntry.groupBy({
    by: ["reference"],
    where: { type: "EXPENSE", reference: { in: returns.map((row) => row.returnNumber) } },
    _sum: { amount: true },
  })
  const cashByReturn = new Map(paidOut.map((row) => [row.reference ?? "", n(row._sum.amount)]))

  const fixes: Array<{ id: string; returnNumber: string; branchId: string; from: number; to: number }> = []
  const bySale = new Map<string, number>()

  console.log(`${returns.length} return(s) on ${sales.length} invoice(s) checked.\n`)
  for (const row of returns) {
    const sale = saleById.get(row.saleId!)
    if (!sale) continue
    const value = n(row.returnValue) || n(row.refundAmount)
    bySale.set(sale.id, (bySale.get(sale.id) ?? 0) + value)
    const line = row.saleItemId
      ? sale.items.find((item) => item.id === row.saleItemId)
      : row.imeiId
        ? sale.items.find((item) => item.imeiId === row.imeiId)
        : undefined
    if (!line) continue
    const qty = row.saleItemId ? Math.min(returnQtyOf(row), line.quantity) : 1
    const limit = n((lineValueAfterOrderDiscount(line.totalPrice, sale) / Math.max(1, line.quantity)) * qty)
    if (value - limit <= 0.005) continue
    const cash = cashByReturn.get(row.returnNumber) ?? 0
    console.log(
      `${row.returnNumber} · ${row.branch.code} · ${row.createdAt.toISOString().slice(0, 10)} · by ${row.user?.name ?? "-"} · ${row.outcome} · ${row.status}`
    )
    console.log(
      `   ${qty} × ${line.product.name} on ${sale.invoiceNumber} (invoice ${naira(n(sale.totalAmount))}, paid ${naira(n(sale.paidAmount))})`
    )
    console.log(`   recorded ${naira(value)} · sold for ${naira(limit)} · over by ${naira(value - limit)} · cash actually paid out ${naira(cash)}`)
    if (cash - limit > 0.005) console.log(`   !! more cash went out than the item sold for. Look at this one by hand.`)
    fixes.push({ id: row.id, returnNumber: row.returnNumber, branchId: row.branchId, from: value, to: limit })
  }

  const overInvoice = [...bySale.entries()].filter(([saleId, total]) => total - n(saleById.get(saleId)!.totalAmount) > 0.005)
  const afterFix = new Map(bySale)
  for (const fix of fixes) {
    const saleId = returns.find((row) => row.id === fix.id)!.saleId!
    afterFix.set(saleId, (afterFix.get(saleId) ?? 0) - (fix.from - fix.to))
  }
  const stillOver = overInvoice.filter(([saleId]) => (afterFix.get(saleId) ?? 0) - n(saleById.get(saleId)!.totalAmount) > 0.005)

  console.log(`\n${fixes.length} return(s) recorded above what the item sold for.`)
  console.log(`${overInvoice.length} invoice(s) with returns adding up to more than the invoice; ${stillOver.length} would still be over after the fix.`)
  for (const [saleId, total] of stillOver) {
    const sale = saleById.get(saleId)!
    console.log(`   ${sale.invoiceNumber}: returns ${naira(total)} on an invoice of ${naira(n(sale.totalAmount))}. Left for a person to check.`)
  }

  if (!fixes.length) return
  if (!apply) {
    console.log("\nDry run. Nothing was changed. Add --apply to correct the recorded values.")
    return
  }

  for (const fix of fixes) {
    await prisma.$transaction(async (tx) => {
      await tx.stockReturn.update({
        where: { id: fix.id },
        data: { returnValue: fix.to.toFixed(2), refundAmount: fix.to.toFixed(2) },
      })
      // Stamped into Who did what's hash chain the same way lib/prisma does.
      const last = await tx.auditLog.findFirst({ orderBy: { createdAt: "desc" }, select: { hash: true } })
      const createdAt = new Date()
      const newValue = JSON.stringify({
        returnValue: fix.to,
        note: `Return value was recorded as ${naira(fix.from)}, more than the item sold for. Set to ${naira(fix.to)}, what the invoice allows. No money, stock or customer balance was changed.`,
      })
      await tx.auditLog.create({
        data: {
          userId: null,
          action: "UPDATE",
          entityType: "Return",
          entityId: fix.returnNumber,
          createdAt,
          success: true,
          hash: stampHash(last?.hash ?? null, { createdAt, userId: null, action: "UPDATE", entityType: "Return", entityId: fix.returnNumber, newValue, success: true }),
          oldValue: JSON.stringify({ returnValue: fix.from }),
          newValue,
          branchId: fix.branchId,
          risk: "MEDIUM",
        },
      })
    })
    console.log(`fixed ${fix.returnNumber}: ${naira(fix.from)} → ${naira(fix.to)}`)
  }
  console.log(`\nDone. ${fixes.length} return record(s) corrected.`)
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
