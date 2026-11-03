import type { IMEIStatus, Prisma, StockMoveKind } from "@prisma/client"
import { watDayKey } from "@/lib/lagos-day"

export type Tx = Prisma.TransactionClient

/**
 * Raised when a guarded write loses a race: the row moved between the moment we
 * read it and the moment we wrote it. Every caller runs inside a transaction, so
 * throwing this rolls the whole posting back and nothing half-lands.
 *
 * The message is shop wording, ready to hand straight back to staff.
 */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConflictError"
  }
}

/**
 * Prisma's codes for a transaction that gave up because the database was too
 * busy: timed out, no free connection, or lost a write conflict. All of them
 * roll the whole posting back.
 */
const BUSY_CODES = new Set(["P2024", "P2028", "P2034"])

/**
 * Run a posting and turn a lost race or a busy database into the normal
 * { error } shape instead of a crash. Anything else still throws, so real
 * faults stay loud.
 */
export async function settle<T>(run: () => Promise<T>): Promise<{ data: T } | { error: string }> {
  try {
    return { data: await run() }
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message }
    const code = (error as { code?: unknown } | null)?.code
    if (typeof code === "string" && BUSY_CODES.has(code)) {
      console.error(`[settle] database busy (${code}):`, error)
      return { error: "The shop system is very busy and this was not saved. Wait a moment and try again." }
    }
    // A row this posting needed is gone: someone else got there first.
    if (code === "P2025") {
      return { error: "Someone else changed this while you were working. Refresh and check it." }
    }
    throw error
  }
}

/**
 * Move one tracked unit out of stock, but only if it is still In shop at this
 * branch. This is a single guarded UPDATE, so two tills cannot both win it.
 */
export async function claimImei(
  tx: Tx,
  input: {
    imeiId: string
    branchId: string
    label: string
    from?: IMEIStatus
    data: Prisma.ImeiRecordUncheckedUpdateManyInput
  }
) {
  const { count } = await tx.imeiRecord.updateMany({
    where: {
      id: input.imeiId,
      branchId: input.branchId,
      status: input.from ?? "IN_STOCK",
    },
    data: input.data,
  })
  if (count !== 1) {
    throw new ConflictError(
      `${input.label} was just taken by another till or moved out of this shop. Refresh and try again.`
    )
  }
}

/**
 * Same guard for a batch of units addressed by imei1. Every listed unit must
 * still be In shop at the sending branch, or the whole posting rolls back.
 */
export async function claimImeis(
  tx: Tx,
  input: {
    imei1s: string[]
    branchId: string
    from?: IMEIStatus
    data: Prisma.ImeiRecordUncheckedUpdateManyInput
  }
) {
  if (!input.imei1s.length) return
  const { count } = await tx.imeiRecord.updateMany({
    where: {
      imei1: { in: input.imei1s },
      branchId: input.branchId,
      status: input.from ?? "IN_STOCK",
    },
    data: input.data,
  })
  if (count !== input.imei1s.length) {
    throw new ConflictError(
      `${input.imei1s.length - count} of the phones on this list are no longer In shop here. Someone else moved or sold them while you were working. Refresh and build the list again.`
    )
  }
}

/** What a shelf move is, in the shop's own words, plus the paper behind it. */
export type StockMove = {
  kind: StockMoveKind
  /** Invoice, transfer, or bill number. What staff would quote if asked. */
  reference?: string | null
  userId?: string | null
}

/**
 * Write one line of the stock ledger. Always called inside the same transaction
 * as the shelf move it describes, so the two cannot drift apart.
 *
 * `quantity` is signed: positive onto the shelf, negative off it.
 */
export async function recordMovement(
  tx: Tx,
  input: { productId: string; branchId: string; quantity: number; move: StockMove }
) {
  if (!input.quantity) return
  await tx.stockMovement.create({
    data: {
      productId: input.productId,
      branchId: input.branchId,
      quantity: input.quantity,
      kind: input.move.kind,
      reference: input.move.reference ?? null,
      userId: input.move.userId ?? null,
      businessDate: watDayKey(),
    },
  })
}

/**
 * Draw untracked pieces down. The quantity guard lives in the WHERE clause, so
 * stock can never be pushed below zero and no read-modify-write window exists.
 *
 * The ledger line is written here rather than at each call site, so a shelf can
 * never move without saying why.
 */
export async function drawStock(
  tx: Tx,
  input: {
    productId: string
    branchId: string
    quantity: number
    label: string
    move: StockMove
  }
) {
  if (input.quantity <= 0) return
  const { count } = await tx.inventory.updateMany({
    where: {
      productId: input.productId,
      branchId: input.branchId,
      quantity: { gte: input.quantity },
    },
    data: { quantity: { decrement: input.quantity } },
  })
  if (count !== 1) {
    throw new ConflictError(
      `${input.label} no longer has ${input.quantity} in this shop. Someone else sold or moved it. Check the stock and try again.`
    )
  }
  await recordMovement(tx, { ...input, quantity: -input.quantity })
}

/** Put pieces back. Creates the branch row when the item has never been held here. */
export async function returnStock(
  tx: Tx,
  input: {
    productId: string
    branchId: string
    quantity: number
    move: StockMove
  }
) {
  if (input.quantity <= 0) return
  await tx.inventory.upsert({
    where: { productId_branchId: { productId: input.productId, branchId: input.branchId } },
    update: { quantity: { increment: input.quantity } },
    create: { productId: input.productId, branchId: input.branchId, quantity: input.quantity },
  })
  await recordMovement(tx, input)
}

/**
 * Set a shelf to an exact figure and record the difference.
 *
 * A stock count or a correction by hand says what the shelf *is*, not how much
 * it changed by. The ledger only deals in changes, so the previous figure is
 * read inside the transaction and the delta written from it — which is how a
 * correction finally leaves a trace it never used to.
 */
export async function setStock(
  tx: Tx,
  input: {
    productId: string
    branchId: string
    quantity: number
    move: StockMove
    lastStockCheck?: boolean
  }
) {
  const next = Math.max(0, Math.trunc(input.quantity))
  const row = await tx.inventory.findUnique({
    where: { productId_branchId: { productId: input.productId, branchId: input.branchId } },
    select: { quantity: true },
  })
  const before = row?.quantity ?? 0
  const stamp = input.lastStockCheck ? { lastStockCheck: new Date() } : {}
  await tx.inventory.upsert({
    where: { productId_branchId: { productId: input.productId, branchId: input.branchId } },
    update: { quantity: next, ...stamp },
    create: { productId: input.productId, branchId: input.branchId, quantity: next, ...stamp },
  })
  await recordMovement(tx, { ...input, quantity: next - before })
  return { before, after: next }
}

/**
 * Move a shelf by a difference rather than to a figure. The database does the
 * addition, so stock sold between a count and its approval stays sold. The shelf
 * stops at zero, and the ledger line says what really moved.
 */
export async function shiftStock(
  tx: Tx,
  input: {
    productId: string
    branchId: string
    delta: number
    move: StockMove
    lastStockCheck?: boolean
  }
) {
  const delta = Math.trunc(input.delta)
  const stamp = input.lastStockCheck ? { lastStockCheck: new Date() } : {}
  const where = { productId_branchId: { productId: input.productId, branchId: input.branchId } }
  const row = await tx.inventory.upsert({
    where,
    update: { quantity: { increment: delta }, ...stamp },
    create: { productId: input.productId, branchId: input.branchId, quantity: Math.max(0, delta), ...stamp },
    select: { quantity: true },
  })
  const shortBy = row.quantity < 0 ? -row.quantity : 0
  if (shortBy) await tx.inventory.update({ where, data: { quantity: 0 } })
  await recordMovement(tx, {
    productId: input.productId,
    branchId: input.branchId,
    quantity: delta + shortBy,
    move: input.move,
  })
}

/**
 * Move a customer's debt by delta and hand back the true balance after the move.
 * The database does the addition, so two clerks posting at once cannot overwrite
 * each other. Use the returned figure for the ledger line, never a figure read
 * before the write.
 */
export async function shiftCustomerBalance(tx: Tx, customerId: string, delta: number) {
  const updated = await tx.customer.update({
    where: { id: customerId },
    data: { currentBalance: { increment: delta } },
    select: { id: true, name: true, currentBalance: true, creditLimit: true, branchId: true },
  })
  return updated
}

/**
 * Add to what an invoice has been paid and hand back the fresh figures. Throws
 * if the collection would take the invoice past its own total, which is what a
 * double-submit or a two-clerk race looks like.
 */
export async function creditInvoice(tx: Tx, saleId: string, amount: number) {
  const updated = await tx.sale.update({
    where: { id: saleId },
    data: { paidAmount: { increment: amount } },
    select: { id: true, invoiceNumber: true, paidAmount: true, totalAmount: true, paymentMethod: true },
  })
  if (Number(updated.paidAmount) > Number(updated.totalAmount) + 0.005) {
    throw new ConflictError(
      `${updated.invoiceNumber} was already collected on while you were typing. Open the invoice again to see what is still owed.`
    )
  }
  return updated
}
