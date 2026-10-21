"use server"

import { formatSignedBalance } from "@/lib/balance-sign"
import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { canReachBranch, OTHER_SHOP, resolveWritableShopId, scopeRecord, viewBranchFilter } from "@/lib/branch-scope"
import { requireUser } from "@/lib/session"
import { canApprove, canHardDelete, canManageFinance, canSell, canSetOpeningMoney, isShopOwner } from "@/lib/rbac"
import { shopError } from "@/lib/shop-speak"
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
        ? { OR: [{ name: { contains: search, mode: "insensitive" } }, { phone: { contains: search, mode: "insensitive" } }] }
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
        where: { customerId: { in: customers.map((row) => row.id) }, status: "COMPLETED" },
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

  // No sign: they owed us before this software. A minus: we owed them.
  const openingBalance = Math.round((Number(formData.get("openingBalance") || 0) || 0) * 100) / 100
  const creditLimit = Math.max(0, Number(formData.get("creditLimit") || 0) || 0)

  const exists = await prisma.customer.findUnique({ where: { phone } })
  if (exists) return { error: "A customer with this phone number is already on the system." }

  // The customer and their opening line are written together, so a balance
  // never stands without the statement line that explains it.
  const customer = await prisma.$transaction(async (tx) => {
    const created = await tx.customer.create({
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
    if (Math.abs(openingBalance) > 0.005) {
      await tx.ledgerEntry.create({
        data: {
          customerId: created.id,
          type: "ADJUSTMENT",
          amount: openingBalance.toFixed(2),
          balance: openingBalance.toFixed(2),
          reference: generateDocNumber(OPENING_REF_PREFIX),
          description:
            openingBalance > 0
              ? "Opening balance. Money this buyer already owed when the shops started on this software."
              : "Opening balance. Money we already owed this buyer when the shops started on this software.",
        },
      })
    }
    return created
  })

  revalidatePath("/customers")
  revalidatePath("/pos")
  revalidatePath("/sales")
  revalidatePath("/finance")
  revalidatePath("/reports")
  return { success: true, id: customer.id }
}

/**
 * Put right a customer's name, phone, email, address or notes. A phone typed
 * wrong used to stay wrong for good: there was no edit, and the right number
 * could not be added either, because a phone belongs to one customer only.
 *
 * Their balance is never touched here (see setCustomerOpeningBalance). The
 * credit limit decides how much they may take on credit, so only a manager,
 * the CEO or the main admin may change it.
 */
export async function updateCustomer(formData: FormData) {
  const user = await requireUser()
  if (!(await canSell(user.role)) && !(await canManageFinance(user.role))) {
    return { error: "You are not allowed to change customer details. Ask the main admin." }
  }
  const id = String(formData.get("id") || "")
  const name = String(formData.get("name") ?? "").trim()
  const phone = String(formData.get("phone") ?? "").trim()
  if (!id) return { error: "Customer missing. Open their page again." }
  if (!name || !phone) return { error: "Type the name and phone." }

  const existing = await prisma.customer.findUnique({ where: { id } })
  if (!existing) return { error: "We could not find that customer." }
  if (!(await canReachBranch(user, existing.branchId))) return { error: OTHER_SHOP }

  if (phone !== existing.phone) {
    const taken = await prisma.customer.findUnique({ where: { phone }, select: { name: true } })
    if (taken) return { error: `That phone number already belongs to ${taken.name}.` }
  }

  const limitRaw = String(formData.get("creditLimit") ?? "").trim()
  let creditLimit = money(existing.creditLimit)
  if (limitRaw !== "" && Math.abs(Number(limitRaw) - creditLimit) > 0.005) {
    if (!isShopOwner(user.role) && !(await canApprove(user.role))) {
      return { error: "Only a manager, the CEO or the main admin can change a credit limit." }
    }
    const wanted = Number(limitRaw)
    if (!Number.isFinite(wanted) || wanted < 0) return { error: "The credit limit must be 0 or more." }
    creditLimit = Math.round(wanted * 100) / 100
  }

  const before = {
    name: existing.name,
    phone: existing.phone,
    email: existing.email,
    address: existing.address,
    notes: existing.notes,
    creditLimit: money(existing.creditLimit),
  }
  const after = {
    name,
    phone,
    email: String(formData.get("email") || "").trim() || null,
    address: String(formData.get("address") || "").trim() || null,
    notes: String(formData.get("notes") || "").trim() || null,
    creditLimit,
  }
  const changed = (Object.keys(after) as Array<keyof typeof after>).filter(
    (key) => String(before[key] ?? "") !== String(after[key] ?? "")
  )
  if (!changed.length) return { success: true, message: "Nothing changed." }

  try {
    await prisma.$transaction([
      prisma.customer.update({ where: { id }, data: { ...after, creditLimit: creditLimit.toFixed(2) } }),
      prisma.auditLog.create({
        data: {
          userId: user.id,
          action: "UPDATE",
          entityType: "Customer",
          entityId: id,
          oldValue: JSON.stringify(Object.fromEntries(changed.map((key) => [key, before[key]]))),
          newValue: JSON.stringify({
            ...Object.fromEntries(changed.map((key) => [key, after[key]])),
            note: `Customer details changed: ${name}. Changed: ${changed.join(", ")}.`,
          }),
          branchId: existing.branchId,
          risk: changed.includes("creditLimit") || changed.includes("phone") ? "MEDIUM" : "LOW",
        },
      }),
    ])
  } catch (error) {
    // Two people saving the same new phone at once: the database keeps one.
    return { error: shopError(error, "Could not save these details. Nothing was changed.") }
  }

  revalidatePath(`/customers/${id}`)
  revalidatePath("/customers")
  revalidatePath("/pos")
  revalidatePath("/sales")
  return { success: true, message: `${name}: details saved.` }
}

/**
 * Take a customer added by mistake off the system. Only one with no sales,
 * statement lines, returns, swaps, repairs or phones on record, so no figure
 * anywhere can change. A customer with history stays.
 */
export async function removeCustomer(formData: FormData) {
  const user = await requireUser()
  if (!canHardDelete(user.role)) return { error: "Only the CEO or the main admin can remove a customer." }
  const id = String(formData.get("id") || "")
  const customer = await prisma.customer.findUnique({
    where: { id },
    include: { _count: { select: { sales: true, ledgerEntries: true, returns: true, swaps: true, repairs: true, imeiRecords: true } } },
  })
  if (!customer) return { error: "We could not find that customer." }
  if (!(await canReachBranch(user, customer.branchId))) return { error: OTHER_SHOP }
  const history = Object.values(customer._count).some((count) => count > 0)
  if (history || Math.abs(money(customer.currentBalance)) > 0.005) {
    return { error: `${customer.name} has sales or money on record, so they stay on the system. Correct their details instead.` }
  }
  try {
    await prisma.$transaction([
      prisma.customer.delete({ where: { id } }),
      prisma.auditLog.create({
        data: {
          userId: user.id,
          action: "DELETE",
          entityType: "Customer",
          entityId: `${customer.name} (${customer.phone})`,
          oldValue: JSON.stringify({ name: customer.name, phone: customer.phone, email: customer.email, address: customer.address }),
          newValue: JSON.stringify({ note: `Removed ${customer.name} (${customer.phone}), added by mistake. They had no sales or money on record.` }),
          branchId: customer.branchId,
        },
      }),
    ])
  } catch (error) {
    return { error: shopError(error, "Could not remove this customer. Nothing was changed.") }
  }
  revalidatePath("/customers")
  revalidatePath("/pos")
  return { success: true, message: `${customer.name} removed.`, redirectTo: "/customers" }
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
  // No sign: they owed us before this software. A minus: we owed them.
  if (raw === "" || !Number.isFinite(wanted)) {
    return { error: "Type the opening balance in naira. Put a minus in front if we owed them." }
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
      // The balance is signed (a minus is money we owe them), so the opening
      // figure moves it by the difference either way. Money they already
      // paid stays paid: paying off more than they owed leaves us owing them.
      const owing = money(customer.currentBalance)
      const after = await shiftCustomerBalance(tx, customerId, change)
      const next = money(after.currentBalance)

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
              ? target < 0
                ? `Opening balance −${formatCurrency(-target)}: money we already owed this buyer before this software. Set by ${by}. ${reason}`
                : `Opening balance ${formatCurrency(target)}: money this buyer already owed before this software. Set by ${by}. ${reason}`
              : `Opening balance changed from ${formatSignedBalance(before)} to ${formatSignedBalance(target)} by ${by}. ${reason}`,
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
    message: `${name}: opening balance is now ${formatSignedBalance(saved)}. Balance ${formatSignedBalance(next)}.`,
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
          shippingFee: true,
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

  // The client's rule for every account: no sign, they owed us; a minus, we
  // owed them. A minus becomes an unpaid opening bill; no sign is credit.
  const openingBalance = Math.round((Number(formData.get("openingBalance") || 0) || 0) * 100) / 100
  const weOwed = Math.max(0, -openingBalance)
  const theyOwed = Math.max(0, openingBalance)
  let shopId: string | null = null
  if (weOwed > 0) {
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
      creditBalance: theyOwed.toFixed(2),
      openingCredit: theyOwed.toFixed(2),
    },
  })

  // Opening money we already owed this house becomes an unpaid bill so Suppliers,
  // Reports, and Check the books all count it the same way as later cartons.
  if (weOwed > 0 && shopId) {
    await prisma.purchase.create({
      data: {
        invoiceNumber: generateDocNumber("OBAL"),
        supplierId: supplier.id,
        branchId: shopId,
        userId: user.id,
        status: "RECEIVED",
        totalAmount: weOwed.toFixed(2),
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

/** Who may change a supplier's details: the jobs that buy from them or pay them. */
async function mayEditSuppliers(role: Parameters<typeof can>[0]) {
  if (isShopOwner(role)) return true
  const keys = ["action.upload", "action.intake", "action.incoming", "action.finance"]
  return (await Promise.all(keys.map((key) => can(role, key)))).some(Boolean)
}

/**
 * Put right a supplier's name, phone and contact details. There was no edit:
 * a misspelt name or a wrong number stayed on every bill for good.
 *
 * An opening stock name is not a supplier we owe (see payablePurchaseWhere),
 * so a rename may not move a house into or out of that group: its bills would
 * suddenly count as owed, or stop counting.
 */
export async function updateSupplier(formData: FormData) {
  const user = await requireUser()
  if (!(await mayEditSuppliers(user.role))) return { error: "You are not allowed to change supplier details. Ask the main admin." }
  const id = String(formData.get("id") || "")
  const name = displayPartyName(String(formData.get("name") ?? ""))
  const phone = String(formData.get("phone") ?? "").trim()
  if (!id) return { error: "Supplier missing. Open their page again." }
  const existing = await prisma.supplier.findUnique({ where: { id } })
  if (!existing) return { error: "We could not find that supplier." }
  const openingStock = isOpeningStockSupplierName(existing.name)
  if (!name || (!phone && !openingStock)) return { error: "Name and phone are required." }
  if (isOpeningStockSupplierName(name) !== openingStock) {
    return {
      error: openingStock
        ? "This name holds opening stock. Keep opening stock in its name, so its value is never counted as owed."
        : "A supplier's name cannot say opening stock: its bills would stop counting as owed. Pick another name.",
    }
  }
  const clash = await findDuplicateSupplier({ name, phone, ignoreId: id })
  if (clash) return clash

  const before = {
    name: existing.name,
    phone: existing.phone,
    contactPerson: existing.contactPerson,
    email: existing.email,
    address: existing.address,
    country: existing.country,
    city: existing.city,
    kind: existing.kind,
  }
  const after = {
    name,
    phone: phone || existing.phone,
    contactPerson: String(formData.get("contactPerson") || "").trim() || null,
    email: String(formData.get("email") || "").trim() || null,
    address: String(formData.get("address") || "").trim() || null,
    country: String(formData.get("country") || "").trim() || null,
    city: String(formData.get("city") || "").trim() || null,
    kind: (String(formData.get("kind") || existing.kind) === "NEIGHBOR" ? "NEIGHBOR" : "SUPPLIER") as SupplierKind,
  }
  const changed = (Object.keys(after) as Array<keyof typeof after>).filter(
    (key) => String(before[key] ?? "") !== String(after[key] ?? "")
  )
  if (!changed.length) return { success: true, message: "Nothing changed." }

  await prisma.$transaction([
    prisma.supplier.update({ where: { id }, data: after }),
    prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "UPDATE",
        entityType: "Supplier",
        entityId: id,
        oldValue: JSON.stringify(Object.fromEntries(changed.map((key) => [key, before[key]]))),
        newValue: JSON.stringify({
          ...Object.fromEntries(changed.map((key) => [key, after[key]])),
          note: `Supplier details changed: ${name}. Changed: ${changed.join(", ")}.`,
        }),
        branchId: user.branchId,
        risk: changed.includes("name") ? "MEDIUM" : "LOW",
      },
    }),
  ])

  revalidatePath(`/suppliers/${id}`)
  revalidatePath("/suppliers")
  revalidatePath("/purchases")
  return { success: true, message: `${name}: details saved.` }
}

/**
 * Take a supplier added by mistake off the system: only one with no bills,
 * phones, incoming goods or send-backs, and no credit with us.
 */
export async function removeSupplier(formData: FormData) {
  const user = await requireUser()
  if (!canHardDelete(user.role)) return { error: "Only the CEO or the main admin can remove a supplier." }
  const id = String(formData.get("id") || "")
  const supplier = await prisma.supplier.findUnique({
    where: { id },
    include: { _count: { select: { purchases: true, imeiRecords: true, incomingLots: true, stockReturns: true, supplierReturnLines: true } } },
  })
  if (!supplier) return { error: "We could not find that supplier." }
  const history = Object.values(supplier._count).some((count) => count > 0)
  if (history || Math.abs(money(supplier.creditBalance)) > 0.005) {
    return { error: `${supplier.name} has bills or goods on record, so they stay on the system. Correct their details instead.` }
  }
  await prisma.$transaction([
    prisma.supplier.delete({ where: { id } }),
    prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "DELETE",
        entityType: "Supplier",
        entityId: `${supplier.name} (${supplier.phone})`,
        oldValue: JSON.stringify({ name: supplier.name, phone: supplier.phone, email: supplier.email, city: supplier.city }),
        newValue: JSON.stringify({ note: `Removed ${supplier.name}, added by mistake. They had no bills or goods on record.` }),
        branchId: user.branchId,
      },
    }),
  ])
  revalidatePath("/suppliers")
  revalidatePath("/purchases")
  return { success: true, message: `${supplier.name} removed.`, redirectTo: "/suppliers" }
}

/** Opening bills: money we owed a house before this software. */
const supplierOpeningBills = (supplierId: string) => ({ supplierId, source: "OPENING_BALANCE", status: { not: "CANCELLED" as const } })

/** A house's opening balance as it stands: no sign, they owed us; a minus, we owed them. */
export async function getSupplierOpening(supplierId: string) {
  const user = await requireUser()
  const [supplier, bills] = await Promise.all([
    prisma.supplier.findUnique({ where: { id: supplierId }, select: { openingCredit: true } }),
    prisma.purchase.findMany({
      where: supplierOpeningBills(supplierId),
      select: { id: true, invoiceNumber: true, totalAmount: true, paidAmount: true, returnedAmount: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
  ])
  if (!supplier) return null
  const weOwed = bills.reduce((sum, bill) => sum + money(bill.totalAmount), 0)
  const paid = bills.reduce((sum, bill) => sum + money(bill.paidAmount), 0)
  return {
    amount: money(supplier.openingCredit) - weOwed,
    paidOnIt: paid,
    bills: bills.map((bill) => ({ id: bill.id, invoiceNumber: bill.invoiceNumber, total: money(bill.totalAmount), paid: money(bill.paidAmount) })),
    canChange: canSetOpeningMoney(user.role),
  }
}

/**
 * Add or correct a supplier's opening balance after the house was made.
 *
 * The super admin could only set it when adding a supplier, and only as
 * money we owed. Now it can be set or changed any time, either way: a minus
 * (−1,400,000) is money we owed them and sits on an unpaid opening bill,
 * so Pay supplier, the supplier account and Money in and out treat it like
 * any bill; no sign is money they owed us, carried as credit with them.
 */
export async function setSupplierOpeningBalance(formData: FormData) {
  const user = await requireUser()
  if (!canSetOpeningMoney(user.role)) {
    return { error: "Only the CEO, the main admin, the Accountant or the Auditor can set a supplier's opening balance." }
  }
  const supplierId = String(formData.get("supplierId") || "")
  const raw = String(formData.get("openingBalance") ?? "").trim()
  const wanted = Number(raw)
  const reason = String(formData.get("reason") || "").trim()
  if (!supplierId) return { error: "Supplier missing. Open their page again." }
  if (raw === "" || !Number.isFinite(wanted)) {
    return { error: "Type the opening balance in naira. Put a minus in front if we owed them." }
  }
  if (reason.length < 3) return { error: "Say why the opening balance is being set or changed." }
  const target = Math.round(wanted * 100) / 100
  const weOwe = Math.max(0, -target)
  const theyOwe = Math.max(0, target)

  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } })
  if (!supplier) return { error: "We could not find that supplier." }
  if (isOpeningStockSupplierName(supplier.name)) {
    return { error: "Opening stock is the value the shops started with. It has no opening balance." }
  }
  const bills = await prisma.purchase.findMany({ where: supplierOpeningBills(supplierId), orderBy: { createdAt: "desc" } })
  const weOwedBefore = bills.reduce((sum, bill) => sum + money(bill.totalAmount), 0)
  const before = money(supplier.openingCredit) - weOwedBefore
  if (Math.abs(target - before) < 0.005) return { error: `The opening balance is already ${formatSignedBalance(target)}.` }

  // Money already paid on the opening bill stays paid: it can come down only
  // as far as what has been paid on it.
  const paidOn = bills.reduce((sum, bill) => sum + money(bill.paidAmount) + money(bill.returnedAmount), 0)
  if (weOwe + 0.005 < paidOn) {
    return {
      error: `${formatCurrency(paidOn)} has already been paid on this opening balance, so what we owed them cannot be set below ${formatCurrency(paidOn)}.`,
    }
  }
  const creditChange = money(theyOwe - money(supplier.openingCredit))
  if (money(supplier.creditBalance) + creditChange < -0.005) {
    return { error: "Part of the credit this house owed us has already been used, so it cannot come down that far." }
  }

  let shopId: string | null = null
  if (weOwe > weOwedBefore + 0.005 && !bills.length) {
    const hq = await prisma.branch.findFirst({ where: { isActive: true }, orderBy: [{ isHq: "desc" }, { name: "asc" }], select: { id: true } })
    shopId = user.branchId ?? hq?.id ?? null
    if (!shopId) return { error: "No shop is open to hold the opening bill." }
  }

  try {
    await prisma.$transaction(async (tx) => {
      if (Math.abs(weOwe - weOwedBefore) > 0.005) {
        if (bills.length) {
          // The newest opening bill takes the change; older ones stay as they were.
          const [latest, ...rest] = bills
          const others = rest.reduce((sum, bill) => sum + money(bill.totalAmount), 0)
          const nextTotal = Math.max(money(latest.paidAmount) + money(latest.returnedAmount), weOwe - others)
          await tx.purchase.update({
            where: { id: latest.id },
            // Brought to nothing with nothing paid: the bill is no longer needed.
            data: nextTotal <= 0.005 && money(latest.paidAmount) <= 0.005
              ? { totalAmount: "0.00", status: "CANCELLED" }
              : { totalAmount: nextTotal.toFixed(2) },
          })
        } else if (weOwe > 0.005 && shopId) {
          await tx.purchase.create({
            data: {
              invoiceNumber: generateDocNumber("OBAL"),
              supplierId,
              branchId: shopId,
              userId: user.id,
              status: "RECEIVED",
              totalAmount: weOwe.toFixed(2),
              paidAmount: "0",
              notes: "Opening balance. Money we already owed this house when the shops started on this software. Not a new carton.",
              source: "OPENING_BALANCE",
            },
          })
        }
      }
      if (Math.abs(creditChange) > 0.005) {
        await tx.supplier.update({
          where: { id: supplierId },
          data: { creditBalance: { increment: creditChange }, openingCredit: theyOwe.toFixed(2) },
        })
      }
      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: "UPDATE",
          entityType: "Supplier",
          entityId: supplierId,
          oldValue: JSON.stringify({ openingBalance: before }),
          newValue: JSON.stringify({
            openingBalance: target,
            reason,
            note: `Opening balance for ${supplier.name}: ${formatSignedBalance(before)} to ${formatSignedBalance(target)}. ${target < 0 ? "We owed them" : target > 0 ? "They owed us" : "Nothing either way"} before this software.`,
          }),
          branchId: user.branchId,
          risk: "MEDIUM",
        },
      })
    })
  } catch (error) {
    return { error: error instanceof Error && error.message ? "Could not save the opening balance. Nothing was changed." : "Could not save." }
  }

  revalidatePath(`/suppliers/${supplierId}`)
  revalidatePath("/suppliers")
  revalidatePath("/purchases")
  revalidatePath("/finance")
  revalidatePath("/reports")
  revalidatePath("/dashboard")
  return { success: true, message: `${supplier.name}: opening balance is now ${formatSignedBalance(target)}.` }
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
