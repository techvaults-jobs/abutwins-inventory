import type { IMEIStatus, Prisma, PrismaClient } from "@prisma/client"
import { ConflictError } from "@/lib/concurrency"

type Db = PrismaClient | Prisma.TransactionClient

/**
 * A phone that has left the shop can come back: a customer sells back a phone
 * we sold them, trades it in on a Swap Deal, or a supplier sends one we
 * returned. Every IMEI is one record for the life of the phone (imei1 is
 * unique), so the shop used to refuse it as "already on the system" and the
 * phone could not be sold again.
 *
 * Such a phone is booked in again on the record it already has. Its earlier
 * sale, return, swap and send-back stay on that record, so its history reads
 * as one life: sold, bought back, sold again. What it was before coming back
 * is kept on Who did what, which is also how a bill booked by mistake puts it
 * back (see restoreCameBack).
 */

/** Out of the shop for good: sold, given out on a Swap Deal, written off, or sent back to the supplier. */
export const LEFT_SHOP_STATUSES: IMEIStatus[] = ["SOLD", "SWAPPED", "DISPOSED", "RETURNED_TO_SUPPLIER"]

/** Who did what marks the line that books a phone back in with this. */
export const CAME_BACK_NOTE = "Came back into the shop"

export type CameBackUnit = {
  id: string
  imei1: string
  imei2: string | null
  serialNumber: string | null
  status: IMEIStatus
  productId: string
  branchId: string
  supplierId: string | null
  purchaseId: string | null
  customerId: string | null
  saleId: string | null
  notes: string | null
  /** One line for staff: what it is and where it went. */
  label: string
}

const unitSelect = {
  id: true,
  imei1: true,
  imei2: true,
  serialNumber: true,
  status: true,
  productId: true,
  branchId: true,
  supplierId: true,
  purchaseId: true,
  customerId: true,
  saleId: true,
  notes: true,
  product: { select: { name: true } },
  customer: { select: { name: true } },
  sale: { select: { invoiceNumber: true, saleDate: true } },
} satisfies Prisma.ImeiRecordSelect

const WHERE_IT_WENT: Partial<Record<IMEIStatus, string>> = {
  SOLD: "sold",
  SWAPPED: "given out on a Swap Deal",
  DISPOSED: "written off",
  RETURNED_TO_SUPPLIER: "sent back to the supplier",
}

/**
 * Sorts the numbers being booked in. `back` are phones that left the shop and
 * may come in again, keyed by every number they carry. `held` are phones still
 * in a shop, on the way, or tied up in a return or Swap Deal that is not
 * finished: those cannot be booked twice, and the reason says why.
 */
export async function sortComingBack(db: Db, codes: string[]) {
  const wanted = [...new Set(codes.filter(Boolean))]
  const back = new Map<string, CameBackUnit>()
  const held = new Map<string, string>()
  if (!wanted.length) return { back, held }

  const rows = await db.imeiRecord.findMany({
    where: { OR: [{ imei1: { in: wanted } }, { imei2: { in: wanted } }, { serialNumber: { in: wanted } }] },
    select: unitSelect,
  })
  const leftIds = rows.filter((row) => LEFT_SHOP_STATUSES.includes(row.status)).map((row) => row.id)
  const [openReturns, openSwaps] = leftIds.length
    ? await Promise.all([
        db.stockReturn.findMany({
          where: { imeiId: { in: leftIds }, status: { in: ["PENDING", "APPROVED"] } },
          select: { imeiId: true, returnNumber: true },
        }),
        db.swap.findMany({
          where: {
            OR: [{ oldImeiId: { in: leftIds } }, { newImeiId: { in: leftIds } }],
            status: { in: ["PENDING", "APPROVED"] },
          },
          select: { oldImeiId: true, newImeiId: true, swapNumber: true },
        }),
      ])
    : [[], []]

  for (const row of rows) {
    const keys = [row.imei1, row.imei2, row.serialNumber].filter((code): code is string => Boolean(code) && wanted.includes(code!))
    let why: string | null = null
    if (!LEFT_SHOP_STATUSES.includes(row.status)) {
      why = `${row.imei1} is already on the system (${row.status.toLowerCase().replace(/_/g, " ")}).`
    } else {
      const ret = openReturns.find((r) => r.imeiId === row.id)
      const swap = openSwaps.find((s) => s.oldImeiId === row.id || s.newImeiId === row.id)
      if (ret) why = `${row.imei1} has return ${ret.returnNumber} still open. Finish it first.`
      else if (swap) why = `${row.imei1} is on Swap Deal ${swap.swapNumber}, not settled yet. Settle it first.`
    }
    if (why) {
      for (const key of keys) held.set(key, why)
      continue
    }
    const went = row.sale
      ? `${WHERE_IT_WENT[row.status]} on ${row.sale.invoiceNumber}${row.customer ? ` to ${row.customer.name}` : ""}`
      : `${WHERE_IT_WENT[row.status]}${row.customer ? ` to ${row.customer.name}` : ""}`
    const unit: CameBackUnit = {
      id: row.id,
      imei1: row.imei1,
      imei2: row.imei2,
      serialNumber: row.serialNumber,
      status: row.status,
      productId: row.productId,
      branchId: row.branchId,
      supplierId: row.supplierId,
      purchaseId: row.purchaseId,
      customerId: row.customerId,
      saleId: row.saleId,
      notes: row.notes,
      label: `${row.imei1} · ${row.product.name} · ${went}`,
    }
    for (const key of keys) back.set(key, unit)
  }
  return { back, held }
}

/**
 * Book a phone that left the shop back in, on its own record. The record is
 * claimed on the status it was read with, so two people booking the same
 * phone at once cannot both bring it in.
 */
export async function bookCameBack(
  tx: Prisma.TransactionClient,
  unit: CameBackUnit,
  input: {
    data: Omit<Prisma.ImeiRecordUncheckedUpdateManyInput, "id" | "imei1">
    /** The bill, swap or note it came back on, for Who did what. */
    reference: string
    userId: string
  }
) {
  const claimed = await tx.imeiRecord.updateMany({
    where: { id: unit.id, status: unit.status },
    data: {
      customerId: null,
      saleId: null,
      ...input.data,
    },
  })
  if (claimed.count !== 1) {
    throw new ConflictError(`${unit.imei1} changed while it was being booked in. Try again.`)
  }
  await tx.auditLog.create({
    data: {
      userId: input.userId,
      action: "UPDATE",
      entityType: "IMEIRecord",
      entityId: unit.imei1,
      oldValue: JSON.stringify({
        status: unit.status,
        productId: unit.productId,
        branchId: unit.branchId,
        supplierId: unit.supplierId,
        purchaseId: unit.purchaseId,
        customerId: unit.customerId,
        saleId: unit.saleId,
        notes: unit.notes,
      }),
      newValue: JSON.stringify({
        note: `${CAME_BACK_NOTE} on ${input.reference}. It was ${unit.label.split(" · ").slice(2).join(" · ")}.`,
        cameBackOn: input.reference,
        status: input.data.status,
      }),
      branchId: typeof input.data.branchId === "string" ? input.data.branchId : unit.branchId,
    },
  })
}

/**
 * For a bill cancelled as booked by mistake: a phone that came back on it
 * goes back to what it was before (sold to its customer, written off, with
 * the supplier), instead of leaving the system. Returns false when the phone
 * did not come back on this bill.
 */
export async function restoreCameBack(tx: Prisma.TransactionClient, unit: { id: string; imei1: string }, reference: string) {
  const line = await tx.auditLog.findFirst({
    where: {
      entityType: "IMEIRecord",
      entityId: unit.imei1,
      newValue: { contains: `"cameBackOn":${JSON.stringify(reference)}` },
    },
    orderBy: { createdAt: "desc" },
    select: { oldValue: true, createdAt: true },
  })
  if (!line?.oldValue) return null
  const before = JSON.parse(line.oldValue) as {
    status: IMEIStatus
    productId: string
    branchId: string
    supplierId: string | null
    purchaseId: string | null
    customerId: string | null
    saleId: string | null
    notes: string | null
  }
  await tx.imeiRecord.update({
    where: { id: unit.id },
    data: {
      status: before.status,
      productId: before.productId,
      branchId: before.branchId,
      supplierId: before.supplierId,
      purchaseId: before.purchaseId,
      customerId: before.customerId,
      saleId: before.saleId,
      notes: before.notes,
    },
  })
  return { since: line.createdAt }
}
