"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { canReachBranch, resolveWritableShopId, scopeRecord, viewBranchFilter } from "@/lib/branch-scope"
import { requireUser } from "@/lib/session"
import { canSetOpeningMoney, isShopOwner } from "@/lib/rbac"
import { ConflictError, settle, shiftCustomerBalance } from "@/lib/concurrency"
import { can } from "@/lib/permissions"
import { displayPartyName } from "@/lib/party-key"
import { findDuplicateSupplier } from "@/lib/supplier-identity"
import { healOpeningStockBills } from "@/lib/opening-stock-money"
import { openingStockPurchaseWhere, payablePurchaseWhere } from "@/lib/purchase-money"
import { isOpeningStockSupplierName } from "@/lib/upload-purchase"
import { formatCurrency, generateDocNumber, money } from "@/lib/utils"
import type { SupplierKind } from "@prisma/client"

export async function getCustomers(search?: string) {
  const user = await requireUser()
  const branchId = await viewBranchFilter(user)
  const customers = await prisma.customer.findMany({
    where: {
      ...(branchId ? { branchId } : {}),
      ...(search
        ? { OR: [{ name: { contains: search } }, { phone: { contains: search } }] }
        : {}),
    },
    include: {
      branch: { select: { id: true, name: true, code: true } },
      _count: { select: { sales: true, returns: true } },
    },
    orderBy: { updatedAt: "desc" },
  })
  // What each customer bought and paid, added up by the database rather than
  // by loading every sale they ever made.
  const totals = customers.length
    ? await prisma.sale.groupBy({
        by: ["customerId"],
        where: { customerId: { in: customers.map((row) => row.id) } },
        _sum: { totalAmount: true, paidAmount: true },
      })
    : []
  const byCustomer = new Map(totals.map((row) => [row.customerId, row._sum]))
  return customers.map((row) => ({
    ...row,
    purchased: money(byCustomer.get(row.id)?.totalAmount),
    paid: money(byCustomer.get(row.id)?.paidAmount),
  }))
}

export async function getCustomer(id: string) {
  const user = await requireUser()
  // A customer ledger shows what someone owes and everything they have bought.
  // It belongs to the shop that opened the account.
  return scopeRecord(user, await prisma.customer.findUnique({
    where: { id },
    include: {
      branch: true,
      sales: { orderBy: { saleDate: "desc" }, take: 20 },
      ledgerEntries: { orderBy: { createdAt: "desc" }, take: 30 },
      returns: { orderBy: { createdAt: "desc" } },
      swaps: { orderBy: { createdAt: "desc" } },
      imeiRecords: { include: { product: true, sale: true }, orderBy: { updatedAt: "desc" }, take: 20 },
    },
  }))
}

export async function createCustomer(formData: FormData) {
  const user = await requireUser()
  const phone = String(formData.get("phone") ?? "").trim()
  const name = String(formData.get("name") ?? "").trim()
  const shopGate = await resolveWritableShopId(user, String(formData.get("branchId") ?? user.branchId ?? ""))
  if ("error" in shopGate) return { error: shopGate.error }
  const branchId = shopGate.shopId
  if (!name || !phone) return { error: "Type the name and phone, and pick the shop." }

  const openingBalance = Math.max(0, Number(formData.get("openingBalance") || 0) || 0)
  const creditLimit = Math.max(0, Number(formData.get("creditLimit") || 0) || 0)

  const exists = await prisma.customer.findUnique({ where: { phone } })
  if (exists) return { error: "A customer with this phone number is already on the system." }

  const customer = await prisma.customer.create({
    data: {
      name,
      phone,
      email: String(formData.get("email") || "") || null,
      address: String(formData.get("address") || "") || null,
      branchId,
      creditLimit: creditLimit.toFixed(2),
      currentBalance: openingBalance.toFixed(2),
      notes: String(formData.get("notes") || "") || null,
    },
  })

  if (openingBalance > 0) {
    await prisma.ledgerEntry.create({
      data: {
        customerId: customer.id,
        type: "ADJUSTMENT",
        amount: openingBalance.toFixed(2),
        balance: openingBalance.toFixed(2),
        reference: generateDocNumber(OPENING_REF_PREFIX),
        description:
          "Opening balance. Money this buyer already owed when the shops started on this software.",
      },
    })
  }

  revalidatePath("/customers")
  revalidatePath("/pos")
  revalidatePath("/sales")
  revalidatePath("/finance")
  revalidatePath("/reports")
  return { success: true, id: customer.id }
}

/** Ledger lines that make up a customer's opening balance: the first one and every correction. */
const OPENING_REF_PREFIX = "OBAL"

function isOpeningLine(entry: { reference: string | null }) {
  return Boolean(entry.reference?.startsWith(OPENING_REF_PREFIX))
}

/**
 * What a customer owed us before this software, as it stands now: the
 * opening line from when the account was made plus every correction since.
 * Each correction is its own line, so the history of the figure is kept.
 */
export async function getCustomerOpening(customerId: string) {
  const user = await requireUser()
  const customer = await scopeRecord(
    user,
    await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true, branchId: true } })
  )
  if (!customer) return null
  const lines = await prisma.ledgerEntry.findMany({
    where: { customerId, type: "ADJUSTMENT", reference: { startsWith: OPENING_REF_PREFIX } },
    orderBy: { createdAt: "asc" },
    select: { id: true, amount: true, reference: true, description: true, createdAt: true },
  })
  return {
    amount: lines.reduce((sum, line) => sum + money(line.amount), 0),
    history: lines.map((line) => ({
      id: line.id,
      change: money(line.amount),
      reference: line.reference ?? "",
      description: line.description ?? "",
      createdAt: line.createdAt,
    })),
    canChange: canSetOpeningMoney(user.role),
  }
}

/**
 * Add or correct what an existing customer already owed before this
 * software. The new figure replaces the old one by posting the difference as
 * one more opening line (never by rewriting the first), so the ledger, the
 * customer's balance and Who did what all show the change and why.
 *
 * The same people who set opening cash and bank balances may do this (see
 * canSetOpeningMoney): it changes what the business is owed.
 */
export async function setCustomerOpeningBalance(formData: FormData) {
  const user = await requireUser()
  if (!canSetOpeningMoney(user.role)) {
    return { error: "Only the CEO, the main admin, the Accountant or the Auditor can set a customer's opening balance." }
  }
  const customerId = String(formData.get("customerId") || "")
  const raw = String(formData.get("openingBalance") ?? "").trim()
  const wanted = Number(raw)
  if (!customerId) return { error: "Customer missing. Open their page again." }
  if (raw === "" || !Number.isFinite(wanted) || wanted < 0) {
    return { error: "Type the opening balance in naira, 0 or more." }
  }
  const target = Math.round(wanted * 100) / 100
  const reason = String(formData.get("reason") || "").trim()
  if (reason.length < 3) return { error: "Say why the opening balance is being set or changed." }

  const result = await settle(() =>
    prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUnique({
        where: { id: customerId },
        select: { id: true, name: true, branchId: true, currentBalance: true },
      })
      if (!customer) throw new ConflictError("We could not find that customer.")
      if (!(await canReachBranch(user, customer.branchId))) {
        throw new ConflictError("This customer belongs to another shop.")
      }
      const lines = await tx.ledgerEntry.findMany({
        where: { customerId, type: "ADJUSTMENT", reference: { startsWith: OPENING_REF_PREFIX } },
        select: { amount: true, reference: true },
      })
      const before = lines.filter(isOpeningLine).reduce((sum, line) => sum + money(line.amount), 0)
      const change = Math.round((target - before) * 100) / 100
      if (Math.abs(change) < 0.005) throw new ConflictError(`The opening balance is already ${formatCurrency(target)}.`)

      // Lowering it cannot undo money already paid: the lowest it can go is
      // what they have paid off so far.
      const owing = money(customer.currentBalance)
      if (owing + change < -0.005) {
        const lowest = Math.max(0, before - owing)
        throw new ConflictError(
          `${customer.name} has already paid off ${formatCurrency(before - owing)} of it, so the opening balance cannot go below ${formatCurrency(lowest)}.`
        )
      }

      const after = await shiftCustomerBalance(tx, customerId, change)
      const next = money(after.currentBalance)
      if (next < -0.005) {
        throw new ConflictError(`${customer.name} was collected from while you were typing. Open their page again.`)
      }

      const reference = generateDocNumber(OPENING_REF_PREFIX)
      const by = user.name || user.email
      await tx.ledgerEntry.create({
        data: {
          customerId,
          type: "ADJUSTMENT",
          amount: change.toFixed(2),
          balance: next.toFixed(2),
          reference,
          description:
            before === 0 && lines.length === 0
              ? `Opening balance ${formatCurrency(target)}: money this buyer already owed before this software. Set by ${by}. ${reason}`
              : `Opening balance changed from ${formatCurrency(before)} to ${formatCurrency(target)} by ${by}. ${reason}`,
        },
      })
      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: "UPDATE",
          entityType: "Customer",
          entityId: customerId,
          oldValue: JSON.stringify({ openingBalance: before, currentBalance: owing }),
          newValue: JSON.stringify({
            openingBalance: target,
            currentBalance: next,
            change,
            reference,
            reason,
            note: `Opening balance for ${customer.name}: ${formatCurrency(before)} to ${formatCurrency(target)}.`,
          }),
          branchId: customer.branchId,
          risk: "MEDIUM",
        },
      })
      return { name: customer.name, before, target, next }
    })
  )
  if ("error" in result) return { error: result.error }

  revalidatePath(`/customers/${customerId}`)
  revalidatePath("/customers")
  revalidatePath("/pos")
  revalidatePath("/sales")
  revalidatePath("/finance")
  revalidatePath("/reports")
  revalidatePath("/dashboard")
  const { name, target: saved, next } = result.data
  return {
    success: true,
    message: `${name}: opening balance is now ${formatCurrency(saved)}. Still owing ${formatCurrency(next)}.`,
  }
}

export async function getSuppliers() {
  const user = await requireUser()
  // Supplier balances and bill amounts are for the jobs that deal with
  // suppliers or load stock, not for anyone who happens to be signed in.
  const allowed = (
    await Promise.all(
      ["view.suppliers", "view.purchases", "view.uploads", "action.intake", "action.upload"].map((key) => can(user.role, key))
    )
  ).some(Boolean)
  if (!allowed) return []
  await healOpeningStockBills()
  // Every house, the opening stock ones included. Their opening bills come
  // back on their own (openingBills): the stock's starting value is shown,
  // but it is never part of what we owe.
  const houses = await prisma.supplier.findMany({
    include: {
      _count: { select: { purchases: true, imeiRecords: true } },
      purchases: {
        where: payablePurchaseWhere,
        select: {
          id: true,
          invoiceNumber: true,
          totalAmount: true,
          paidAmount: true,
          returnedAmount: true,
          status: true,
          createdAt: true,
          branch: { select: { name: true, code: true } },
        },
        orderBy: { createdAt: "desc" },
      },
    },
    orderBy: { name: "asc" },
  })
  const openingBills = await prisma.purchase.findMany({
    where: { ...openingStockPurchaseWhere, supplierId: { in: houses.map((house) => house.id) } },
    select: {
      id: true,
      supplierId: true,
      invoiceNumber: true,
      totalAmount: true,
      createdAt: true,
      branch: { select: { name: true, code: true } },
      _count: { select: { imeiRecords: true } },
    },
    orderBy: { createdAt: "desc" },
  })
  const openingBySupplier = new Map<string, typeof openingBills>()
  for (const bill of openingBills) {
    const list = openingBySupplier.get(bill.supplierId) ?? []
    list.push(bill)
    openingBySupplier.set(bill.supplierId, list)
  }
  // Phones put on the shelf one at a time under an opening stock name carry
  // no bill, so a name used only that way ("Opening Stock Adjustment") read
  // as empty. Their value is counted at each item's cost.
  const openingNames = houses.filter((house) => isOpeningStockSupplierName(house.name)).map((house) => house.id)
  const unbilled = openingNames.length
    ? await prisma.imeiRecord.findMany({
        where: { supplierId: { in: openingNames }, purchaseId: null },
        select: { supplierId: true, product: { select: { costPrice: true } } },
      })
    : []
  const unbilledBySupplier = new Map<string, { units: number; value: number }>()
  for (const unit of unbilled) {
    if (!unit.supplierId) continue
    const row = unbilledBySupplier.get(unit.supplierId) ?? { units: 0, value: 0 }
    row.units += 1
    row.value += money(unit.product.costPrice)
    unbilledBySupplier.set(unit.supplierId, row)
  }
  return houses.map((house) => ({
    ...house,
    isOpeningStock: isOpeningStockSupplierName(house.name),
    openingBills: openingBySupplier.get(house.id) ?? [],
    unbilledOpening: unbilledBySupplier.get(house.id) ?? { units: 0, value: 0 },
  }))
}

export async function getSupplier(id: string) {
  const user = await requireUser()
  await healOpeningStockBills()
  // Suppliers are shared, but their bills and phones carry cost prices per shop.
  // Shop staff must only see their own shop's dealings with a supplier, so scope
  // the included bills and IMEIs; head office (viewBranchFilter -> undefined for
  // "All shops") sees every shop.
  const branchId = await viewBranchFilter(user)
  const supplier = await prisma.supplier.findUnique({
    where: { id },
    include: {
      purchases: {
        where: { ...payablePurchaseWhere, ...(branchId ? { branchId } : {}) },
        include: { branch: true, items: { include: { product: true } } },
        orderBy: { createdAt: "desc" },
      },
      imeiRecords: {
        where: branchId ? { branchId } : undefined,
        include: { product: true, branch: true },
        orderBy: { createdAt: "desc" },
        take: 40,
      },
    },
  })
  if (!supplier) return null
  // The opening stock loaded against this house: its value, shown apart from
  // the bills, because it is the shop's starting stock and nothing is owed.
  const openingBills = await prisma.purchase.findMany({
    where: { ...openingStockPurchaseWhere, supplierId: id, ...(branchId ? { branchId } : {}) },
    select: {
      id: true,
      invoiceNumber: true,
      totalAmount: true,
      createdAt: true,
      branch: { select: { name: true, code: true } },
      _count: { select: { imeiRecords: true } },
    },
    orderBy: { createdAt: "desc" },
  })
  // Phones put on the shelf one at a time under an opening stock name, with
  // no bill: part of the opening value, counted at each item's cost.
  const isOpeningStock = isOpeningStockSupplierName(supplier.name)
  const unbilledUnits = isOpeningStock
    ? await prisma.imeiRecord.findMany({
        where: { supplierId: id, purchaseId: null, ...(branchId ? { branchId } : {}) },
        select: { product: { select: { costPrice: true } } },
      })
    : []
  return {
    ...supplier,
    isOpeningStock,
    openingBills,
    unbilledOpening: {
      units: unbilledUnits.length,
      value: unbilledUnits.reduce((sum, unit) => sum + money(unit.product.costPrice), 0),
    },
  }
}

export async function createSupplier(formData: FormData) {
  const user = await requireUser()
  const name = displayPartyName(String(formData.get("name") ?? ""))
  const phone = String(formData.get("phone") ?? "").trim()
  if (!name || !phone) return { error: "Name and phone are required." }
  const clash = await findDuplicateSupplier({ name, phone })
  if (clash) return clash

  const openingBalance = Math.max(0, Number(formData.get("openingBalance") || 0) || 0)
  let shopId: string | null = null
  if (openingBalance > 0) {
    const shopGate = await resolveWritableShopId(user, String(formData.get("branchId") ?? user.branchId ?? ""))
    if ("error" in shopGate) return { error: shopGate.error }
    shopId = shopGate.shopId
  }

  const supplier = await prisma.supplier.create({
    data: {
      name,
      phone,
      contactPerson: String(formData.get("contactPerson") || "") || null,
      email: String(formData.get("email") || "") || null,
      address: String(formData.get("address") || "") || null,
      country: String(formData.get("country") || "").trim() || null,
      city: String(formData.get("city") || "").trim() || null,
      kind: (String(formData.get("kind") || "SUPPLIER") === "NEIGHBOR" ? "NEIGHBOR" : "SUPPLIER") as SupplierKind,
    },
  })

  // Opening money we already owed this house becomes an unpaid bill so Suppliers,
  // Reports, and Check the books all count it the same way as later cartons.
  if (openingBalance > 0 && shopId) {
    await prisma.purchase.create({
      data: {
        invoiceNumber: generateDocNumber("OBAL"),
        supplierId: supplier.id,
        branchId: shopId,
        userId: user.id,
        status: "RECEIVED",
        totalAmount: openingBalance.toFixed(2),
        paidAmount: "0",
        notes:
          "Opening balance. Money we already owed this house when the shops started on this software. Not a new carton.",
        source: "OPENING_BALANCE",
      },
    })
  }

  revalidatePath("/suppliers")
  revalidatePath("/finance")
  revalidatePath("/reports")
  revalidatePath("/purchases")
  return { success: true }
}

export async function getBranches() {
  const user = await requireUser()
  const { canSeeAllBranches } = await import("@/lib/rbac")
  const canAll = await canSeeAllBranches(user.role)
  return prisma.branch.findMany({
    where: canAll ? undefined : user.branchId ? { id: user.branchId } : { id: "__none__" },
    include: {
      _count: { select: { users: true, customers: true, imeiRecords: true, sales: true } },
    },
    orderBy: [{ isHq: "desc" }, { isActive: "desc" }, { name: "asc" }],
  })
}

export async function createBranch(formData: FormData) {
  const user = await requireUser()
  if (!isShopOwner(user.role)) return { error: "Only the main admin or the CEO can open a new shop." }
  const code = String(formData.get("code") ?? "").trim().toUpperCase()
  const name = String(formData.get("name") ?? "").trim()
  if (!code || !name) return { error: "Type the name and the short code." }
  await prisma.branch.create({
    data: {
      name,
      code,
      address: String(formData.get("address") || "Nigeria"),
      phone: String(formData.get("phone") || "") || null,
      email: String(formData.get("email") || "") || null,
    },
  })
  revalidatePath("/branches")
  return { success: true }
}

export async function updateBranch(formData: FormData) {
  const user = await requireUser()
  if (!isShopOwner(user.role)) return { error: "Only the main admin or the CEO can edit a shop." }

  const id = String(formData.get("id") || "")
  const name = String(formData.get("name") ?? "").trim()
  const code = String(formData.get("code") ?? "").trim().toUpperCase()
  const address = String(formData.get("address") ?? "").trim()
  const phone = String(formData.get("phone") || "").trim() || null
  const email = String(formData.get("email") || "").trim() || null

  if (!id) return { error: "We could not find that shop." }
  if (!name || !code || !address) return { error: "Type the name, short code, and address." }

  const existing = await prisma.branch.findUnique({ where: { id } })
  if (!existing) return { error: "We could not find that shop." }

  if (code !== existing.code) {
    const taken = await prisma.branch.findUnique({ where: { code } })
    if (taken) return { error: `Another shop already uses the code ${code}.` }
  }

  await prisma.branch.update({
    where: { id },
    data: { name, code, address, phone, email },
  })
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "UPDATE",
      entityType: "Branch",
      entityId: code,
      oldValue: JSON.stringify({
        name: existing.name,
        code: existing.code,
        address: existing.address,
        phone: existing.phone,
        email: existing.email,
      }),
      newValue: JSON.stringify({ name, code, address, phone, email }),
      branchId: id,
    },
  })
  revalidatePath("/branches")
  revalidatePath("/audit")
  return { success: true }
}

export async function toggleBranch(id: string) {
  const user = await requireUser()
  if (!isShopOwner(user.role)) return { error: "Only the main admin or the CEO can close a shop or open it again." }
  const branch = await prisma.branch.findUnique({ where: { id } })
  if (!branch) return { error: "We could not find that shop." }
  await prisma.branch.update({ where: { id }, data: { isActive: !branch.isActive } })
  revalidatePath("/branches")
  return { success: true }
}
