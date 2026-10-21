"use server"

import { revalidatePath } from "next/cache"
import type { IMEIStatus } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { requireUser } from "@/lib/session"
import { canHardDelete, isShopOwner } from "@/lib/rbac"
import { writeAudit } from "@/lib/audit"
import { canReachBranch, OTHER_SHOP } from "@/lib/branch-scope"
import { ConflictError, drawStock, returnStock, shiftCustomerBalance } from "@/lib/concurrency"
import { assertCashAvailable, UNDO_COLLECTION_NOTE } from "@/lib/shop-cash"
import { isOpeningStockPurchase } from "@/lib/purchase-money"
import { displayAccountNumber, displayBankName, listedBankClash } from "@/lib/opening-money"
import { shopError } from "@/lib/shop-speak"
import { formatCurrency, money } from "@/lib/utils"

/**
 * The CEO's and the main admin's corrections for a whole record entered by
 * mistake: a sale, a supplier bill, a repair job, a bank account's details.
 * The smaller fixes (one price, one payment, one expense) sit with the record
 * they fix. Each one here is refused while anything later depends on the
 * record, says which step to undo first, and leaves the old figures and the
 * reason in Who did what.
 */

function whoDid(user: { name: string | null; email: string }) {
  return user.name || user.email
}

function reasonOf(formData: FormData) {
  return String(formData.get("reason") || "").trim()
}

/**
 * Cancel a sale typed by mistake, as if it never happened. The goods go back
 * on the shelf, every payment on it is taken off (cash out of the till, bank
 * money off the bank), and the buyer's balance loses the sale and gets back
 * what they paid and any credit note used. The invoice stays on Sales,
 * marked Cancelled, so the number is never reused or lost.
 *
 * Refused while a return, swap or repair hangs off the sale (undo that first),
 * and when the till no longer holds the cash to hand back.
 */
export async function cancelSale(formData: FormData) {
  const user = await requireUser()
  if (!isShopOwner(user.role)) return { error: "Only the CEO or the main admin can cancel a sale." }
  const saleId = String(formData.get("saleId") || "")
  const why = reasonOf(formData)
  if (why.length < 4) return { error: "Say why this sale is being cancelled, for Who did what." }

  const sale = await prisma.sale.findUnique({
    where: { id: saleId },
    include: {
      items: { include: { product: { select: { name: true } }, imei: { select: { id: true, imei1: true, status: true, saleId: true } } } },
      payments: true,
      customer: { select: { id: true, name: true } },
    },
  })
  if (!sale) return { error: "We could not find that sale." }
  if (!(await canReachBranch(user, sale.branchId))) return { error: OTHER_SHOP }
  if (sale.status !== "COMPLETED") return { error: "This sale is already cancelled." }

  const [returns, swaps] = await Promise.all([
    prisma.stockReturn.count({ where: { saleId: sale.id, status: { not: "REJECTED" } } }),
    prisma.swap.count({
      where: {
        oldImeiId: { in: sale.items.map((item) => item.imeiId).filter((id): id is string => Boolean(id)) },
        status: { notIn: ["REJECTED", "CANCELLED"] },
      },
    }),
  ])
  if (returns > 0) {
    return { error: "This sale has a return on it. A sale with a return cannot be cancelled; correct the return instead." }
  }
  if (swaps > 0) return { error: "A phone on this sale was swapped. Settle the swap before cancelling the sale." }
  for (const item of sale.items) {
    if (item.imei && (item.imei.status !== "SOLD" || item.imei.saleId !== sale.id)) {
      return {
        error: `${item.imei.imei1} is no longer sold on ${sale.invoiceNumber} (it is ${item.imei.status.toLowerCase().replace(/_/g, " ")}). Undo that first.`,
      }
    }
  }

  const cashTaken = sale.payments.filter((row) => row.method === "CASH").reduce((sum, row) => sum + money(row.amount), 0)
  if (cashTaken > 0.005) {
    const till = await assertCashAvailable(sale.branchId, cashTaken)
    if (!till.ok) {
      return {
        error: `The till holds only ${formatCurrency(Math.max(0, till.available))} now, so the ${formatCurrency(cashTaken)} cash on this sale cannot be handed back. The cash was already moved to the bank or paid out: undo that first.`,
      }
    }
  }

  const moneyPaid = sale.payments.reduce((sum, row) => sum + money(row.amount), 0)
  const total = money(sale.totalAmount)
  const snapshot = {
    total,
    paid: money(sale.paidAmount),
    creditNoteUsed: money(sale.creditNoteUsed),
    customer: sale.customer?.name ?? null,
    items: sale.items.map((item) => ({
      name: item.product.name,
      imei: item.imei?.imei1 ?? null,
      quantity: item.quantity,
      unitPrice: money(item.unitPrice),
    })),
    payments: sale.payments.map((row) => ({ amount: money(row.amount), method: row.method, bankAccountId: row.bankAccountId, paidAt: row.paidAt })),
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Claimed on the figures this screen read, so a collection or a price
      // fix landing at the same moment is never wiped out unseen.
      const claimed = await tx.sale.updateMany({
        where: { id: sale.id, status: "COMPLETED", totalAmount: sale.totalAmount, paidAmount: sale.paidAmount },
        data: {
          status: "CANCELLED",
          paidAmount: "0.00",
          creditNoteUsed: "0.00",
          notes: [sale.notes, `Cancelled by ${whoDid(user)}: ${why.slice(0, 500)}`].filter(Boolean).join("\n"),
        },
      })
      if (claimed.count !== 1) {
        throw new ConflictError(`${sale.invoiceNumber} changed while you were looking at it. Open it again and retry.`)
      }

      for (const item of sale.items) {
        if (item.imei) {
          const back = await tx.imeiRecord.updateMany({
            where: { id: item.imei.id, status: "SOLD", saleId: sale.id },
            data: { status: "IN_STOCK", saleId: null, customerId: null, branchId: sale.branchId },
          })
          if (back.count !== 1) {
            throw new ConflictError(`${item.imei.imei1} was moved on while this sale was being cancelled. Open the sale again.`)
          }
        }
        await returnStock(tx, {
          productId: item.productId,
          branchId: sale.branchId,
          quantity: item.imei ? item.quantity || 1 : item.quantity,
          move: { kind: "SALE_REVERSED", reference: sale.invoiceNumber, userId: user.id },
        })
      }

      // Each payment leaves the way Undo the last money collected takes one:
      // the payment goes (the till and the banks are counted from payments)
      // and the money ledger says so.
      for (const payment of sale.payments) {
        await tx.payment.delete({ where: { id: payment.id } })
        await tx.financeEntry.create({
          data: {
            branchId: sale.branchId,
            account: payment.method === "CASH" ? "CASH" : "BANK",
            type: "EXPENSE",
            amount: money(payment.amount).toFixed(2),
            reference: sale.invoiceNumber,
            description: `${UNDO_COLLECTION_NOTE}${sale.invoiceNumber} · sale cancelled`,
          },
        })
      }

      if (sale.customerId) {
        // The sale put (total − money paid) on their balance, credit note
        // used included. Taking it back off returns both.
        const shift = -(total - moneyPaid)
        const after = await shiftCustomerBalance(tx, sale.customerId, shift)
        await tx.ledgerEntry.create({
          data: {
            customerId: sale.customerId,
            type: "ADJUSTMENT",
            amount: shift.toFixed(2),
            balance: money(after.currentBalance).toFixed(2),
            reference: sale.invoiceNumber,
            description: `${sale.invoiceNumber} cancelled by ${whoDid(user)}${moneyPaid > 0 ? `; ${formatCurrency(moneyPaid)} paid on it handed back` : ""}`,
          },
        })
      }

      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: "DELETE",
          entityType: "Sale",
          entityId: sale.invoiceNumber,
          oldValue: JSON.stringify(snapshot),
          newValue: JSON.stringify({ status: "CANCELLED", why, note: `${sale.invoiceNumber} cancelled by ${whoDid(user)}.` }),
          branchId: sale.branchId,
          risk: "HIGH",
        },
      })
    })
  } catch (error) {
    return { error: shopError(error, "Could not cancel this sale. Nothing was changed.") }
  }

  for (const path of ["/sales", "/pos", "/dashboard", "/finance", "/finance/close", "/reports", "/profits", "/customers", "/imei", "/inventory", "/audit/books"]) {
    revalidatePath(path)
  }
  revalidatePath(`/sales/${sale.id}`)
  if (sale.customerId) revalidatePath(`/customers/${sale.customerId}`)
  return { success: true, message: `${sale.invoiceNumber} is cancelled. The goods are back in stock${moneyPaid > 0 ? ` and ${formatCurrency(moneyPaid)} is off the books` : ""}.` }
}

/**
 * Cancel a supplier bill booked by mistake: the wrong supplier, loaded twice,
 * or goods that never came. Everything the bill put on the shelf comes off,
 * its phones leave the system (so the right bill can load them again), goods
 * still marked coming stop coming, and the bill no longer counts as owed.
 *
 * Refused while money has been paid on it (undo the payments first), goods on
 * it went back to the supplier, or any of its units were sold, moved to
 * another shop or have history of their own.
 */
export async function cancelSupplierBill(formData: FormData) {
  const user = await requireUser()
  if (!isShopOwner(user.role)) return { error: "Only the CEO or the main admin can cancel a supplier bill." }
  const id = String(formData.get("id") || "")
  const why = reasonOf(formData)
  if (why.length < 4) return { error: "Say why this bill is being cancelled, for Who did what." }

  const bill = await prisma.purchase.findUnique({
    where: { id },
    include: {
      openingStock: true,
      supplier: { select: { name: true } },
      items: { include: { product: { select: { name: true, tracking: true } } } },
      incomingLots: { include: { items: true } },
      imeiRecords: {
        select: {
          id: true,
          imei1: true,
          status: true,
          branchId: true,
          productId: true,
          _count: { select: { saleItems: true, returns: true, returnReplacements: true, repairs: true, swapsOld: true, swapsNew: true, supplierReturnLines: true } },
        },
      },
      _count: { select: { supplierReturnLines: true } },
    },
  })
  if (!bill) return { error: "We could not find that supplier bill." }
  if (!(await canReachBranch(user, bill.branchId))) return { error: OTHER_SHOP }
  if (bill.status === "CANCELLED") return { error: "This bill is already cancelled." }
  if (isOpeningStockPurchase(bill)) {
    return { error: "This is opening stock. Remove it on Opening stock, where its lines are kept." }
  }
  if (money(bill.paidAmount) > 0.005) {
    return { error: `${formatCurrency(money(bill.paidAmount))} has been paid on this bill. Undo the supplier payments first, then cancel it.` }
  }
  if (money(bill.returnedAmount) > 0.005 || bill._count.supplierReturnLines > 0) {
    return { error: "Goods on this bill were sent back to the supplier. A bill with send-backs cannot be cancelled." }
  }
  if (bill.incomingLots.some((lot) => lot.status === "PENDING_APPROVAL")) {
    return { error: "Goods on this bill are waiting for a yes on Goods coming. Decide that first." }
  }

  const live = bill.imeiRecords.filter((unit) => unit.status !== "DISPOSED")
  for (const unit of live) {
    const history = Object.values(unit._count).some((count) => count > 0)
    if (!["IN_STOCK", "INCOMING", "RECEIVED"].includes(unit.status) || unit.branchId !== bill.branchId || history) {
      const where =
        unit.branchId !== bill.branchId
          ? "was moved to another shop"
          : history
            ? "has a sale, return, swap or repair on record"
            : `is ${unit.status.toLowerCase().replace(/_/g, " ")}`
      return { error: `${unit.imei1} on this bill ${where}. A bill whose goods have moved on cannot be cancelled whole.` }
    }
  }

  // What this bill put on the shelf, item by item. Phones count one a piece.
  // Untracked pieces are read from the stock ledger lines that name this bill
  // or its cartons; bills older than that ledger fall back to what each line
  // says was received.
  const arrivedLots = bill.incomingLots.filter((lot) => lot.status === "ARRIVED")
  const references = [bill.invoiceNumber, ...arrivedLots.map((lot) => lot.lotNumber)]
  const moves = await prisma.stockMovement.groupBy({
    by: ["productId"],
    where: { branchId: bill.branchId, kind: "RECEIVED", reference: { in: references } },
    _sum: { quantity: true },
  })
  const movedIn = new Map(moves.map((row) => [row.productId, row._sum.quantity ?? 0]))
  const shelfOff = new Map<string, { name: string; quantity: number }>()
  const tracked = new Map<string, number>()
  for (const unit of live) {
    if (unit.status === "IN_STOCK") tracked.set(unit.productId, (tracked.get(unit.productId) ?? 0) + 1)
  }
  for (const line of bill.items) {
    if (shelfOff.has(line.productId)) continue
    const isTracked = line.product.tracking !== "NONE"
    const lotReceived = arrivedLots
      .flatMap((lot) => lot.items)
      .filter((row) => row.productId === line.productId)
      .reduce((sum, row) => sum + (row.receivedQuantity ?? 0), 0)
    const linesReceived = bill.items.filter((row) => row.productId === line.productId).reduce((sum, row) => sum + row.receivedQty, 0)
    const quantity = isTracked
      ? tracked.get(line.productId) ?? 0
      : movedIn.has(line.productId)
        ? Math.max(0, movedIn.get(line.productId) ?? 0)
        : Math.max(linesReceived, lotReceived)
    shelfOff.set(line.productId, { name: line.product.name, quantity })
  }

  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.purchase.updateMany({
        where: { id: bill.id, status: bill.status, paidAmount: bill.paidAmount },
        data: {
          status: "CANCELLED",
          sessionOpen: false,
          notes: [bill.notes, `Cancelled by ${whoDid(user)}: ${why.slice(0, 500)}`].filter(Boolean).join("\n"),
        },
      })
      if (claimed.count !== 1) {
        throw new ConflictError(`${bill.invoiceNumber} changed while you were looking at it. Open it again and retry.`)
      }

      for (const [productId, row] of shelfOff) {
        await drawStock(tx, {
          productId,
          branchId: bill.branchId,
          quantity: row.quantity,
          label: row.name,
          move: { kind: "HAND_CORRECTION", reference: bill.invoiceNumber, userId: user.id },
        })
      }

      // Goods still marked coming stop coming.
      for (const lot of bill.incomingLots.filter((row) => row.status === "COMING")) {
        for (const item of lot.items) {
          const expected = item.expectedQuantity > 0 ? item.expectedQuantity : item.quantity
          const stock = await tx.inventory.findUnique({
            where: { productId_branchId: { productId: item.productId, branchId: lot.branchId } },
            select: { incomingQty: true },
          })
          if (stock) {
            await tx.inventory.update({
              where: { productId_branchId: { productId: item.productId, branchId: lot.branchId } },
              data: { incomingQty: Math.max(0, stock.incomingQty - expected) },
            })
          }
        }
      }
      if (bill.incomingLots.length) {
        await tx.incomingLot.updateMany({
          where: { purchaseId: bill.id, status: { in: ["COMING", "ARRIVED"] } },
          data: { status: "CANCELLED" },
        })
      }

      if (live.length) {
        const gone = await tx.imeiRecord.deleteMany({
          where: { id: { in: live.map((unit) => unit.id) }, status: { in: ["IN_STOCK", "INCOMING", "RECEIVED"] }, branchId: bill.branchId },
        })
        if (gone.count !== live.length) {
          throw new ConflictError("A phone on this bill was sold or moved while it was being cancelled. Open the bill again.")
        }
      }

      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: "DELETE",
          entityType: "Purchase",
          entityId: bill.invoiceNumber,
          oldValue: JSON.stringify({
            supplier: bill.supplier.name,
            total: money(bill.totalAmount),
            status: bill.status,
            lines: bill.items.map((line) => ({ name: line.product.name, quantity: line.quantity, cost: money(line.costPrice) })),
            units: live.map((unit) => unit.imei1),
          }),
          newValue: JSON.stringify({
            status: "CANCELLED",
            why,
            shelfTakenOff: [...shelfOff.values()].filter((row) => row.quantity > 0),
            note: `${bill.invoiceNumber} cancelled by ${whoDid(user)}.`,
          }),
          branchId: bill.branchId,
          risk: "HIGH",
        },
      })
    })
  } catch (error) {
    const message = shopError(error, "Could not cancel this bill. Nothing was changed.")
    return { error: error instanceof ConflictError && message.includes("no longer has") ? `Some of these goods were already sold or moved. ${message}` : message }
  }

  for (const path of ["/purchases", "/suppliers", "/incoming", "/inventory", "/imei", "/finance", "/reports", "/dashboard", "/audit/books"]) {
    revalidatePath(path)
  }
  revalidatePath(`/purchases/${bill.id}`)
  return { success: true, message: `${bill.invoiceNumber} is cancelled. Its goods are off the shelf and it is no longer owed.` }
}

/**
 * Cancel a repair job opened by mistake, or one the customer called off. The
 * phone goes back to where it was before it went on the bench (a shop phone
 * back on the shelf, a customer's back to sold), and a repair charge already
 * put on the customer's account comes off.
 */
export async function cancelRepair(formData: FormData) {
  const user = await requireUser()
  if (!isShopOwner(user.role)) return { error: "Only the CEO or the main admin can cancel a repair." }
  const id = String(formData.get("id") || "")
  const why = reasonOf(formData)
  if (why.length < 4) return { error: "Say why this repair is being cancelled, for Who did what." }

  const repair = await prisma.repair.findUnique({
    where: { id },
    include: { imei: { select: { id: true, imei1: true, status: true, productId: true } } },
  })
  if (!repair) return { error: "We could not find that repair." }
  if (!(await canReachBranch(user, repair.branchId))) return { error: OTHER_SHOP }
  if (repair.status === "CANCELLED") return { error: "This repair is already cancelled." }

  // What the phone was before it went on the bench, as Open a repair wrote it.
  const opened = await prisma.auditLog.findFirst({
    where: { entityType: "Repair", action: "CREATE", entityId: repair.imei.imei1, createdAt: { lte: new Date(repair.createdAt.getTime() + 60_000) } },
    orderBy: { createdAt: "desc" },
    select: { oldValue: true },
  })
  const before: IMEIStatus =
    opened?.oldValue && ["SOLD", "IN_STOCK", "RETURNED", "REPAIRED"].includes(opened.oldValue)
      ? (opened.oldValue as IMEIStatus)
      : repair.customerId
        ? "SOLD"
        : "IN_STOCK"

  const delivered = repair.status === "DELIVERED"
  const shopPhoneBack = delivered && !repair.customerId
  // Where the phone is now, by how far the job went.
  const nowStatus: IMEIStatus = shopPhoneBack ? "IN_STOCK" : repair.status === "COMPLETED" || delivered ? "REPAIRED" : "FAULTY"
  const charged = delivered && repair.customerId ? money(repair.repairCost) : 0

  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.repair.updateMany({
        where: { id: repair.id, status: repair.status },
        data: {
          status: "CANCELLED",
          notes: [repair.notes, `Cancelled by ${whoDid(user)}: ${why.slice(0, 500)}`].filter(Boolean).join("\n"),
        },
      })
      if (claimed.count !== 1) {
        throw new ConflictError(`${repair.repairNumber} was moved on by someone else. Refresh to see where it is now.`)
      }

      if (!shopPhoneBack) {
        const back = await tx.imeiRecord.updateMany({
          where: { id: repair.imeiId, status: nowStatus },
          data: { status: before },
        })
        if (back.count !== 1) {
          throw new ConflictError(`${repair.imei.imei1} is no longer on this repair (it is ${repair.imei.status.toLowerCase()}). Nothing was changed.`)
        }
        // Open a repair took a shop phone off the shelf. It goes back on.
        if (before === "IN_STOCK") {
          await returnStock(tx, {
            productId: repair.imei.productId,
            branchId: repair.branchId,
            quantity: 1,
            move: { kind: "REPAIR_IN", reference: repair.repairNumber, userId: user.id },
          })
        }
      }

      if (charged > 0 && repair.customerId) {
        const after = await shiftCustomerBalance(tx, repair.customerId, -charged)
        await tx.ledgerEntry.create({
          data: {
            customerId: repair.customerId,
            type: "ADJUSTMENT",
            amount: (-charged).toFixed(2),
            balance: money(after.currentBalance).toFixed(2),
            reference: repair.repairNumber,
            description: `Repair ${repair.repairNumber} cancelled by ${whoDid(user)}; the charge comes off`,
          },
        })
      }

      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: "UPDATE",
          entityType: "Repair",
          entityId: repair.repairNumber,
          oldValue: JSON.stringify({ status: repair.status, cost: money(repair.repairCost), phone: repair.imei.imei1 }),
          newValue: JSON.stringify({ status: "CANCELLED", why, phoneBackTo: shopPhoneBack ? "IN_STOCK" : before, chargeTakenOff: charged }),
          branchId: repair.branchId,
          risk: "HIGH",
        },
      })
    })
  } catch (error) {
    return { error: shopError(error, "Could not cancel this repair. Nothing was changed.") }
  }

  for (const path of ["/repairs", "/inventory", "/imei", "/customers", "/finance", "/dashboard"]) revalidatePath(path)
  if (repair.customerId) revalidatePath(`/customers/${repair.customerId}`)
  return { success: true, message: `${repair.repairNumber} is cancelled.${charged > 0 ? ` ${formatCurrency(charged)} came off the customer's account.` : ""}` }
}

/**
 * Fix a bank account's name, number or account name typed wrong. Every
 * payment already on the account stays on it; only the label changes.
 */
export async function fixBankDetails(formData: FormData) {
  const user = await requireUser()
  if (!canHardDelete(user.role)) return { error: "Only the CEO or the main admin can change a bank account's details." }
  const id = String(formData.get("id") || "")
  const bankName = displayBankName(String(formData.get("bankName") || ""))
  const accountNumber = displayAccountNumber(String(formData.get("accountNumber") || ""))
  const accountName = displayBankName(String(formData.get("accountName") || "")) || null
  if (!bankName) return { error: "Type the bank name." }

  const row = await prisma.bankAccount.findUnique({ where: { id } })
  if (!row || !row.isActive) return { error: "We could not find that bank account." }
  if (!(await canReachBranch(user, row.branchId))) return { error: OTHER_SHOP }

  const others = await prisma.bankAccount.findMany({ where: { isActive: true }, select: { id: true, accountNumber: true } })
  const clash = listedBankClash(others, accountNumber, row.id)
  if (clash) return { error: clash }
  if (row.bankName === bankName && row.accountNumber === accountNumber && (row.accountName ?? null) === accountName) {
    return { error: "Nothing was changed." }
  }

  await prisma.bankAccount.update({ where: { id }, data: { bankName, accountNumber, accountName } })
  await writeAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "BankAccount",
    entityId: `${bankName} ${accountNumber}`,
    oldValue: JSON.stringify({ bankName: row.bankName, accountNumber: row.accountNumber, accountName: row.accountName }),
    newValue: JSON.stringify({ bankName, accountNumber, accountName }),
    branchId: row.branchId,
    risk: "HIGH",
  })
  revalidatePath("/finance")
  revalidatePath("/audit")
  return { success: true }
}
