"use server"

import { UserRole } from "@prisma/client"
import { SUPPLIER_PAYMENT_UNDO_NOTE } from "@/lib/supplier-pay"
import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { shiftCustomerBalance } from "@/lib/concurrency"
import { requireUser } from "@/lib/session"
import { canHardDelete, isShopOwner } from "@/lib/rbac"
import { ALL_PERM_KEYS, CEO_ONLY_KEYS, ensureRolePermissions } from "@/lib/permissions"
import { isOpeningStockPurchase } from "@/lib/purchase-money"
import { assertCashAvailable, UNDO_COLLECTION_NOTE } from "@/lib/shop-cash"
import { canReachBranch, OTHER_SHOP } from "@/lib/branch-scope"
import { formatCurrency, money } from "@/lib/utils"

export async function getRoleMatrix() {
  const user = await requireUser()
  if (!isShopOwner(user.role)) return { error: "Only the main admin or the CEO can open Who can see what." as const }
  await ensureRolePermissions()
  const rows = await prisma.rolePermission.findMany()
  return { rows }
}

export async function saveRoleAccess(formData: FormData) {
  const user = await requireUser()
  if (!isShopOwner(user.role)) return { error: "Only the main admin or the CEO can change what others see." }
  const role = String(formData.get("role") || "") as UserRole
  if (!role || role === "SUPER_ADMIN" || role === "CEO") {
    return { error: "Nobody can take pages away from the main admin or the CEO." }
  }

  await ensureRolePermissions()

  // Each job keeps its own ticks. Auditor and accountant are no longer written together.
  for (const key of ALL_PERM_KEYS) {
    // Who can see what stays with the owners; profit and cost stay with the CEO.
    if (key === "view.access" || CEO_ONLY_KEYS.includes(key)) {
      await prisma.rolePermission.upsert({
        where: { role_permKey: { role, permKey: key } },
        update: { allowed: false },
        create: { role, permKey: key, allowed: false },
      })
      continue
    }
    const allowed = formData.get(key) === "on"
    await prisma.rolePermission.upsert({
      where: { role_permKey: { role, permKey: key } },
      update: { allowed },
      create: { role, permKey: key, allowed },
    })
  }

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "UPDATE",
      entityType: "RolePermission",
      entityId: role,
      newValue: "Who can see what was changed",
      branchId: user.branchId,
    },
  })
  revalidatePath("/staff")
  revalidatePath("/staff/access")
  return { success: true }
}

export async function setStaffActive(formData: FormData) {
  const user = await requireUser()
  if (!canHardDelete(user.role)) {
    return { error: "Only the CEO or the main admin can disable or restore a staff login." }
  }
  const id = String(formData.get("id") || "")
  const next = String(formData.get("active") || "") === "true"
  const target = await prisma.user.findUnique({ where: { id } })
  if (!target) return { error: "We could not find that staff." }
  if (target.id === user.id) return { error: "You cannot lock your own login." }
  if (target.role === "SUPER_ADMIN" && user.role !== "SUPER_ADMIN") {
    return { error: "The CEO cannot lock the main admin. Only another main admin, after a proper handover, can do that." }
  }
  if (target.role === "CEO" && user.role !== "CEO") return { error: "Only the CEO can lock or restore the CEO's login." }

  await prisma.user.update({ where: { id }, data: { isActive: next } })
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "UPDATE",
      entityType: "User",
      entityId: target.email,
      oldValue: String(target.isActive),
      newValue: String(next),
      branchId: user.branchId,
    },
  })
  revalidatePath("/staff")
  revalidatePath("/audit")
  return { success: true }
}

export async function reverseInvoicePayment(formData: FormData) {
  const user = await requireUser()
  if (!isShopOwner(user.role)) return { error: "Only the main admin or the CEO can undo a collection." }
  const saleId = String(formData.get("saleId") || "")
  const sale = await prisma.sale.findUnique({
    where: { id: saleId },
    include: { customer: true, payments: { orderBy: { paidAt: "desc" } } },
  })
  if (!sale) return { error: "We could not find that sale." }
  const last = sale.payments[0]
  if (!last) return { error: "Nobody has paid on this sale yet, so there is nothing to undo." }

  const amount = Number(last.amount)
  await prisma.$transaction(async (tx) => {
    await tx.payment.delete({ where: { id: last.id } })
    // The database does the subtraction and the addition, so an undo landing at
    // the same moment as a collection cannot wipe the other one out.
    const reversed = await tx.sale.update({
      where: { id: sale.id },
      data: { paidAmount: { decrement: amount } },
      select: { paidAmount: true },
    })
    if (Number(reversed.paidAmount) < -0.005) {
      await tx.sale.update({ where: { id: sale.id }, data: { paidAmount: "0.00" } })
    }
    if (sale.customerId && sale.customer) {
      const after = await shiftCustomerBalance(tx, sale.customerId, amount)
      await tx.ledgerEntry.create({
        data: {
          customerId: sale.customerId,
          type: "ADJUSTMENT",
          amount: amount.toFixed(2),
          balance: Number(after.currentBalance).toFixed(2),
          reference: sale.invoiceNumber,
          description: `The main admin or the CEO undid money collected on ${sale.invoiceNumber}`,
        },
      })
    }
    await tx.financeEntry.create({
      data: {
        branchId: sale.branchId,
        account: last.method === "CASH" ? "CASH" : "BANK",
        type: "EXPENSE",
        amount: amount.toFixed(2),
        reference: sale.invoiceNumber,
        description: `${UNDO_COLLECTION_NOTE}${sale.invoiceNumber}`,
      },
    })
    await tx.auditLog.create({
      data: {
        userId: user.id,
        action: "DELETE",
        entityType: "Payment",
        entityId: sale.invoiceNumber,
        oldValue: String(amount),
        newValue: "REVERSED",
        branchId: sale.branchId,
      },
    })
  })
  revalidatePath(`/sales/${sale.id}`)
  revalidatePath("/sales")
  revalidatePath("/finance")
  if (sale.customerId) revalidatePath(`/customers/${sale.customerId}`)
  return { success: true }
}

const TAKEN_AS = ["CASH", "TRANSFER", "POS"] as const

/**
 * Fix how one payment on a sale was taken: the cashier pressed Cash for a
 * transfer, Transfer for cash, or picked the wrong bank. The CEO's and the
 * main admin's correction. The amount stays; the till, the bank and each
 * named account follow, since they are counted from the payments.
 *
 * Cash moved to the bank comes out of the till, so it is refused when the till
 * no longer holds it (already moved to the bank or paid out). A day already
 * balanced keeps its old count until someone counts it again.
 */
export async function correctPaymentMethod(formData: FormData) {
  const user = await requireUser()
  if (!isShopOwner(user.role)) return { error: "Only the main admin or the CEO can fix how a payment was taken." }
  const paymentId = String(formData.get("paymentId") || "")
  const nextMethod = String(formData.get("method") || "")
  const why = String(formData.get("reason") || "").trim()
  if (!(TAKEN_AS as readonly string[]).includes(nextMethod)) return { error: "Pick Cash, Transfer or POS." }
  if (why.length < 4) return { error: "Say why the payment is being fixed, for Who did what." }

  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      sale: { select: { id: true, invoiceNumber: true, branchId: true, paymentMethod: true, customerId: true } },
      bankAccount: { select: { bankName: true, accountNumber: true } },
    },
  })
  if (!payment) return { error: "We could not find that payment." }
  if (!(await canReachBranch(user, payment.sale.branchId))) return { error: OTHER_SHOP }

  let bank: { id: string; label: string } | null = null
  if (nextMethod !== "CASH") {
    const bankId = String(formData.get("bankAccountId") || "")
    if (!bankId) return { error: "Pick the bank the money went into." }
    const row = await prisma.bankAccount.findFirst({ where: { id: bankId, isActive: true }, select: { id: true, bankName: true, accountNumber: true, branchId: true } })
    if (!row) return { error: "That bank account is no longer on the list. Pick another." }
    if (!(await canReachBranch(user, row.branchId))) return { error: OTHER_SHOP }
    bank = { id: row.id, label: `${row.bankName} ${row.accountNumber}` }
  }
  if (nextMethod === payment.method && (bank?.id ?? null) === payment.bankAccountId) {
    return { error: "That is already how this payment was taken. Nothing was changed." }
  }

  const amount = money(payment.amount)
  if (payment.method === "CASH" && nextMethod !== "CASH") {
    const till = await assertCashAvailable(payment.sale.branchId, amount)
    if (!till.ok) {
      return {
        error: `The till holds only ${formatCurrency(Math.max(0, till.available))} now, so ${formatCurrency(amount)} cannot come out of it to the bank. The cash was already moved to the bank or paid out: undo that first.`,
      }
    }
  }

  const label = (method: string, bankLabel: string | null) =>
    method === "CASH" ? "Cash" : `${method === "POS" ? "POS" : "Transfer"}${bankLabel ? ` to ${bankLabel}` : ""}`
  const was = label(payment.method, payment.bankAccount ? `${payment.bankAccount.bankName} ${payment.bankAccount.accountNumber}` : null)
  const now = label(nextMethod, bank?.label ?? null)
  const ledgerOf = (method: string) => (method === "CASH" ? "CASH" : "BANK")

  await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        method: nextMethod as (typeof TAKEN_AS)[number],
        bankAccountId: bank?.id ?? null,
        notes: [payment.notes, `Was ${was}; fixed to ${now} by ${user.name || user.email}`].filter(Boolean).join(" · "),
      },
    })
    // A sale paid one way carries that way on the sale too.
    if (payment.sale.paymentMethod === payment.method) {
      await tx.sale.update({ where: { id: payment.sale.id }, data: { paymentMethod: nextMethod as (typeof TAKEN_AS)[number] } })
    }
    // The money-in line written with this payment moves to the right ledger.
    if (ledgerOf(payment.method) !== ledgerOf(nextMethod)) {
      const line = await tx.financeEntry.findFirst({
        where: {
          reference: payment.sale.invoiceNumber,
          type: "INCOME",
          account: ledgerOf(payment.method),
          amount: payment.amount,
        },
        orderBy: { createdAt: "asc" },
        select: { id: true, description: true },
      })
      if (line) {
        await tx.financeEntry.update({
          where: { id: line.id },
          data: { account: ledgerOf(nextMethod), description: `${line.description} · fixed from ${was} to ${now}` },
        })
      }
    }
    await tx.auditLog.create({
      data: {
        userId: user.id,
        action: "UPDATE",
        entityType: "Payment",
        entityId: payment.sale.invoiceNumber,
        oldValue: JSON.stringify({ paymentId: payment.id, amount, method: payment.method, bankAccountId: payment.bankAccountId }),
        newValue: JSON.stringify({
          paymentId: payment.id,
          amount,
          method: nextMethod,
          bankAccountId: bank?.id ?? null,
          why,
          note: `${formatCurrency(amount)} on ${payment.sale.invoiceNumber} fixed by ${user.name || user.email}: ${was} → ${now}.`,
        }),
        branchId: payment.sale.branchId,
        risk: "HIGH",
      },
    })
  })
  revalidatePath(`/sales/${payment.sale.id}`)
  revalidatePath("/sales")
  revalidatePath("/finance")
  revalidatePath("/finance/close")
  if (payment.sale.customerId) revalidatePath(`/customers/${payment.sale.customerId}`)
  return { success: true }
}

export async function reverseSupplierPayment(formData: FormData) {
  const user = await requireUser()
  if (!isShopOwner(user.role)) return { error: "Only the main admin or the CEO can undo a supplier payment." }
  const id = String(formData.get("id") || "")
  const purchase = await prisma.purchase.findUnique({
    where: { id },
    include: { openingStock: true },
  })
  if (!purchase) return { error: "We could not find that supplier bill." }
  if (isOpeningStockPurchase(purchase)) {
    return { error: "Opening stock is the value the shop started with. It is not a bill to pay." }
  }
  const paid = Number(purchase.paidAmount)
  if (paid <= 0) return { error: "Nothing has been paid on this supplier bill yet." }

  // The newest payment on this bill that has not been undone already. Each
  // undo names the payment it reversed, so undoing twice walks back through
  // the payments instead of reversing the same one again.
  const moves = await prisma.financeEntry.findMany({
    where: { description: { contains: purchase.invoiceNumber } },
    orderBy: { createdAt: "desc" },
  })
  const undone = moves.filter((row) => row.type === "INCOME").map((row) => row.description ?? "").join(" ")
  const last =
    moves.find((row) => row.type === "EXPENSE" && !undone.includes(`payment ${row.id}`)) ??
    moves[0] ??
    null
  const amount = last ? Number(last.amount) : paid
  const undo = Math.min(amount, paid)

  await prisma.$transaction(async (tx) => {
    await tx.purchase.update({
      where: { id: purchase.id },
      data: { paidAmount: (paid - undo).toFixed(2) },
    })
    await tx.financeEntry.create({
      data: {
        branchId: purchase.branchId,
        account: "BANK",
        // Back onto the same bank account the payment left, when it named one.
        bankAccountId: last?.type === "EXPENSE" ? last.bankAccountId : null,
        type: "INCOME",
        amount: undo.toFixed(2),
        reference: purchase.invoiceNumber,
        description: `${SUPPLIER_PAYMENT_UNDO_NOTE} on ${purchase.invoiceNumber}${last?.type === "EXPENSE" ? ` · payment ${last.id}` : ""}`,
      },
    })
    await tx.auditLog.create({
      data: {
        userId: user.id,
        action: "DELETE",
        entityType: "PurchasePayment",
        entityId: purchase.invoiceNumber,
        oldValue: String(undo),
        newValue: "REVERSED",
        branchId: purchase.branchId,
      },
    })
  })
  revalidatePath(`/purchases/${purchase.id}`)
  revalidatePath("/purchases")
  revalidatePath("/finance")
  revalidatePath("/suppliers")
  revalidatePath("/reports")
  revalidatePath("/dashboard")
  revalidatePath("/audit/books")
  return { success: true }
}
