/**
 * Show every return on one invoice: value, who logged it, the cash paid out
 * and the stock put back.
 *
 * Read only. It writes nothing, so it is safe to point at the live database:
 *
 *   npx tsx scripts/show-returns.ts INV-MV10REQ0-OAB6
 */
import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()
const naira = (value: unknown) => `₦${Number(value ?? 0).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

async function main() {
  const invoiceNumber = (process.argv[2] ?? "").trim()
  if (!invoiceNumber) throw new Error("Give the invoice number, e.g. npx tsx scripts/show-returns.ts INV-MV10REQ0-OAB6")
  const sale = await prisma.sale.findUnique({
    where: { invoiceNumber },
    select: {
      id: true, invoiceNumber: true, saleDate: true, totalAmount: true, paidAmount: true, paymentMethod: true,
      customer: { select: { name: true, currentBalance: true } },
      user: { select: { name: true } },
      branch: { select: { code: true } },
      items: { select: { id: true, quantity: true, totalPrice: true, imeiId: true, product: { select: { name: true } } } },
    },
  })
  if (!sale) {
    console.log(`No invoice ${invoiceNumber}.`)
    return
  }
  console.log(`${sale.invoiceNumber} · ${sale.branch.code} · ${sale.saleDate.toISOString().slice(0, 16)} · sold by ${sale.user?.name ?? "-"} · buyer ${sale.customer?.name ?? "walk-in"} (balance ${naira(sale.customer?.currentBalance)})`)
  console.log(`total ${naira(sale.totalAmount)} · paid ${naira(sale.paidAmount)} · ${sale.paymentMethod}`)
  for (const item of sale.items) console.log(`  line: ${item.quantity} × ${item.product.name} = ${naira(item.totalPrice)}${item.imeiId ? " (IMEI)" : ""}`)

  const returns = await prisma.stockReturn.findMany({
    where: { saleId: sale.id },
    orderBy: { createdAt: "asc" },
    select: { returnNumber: true, status: true, outcome: true, faultClass: true, reason: true, notes: true, returnValue: true, createdAt: true, completedAt: true, saleItemId: true, user: { select: { name: true } } },
  })
  console.log(`\n${returns.length} return(s):`)
  for (const row of returns) {
    const money = await prisma.financeEntry.findMany({ where: { reference: row.returnNumber }, select: { account: true, type: true, amount: true, description: true } })
    const stock = await prisma.stockMovement.findMany({ where: { reference: row.returnNumber }, select: { kind: true, quantity: true } })
    console.log(`  ${row.returnNumber} · ${row.createdAt.toISOString().slice(0, 16)} · by ${row.user?.name ?? "-"} · ${row.reason} → ${row.outcome} · ${row.status} · value ${naira(row.returnValue)} · ${row.faultClass}`)
    console.log(`     notes: ${row.notes ?? "-"}`)
    for (const entry of money) console.log(`     money: ${entry.account} ${entry.type} ${naira(entry.amount)} · ${entry.description ?? ""}`)
    for (const move of stock) console.log(`     stock: ${move.kind} ${move.quantity}`)
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
