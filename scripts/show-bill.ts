/**
 * Show one supplier bill: its lines (item, quantity, cost) and every unit on
 * it with its item and status.
 *
 * Read only. It writes nothing, so it is safe to point at the live database:
 *
 *   npx tsx scripts/show-bill.ts PO-MUXU161J-M275
 */
import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()
const naira = (value: number) => `₦${value.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

async function main() {
  const invoiceNumber = (process.argv[2] ?? "").trim()
  if (!invoiceNumber) throw new Error("Give the bill number, e.g. npx tsx scripts/show-bill.ts PO-MUXU161J-M275")
  const bill = await prisma.purchase.findUnique({
    where: { invoiceNumber },
    select: {
      invoiceNumber: true,
      status: true,
      source: true,
      totalAmount: true,
      paidAmount: true,
      supplier: { select: { name: true } },
      branch: { select: { code: true } },
      items: { select: { quantity: true, receivedQty: true, costPrice: true, totalAmount: true, product: { select: { name: true, storage: true, tracking: true } } } },
      imeiRecords: { select: { imei1: true, status: true, saleId: true, product: { select: { name: true, storage: true } } }, orderBy: { createdAt: "asc" } },
    },
  })
  if (!bill) {
    console.log(`No bill ${invoiceNumber}.`)
    return
  }
  console.log(`${bill.invoiceNumber} · ${bill.supplier.name} · ${bill.branch.code} · ${bill.source ?? "-"} · ${bill.status} · total ${naira(Number(bill.totalAmount))} · paid ${naira(Number(bill.paidAmount))}`)
  console.log(`\n${bill.items.length} line(s):`)
  let sum = 0
  for (const line of bill.items) {
    sum += Number(line.totalAmount)
    console.log(`  ${line.product.name}${line.product.storage ? ` ${line.product.storage}` : ""} · ${line.product.tracking} · ${line.quantity} × ${naira(Number(line.costPrice))} = ${naira(Number(line.totalAmount))} · received ${line.receivedQty}`)
  }
  console.log(`  lines add up to ${naira(sum)}`)
  console.log(`\n${bill.imeiRecords.length} unit(s):`)
  for (const unit of bill.imeiRecords) {
    console.log(`  ${unit.imei1} · ${unit.product.name}${unit.product.storage ? ` ${unit.product.storage}` : ""} · ${unit.status}${unit.saleId ? " · has a sale" : ""}`)
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
