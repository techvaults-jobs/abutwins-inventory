/**
 * Look up suppliers by part of their name and show what sits under each one:
 * its bills (opening stock or owed), and phones put on the shelf with no bill.
 *
 * Read only. It writes nothing, so it is safe to point at the live database:
 *
 *   npx tsx scripts/find-supplier.ts "opening stock"
 *   npx tsx scripts/find-supplier.ts "Opening Stock Adjustment"
 */
import { PrismaClient } from "@prisma/client"
import { isOpeningStockSupplierName } from "../src/lib/upload-purchase"

const prisma = new PrismaClient()
const naira = (value: number) => `₦${value.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

async function main() {
  const term = process.argv.slice(2).join(" ").trim()
  if (!term) throw new Error('Give part of a supplier name, e.g. npx tsx scripts/find-supplier.ts "opening stock"')

  const suppliers = await prisma.supplier.findMany({
    where: { name: { contains: term, mode: "insensitive" } },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      phone: true,
      isActive: true,
      createdAt: true,
      purchases: {
        orderBy: { createdAt: "asc" },
        select: {
          invoiceNumber: true,
          source: true,
          status: true,
          paymentMethod: true,
          totalAmount: true,
          paidAmount: true,
          createdAt: true,
          branch: { select: { code: true } },
          openingStock: { select: { id: true } },
          _count: { select: { imeiRecords: true } },
        },
      },
    },
  })
  if (!suppliers.length) {
    console.log(`No supplier name contains "${term}".`)
    return
  }

  for (const supplier of suppliers) {
    const opening = isOpeningStockSupplierName(supplier.name)
    const unbilled = await prisma.imeiRecord.findMany({
      where: { supplierId: supplier.id, purchaseId: null },
      select: { status: true, product: { select: { costPrice: true } } },
    })
    const billValue = supplier.purchases.reduce((sum, bill) => sum + Number(bill.totalAmount), 0)
    const unbilledValue = unbilled.reduce((sum, unit) => sum + Number(unit.product.costPrice), 0)
    console.log(`\n${supplier.name}`)
    console.log(
      `  phone ${supplier.phone || "-"} · ${supplier.isActive ? "active" : "inactive"} · added ${supplier.createdAt.toISOString().slice(0, 10)} · ${
        opening ? "treated as OPENING STOCK (value, never owed)" : "a normal supplier"
      }`
    )
    console.log(`  ${supplier.purchases.length} bill(s), ${naira(billValue)}`)
    for (const bill of supplier.purchases) {
      console.log(
        `    ${bill.invoiceNumber} · ${bill.branch.code} · ${bill.source ?? "-"} · ${bill.status} · ${bill.paymentMethod} · total ${naira(Number(bill.totalAmount))} · paid ${naira(Number(bill.paidAmount))} · ${bill._count.imeiRecords} phone(s)${bill.openingStock ? " · opening record" : ""}`
      )
    }
    console.log(`  ${unbilled.length} phone(s) with no bill, ${naira(unbilledValue)} at item cost`)
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
