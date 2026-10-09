/**
 * Turn a supplier that was really opening stock into an opening stock name.
 *
 * Renames the supplier to an opening stock name (so every screen treats it as
 * opening stock: its value shows, nothing on it is owed) and marks its bills
 * as opening stock, the same way the opening stock heal does. Bills, phones
 * and history stay where they are. Nothing is deleted.
 *
 * It refuses to run if real money was recorded against any of the bills
 * (a payment to the supplier, or money in or out under the bill number),
 * because turning those bills into opening stock would leave that money
 * unexplained in the books. Sort those out first.
 *
 *   npx tsx scripts/reclassify-supplier-as-opening.ts --supplier "OPEN" --rename "Opening Stock Adjustment"           # dry run
 *   npx tsx scripts/reclassify-supplier-as-opening.ts --supplier "OPEN" --rename "Opening Stock Adjustment" --apply   # do it
 */
import { PrismaClient } from "@prisma/client"
import { isOpeningStockSupplierName, OPENING_STOCK_METHOD } from "../src/lib/upload-purchase"
import { stampHash } from "../src/lib/audit-meta"

const prisma = new PrismaClient()

function arg(name: string) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? (process.argv[i + 1] ?? "").trim() : ""
}
const naira = (value: number) => `₦${value.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

async function main() {
  const from = arg("--supplier")
  const to = arg("--rename")
  const apply = process.argv.includes("--apply")
  if (!from || !to) throw new Error('Use --supplier "<exact current name>" --rename "<opening stock name>"')
  if (!isOpeningStockSupplierName(to)) throw new Error(`"${to}" is not an opening stock name. It must contain "Opening Stock".`)

  const matches = await prisma.supplier.findMany({ where: { name: from }, select: { id: true, name: true, phone: true } })
  if (matches.length !== 1) throw new Error(`Expected exactly one supplier named "${from}", found ${matches.length}.`)
  const supplier = matches[0]
  const clash = await prisma.supplier.findFirst({ where: { name: { equals: to, mode: "insensitive" }, NOT: { id: supplier.id } } })
  if (clash) throw new Error(`A supplier named "${clash.name}" already exists. Pick another name.`)

  const bills = await prisma.purchase.findMany({
    where: { supplierId: supplier.id },
    select: {
      id: true,
      invoiceNumber: true,
      source: true,
      status: true,
      paymentMethod: true,
      totalAmount: true,
      paidAmount: true,
      createdAt: true,
      branchId: true,
      branch: { select: { code: true } },
      _count: { select: { imeiRecords: true, items: true } },
    },
    orderBy: { createdAt: "asc" },
  })
  const refs = bills.map((bill) => bill.invoiceNumber)
  const money = refs.length
    ? await prisma.financeEntry.findMany({
        where: { reference: { in: refs } },
        select: { reference: true, account: true, type: true, amount: true, description: true },
      })
    : []
  const phones = await prisma.imeiRecord.count({ where: { supplierId: supplier.id } })

  console.log(`Supplier "${supplier.name}" (phone ${supplier.phone || "-"}) → "${to}"`)
  console.log(`${bills.length} bill(s), ${phones} phone(s) under this supplier`)
  for (const bill of bills) {
    console.log(
      `  ${bill.invoiceNumber} · ${bill.branch.code} · ${bill.source ?? "-"} · ${bill.status} · ${bill.paymentMethod} · total ${naira(Number(bill.totalAmount))} · paid ${naira(Number(bill.paidAmount))} · ${bill._count.items} line(s), ${bill._count.imeiRecords} phone(s) · ${bill.createdAt.toISOString().slice(0, 10)}`
    )
  }
  console.log(`${money.length} money line(s) recorded under these bill numbers`)
  for (const row of money) {
    console.log(`  ${row.reference} · ${row.account} · ${row.type} · ${naira(Number(row.amount))} · ${row.description ?? ""}`)
  }

  if (money.length) {
    console.log("\nStopped: money is recorded against these bills. Turning them into opening stock would leave it unexplained. Nothing was changed.")
    return
  }
  if (!apply) {
    console.log("\nDry run. Nothing was changed. Add --apply to rename the supplier and mark its bills as opening stock.")
    return
  }

  await prisma.$transaction(async (tx) => {
    await tx.supplier.update({ where: { id: supplier.id }, data: { name: to } })
    for (const bill of bills) {
      if (bill.status === "CANCELLED") continue
      await tx.purchase.update({
        where: { id: bill.id },
        data: { paymentMethod: OPENING_STOCK_METHOD, paidAmount: bill.totalAmount },
      })
    }
    // Stamped into Who did what's hash chain the same way lib/prisma does, so
    // the chain still checks out after this entry.
    const last = await tx.auditLog.findFirst({ orderBy: { createdAt: "desc" }, select: { hash: true } })
    const createdAt = new Date()
    const newValue = JSON.stringify({
      name: to,
      note: `"${supplier.name}" was opening stock, confirmed by the client. Renamed to "${to}" and its ${bills.length} bill(s) marked as opening stock: value shown, nothing owed.`,
    })
    await tx.auditLog.create({
      data: {
        userId: null,
        action: "UPDATE",
        entityType: "Supplier",
        entityId: supplier.id,
        createdAt,
        success: true,
        hash: stampHash(last?.hash ?? null, { createdAt, userId: null, action: "UPDATE", entityType: "Supplier", entityId: supplier.id, newValue, success: true }),
        oldValue: JSON.stringify({
          name: supplier.name,
          bills: bills.map((bill) => ({ invoice: bill.invoiceNumber, paymentMethod: bill.paymentMethod, paid: Number(bill.paidAmount) })),
        }),
        newValue,
        risk: "MEDIUM",
      },
    })
  })
  console.log(`\nDone. "${supplier.name}" is now "${to}", and its bills are opening stock.`)
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
