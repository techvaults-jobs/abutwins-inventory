"use server"

import { revalidatePath } from "next/cache"
import {
  FaultClass,
  PaymentMethod,
  ProductCondition,
  RepairStatus,
  ReturnOutcome,
  ReturnReason,
  type Prisma,
} from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { mayDecideTransfer, transferDeciders } from "@/lib/transfer-rights"
import { requireUser } from "@/lib/session"
import { writeAudit } from "@/lib/audit"
import { canApprove, canManageFinance, canSeeAllBranches, canSendToSupplier, isShopOwner, scopedBranchId } from "@/lib/rbac"
import { can } from "@/lib/permissions"
import { formatCurrency, generateDocNumber, money } from "@/lib/utils"
import { shopError } from "@/lib/shop-speak"
import { canReachBranch, OTHER_SHOP, resolveWritableShopId, viewBranchFilter } from "@/lib/branch-scope"
import { ConflictError, claimImei, claimImeis, drawStock, recordMovement, returnStock, shiftCustomerBalance } from "@/lib/concurrency"
import { warrantyState } from "@/lib/warranty"
import { cell, readTableFile } from "@/lib/table-file"
import { buildBillTrace, type SupplierBillTrace } from "@/lib/supplier-trace"
import { watBounds, watDayKey } from "@/lib/lagos-day"
import { getAppSettings } from "@/lib/settings"
import { healOpeningStockBills } from "@/lib/opening-stock-money"
import { isOpeningStockPurchase, purchaseBalance, SUPPLIER_PAYMENT_NOTE } from "@/lib/purchase-money"
import { isSupplierReturnableStatus, supplierReturnMoneyPlan } from "@/lib/vendor-return"
import { recordSupplierReturnLine } from "@/lib/supplier-returns"
import { assertCashAvailable } from "@/lib/shop-cash"
import { shopPayChannel } from "@/lib/sale-money"
import { parseShopCondition, shopConditionLabel } from "@/lib/conditions"
import { normalizeStorage } from "@/lib/item-specs"
import { makeOpeningSku } from "@/lib/opening-stock"
import { unitCodeProblem, unitIdentityColumns, type UnitIdentityKind } from "@/lib/unit-identity"

function parseImeis(raw: string) {
  return [...new Set(raw.split(/[\s,;]+/).map((item) => item.trim()).filter((item) => item.length >= 14))]
}

/** IMEIs or serials, one unit each. Serial-only items (tablets, laptops) have short numbers. */
function parseUnitCodes(raw: string, tracking: string) {
  if (tracking !== "SERIAL") return parseImeis(raw)
  return [...new Set(raw.split(/[\s,;]+/).map((item) => item.trim()).filter((item) => item.length >= 4))]
}

/**
 * Numbers typed or scanned at the receiving shop. Unlike a transfer's notes
 * they carry no "IMEIs:" label, so they must not go through parseTransferIds:
 * once that stopped reading unlabelled text, every scanned phone list read as
 * empty and no transfer with phones could be accepted.
 */
function parseScannedCodes(raw: string) {
  return [...new Set(raw.split(/[\s,;]+/).map((item) => item.trim()).filter((item) => item.length >= 4))]
}

/** The numbers on one labelled line of a transfer's notes, such as "Arrived: a,b". */
function parseLabelledIds(raw: string, label: string) {
  const line = raw.split("\n").find((row) => row.startsWith(`${label}:`))
  return line ? parseScannedCodes(line.slice(label.length + 1)) : []
}

function parseTransferIds(raw: string) {
  const match = raw.match(/IMEIs:\s*(.+)/i)
  if (!match) return []
  const list = match[1]
  return [...new Set(list.split(/[\s,;]+/).map((item) => item.trim()).filter((item) => item.length >= 4 && !item.includes(":")))]
}

/** IMEIs on transfers still waiting for the other shop to accept or reject. */
export async function reservedTransferImeiSet(branchId?: string) {
  // Exported from a server-actions file, so callable on its own: signed in only.
  await requireUser()
  const rows = await prisma.stockTransfer.findMany({
    where: {
      status: "PENDING",
      ...(branchId ? { fromBranchId: branchId } : {}),
    },
    select: { notes: true },
  })
  return new Set(rows.flatMap((row) => parseTransferIds(row.notes ?? "")))
}

/** Shop devices on a Swap Deal still waiting for approval. Stock has not left yet. */
export async function reservedSwapImeiSet(branchId?: string) {
  await requireUser()
  const rows = await prisma.swap.findMany({
    where: {
      status: "PENDING",
      ...(branchId ? { branchId } : {}),
      newImeiId: { not: null },
    },
    select: { newImei: { select: { imei1: true, serialNumber: true } } },
  })
  const ids = new Set<string>()
  for (const row of rows) {
    if (row.newImei?.imei1) ids.add(row.newImei.imei1)
    if (row.newImei?.serialNumber) ids.add(row.newImei.serialNumber)
  }
  return ids
}

function cleanDeviceId(raw: string) {
  return String(raw || "").replace(/[\s-]/g, "").trim()
}

function looksLikeImei(value: string) {
  return /^\d{14,17}$/.test(value)
}

function refreshOps() {
  for (const path of [
    "/purchases",
    "/swaps",
    "/returns",
    "/transfers",
    "/repairs",
    "/imei",
    "/inventory",
    "/approvals",
    "/sales",
    "/customers",
    "/finance",
    "/reconciliation",
    "/audit",
    "/staff",
    "/suppliers",
    "/profits",
    "/reports",
    "/dashboard",
    "/audit/books",
  ]) {
    revalidatePath(path)
  }
  revalidatePath("/purchases", "layout")
  revalidatePath("/imei", "layout")
}

async function notify(userId: string, title: string, message: string, actionUrl: string, type: "APPROVAL_REQUEST" | "TRANSFER" | "RETURN" | "SYSTEM" = "SYSTEM") {
  await prisma.notification.create({
    data: { userId, type, title, message, actionUrl },
  })
}

async function attachImeisToPurchases() {
  const orphanCount = await prisma.imeiRecord.count({
    where: { purchaseId: null, notes: { not: null } },
  })
  if (orphanCount === 0) return
  const bills = await prisma.purchase.findMany({
    select: {
      id: true,
      invoiceNumber: true,
      incomingLots: { select: { lotNumber: true } },
    },
  })
  for (const bill of bills) {
    const needles = [bill.invoiceNumber, ...bill.incomingLots.map((lot) => lot.lotNumber)].filter(Boolean)
    if (!needles.length) continue
    await prisma.imeiRecord.updateMany({
      where: {
        purchaseId: null,
        OR: needles.map((needle) => ({ notes: { contains: needle } })),
      },
      data: { purchaseId: bill.id },
    })
  }
}

function trackingOf(value: string | undefined): "IMEI" | "SERIAL" | "NONE" {
  if (value === "SERIAL") return "SERIAL"
  if (value === "NONE") return "NONE"
  return "IMEI"
}

async function accessorySoldSince(productId: string, branchId: string, since: Date) {
  const today = watBounds(watDayKey())
  const [all, todayRows] = await Promise.all([
    prisma.saleItem.aggregate({
      where: {
        productId,
        imeiId: null,
        sale: {
          branchId,
          status: "COMPLETED",
          saleDate: { gte: since },
        },
      },
      _sum: { quantity: true },
    }),
    prisma.saleItem.aggregate({
      where: {
        productId,
        imeiId: null,
        sale: {
          branchId,
          status: "COMPLETED",
          saleDate: { gte: today.start, lt: today.end },
        },
      },
      _sum: { quantity: true },
    }),
  ])
  return {
    soldQty: all._sum.quantity ?? 0,
    soldToday: todayRows._sum.quantity ?? 0,
  }
}

const purchaseInclude = {
  supplier: true,
  branch: true,
  user: { select: { id: true, name: true, email: true, role: true, branchId: true } },
  items: { include: { product: true } },
  incomingLots: { select: { id: true, lotNumber: true, status: true, createdAt: true } },
  openingStock: { select: { id: true } },
  imeiRecords: {
    include: {
      branch: true,
      customer: true,
      sale: { select: { id: true, invoiceNumber: true, saleDate: true, status: true } },
    },
    orderBy: { createdAt: "asc" as const },
  },
}

function purchaseSearchWhere(q: string) {
  return {
    OR: [
      { invoiceNumber: { contains: q } },
      { originCity: { contains: q } },
      { originCountry: { contains: q } },
      { notes: { contains: q } },
      { supplier: { name: { contains: q } } },
      { items: { some: { product: { OR: [{ name: { contains: q } }, { sku: { contains: q } }] } } } },
      {
        imeiRecords: {
          some: {
            OR: [
              { imei1: { contains: q } },
              { imei2: { contains: q } },
              { serialNumber: { contains: q } },
            ],
          },
        },
      },
    ],
  }
}

export async function getPurchases(search?: string) {
  const user = await requireUser()
  const branchId = await viewBranchFilter(user)
  await healOpeningStockBills()
  await attachImeisToPurchases()
  const q = search?.trim() ?? ""
  const purchases = await prisma.purchase.findMany({
    where: {
      ...(branchId ? { branchId } : {}),
      ...(q.length >= 2 ? purchaseSearchWhere(q) : {}),
    },
    include: purchaseInclude,
    orderBy: { createdAt: "desc" },
  })

  const traces = await Promise.all(
    purchases.map(async (purchase) => {
      const item = purchase.items[0]
      const tracking = trackingOf(item?.product.tracking)
      const accessory =
        tracking === "NONE" && item
          ? {
              receivedQty: item.receivedQty,
              ...(await accessorySoldSince(item.productId, purchase.branchId, purchase.createdAt)),
            }
          : undefined
      const trace = buildBillTrace(
        item?.quantity ?? 0,
        tracking,
        purchase.imeiRecords.map((row) => ({ status: row.status, saleDate: row.sale?.saleDate ?? null })),
        accessory
      )
      return { ...purchase, trace }
    })
  )
  return traces
}

export async function getPurchase(id: string) {
  const user = await requireUser()
  await healOpeningStockBills()
  await attachImeisToPurchases()
  const purchase = await prisma.purchase.findUnique({
    where: { id },
    include: { ...purchaseInclude, incomingLots: true },
  })
  if (!purchase) return null
  // A supplier bill carries cost prices and the IMEIs it landed. It stays with
  // the shop that ordered it.
  if (!(await canReachBranch(user, purchase.branchId))) return null
  const item = purchase.items[0]
  const tracking = trackingOf(item?.product.tracking)
  const accessory =
    tracking === "NONE" && item
      ? {
          receivedQty: item.receivedQty,
          ...(await accessorySoldSince(item.productId, purchase.branchId, purchase.createdAt)),
        }
      : undefined
  const trace: SupplierBillTrace = buildBillTrace(
    item?.quantity ?? 0,
    tracking,
    purchase.imeiRecords.map((row) => ({ status: row.status, saleDate: row.sale?.saleDate ?? null })),
    accessory
  )
  return { ...purchase, trace }
}

export async function createPurchase(formData: FormData) {
  const user = await requireUser()
  const supplierId = String(formData.get("supplierId"))
  const shopGate = await resolveWritableShopId(user, String(formData.get("branchId") || user.branchId || ""))
  if ("error" in shopGate) return { error: shopGate.error }
  const branchId = shopGate.shopId
  const productId = String(formData.get("productId"))
  const quantity = Number(formData.get("quantity") || 0)
  const costPrice = Number(formData.get("costPrice") || 0)
  if (!supplierId || !productId || quantity < 1) return { error: "Fill the form for the goods you are expecting." }

  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } })
  if (!supplier) return { error: "Pick a supplier from the list." }
  if (supplier.kind === "NEIGHBOR") {
    return { error: "A neighboring shop is not a supplier carton." }
  }

  const originCountry = String(formData.get("originCountry") || "").trim() || supplier.country
  const originCity = String(formData.get("originCity") || "").trim() || supplier.city
  const expectedRaw = String(formData.get("expectedDate") || "").trim()
  const expectedDate = expectedRaw ? new Date(`${expectedRaw}T12:00:00`) : null

  const purchase = await prisma.purchase.create({
    data: {
      invoiceNumber: generateDocNumber("PO"),
      supplierId,
      branchId,
      userId: user.id,
      status: "ORDERED",
      totalAmount: (quantity * costPrice).toFixed(2),
      notes: String(formData.get("notes") || "") || null,
      originCountry,
      originCity,
      expectedDate,
      items: {
        create: {
          productId,
          quantity,
          costPrice: costPrice.toFixed(2),
          totalAmount: (quantity * costPrice).toFixed(2),
        },
      },
    },
  })
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "CREATE",
      entityType: "Purchase",
      entityId: purchase.invoiceNumber,
      newValue: JSON.stringify({ quantity, costPrice }),
      branchId,
    },
  })
  refreshOps()
  return { success: true, id: purchase.id, redirectTo: `/purchases/${purchase.id}` }
}

export async function receivePurchaseImeis(formData: FormData) {
  const user = await requireUser()
  if (!(await can(user.role, "action.intake"))) return { error: "You are not allowed to receive supplier goods. Ask the main admin." }
  const id = String(formData.get("id"))
  const purchase = await prisma.purchase.findUnique({
    where: { id },
    include: { items: { include: { product: true } }, supplier: true },
  })
  if (!purchase) return { error: "We could not find that supplier bill." }
  if (!(await canReachBranch(user, purchase.branchId))) return { error: OTHER_SHOP }
  if (purchase.status === "RECEIVED") return { error: "These goods have already been received and the bill is closed." }

  const item = purchase.items[0]
  if (!item) return { error: "That supplier bill has no items on it." }

  const costRaw = String(formData.get("costPrice") ?? "").trim()
  const unitCost = costRaw === "" ? money(item.costPrice) : Number(costRaw)
  if (!Number.isFinite(unitCost) || unitCost < 0) {
    return { error: "Enter a valid unit cost from the supplier paper before you receive." }
  }
  const costNote = String(formData.get("costNote") || "").trim()
  if (unitCost !== money(item.product.costPrice) && !costNote) {
    return { error: "The unit cost differs from the price list. Write a short note before you receive." }
  }

  async function applyCost(tx: Prisma.TransactionClient) {
    const next = unitCost.toFixed(2)
    const previous = money(item!.product.costPrice)
    if (previous !== unitCost) {
      await tx.product.update({ where: { id: item!.productId }, data: { costPrice: next } })
      await tx.priceHistory.create({
        data: {
          productId: item!.productId,
          oldPrice: previous.toFixed(2),
          newPrice: next,
          priceType: "COST_PRICE",
          reason: costNote || `Checked on receive ${purchase!.invoiceNumber}`,
          changedBy: user.id,
        },
      })
    }
    const lineTotal = (unitCost * item!.quantity).toFixed(2)
    await tx.purchaseItem.update({
      where: { id: item!.id },
      data: { costPrice: next, totalAmount: lineTotal },
    })
    await tx.purchase.update({
      where: { id: purchase!.id },
      data: { totalAmount: lineTotal },
    })
  }

  const settings = await getAppSettings()
  if (settings.dualControlIncoming) {
    return {
      error:
        "A second person must say yes before goods enter the shop. Book this bill as Coming, then use Preview and receive on Goods on the way.",
    }
  }

  const serialOnly = item.product.tracking === "SERIAL"
  const imeis = parseUnitCodes(String(formData.get("imeis") || ""), item.product.tracking)
  const remaining = item.quantity - item.receivedQty

  if (imeis.length === 0) {
    if (remaining < 1) return { error: "There is nothing left to receive on this bill." }
    try {
      await prisma.$transaction(async (tx) => {
        // Only book in against the count this screen was showing. Two people
        // receiving the same shipment used to add the goods to stock twice.
        const booked = await tx.purchaseItem.updateMany({
          where: { id: item.id, receivedQty: item.receivedQty },
          data: { receivedQty: item.quantity },
        })
        if (booked.count !== 1) {
          throw new ConflictError(`${purchase.invoiceNumber} was already received by someone else. Refresh to see it.`)
        }
        await applyCost(tx)
        await tx.purchase.update({
          where: { id },
          data: { status: "RECEIVED", receivedDate: new Date() },
        })
        await returnStock(tx, {
          productId: item.productId,
          branchId: purchase.branchId,
          quantity: remaining,
          move: { kind: "RECEIVED", reference: purchase.invoiceNumber, userId: user.id },
        })
      })
    } catch (error) {
      return { error: shopError(error, "Could not receive this shipment.") }
    }
    refreshOps()
    revalidatePath("/products")
    return { success: true }
  }

  const numberWord = serialOnly ? "serials" : "IMEIs"
  if (imeis.length > remaining) {
    return { error: `Only ${remaining} units are still expected. You pasted ${imeis.length} ${numberWord}.` }
  }

  const duplicates = await prisma.imeiRecord.findMany({
    where: { OR: [{ imei1: { in: imeis } }, { imei2: { in: imeis } }, { serialNumber: { in: imeis } }] },
    select: { imei1: true },
  })
  if (duplicates.length) {
    return { error: `Already in the shop: ${duplicates.map((row) => row.imei1).join(", ")}` }
  }

  const receivedQty = item.receivedQty + imeis.length
  const done = receivedQty >= item.quantity

  try {
  await prisma.$transaction(async (tx) => {
    // Claim the line against the count this screen was showing, before creating
    // anything. A second receive on the same shipment now stops here instead of
    // booking the same phones in twice.
    const booked = await tx.purchaseItem.updateMany({
      where: { id: item.id, receivedQty: item.receivedQty },
      data: { receivedQty },
    })
    if (booked.count !== 1) {
      throw new ConflictError(`${purchase.invoiceNumber} was received by someone else while you were scanning. Refresh and scan what is left.`)
    }
    for (const imei1 of imeis) {
      await tx.imeiRecord.create({
        data: {
          imei1,
          serialNumber: serialOnly ? imei1 : null,
          productId: item.productId,
          supplierId: purchase.supplierId,
          branchId: purchase.branchId,
          purchaseId: purchase.id,
          status: "IN_STOCK",
          notes: `Received on ${purchase.invoiceNumber}`,
        },
      })
    }
    await applyCost(tx)
    await tx.purchase.update({
      where: { id },
      data: {
        status: done ? "RECEIVED" : "PARTIAL_RECEIVED",
        receivedDate: done ? new Date() : purchase.receivedDate,
      },
    })
    await returnStock(tx, {
      productId: item.productId,
      branchId: purchase.branchId,
      quantity: imeis.length,
      move: { kind: "RECEIVED", reference: purchase.invoiceNumber, userId: user.id },
    })
    await tx.auditLog.create({
      data: {
        userId: user.id,
        action: "IMPORT",
        entityType: "Purchase",
        entityId: purchase.invoiceNumber,
        newValue: JSON.stringify({
          imeis,
          receivedQty,
          unitCost,
          status: done ? "RECEIVED" : "PARTIAL_RECEIVED",
        }),
        branchId: purchase.branchId,
      },
    })
    for (const imei1 of imeis) {
      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: "CREATE",
          entityType: "IMEIRecord",
          entityId: imei1,
          newValue: JSON.stringify({ status: "IN_STOCK", purchase: purchase.invoiceNumber }),
          branchId: purchase.branchId,
        },
      })
    }
  })
  } catch (error) {
    return { error: shopError(error, "Could not receive these phones. Check that no IMEI is already on the system.") }
  }

  refreshOps()
  revalidatePath("/products")
  return { success: true }
}

export async function payPurchase(formData: FormData) {
  const user = await requireUser()
  if (!(await canManageFinance(user.role))) return { error: "You are not allowed to pay suppliers. Ask accounts." }
  const id = String(formData.get("id") || "")
  const amount = Number(formData.get("amount") || 0)
  const method = String(formData.get("method") || "TRANSFER")
  if (!id || amount <= 0) return { error: "Enter the amount sent to the supplier." }

  await healOpeningStockBills()
  const purchase = await prisma.purchase.findUnique({
    where: { id },
    include: { supplier: true, openingStock: true },
  })
  if (!purchase) return { error: "We could not find that supplier bill." }
  if (!(await canReachBranch(user, purchase.branchId))) return { error: OTHER_SHOP }
  if (isOpeningStockPurchase(purchase)) {
    return { error: "Opening stock is the value the shop started with. It is not a bill to pay." }
  }
  const due = purchaseBalance(purchase.totalAmount, purchase.paidAmount, purchase.returnedAmount).owed
  if (due <= 0) {
    const surplus = purchaseBalance(purchase.totalAmount, purchase.paidAmount, purchase.returnedAmount).surplus
    if (surplus > 0) {
      return { error: "This house already owes us after phones were sent back. Do not pay more on this bill." }
    }
    return { error: "This supplier bill is already fully paid." }
  }
  const sent = Math.min(amount, due)
  const payRef = generateDocNumber("SPAY")

  try {
  await prisma.$transaction(async (tx) => {
    // The database adds the payment on, so two clerks paying the same supplier
    // invoice at once cannot overwrite each other and lose one of the payments.
    const paid = await tx.purchase.update({
      where: { id },
      data: {
        paidAmount: { increment: sent },
        paymentMethod: method,
      },
      select: { paidAmount: true, totalAmount: true, returnedAmount: true, invoiceNumber: true },
    })
    const remaining = Math.max(0, money(paid.totalAmount) - money(paid.returnedAmount))
    if (money(paid.paidAmount) > remaining + 0.005) {
      throw new ConflictError(`${paid.invoiceNumber} was already paid while you were typing. Open it again to see what is still owed.`)
    }
    await tx.financeEntry.create({
      data: {
        branchId: purchase.branchId,
        account: method === "CASH" ? "CASH" : "BANK",
        type: "EXPENSE",
        amount: sent.toFixed(2),
        reference: payRef,
        description: `${SUPPLIER_PAYMENT_NOTE}${purchase.invoiceNumber} · ${purchase.supplier.name}`,
      },
    })
    await tx.auditLog.create({
      data: {
        userId: user.id,
        action: "CREATE",
        entityType: "Purchase",
        entityId: purchase.invoiceNumber,
        newValue: JSON.stringify({ payRef, sent, method, goodsUnchanged: true }),
        branchId: purchase.branchId,
      },
    })
  })
  } catch (error) {
    return { error: shopError(error, "Could not record this supplier payment.") }
  }

  refreshOps()
  revalidatePath(`/purchases/${id}`)
  return { success: true }
}

export async function getReturns() {
  const user = await requireUser()
  const branchId = await viewBranchFilter(user)
  const rows = await prisma.stockReturn.findMany({
    where: branchId ? { branchId } : undefined,
    include: {
      customer: true,
      imei: { include: { product: true } },
      replacementImei: { include: { product: true } },
      saleItem: { include: { product: true } },
      branch: true,
      user: { select: { id: true, name: true, email: true, role: true, branchId: true } },
    },
    orderBy: { createdAt: "desc" },
  })
  const invoices = await prisma.sale.findMany({
    where: { id: { in: rows.map((row) => row.saleId).filter((id): id is string => Boolean(id)) } },
    select: { id: true, invoiceNumber: true, totalAmount: true, paidAmount: true },
  })
  return rows.map((row) => ({
    ...row,
    invoice: invoices.find((sale) => sale.id === row.saleId) ?? null,
  }))
}

/**
 * Phones a customer can bring back: sold ones, and ones handed out on a Swap
 * Deal that was approved but never settled (those carry no invoice yet).
 */
const RETURNABLE_UNIT: Prisma.ImeiRecordWhereInput = {
  customerId: { not: null },
  OR: [{ status: "SOLD" }, { status: "SWAPPED", swapsNew: { some: { status: "APPROVED" } } }],
}

export async function getSoldImeis() {
  const user = await requireUser()
  const branchId = await scopedBranchId(user.role, user.branchId)
  return prisma.imeiRecord.findMany({
    where: { ...RETURNABLE_UNIT, ...(branchId ? { branchId } : {}) },
    include: {
      product: true,
      customer: true,
      sale: { include: { items: true } },
      branch: true,
    },
    orderBy: { updatedAt: "desc" },
    take: 300,
  })
}

/** Find one sold phone by IMEI or serial when it is not in the recent list. */
export async function findSoldImei(code: string) {
  const user = await requireUser()
  if (!(await can(user.role, "action.return"))) {
    return { error: "You are not allowed to record a return. Ask the main admin." }
  }
  const cleaned = code.replace(/[\s-]/g, "").trim()
  if (!cleaned) return { error: "Scan or type the sold IMEI first." }
  const branchId = await scopedBranchId(user.role, user.branchId)
  const row = await prisma.imeiRecord.findFirst({
    where: {
      AND: [
        RETURNABLE_UNIT,
        { OR: [{ imei1: cleaned }, { imei2: cleaned }, { serialNumber: cleaned }, { imei1: { endsWith: cleaned } }] },
      ],
      ...(branchId ? { branchId } : {}),
    },
    include: {
      product: true,
      customer: true,
      sale: { include: { items: true } },
      branch: true,
    },
  })
  if (!row) {
    return {
      error:
        "That IMEI is not a sold phone with a buyer name in this shop. Attach the buyer on the invoice first, or check the shop.",
    }
  }
  return { sold: row }
}

/**
 * Look up a completed sale by invoice number so staff can pick which line item
 * to return. Used for accessories, cords, and other non-IMEI goods.
 */
export async function findSaleByInvoice(invoiceNumber: string) {
  const user = await requireUser()
  if (!(await can(user.role, "action.return"))) {
    return { error: "You are not allowed to record a return. Ask the main admin." }
  }
  const cleaned = invoiceNumber.trim().toUpperCase()
  if (!cleaned) return { error: "Type the invoice number first." }
  const branchId = await scopedBranchId(user.role, user.branchId)

  const sale = await prisma.sale.findFirst({
    where: {
      invoiceNumber: { equals: cleaned },
      status: "COMPLETED",
      ...(branchId ? { branchId } : {}),
    },
    include: {
      customer: true,
      branch: true,
      items: {
        include: {
          product: { include: { category: true } },
          imei: true,
        },
      },
    },
  })

  if (!sale) {
    // Try a case-insensitive partial match to help with minor typos
    const partial = await prisma.sale.findFirst({
      where: {
        invoiceNumber: { contains: cleaned },
        status: "COMPLETED",
        ...(branchId ? { branchId } : {}),
      },
      include: {
        customer: true,
        branch: true,
        items: {
          include: {
            product: { include: { category: true } },
            imei: true,
          },
        },
      },
    })
    if (!partial) {
      return { error: `Invoice ${cleaned} was not found in this shop as a completed sale. Check the number and try again.` }
    }
    if (!partial.customerId) {
      return { error: `Invoice ${partial.invoiceNumber} has no buyer name. Attach the customer on the invoice before logging a return.` }
    }
    return { sale: partial }
  }

  if (!sale.customerId) {
    return { error: `Invoice ${sale.invoiceNumber} has no buyer name. Attach the customer on the invoice before logging a return.` }
  }

  return { sale }
}

/** In shop units staff may give out on a Replace return. */
export async function getInStockForReplace() {
  const user = await requireUser()
  const branchId = await scopedBranchId(user.role, user.branchId)
  // A replacement must come from the return's own shop. Taking the newest 200
  // across every shop meant someone who sees all shops (the CEO, the main
  // admin) could find their shop's list empty, so it is read shop by shop.
  const shopIds = branchId
    ? [branchId]
    : // Every shop, closed ones too: a closed shop can still have returns to apply.
      (await prisma.branch.findMany({ select: { id: true } })).map((row) => row.id)
  const perShop = await Promise.all(
    shopIds.map((shopId) =>
      prisma.imeiRecord.findMany({
        where: {
          status: "IN_STOCK",
          // A phone with no cosmetic grade recorded is an ordinary phone, not a
          // faulty one. `NOT: { cosmeticGrade: "FAULTY" }` drops those rows, because
          // SQL cannot compare NULL to a word — it hid every ungraded phone.
          OR: [{ cosmeticGrade: null }, { cosmeticGrade: { not: "FAULTY" } }],
          product: { condition: { not: "FAULTY" } },
          branchId: shopId,
        },
        include: { product: true },
        orderBy: { updatedAt: "desc" },
        take: 150,
      })
    )
  )
  return perShop.flat()
}

/** The reasons a return inward from the shop floor may give. */
const INWARD_RETURN_REASONS: ReturnReason[] = ["FAULTY", "CUSTOMER_DISSATISFACTION", "EXCHANGE"]

export async function createReturn(formData: FormData) {
  const user = await requireUser()
  if (!(await can(user.role, "action.return"))) return { error: "You are not allowed to record a return. Ask the main admin." }

  const reason = String(formData.get("reason")) as ReturnReason
  const outcome = String(formData.get("outcome")) as ReturnOutcome
  // A return goes back into the shop's sellable stock unless someone with full
  // control says otherwise. Defaulting to faulty kept returned phones (and every
  // accessory refunded by a manager, whose form has no condition box) off the
  // shelf, so returns never showed in Shop stock or on Sell now.
  let faultClass = String(formData.get("faultClass") || "GOOD_STOCK") as FaultClass
  if (!(Object.values(FaultClass) as string[]).includes(faultClass)) faultClass = "GOOD_STOCK"
  const notesRaw = String(formData.get("notes") || "").trim()
  if (!(Object.values(ReturnReason) as string[]).includes(reason)) return { error: "Pick why it is coming back." }
  if (!(Object.values(ReturnOutcome) as string[]).includes(outcome)) return { error: "Pick what happens next." }

  // A cashier's return is a return inward: it comes back into the shop, as a
  // replacement from our stock or a refund. Anything beyond the shop (back to
  // the supplier, repair, a credit note) is for the Vault Manager, the shop
  // Manager, the CEO or the main admin, who take it from there.
  if (!canSendToSupplier(user.role)) {
    if (!INWARD_RETURN_REASONS.includes(reason)) {
      return { error: "Pick Faulty, Dissatisfaction / change of mind, or Replacement." }
    }
    if (outcome !== "REPLACEMENT" && outcome !== "REFUND") {
      return { error: "A return from the shop floor is a replacement from our stock or a refund. A manager decides anything else." }
    }
    // From the shop floor every return goes straight back on the shelf, ready
    // to sell, as the owners asked. A manager can mark a broken one Damaged on
    // its phone page in one tap.
    faultClass = "GOOD_STOCK"
  }
  const returnRaw = formData.get("returnValue") ?? formData.get("refundAmount")
  const returnMode = String(formData.get("returnMode") || "imei") // "imei" | "invoice"

  // ── INVOICE-ITEM PATH (accessories, cords, no-number items) ──────────────
  if (returnMode === "invoice") {
    const saleItemId = String(formData.get("saleItemId") || "").trim()
    const quantityRaw = Number(formData.get("returnQty") || 1)
    const returnQty = Math.max(1, Math.floor(quantityRaw))

    if (!saleItemId) return { error: "Pick the item from the invoice that is being returned." }

    const saleItem = await prisma.saleItem.findUnique({
      where: { id: saleItemId },
      include: {
        product: true,
        sale: {
          include: {
            customer: true,
            branch: true,
            items: true,
          },
        },
      },
    })
    if (!saleItem) return { error: "That sale line was not found. Reload the invoice and try again." }
    if (!saleItem.sale) return { error: "The sale for that item was not found." }
    if (!saleItem.sale.customerId) return { error: "This sale has no buyer name. Add the buyer before you start the return." }
    if (saleItem.imeiId) {
      return { error: "That line has an IMEI. Use the IMEI tab to return a phone or laptop." }
    }

    // Check for existing open return on this exact sale item
    const openItemReturn = await prisma.stockReturn.findFirst({
      where: { saleItemId, status: { in: ["PENDING", "APPROVED"] } },
    })
    if (openItemReturn) {
      return { error: `${saleItem.product.name} from that invoice already has a return that is not finished. Open it on Returns and finish it.` }
    }

    // Validate quantity
    if (returnQty > saleItem.quantity) {
      return { error: `You can return at most ${saleItem.quantity} ${saleItem.product.name}. The invoice only has that many.` }
    }

    const unitPrice = money(saleItem.totalPrice) / Math.max(1, saleItem.quantity)
    const suggestedReturn = unitPrice * returnQty
    const returnValue =
      returnRaw !== null && String(returnRaw).trim() !== "" ? Number(returnRaw) : suggestedReturn
    if (!Number.isFinite(returnValue) || returnValue < 0) {
      return { error: "Enter the return item value." }
    }

    let replacementImeiId: string | null = null
    let replacementValue: number | null = null
    let balanceAmount: number | null = null

    if (outcome === "REPLACEMENT") {
      replacementImeiId = String(formData.get("replacementImeiId") || "").trim() || null
      const replacementValueRaw = formData.get("replacementValue")
      if (!replacementImeiId) return { error: "Pick the shop item to give out as the replacement." }
      const fresh = await prisma.imeiRecord.findUnique({
        where: { id: replacementImeiId },
        include: { product: true },
      })
      if (!fresh || fresh.status !== "IN_STOCK") return { error: "That replacement is not In shop." }
      if (fresh.branchId !== saleItem.sale.branchId) return { error: "The replacement must be in the same shop as the return." }
      replacementValue =
        replacementValueRaw !== null && String(replacementValueRaw).trim() !== ""
          ? Number(replacementValueRaw)
          : money(fresh.product.sellingPrice)
      if (!Number.isFinite(replacementValue) || replacementValue < 0) {
        return { error: "Enter the value of the replacement given out." }
      }
      balanceAmount = replacementValue - returnValue
    }

    const record = await prisma.stockReturn.create({
      data: {
        returnNumber: generateDocNumber("RTN"),
        status: "APPROVED",
        approvedBy: user.id,
        approvedAt: new Date(),
        customerId: saleItem.sale.customerId,
        saleId: saleItem.saleId,
        saleItemId: saleItem.id,
        branchId: saleItem.sale.branchId,
        userId: user.id,
        reason,
        outcome,
        faultClass,
        notes: [
          `Item: ${saleItem.product.name}`,
          returnQty > 1 ? `Qty: ${returnQty}` : null,
          notesRaw || null,
        ].filter(Boolean).join(" · ") || null,
        returnValue: returnValue.toFixed(2),
        refundAmount: returnValue.toFixed(2),
        replacementImeiId,
        replacementValue: replacementValue != null ? replacementValue.toFixed(2) : null,
        balanceAmount: balanceAmount != null ? balanceAmount.toFixed(2) : null,
      },
    })

    return settleNewReturn(user, record.id, formData)
  }

  // ── IMEI PATH (phones, laptops, serial items) ─────────────────────────────
  const imei1 = String(formData.get("imei1") ?? "").trim()
  let imei = await prisma.imeiRecord.findUnique({
    where: { imei1 },
    include: { sale: { include: { items: true } }, customer: true, product: true },
  })
  // A phone we gave out on a Swap Deal that was approved but never settled is
  // "swapped", not sold: it has no invoice, so the return could not find a
  // sale for it. Settle that swap first, which writes its invoice (anything
  // the customer still owed on it goes on their account), then return it.
  if (imei && imei.status === "SWAPPED") {
    const swap = await prisma.swap.findFirst({
      where: { newImeiId: imei.id, status: "APPROVED" },
      select: { id: true, swapNumber: true, balanceAmount: true },
    })
    if (!swap) return { error: `${imei1} went out on a Swap Deal that is not open any more. Check it on Swap Deals.` }
    const owedToCustomer = Math.max(0, -money(swap.balanceAmount))
    if (owedToCustomer > 0) {
      return {
        error: `${imei1} went out on Swap Deal ${swap.swapNumber}, which still owes the customer ${owedToCustomer.toLocaleString("en-NG")} naira. Settle and invoice it on Swap Deals first (say how that money was paid), then log the return.`,
      }
    }
    const settle = new FormData()
    settle.set("id", swap.id)
    settle.set("method", "CASH")
    settle.set("paidAmount", "0")
    const settled = await finishSwap(user, settle)
    if (settled && "error" in settled && settled.error) {
      return { error: `Swap Deal ${swap.swapNumber} could not be settled first: ${settled.error}` }
    }
    imei = await prisma.imeiRecord.findUnique({
      where: { imei1 },
      include: { sale: { include: { items: true } }, customer: true, product: true },
    })
  }
  if (!imei || imei.status !== "SOLD") return { error: "That IMEI was never sold, so it cannot be returned." }
  if (!imei.customerId) return { error: "This sale has no buyer name. Add the buyer before you start the return." }
  const open = await prisma.stockReturn.findFirst({
    where: { imeiId: imei.id, status: { in: ["PENDING", "APPROVED"] } },
  })
  if (open) return { error: `${imei1} already has an open return.` }

  if (reason === "WARRANTY") {
    const cover = warrantyState(imei.sale?.saleDate, imei.product.warrantyDays)
    if (!cover.active) return { error: cover.label + ". Pick another return reason. Do not change the old sale." }
  }

  const line = imei.sale?.items.find((item) => item.imeiId === imei.id)
  const suggested = money(line?.totalPrice) || money(imei.product.sellingPrice)
  const returnValue = returnRaw !== null && String(returnRaw).trim() !== "" ? Number(returnRaw) : suggested
  if (!Number.isFinite(returnValue) || returnValue < 0) {
    return { error: "Enter the return item value." }
  }

  let replacementImeiId: string | null = null
  let replacementValue: number | null = null
  let balanceAmount: number | null = null

  if (outcome === "REPLACEMENT") {
    replacementImeiId = String(formData.get("replacementImeiId") || "").trim() || null
    const replacementValueRaw = formData.get("replacementValue")
    if (!replacementImeiId) return { error: "Pick the shop item to give out as the replacement." }
    const fresh = await prisma.imeiRecord.findUnique({
      where: { id: replacementImeiId },
      include: { product: true },
    })
    if (!fresh || fresh.status !== "IN_STOCK") return { error: "That replacement is not In shop." }
    if (fresh.branchId !== imei.branchId) return { error: "The replacement must be in the same shop as the return." }
    replacementValue =
      replacementValueRaw !== null && String(replacementValueRaw).trim() !== ""
        ? Number(replacementValueRaw)
        : money(fresh.product.sellingPrice)
    if (!Number.isFinite(replacementValue) || replacementValue! < 0) {
      return { error: "Enter the value of the replacement given out." }
    }
    balanceAmount = replacementValue! - returnValue
  }

  const record = await prisma.stockReturn.create({
    data: {
      returnNumber: generateDocNumber("RTN"),
      status: "APPROVED",
      approvedBy: user.id,
      approvedAt: new Date(),
      customerId: imei.customerId!,
      saleId: imei.saleId,
      imeiId: imei.id,
      branchId: imei.branchId,
      userId: user.id,
      reason,
      outcome,
      faultClass,
      notes: notesRaw || null,
      supplierId: imei.supplierId,
      returnValue: returnValue.toFixed(2),
      refundAmount: returnValue.toFixed(2),
      replacementImeiId,
      replacementValue: replacementValue != null ? replacementValue.toFixed(2) : null,
      balanceAmount: balanceAmount != null ? balanceAmount.toFixed(2) : null,
    },
  })
  return settleNewReturn(user, record.id, formData)
}

/**
 * A return takes effect the moment it is logged: no approval, no waiting.
 * What came back goes onto the shop's stock (or the damaged list when it is
 * faulty), and the refund, credit note or replacement is settled in the same
 * step, from the details on the form. If that cannot be done (no bank picked
 * for a refund, say), the return is taken off again so nothing is half-done.
 */
async function settleNewReturn(user: Awaited<ReturnType<typeof requireUser>>, returnId: string, formData: FormData) {
  const settle = new FormData()
  settle.set("id", returnId)
  for (const key of ["method", "paidAmount", "bankAccountId", "replacementImeiId"]) {
    const value = formData.get(key)
    if (value != null && String(value).trim() !== "") settle.set(key, String(value))
  }
  const applied = await applyReturn(user, settle)
  if (applied && "error" in applied && applied.error) {
    await prisma.stockReturn.deleteMany({ where: { id: returnId, status: { not: "COMPLETED" } } })
    return { error: applied.error }
  }
  return { success: true }
}

/** Apply a return that was logged and approved before returns applied themselves. */
export async function completeReturn(formData: FormData) {
  const user = await requireUser()
  return applyReturn(user, formData)
}

/**
 * The money and the stock behind one return. Run straight away when a return
 * is logged, and by Apply for a return still waiting from before.
 */
async function applyReturn(user: Awaited<ReturnType<typeof requireUser>>, formData: FormData) {
  const id = String(formData.get("id"))
  const record = await prisma.stockReturn.findUnique({
    where: { id },
    include: {
      customer: true,
      imei: {
        include: {
          product: true,
          supplier: true,
          branch: true,
          purchase: { include: { items: true, openingStock: true } },
        },
      },
      replacementImei: { include: { product: true } },
      saleItem: { include: { product: true } },
    },
  })
  if (!record) return { error: "We could not find that return." }
  // A record id is easy to guess or pass on: only someone who can reach the
  // return's shop may apply it (and pay its refund).
  if (!(await canReachBranch(user, record.branchId))) return { error: OTHER_SHOP }
  if (record.status === "COMPLETED") return { error: "That return is already finished." }
  if (record.status === "REJECTED") return { error: "That return was declined. Log it again if it is coming back." }
  // Returns no longer wait for approval, so one still waiting from before can
  // be applied by anyone who records returns.
  if (!(await can(user.role, "action.return"))) return { error: "You are not allowed to finish a return. Ask the main admin." }
  const sale = record.saleId
    ? await prisma.sale.findUnique({ where: { id: record.saleId } })
    : null

  // Reconfirmation at Apply. The CEO and the main admin may change the course
  // of action (send a faulty phone back to the supplier instead of refunding,
  // say) or the condition before anything moves. Everyone else applies what
  // was approved. The change is kept on Who did what.
  const askedOutcome = String(formData.get("outcome") || "").trim()
  const askedFault = String(formData.get("faultClass") || "").trim()
  const outcomeChange = askedOutcome !== "" && askedOutcome !== record.outcome
  const faultChange = askedFault !== "" && askedFault !== record.faultClass
  if (outcomeChange || faultChange) {
    if (!isShopOwner(user.role)) {
      return { error: "Only the CEO or the main admin can change what happens to a return." }
    }
    if (outcomeChange && !(Object.values(ReturnOutcome) as string[]).includes(askedOutcome)) {
      return { error: "Pick what happens next from the list." }
    }
    if (faultChange && !(Object.values(FaultClass) as string[]).includes(askedFault)) {
      return { error: "Pick the condition from the list." }
    }
    if (outcomeChange && !record.imeiId && (askedOutcome === "REPAIR" || askedOutcome === "SEND_TO_SUPPLIER")) {
      return { error: "Repair and Send back to the supplier are for phones and laptops with a number." }
    }
    const before = { outcome: record.outcome, faultClass: record.faultClass }
    const nextOutcome = (outcomeChange ? askedOutcome : record.outcome) as ReturnOutcome
    const nextFault = (faultChange ? askedFault : record.faultClass) as FaultClass
    await prisma.stockReturn.update({
      where: { id },
      data: {
        outcome: nextOutcome,
        faultClass: nextFault,
        // A replacement agreed at logging belongs to the old course of action.
        ...(outcomeChange ? { replacementImeiId: null, replacementValue: null, balanceAmount: null } : {}),
      },
    })
    record.outcome = nextOutcome
    record.faultClass = nextFault
    if (outcomeChange) {
      record.replacementImeiId = null
      record.replacementValue = null
      record.balanceAmount = null
      record.replacementImei = null
    }
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "UPDATE",
        entityType: "Return",
        entityId: record.returnNumber,
        oldValue: JSON.stringify(before),
        newValue: JSON.stringify({ outcome: nextOutcome, faultClass: nextFault, reconfirmed: true }),
        branchId: record.branchId,
        risk: "HIGH",
      },
    })
  }

  if (record.outcome === "SEND_TO_SUPPLIER" && !canSendToSupplier(user.role)) {
    return { error: "Only the Vault Manager, the shop Manager, the CEO or the main admin can send stock back to a supplier." }
  }
  const method = String(formData.get("method") || "CASH") as PaymentMethod
  const paidAmount = Number(formData.get("paidAmount") || 0)
  // Money going back to a customer leaves by bank, from a named account: safer
  // than cash from the till, and it is how most refunds are paid anyway.
  const bankAccountId = String(formData.get("bankAccountId") || "").trim()
  const refundBank = bankAccountId
    ? await prisma.bankAccount.findFirst({ where: { id: bankAccountId, isActive: true } })
    : null
  if (bankAccountId && !refundBank) return { error: "That bank account is no longer on the list. Pick another." }
  const bankLabel = refundBank ? `${refundBank.bankName} ${refundBank.accountNumber}` : ""
  let replacementImeiId = record.replacementImeiId || String(formData.get("replacementImeiId") || "").trim() || null
  const typedImei = String(formData.get("replacementImei") || "").replace(/[\s-]/g, "").trim()

  if (record.outcome === "REPLACEMENT") {
    if (!replacementImeiId && typedImei) {
      const byCode = await prisma.imeiRecord.findFirst({
        where: {
          status: "IN_STOCK",
          branchId: record.branchId,
          OR: [{ imei1: typedImei }, { serialNumber: typedImei }],
        },
      })
      replacementImeiId = byCode?.id ?? null
    }
    if (!replacementImeiId) return { error: "Pick or enter the replacement from In shop stock." }
  }

  if (record.outcome === "REFUND") {
    // The same sum the transaction below pays out: debt on the sale is
    // cancelled first, and only what was actually paid can come back.
    const asked = money(record.returnValue) || money(record.refundAmount) || (record.imei ? money(record.imei.product.sellingPrice) : 0)
    const salePaid = sale ? money(sale.paidAmount) : asked
    const saleDue = sale ? Math.max(0, money(sale.totalAmount) - salePaid) : 0
    const refundOut = Math.min(asked - Math.min(saleDue, asked), salePaid)
    if (refundOut > 0 && !refundBank) return { error: "Pick the bank account the refund is paid from." }
  }
  if (record.outcome === "REPLACEMENT") {
    // A replacement chosen now has no agreed balance yet: it is the unit's price
    // less the return value, the same sum the transaction below uses.
    let balance = record.balanceAmount != null ? money(record.balanceAmount) : 0
    if (record.balanceAmount == null && replacementImeiId) {
      const unit = await prisma.imeiRecord.findUnique({ where: { id: replacementImeiId }, include: { product: true } })
      const returnValue = money(record.returnValue) || money(record.refundAmount) || (record.imei ? money(record.imei.product.sellingPrice) : 0)
      balance = unit ? money(unit.product.sellingPrice) - returnValue : 0
    }
    if (balance < 0 && !refundBank) return { error: "Pick the bank account the difference is paid back from." }
  }

  try {
  await prisma.$transaction(async (tx) => {
    const sealed = await tx.stockReturn.updateMany({
      where: { id, status: { not: "COMPLETED" } },
      data: {
        status: "COMPLETED",
        approvedBy: user.id,
        approvedAt: new Date(),
        completedAt: new Date(),
        sentToSupplierAt: record.outcome === "SEND_TO_SUPPLIER" ? new Date() : record.sentToSupplierAt,
        supplierId: record.supplierId || record.imei?.supplierId || null,
        replacementImeiId: replacementImeiId || record.replacementImeiId,
      },
    })
    if (sealed.count !== 1) {
      throw new ConflictError(`${record.returnNumber} was already completed by someone else. Refresh to see it.`)
    }

    if (record.outcome === "REFUND" || record.outcome === "CREDIT_NOTE") {
      const asked = money(record.returnValue) || money(record.refundAmount) || (record.imei ? money(record.imei.product.sellingPrice) : 0)
      const salePaid = sale ? money(sale.paidAmount) : asked
      const saleDue = sale ? Math.max(0, money(sale.totalAmount) - salePaid) : 0
      // What is returned first cancels what the customer still owes on that
      // sale; only the rest comes back as money, and never more than they paid.
      // This used to read `Math.min(asked, salePaid || asked)`: with nothing
      // paid, `0 || asked` refunded the full value in cash on top of wiping the
      // debt (a ₦520,000 credit sale at Iwo Road would have paid out ₦520,000
      // the shop never received), and on a part-paid sale it both cut the debt
      // and paid the same value out again.
      const debtRelief = Math.min(saleDue, asked)
      const cashOut = record.outcome === "REFUND" ? Math.min(asked - debtRelief, salePaid) : 0
      const after = await shiftCustomerBalance(tx, record.customerId, -debtRelief)
      const next = Math.max(0, money(after.currentBalance))
      const invoiceRef = sale?.invoiceNumber ? ` on ${sale.invoiceNumber}` : ""
      // Each line says what really happened. A return on a sale nobody paid for
      // only clears the debt; it used to be written as a "Refund", which read as
      // money paid out to a customer who never paid.
      if (debtRelief > 0) {
        await tx.ledgerEntry.create({
          data: {
            customerId: record.customerId,
            type: "ADJUSTMENT",
            amount: (-debtRelief).toFixed(2),
            balance: next.toFixed(2),
            reference: record.returnNumber,
            description: `Returned: ${formatCurrency(debtRelief)} still owed${invoiceRef} cleared. No money paid out`,
          },
        })
      }
      if (cashOut > 0) {
        await tx.ledgerEntry.create({
          data: {
            customerId: record.customerId,
            type: "REFUND",
            amount: (-cashOut).toFixed(2),
            balance: next.toFixed(2),
            reference: record.returnNumber,
            description: `Refund paid to the customer by bank${invoiceRef}. Does not change what they owe`,
          },
        })
      }
      const creditLeft = record.outcome === "CREDIT_NOTE" ? Math.max(0, asked - debtRelief) : 0
      if (creditLeft > 0) {
        await tx.ledgerEntry.create({
          data: {
            customerId: record.customerId,
            type: "CREDIT_NOTE",
            amount: "0.00",
            balance: next.toFixed(2),
            reference: record.returnNumber,
            description: `Credit note for ${formatCurrency(creditLeft)}${invoiceRef}, to use on a later purchase`,
          },
        })
      }
      if (debtRelief <= 0 && cashOut <= 0 && creditLeft <= 0) {
        await tx.ledgerEntry.create({
          data: {
            customerId: record.customerId,
            type: "ADJUSTMENT",
            amount: "0.00",
            balance: next.toFixed(2),
            reference: record.returnNumber,
            description: `Returned${invoiceRef}. Nothing was owed and nothing was paid out`,
          },
        })
      }
      if (cashOut > 0) {
        await tx.financeEntry.create({
          data: {
            branchId: record.branchId,
            account: "BANK",
            type: "EXPENSE",
            amount: cashOut.toFixed(2),
            reference: record.returnNumber,
            description: `Refund to ${record.customer.name} from ${bankLabel}`,
            bankAccountId: refundBank?.id ?? null,
          },
        })
      }
    }

    if (record.outcome === "REPAIR" && record.imeiId) {
      await tx.repair.create({
        data: {
          repairNumber: generateDocNumber("RPR"),
          imeiId: record.imeiId,
          customerId: record.customerId,
          branchId: record.branchId,
          userId: user.id,
          issue: record.notes || record.reason,
          status: "PENDING",
        },
      })
      await tx.imeiRecord.update({ where: { id: record.imeiId }, data: { status: "FAULTY" } })
    }

    if (record.outcome === "SEND_TO_SUPPLIER" && record.imeiId && record.imei) {
      await tx.imeiRecord.update({
        where: { id: record.imeiId },
        data: {
          status: "RETURNED_TO_SUPPLIER",
          customerId: null,
          notes: [record.imei.notes, `Sent back to supplier on ${record.returnNumber}`].filter(Boolean).join(" · "),
        },
      })
      const sentBack = await applySupplierReturnMoney(tx, record.imei)
      await recordSupplierReturnLine(tx, {
        reference: record.returnNumber,
        supplierId: record.supplierId || record.imei.supplierId,
        branchId: record.branchId,
        imeiId: record.imeiId,
        productId: record.imei.productId,
        purchaseId: record.imei.purchaseId ?? null,
        cost: sentBack.cost,
        moneyEffect: sentBack.reason,
        source: "CUSTOMER_RETURN",
        userId: user.id,
      })
    }

    if (record.outcome === "REPLACEMENT") {
      const fresh = await tx.imeiRecord.findUnique({
        where: { id: replacementImeiId! },
        include: { product: true },
      })
      if (!fresh || fresh.status !== "IN_STOCK") {
        throw new ConflictError("Replacement must be In shop.")
      }
      if (fresh.branchId !== record.branchId) {
        throw new ConflictError("Replacement must be in the same shop.")
      }

      const returnValue = money(record.returnValue) || money(record.refundAmount) || (record.imei ? money(record.imei.product.sellingPrice) : 0)
      const replacementValue =
        record.replacementValue != null ? money(record.replacementValue) : money(fresh.product.sellingPrice)
      const balance = record.balanceAmount != null ? money(record.balanceAmount) : replacementValue - returnValue
      const receivable = Math.max(balance, 0)
      const payable = Math.max(-balance, 0)
      const collected = Math.min(Math.max(0, paidAmount), receivable || payable)

      await tx.stockReturn.update({
        where: { id: record.id },
        data: {
          replacementImeiId: fresh.id,
          replacementValue: replacementValue.toFixed(2),
          balanceAmount: balance.toFixed(2),
          returnValue: returnValue.toFixed(2),
          refundAmount: returnValue.toFixed(2),
        },
      })

      await claimImei(tx, {
        imeiId: fresh.id,
        branchId: fresh.branchId,
        label: fresh.imei1,
        data: { status: "SOLD", customerId: record.customerId, saleId: record.saleId },
      })
      await drawStock(tx, {
        productId: fresh.productId,
        branchId: fresh.branchId,
        quantity: 1,
        label: fresh.product.name,
        move: { kind: "REPLACEMENT_OUT", reference: record.returnNumber, userId: user.id },
      })
      if (record.imeiId) {
        await tx.imeiRecord.update({
          where: { id: record.imeiId },
          data: { status: record.faultClass === "GOOD_STOCK" ? "IN_STOCK" : "FAULTY", customerId: null, saleId: null },
        })
        if (record.faultClass === "GOOD_STOCK") {
          await returnStock(tx, {
            productId: record.imei!.productId,
            branchId: record.branchId,
            quantity: 1,
            move: { kind: "RETURN_IN", reference: record.returnNumber, userId: user.id },
          })
        }
      }

      if (receivable > 0 && collected > 0) {
        await tx.financeEntry.create({
          data: {
            branchId: record.branchId,
            account: method === "CASH" ? "CASH" : "BANK",
            type: "INCOME",
            amount: collected.toFixed(2),
            reference: record.returnNumber,
            description: `Return receivable · ${record.customer.name} · ${record.returnNumber}`,
            bankAccountId: method === "CASH" ? null : refundBank?.id ?? null,
          },
        })
      }
      const due = Math.max(receivable - collected, 0)
      if (due > 0) {
        const after = await shiftCustomerBalance(tx, record.customerId, due)
        await tx.ledgerEntry.create({
          data: {
            customerId: record.customerId,
            type: "SALE",
            amount: due.toFixed(2),
            balance: money(after.currentBalance).toFixed(2),
            reference: record.returnNumber,
            description: `Return receivable still owed · ${record.returnNumber}`,
          },
        })
      }
      if (payable > 0) {
        const payOut = collected > 0 ? Math.min(collected, payable) : payable
        await tx.financeEntry.create({
          data: {
            branchId: record.branchId,
            account: "BANK",
            type: "EXPENSE",
            amount: payOut.toFixed(2),
            reference: record.returnNumber,
            description: `Return payable to ${record.customer.name} from ${bankLabel} · ${record.returnNumber}`,
            bankAccountId: refundBank?.id ?? null,
          },
        })
      }
    }

    if (record.outcome !== "REPLACEMENT" && record.outcome !== "REPAIR" && record.outcome !== "SEND_TO_SUPPLIER" && record.imeiId) {
      await tx.imeiRecord.update({
        where: { id: record.imeiId },
        data: {
          status: record.faultClass === "GOOD_STOCK" ? "IN_STOCK" : record.faultClass === "SCRAP_STOCK" ? "DISPOSED" : "FAULTY",
          customerId: null,
        },
      })
      if (record.faultClass === "GOOD_STOCK") {
        await returnStock(tx, {
          productId: record.imei!.productId,
          branchId: record.branchId,
          quantity: 1,
          move: { kind: "RETURN_IN", reference: record.returnNumber, userId: user.id },
        })
      }
    }

    // ── Invoice-item (non-IMEI) stock adjustment on Apply ─────────────────
    // When the return was logged from an invoice line (accessories, cords, etc.)
    // and the item is going back onto the shelf, add its pieces back to stock.
    // Replacements included: the replacement step above puts back a returned
    // phone only, so a returned accessory swapped for another was lost.
    if (record.saleItemId && record.saleItem && !record.imeiId) {
      if (record.faultClass === "GOOD_STOCK") {
        // Parse quantity from notes: "Item: X · Qty: N · ..." or default 1
        const qtyMatch = record.notes?.match(/Qty:\s*(\d+)/)
        const returnQty = qtyMatch ? Number(qtyMatch[1]) : 1
        await returnStock(tx, {
          productId: record.saleItem.productId,
          branchId: record.branchId,
          quantity: returnQty,
          move: { kind: "RETURN_IN", reference: record.returnNumber, userId: user.id },
        })
      }
    }

    await tx.auditLog.create({
      data: {
        userId: user.id,
        action: "UPDATE",
        entityType: "Return",
        entityId: record.returnNumber,
        newValue: JSON.stringify({
          outcome: record.outcome,
          faultClass: record.faultClass,
          returnValue: record.returnValue,
          replacementValue: record.replacementValue,
          balanceAmount: record.balanceAmount,
        }),
        branchId: record.branchId,
      },
    })
  })
  } catch (error) {
    return { error: shopError(error, "Could not complete return.") }
  }

  // A return logged before approvals were dropped still has its request on
  // Needs approval. Applying it settles that request too.
  await prisma.approval.updateMany({
    where: { entityType: "Return", entityId: record.id, status: "PENDING" },
    data: { status: "APPROVED", approvedBy: user.id, approvedAt: new Date() },
  })
  refreshOps()
  return { success: true }
}

/**
 * Put a finished return's item back on the shelf, ready to sell.
 *
 * Returns used to be logged as faulty unless someone changed the condition
 * box, and an accessory refunded by a manager had no box at all, so returned
 * items sat on the damaged list or vanished from the count and never showed
 * in Shop stock. This puts one such return right, once.
 */
export async function restockReturn(formData: FormData) {
  const user = await requireUser()
  if (!(await can(user.role, "action.return"))) return { error: "You are not allowed to change a return. Ask the main admin." }
  const id = String(formData.get("id") || "")
  const record = await prisma.stockReturn.findUnique({
    where: { id },
    include: { imei: { include: { product: true } }, saleItem: { include: { product: true } } },
  })
  if (!record) return { error: "We could not find that return." }
  if (!(await canReachBranch(user, record.branchId))) return { error: OTHER_SHOP }
  if (record.status !== "COMPLETED") return { error: "Finish this return first (Apply); that puts it back in stock." }
  if (record.faultClass === "GOOD_STOCK") return { error: "This return is already back on the shelf." }
  if (record.outcome === "REPAIR" || record.outcome === "SEND_TO_SUPPLIER") {
    return { error: "This item went to repair or back to the supplier, so it is not in the shop to put on the shelf." }
  }
  if (record.imei && !["FAULTY", "DISPOSED", "RETURNED"].includes(record.imei.status)) {
    return { error: `${record.imei.imei1} is ${record.imei.status.replace(/_/g, " ").toLowerCase()} now, so it cannot be put back from this return.` }
  }
  const qtyMatch = record.notes?.match(/Qty:\s*(\d+)/)
  const pieces = record.saleItem && !record.imeiId ? (qtyMatch ? Number(qtyMatch[1]) : 1) : 0
  const productId = record.imei?.productId ?? record.saleItem?.productId
  if (!productId) return { error: "This return has no item to put back." }

  try {
    await prisma.$transaction(async (tx) => {
      const sealed = await tx.stockReturn.updateMany({
        where: { id, faultClass: { not: "GOOD_STOCK" } },
        data: { faultClass: "GOOD_STOCK" },
      })
      if (sealed.count !== 1) throw new ConflictError("Someone already put this return back on the shelf.")
      if (record.imeiId) {
        await tx.imeiRecord.update({
          where: { id: record.imeiId },
          data: { status: "IN_STOCK", customerId: null, cosmeticGrade: record.imei?.cosmeticGrade === "FAULTY" ? null : record.imei?.cosmeticGrade },
        })
      }
      await returnStock(tx, {
        productId,
        branchId: record.branchId,
        quantity: record.imeiId ? 1 : pieces,
        move: { kind: "RETURN_IN", reference: record.returnNumber, userId: user.id },
      })
      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: "UPDATE",
          entityType: "Return",
          entityId: record.returnNumber,
          oldValue: JSON.stringify({ faultClass: record.faultClass }),
          newValue: JSON.stringify({ faultClass: "GOOD_STOCK", backOnShelf: record.imeiId ? record.imei?.imei1 : `${pieces} piece(s)` }),
          branchId: record.branchId,
        },
      })
    })
  } catch (error) {
    return { error: shopError(error, "Could not put this return back on the shelf.") }
  }
  refreshOps()
  return { success: true }
}

export async function getSwaps() {
  const user = await requireUser()
  const branchId = await viewBranchFilter(user)
  const rows = await prisma.swap.findMany({
    where: branchId ? { branchId } : undefined,
    include: {
      customer: true,
      oldImei: { include: { product: { include: { brand: true } } } },
      newImei: { include: { product: true } },
      newProduct: true,
      branch: true,
      user: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
  })
  const invoices = await prisma.sale.findMany({
    where: { notes: { contains: "Swap " } },
    select: {
      id: true,
      invoiceNumber: true,
      notes: true,
      user: { select: { name: true } },
      payments: {
        select: { amount: true, method: true, reference: true, bankAccount: { select: { bankName: true, accountNumber: true } } },
      },
    },
  })
  // Money paid out to a customer on a swap is not a payment on the invoice; it
  // is written to the money ledger under the invoice number.
  const payouts = await prisma.financeEntry.findMany({
    where: { reference: { in: invoices.map((sale) => sale.invoiceNumber) }, type: "EXPENSE" },
    select: { reference: true, amount: true, account: true, bankAccount: { select: { bankName: true, accountNumber: true } } },
  })
  const approvers = await prisma.user.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.approvedBy).filter((id): id is string => Boolean(id)))] } },
    select: { id: true, name: true },
  })
  const approverName = new Map(approvers.map((row) => [row.id, row.name]))
  const bankWords = (bank: { bankName: string; accountNumber: string } | null) => (bank ? `${bank.bankName} ${bank.accountNumber}` : null)

  return rows.map((row) => {
    const invoice = invoices.find((sale) => sale.notes?.includes(row.swapNumber)) ?? null
    const money_: Array<{ direction: "in" | "out"; amount: number; channel: string; bank: string | null; reference: string | null }> = []
    for (const payment of invoice?.payments ?? []) {
      money_.push({
        direction: "in",
        amount: money(payment.amount),
        channel: payment.method === "CASH" ? "Cash" : "Bank",
        bank: bankWords(payment.bankAccount),
        reference: payment.reference,
      })
    }
    for (const out of payouts.filter((entry) => entry.reference === invoice?.invoiceNumber)) {
      money_.push({
        direction: "out",
        amount: money(out.amount),
        channel: out.account === "CASH" ? "Cash" : "Bank",
        bank: bankWords(out.bankAccount),
        reference: null,
      })
    }
    return {
      ...row,
      invoice: invoice ? { id: invoice.id, invoiceNumber: invoice.invoiceNumber } : null,
      startedBy: row.user?.name ?? null,
      approvedByName: row.approvedBy ? approverName.get(row.approvedBy) ?? null : null,
      settledBy: invoice?.user?.name ?? null,
      money: money_,
    }
  })
}

type SwapInSpec = {
  name: string
  brand: string
  category: string
  storage: string | null
  ram: string | null
  color: string | null
  condition: ProductCondition
  tracking: "IMEI" | "SERIAL"
  tradeValue: number
}

/**
 * The item the customer's phone goes onto. The same model, brand, storage and
 * condition reuses the name already on the price list; anything new is added,
 * priced at the swap value until someone sets its selling price.
 */
async function resolveSwapInProduct(spec: SwapInSpec) {
  const lower = (value: string) => value.trim().toLowerCase()
  const candidates = await prisma.product.findMany({
    where: { isActive: true, condition: spec.condition, storage: spec.storage, tracking: spec.tracking },
    include: { brand: true },
  })
  const hit = candidates.find(
    (row) => lower(row.name) === lower(spec.name) && lower(row.brand.name) === lower(spec.brand)
  )
  if (hit) return { productId: hit.id, created: false }

  const brands = await prisma.brand.findMany({ select: { id: true, name: true } })
  const brandId =
    brands.find((row) => lower(row.name) === lower(spec.brand))?.id ??
    (await prisma.brand.create({ data: { name: spec.brand } })).id
  const categories = await prisma.category.findMany({ select: { id: true, name: true } })
  const categoryId =
    categories.find((row) => lower(row.name) === lower(spec.category))?.id ??
    (await prisma.category.create({ data: { name: spec.category } })).id

  const base = makeOpeningSku({ brand: spec.brand, name: spec.name, storage: spec.storage || "", condition: spec.condition })
  let sku = base
  for (let n = 2; await prisma.product.findUnique({ where: { sku }, select: { id: true } }); n += 1) {
    sku = `${base.slice(0, 56)}-${n}`
  }
  const price = Math.max(0, spec.tradeValue).toFixed(2)
  const created = await prisma.product.create({
    data: {
      sku,
      name: spec.name,
      brandId,
      categoryId,
      condition: spec.condition,
      storage: spec.storage,
      ram: spec.ram,
      color: spec.color,
      tracking: spec.tracking,
      costPrice: price,
      minimumPrice: price,
      sellingPrice: price,
      warrantyDays: 0,
      description: "Added from a Swap Deal. Set the selling price on Phones & items.",
    },
  })
  const shops = await prisma.branch.findMany({ where: { isActive: true }, select: { id: true } })
  await prisma.inventory.createMany({
    data: shops.map((shop) => ({ productId: created.id, branchId: shop.id, quantity: 0 })),
  })
  return { productId: created.id, created: true }
}

export async function createSwap(formData: FormData) {
  const user = await requireUser()
  if (!(await can(user.role, "action.swap"))) return { error: "You are not allowed to record a swap. Ask the main admin." }

  const branchId = String(formData.get("branchId") || user.branchId || "")
  const existingCustomerId = String(formData.get("customerId") || "").trim()
  const customerName = String(formData.get("customerName") || "").trim()
  const customerPhone = String(formData.get("customerPhone") || "").trim()
  const oldDeviceId = cleanDeviceId(String(formData.get("oldDeviceId") || formData.get("oldImei1") || ""))
  const oldIdentityKind: UnitIdentityKind =
    String(formData.get("oldIdentityKind") || (looksLikeImei(oldDeviceId) ? "IMEI" : "SERIAL")).toUpperCase() === "SERIAL"
      ? "SERIAL"
      : "IMEI"
  const oldImei2 = cleanDeviceId(String(formData.get("oldImei2") || ""))
  const oldName = String(formData.get("oldProductName") || "").trim().replace(/\s+/g, " ")
  const oldBrand = String(formData.get("oldBrand") || "").trim()
  const oldCategory = String(formData.get("oldCategory") || "").trim() || "Phones"
  const oldStorage = normalizeStorage(String(formData.get("oldStorage") || "")) || null
  const oldRam = String(formData.get("oldRam") || "").trim() || null
  const oldColor = String(formData.get("oldColor") || "").trim() || null
  const oldConditionNotes = String(formData.get("oldConditionNotes") || "").trim() || null
  const newDeviceId = cleanDeviceId(String(formData.get("newDeviceId") || formData.get("newImei1") || ""))
  const newImeiId = String(formData.get("newImeiId") || "")
  let oldProductId = String(formData.get("oldProductId") || "")
  const tradeValue = Number(formData.get("tradeValue") || 0)
  const givenRaw = formData.get("givenValue")
  const condition = parseShopCondition(String(formData.get("oldDeviceCondition") || ""))

  if (!branchId) return { error: "Pick the shop for this Swap Deal." }
  if (!existingCustomerId && (!customerName || !customerPhone)) {
    return { error: "Pick a customer on the list, or type the customer name and phone." }
  }
  const oldCodeProblem = unitCodeProblem(oldIdentityKind, oldDeviceId)
  if (oldCodeProblem) return { error: `Customer's phone: ${oldCodeProblem}` }
  if (oldIdentityKind === "IMEI" && oldImei2) {
    const imei2Problem = unitCodeProblem("IMEI", oldImei2)
    if (imei2Problem) return { error: `Customer's phone IMEI 2: ${imei2Problem}` }
  }
  if (!newImeiId && newDeviceId.length < 5) return { error: "Scan or type the shop device IMEI or serial number going out." }
  if (!condition) return { error: "Pick the condition of the customer's phone." }
  if (!oldProductId) {
    if (!oldName) return { error: "Type the name of the customer's phone, for example iPhone 12 Pro." }
    if (!oldBrand) return { error: "Type the brand of the customer's phone, for example Apple or Samsung." }
    if (!oldStorage) return { error: "Pick the storage of the customer's phone." }
  }
  if (!Number.isFinite(tradeValue) || tradeValue < 0) return { error: "Enter the value of the swap-in item." }

  const scoped = await scopedBranchId(user.role, user.branchId)
  if (scoped && branchId !== scoped) return { error: "You can only record a swap for your own shop." }

  let customer = existingCustomerId
    ? await prisma.customer.findUnique({ where: { id: existingCustomerId } })
    : customerPhone
      ? await prisma.customer.findUnique({ where: { phone: customerPhone } })
      : null

  if (!customer) {
    if (!customerName || !customerPhone) {
      return { error: "Pick a customer on the list, or type the customer name and phone." }
    }
    customer = await prisma.customer.create({
      data: { name: customerName, phone: customerPhone, branchId },
    })
  } else if (!existingCustomerId && customerName && customer.name !== customerName) {
    return { error: `Phone ${customerPhone} already belongs to ${customer.name}. Pick them from the list.` }
  }
  if (scoped && customer.branchId !== scoped && customer.branchId !== branchId) {
    return { error: "That customer belongs to another shop." }
  }

  const oldCodes = [oldDeviceId, ...(oldIdentityKind === "IMEI" && oldImei2 ? [oldImei2] : [])]
  const exists = await prisma.imeiRecord.findFirst({
    where: {
      OR: [{ imei1: { in: oldCodes } }, { imei2: { in: oldCodes } }, { serialNumber: { in: oldCodes } }],
    },
  })
  if (exists) return { error: "That IMEI or serial number is already on this system." }

  const newImei = newImeiId
    ? await prisma.imeiRecord.findUnique({
        where: { id: newImeiId },
        include: { product: true },
      })
    : await prisma.imeiRecord.findFirst({
        where: {
          status: "IN_STOCK",
          branchId,
          OR: [{ imei1: newDeviceId }, { serialNumber: newDeviceId }],
        },
        include: { product: true },
      })
  if (!newImei || newImei.status !== "IN_STOCK") return { error: "That shop device is not In shop." }
  if (newImei.branchId !== branchId) return { error: "That device is not in the selected shop." }

  const reservedTransfer = await reservedTransferImeiSet(branchId)
  const reservedSwap = await reservedSwapImeiSet(branchId)
  if (
    reservedTransfer.has(newImei.imei1) ||
    (newImei.serialNumber && reservedTransfer.has(newImei.serialNumber))
  ) {
    return { error: "That shop device is on a shop-to-shop transfer waiting for accept or reject." }
  }
  if (
    reservedSwap.has(newImei.imei1) ||
    (newImei.serialNumber && reservedSwap.has(newImei.serialNumber))
  ) {
    return { error: "That shop device is already on another Swap Deal waiting for approval." }
  }

  const givenValue =
    givenRaw !== null && String(givenRaw).trim() !== ""
      ? Number(givenRaw)
      : money(newImei.product.sellingPrice)
  if (!Number.isFinite(givenValue) || givenValue < 0) {
    return { error: "Enter the value of the shop item given out." }
  }
  const balance = givenValue - tradeValue

  if (!oldProductId) {
    const resolved = await resolveSwapInProduct({
      name: oldName,
      brand: oldBrand,
      category: oldCategory,
      storage: oldStorage,
      ram: oldRam,
      color: oldColor,
      condition,
      tracking: oldIdentityKind,
      tradeValue,
    })
    oldProductId = resolved.productId
  }
  const swapInLabel = [oldBrand, oldName, oldStorage, shopConditionLabel(condition), oldColor].filter(Boolean).join(" · ")

  // Hold only: swap-in stays off the shelf, shop device stays In shop until approval.
  const incoming = await prisma.imeiRecord.create({
    data: {
      ...unitIdentityColumns({ kind: oldIdentityKind, imei1: oldDeviceId, imei2: oldImei2 }),
      productId: oldProductId,
      branchId,
      customerId: customer.id,
      status: "RECEIVED",
      cosmeticGrade: condition,
      conditionNotes: [oldColor ? `Colour ${oldColor}` : null, oldConditionNotes].filter(Boolean).join(" · ") || null,
      notes: `Swap Deal waiting for approval · ${swapInLabel || shopConditionLabel(condition)} · swap value ${tradeValue}`,
    },
  })

  const swap = await prisma.swap.create({
    data: {
      swapNumber: generateDocNumber("SWP"),
      customerId: customer.id,
      oldImeiId: incoming.id,
      oldDeviceCondition: condition,
      tradeValue: tradeValue.toFixed(2),
      newProductId: newImei.productId,
      newProductPrice: givenValue.toFixed(2),
      newImeiId: newImei.id,
      balanceAmount: balance.toFixed(2),
      branchId,
      userId: user.id,
      status: "PENDING",
      notes: String(formData.get("notes") || "") || null,
    },
  })
  await prisma.approval.create({
    data: {
      type: "SWAP",
      entityId: swap.id,
      entityType: "Swap",
      requestedBy: user.id,
      reason: `${swap.swapNumber}: ${swapInLabel ? `${swapInLabel} (${oldDeviceId}) ` : ""}swap-in ₦${tradeValue} · given ₦${givenValue} · ${
        balance > 0 ? `Receivable ₦${balance}` : balance < 0 ? `Payable ₦${Math.abs(balance)}` : "Even"
      } · ${newImei.product.name}`,
    },
  })
  const managers = await prisma.user.findMany({
    where: { role: { in: ["CEO", "BRANCH_MANAGER", "SUPER_ADMIN"] }, isActive: true },
  })
  for (const manager of managers) {
    await notify(manager.id, "A Swap Deal is waiting for approval", swap.swapNumber, "/approvals", "APPROVAL_REQUEST")
  }
  refreshOps()
  return { success: true }
}

/**
 * After Needs approval says yes: swap-in hits In shop, shop device leaves.
 * After no: cancel the hold and remove the pending swap-in record.
 */
export async function applySwapApprovalDecision(
  swapId: string,
  status: "APPROVED" | "REJECTED",
  _callerUserId?: string
) {
  // Exported from a server-actions file, so it is a public endpoint of its own.
  // It used to trust whoever called it and the userId they passed: anyone who
  // reached it could approve or reject a Swap Deal in another person's name.
  // The signed-in person is the decider, and they must be allowed to decide.
  const actor = await requireUser()
  if (!(await canApprove(actor.role))) return { error: "You are not allowed to say yes or no to a Swap Deal." }
  const userId = actor.id
  const swap = await prisma.swap.findUnique({
    where: { id: swapId },
    include: { customer: true, newProduct: true, oldImei: true, newImei: true },
  })
  if (!swap) return { error: "We could not find that Swap Deal." }
  if (!(await canReachBranch(actor, swap.branchId))) return { error: OTHER_SHOP }
  if (swap.status !== "PENDING") return { error: "Somebody has already decided on this Swap Deal." }

  try {
    await prisma.$transaction(async (tx) => {
      if (status === "REJECTED") {
        await tx.swap.update({
          where: { id: swap.id },
          data: { status: "REJECTED", approvedBy: userId, approvedAt: new Date() },
        })
        await tx.imeiRecord.update({
          where: { id: swap.oldImeiId },
          data: {
            status: "DISPOSED",
            customerId: null,
            notes: `Swap Deal rejected · ${swap.swapNumber}`,
          },
        })
        await tx.auditLog.create({
          data: {
            userId,
            action: "REJECT",
            entityType: "Swap",
            entityId: swap.swapNumber,
            newValue: JSON.stringify({ status: "REJECTED" }),
            branchId: swap.branchId,
          },
        })
        return
      }

      if (!swap.newImeiId) throw new ConflictError("This Swap Deal has no shop device going out.")

      await claimImei(tx, {
        imeiId: swap.newImeiId,
        branchId: swap.branchId,
        label: "The shop device on this Swap Deal",
        data: {
          status: "SWAPPED",
          customerId: swap.customerId,
          notes: `Left on Swap Deal ${swap.swapNumber}`,
        },
      })
      await drawStock(tx, {
        move: { kind: "SWAP_OUT", reference: swap.swapNumber, userId },
        productId: swap.newProductId,
        branchId: swap.branchId,
        quantity: 1,
        label: swap.newProduct.name,
      })
      await tx.imeiRecord.update({
        where: { id: swap.oldImeiId },
        data: {
          status: "IN_STOCK",
          customerId: null,
          notes: `Swap Deal from ${swap.customer.name} · ${swap.swapNumber}`,
        },
      })
      await returnStock(tx, {
        productId: swap.oldImei.productId,
        branchId: swap.branchId,
        quantity: 1,
        move: { kind: "SWAP_IN", reference: swap.swapNumber, userId },
      })

      await tx.swap.update({
        where: { id: swap.id },
        data: { status: "APPROVED", approvedBy: userId, approvedAt: new Date() },
      })
      await tx.auditLog.create({
        data: {
          userId,
          action: "APPROVE",
          entityType: "Swap",
          entityId: swap.swapNumber,
          newValue: JSON.stringify({
            status: "APPROVED",
            stockIn: swap.oldImei.imei1,
            stockOut: swap.newImei?.imei1 ?? null,
          }),
          branchId: swap.branchId,
        },
      })
    })
  } catch (error) {
    return { error: shopError(error, "Could not apply this Swap Deal decision.") }
  }

  refreshOps()
  return { success: true }
}

export async function completeSwap(formData: FormData) {
  const user = await requireUser()
  return finishSwap(user, formData)
}

/** Write a Swap Deal's invoice and money. Used by Settle and invoice, and by a return of its phone. */
async function finishSwap(user: Awaited<ReturnType<typeof requireUser>>, formData: FormData) {
  const id = String(formData.get("id"))
  const paid = Number(formData.get("paidAmount") || 0)
  // A Swap Deal is settled in cash or by bank transfer. By transfer, the named
  // bank account the money went into, or came out of, is picked.
  const method = (String(formData.get("method") || "TRANSFER") === "CASH" ? "CASH" : "TRANSFER") as PaymentMethod
  const bankAccountId = String(formData.get("bankAccountId") || "").trim()
  // The transfer description or POS code, so the money can be matched to the
  // bank statement like any other bank payment.
  const paymentReference = String(formData.get("paymentReference") || "").trim() || null
  const swap = await prisma.swap.findUnique({
    where: { id },
    include: { customer: true, newProduct: true, oldImei: true, newImei: true },
  })
  if (!swap || !swap.newImeiId) return { error: "We could not find that swap." }
  if (!(await canReachBranch(user, swap.branchId))) return { error: OTHER_SHOP }
  if (swap.status === "COMPLETED") return { error: "That swap is already finished." }
  if (swap.status !== "APPROVED") {
    return { error: "Wait for approval on Needs approval before settling the money." }
  }
  // Approval already moved both phones. Finishing then only writes the invoice
  // and the money, which has nothing to do with the opening count, so it must
  // not wait for it: Iwo Road's first swap sat approved for days, phone gone,
  // money unrecorded, because this check refused it while opening stock was
  // open. Only the old path that still moves stock here waits for the count.
  const movesStockHere = swap.oldImei.status === "RECEIVED" || swap.newImei?.status === "IN_STOCK"
  if (movesStockHere) {
    const opening = await prisma.openingStock.findUnique({ where: { branchId: swap.branchId }, select: { status: true } })
    if (opening?.status === "OPEN") {
      return { error: "This shop's opening stock is still being counted. Finish the swap once it is closed." }
    }
  }

  const invoiceNumber = generateDocNumber("INV")
  const balance = money(swap.balanceAmount)
  const receivable = Math.max(balance, 0)
  const payable = Math.max(-balance, 0)
  const collected = Math.min(Math.max(0, paid), receivable || payable)
  const payChannel = shopPayChannel(method)
  const movesMoney = (receivable > 0 && collected > 0) || payable > 0
  const swapBank =
    payChannel !== "CASH" && movesMoney && bankAccountId
      ? await prisma.bankAccount.findFirst({ where: { id: bankAccountId, isActive: true } })
      : null
  if (payChannel !== "CASH" && movesMoney && !swapBank) {
    return { error: "Pick the bank account the money went into or came out of." }
  }
  if (payChannel !== "CASH" && movesMoney && !paymentReference) {
    return { error: "Type the payment reference (transfer description or POS code) so this can be matched to the bank." }
  }
  const swapBankLabel = swapBank ? ` · ${swapBank.bankName} ${swapBank.accountNumber}` : ""
  if (payable > 0 && payChannel === "CASH") {
    const payOut = collected > 0 ? Math.min(collected, payable) : payable
    const cashGate = await assertCashAvailable(swap.branchId, payOut)
    if (!cashGate.ok) return { error: cashGate.error }
  }

  let invoice: { id: string }
  try {
  invoice = await prisma.$transaction(async (tx) => {
    const sealed = await tx.swap.updateMany({
      where: { id, status: "APPROVED" },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        notes: [swap.notes, `Invoice ${invoiceNumber}`].filter(Boolean).join(" · "),
      },
    })
    if (sealed.count !== 1) {
      throw new ConflictError(`${swap.swapNumber} was already completed by someone else. Refresh to see it.`)
    }

    // Legacy path: older swaps may still have stock waiting if approval only flipped status.
    if (swap.oldImei.status === "RECEIVED") {
      await tx.imeiRecord.update({
        where: { id: swap.oldImeiId },
        data: {
          status: "IN_STOCK",
          customerId: null,
          notes: `Swap Deal from ${swap.customer.name} · ${swap.swapNumber}`,
        },
      })
      await returnStock(tx, {
        productId: swap.oldImei.productId,
        branchId: swap.branchId,
        quantity: 1,
        move: { kind: "SWAP_IN", reference: swap.swapNumber, userId: user.id },
      })
    }
    if (swap.newImei?.status === "IN_STOCK") {
      await claimImei(tx, {
        imeiId: swap.newImeiId!,
        branchId: swap.branchId,
        label: "The shop device on this Swap Deal",
        data: { status: "SOLD", customerId: swap.customerId },
      })
      await drawStock(tx, {
        move: { kind: "SWAP_OUT", reference: swap.swapNumber, userId: user.id },
        productId: swap.newProductId,
        branchId: swap.branchId,
        quantity: 1,
        label: swap.newProduct.name,
      })
    } else {
      await tx.imeiRecord.update({
        where: { id: swap.newImeiId! },
        data: { status: "SOLD", customerId: swap.customerId },
      })
    }

    const sale = await tx.sale.create({
      data: {
        invoiceNumber,
        branchId: swap.branchId,
        userId: user.id,
        customerId: swap.customerId,
        saleType: "RETAIL",
        status: "COMPLETED",
        subtotal: receivable.toFixed(2),
        // The trade-in is already taken off on the line below. Taking it off
        // the invoice again made subtotal less discount disagree with the total.
        discount: "0.00",
        totalAmount: receivable.toFixed(2),
        paidAmount: receivable > 0 ? collected.toFixed(2) : "0.00",
        paymentMethod: receivable > 0 && collected < receivable ? "CREDIT" : method,
        notes: `Swap ${swap.swapNumber}`,
        items: {
          create: {
            productId: swap.newProductId,
            imeiId: swap.newImeiId,
            quantity: 1,
            unitPrice: money(swap.newProductPrice).toFixed(2),
            discount: money(swap.tradeValue).toFixed(2),
            totalPrice: receivable.toFixed(2),
            // Profit everywhere is line amount less line cost. The line only
            // carries what the customer pays in money; the rest of the price
            // was paid with the phone they traded in, which goes onto the shelf
            // as stock. So the cost here is the new phone's cost less that
            // part, and the profit comes out as price less cost, as for any
            // sale. Left at 0, the whole balance read as profit.
            costPrice: (money(swap.newProduct.costPrice) - (money(swap.newProductPrice) - receivable)).toFixed(2),
          },
        },
        payments:
          receivable > 0 && collected > 0
            ? { create: { amount: collected.toFixed(2), method, bankAccountId: swapBank?.id ?? null, reference: payChannel === "CASH" ? null : paymentReference } }
            : undefined,
      },
    })

    await tx.imeiRecord.update({
      where: { id: swap.newImeiId! },
      data: { saleId: sale.id },
    })

    const due = Math.max(receivable - collected, 0)
    if (due > 0) {
      const after = await shiftCustomerBalance(tx, swap.customerId, due)
      await tx.ledgerEntry.create({
        data: {
          customerId: swap.customerId,
          type: "SALE",
          amount: due.toFixed(2),
          balance: money(after.currentBalance).toFixed(2),
          reference: invoiceNumber,
          description: `Swap receivable ${swap.swapNumber}`,
        },
      })
    }
    if (receivable > 0 && collected > 0) {
      await tx.financeEntry.create({
        data: {
          branchId: swap.branchId,
          account: payChannel === "CASH" ? "CASH" : "BANK",
          type: "INCOME",
          amount: collected.toFixed(2),
          reference: invoiceNumber,
          description: `Swap receivable ${swap.swapNumber}${swapBankLabel}${paymentReference ? ` · ref ${paymentReference}` : ""}`,
          bankAccountId: swapBank?.id ?? null,
        },
      })
    }
    if (payable > 0) {
      const payOut = collected > 0 ? Math.min(collected, payable) : payable
      await tx.financeEntry.create({
        data: {
          branchId: swap.branchId,
          account: payChannel === "CASH" ? "CASH" : "BANK",
          type: "EXPENSE",
          amount: payOut.toFixed(2),
          reference: invoiceNumber,
          description: `Swap payable to ${swap.customer.name} · ${swap.swapNumber}${swapBankLabel}${paymentReference ? ` · ref ${paymentReference}` : ""}`,
          bankAccountId: swapBank?.id ?? null,
        },
      })
    }

    await tx.auditLog.create({
      data: {
        userId: user.id,
        action: "UPDATE",
        entityType: "Swap",
        entityId: swap.swapNumber,
        newValue: JSON.stringify({ invoiceNumber, collected, receivable, payable }),
        branchId: swap.branchId,
      },
    })
    return sale
  })
  } catch (error) {
    return { error: shopError(error, "Could not complete this swap.") }
  }

  refreshOps()
  return { success: true, redirectTo: `/sales/${invoice.id}` }
}

export async function getRepairs() {
  const user = await requireUser()
  const branchId = await viewBranchFilter(user)
  return prisma.repair.findMany({
    where: branchId ? { branchId } : undefined,
    include: { imei: { include: { product: true } }, customer: true, branch: true, user: { select: { id: true, name: true, email: true, role: true, branchId: true } } },
    orderBy: { createdAt: "desc" },
  })
}

export async function createRepair(formData: FormData) {
  const user = await requireUser()
  if (!(await can(user.role, "action.repair"))) return { error: "You are not allowed to open a repair. Ask the main admin." }
  const imei1 = String(formData.get("imei1") ?? "").trim()
  const imei = await prisma.imeiRecord.findUnique({ where: { imei1 } })
  if (!imei) return { error: "We could not find that IMEI." }
  if (["SOLD", "IN_STOCK", "RETURNED", "REPAIRED"].includes(imei.status) === false) {
    return { error: `${imei1} cannot go on the bench from ${imei.status}.` }
  }

  await prisma.$transaction(async (tx) => {
    await tx.repair.create({
      data: {
        repairNumber: generateDocNumber("RPR"),
        imeiId: imei.id,
        customerId: imei.customerId,
        branchId: imei.branchId,
        userId: user.id,
        issue: String(formData.get("issue") || "Diagnosis required"),
        notes: String(formData.get("notes") || "") || null,
      },
    })
    await tx.imeiRecord.update({ where: { id: imei.id }, data: { status: "FAULTY" } })
    if (imei.status === "IN_STOCK") {
      await tx.inventory.update({
        where: { productId_branchId: { productId: imei.productId, branchId: imei.branchId } },
        data: { quantity: { decrement: 1 } },
      })
      await recordMovement(tx, {
        productId: imei.productId,
        branchId: imei.branchId,
        quantity: -1,
        move: { kind: "REPAIR_OUT", reference: imei1, userId: user.id },
      })
    }
    await tx.auditLog.create({
      data: {
        userId: user.id,
        action: "CREATE",
        entityType: "Repair",
        entityId: imei1,
        oldValue: imei.status,
        newValue: "FAULTY",
        branchId: imei.branchId,
      },
    })
  })
  refreshOps()
  return { success: true }
}

export async function advanceRepair(formData: FormData) {
  const user = await requireUser()
  const id = String(formData.get("id"))
  const status = String(formData.get("status")) as RepairStatus
  const repair = await prisma.repair.findUnique({
    where: { id },
    include: { customer: true, imei: { include: { product: true } } },
  })
  if (!repair) return { error: "We could not find that repair." }
  if (!(await canReachBranch(user, repair.branchId))) return { error: OTHER_SHOP }

  const nextCost = formData.get("repairCost") ? Number(formData.get("repairCost")) : money(repair.repairCost)
  const closing = status === "COMPLETED" || status === "DELIVERED"

  try {
  await prisma.$transaction(async (tx) => {
    // Only move the job on from the state this screen was showing. A second
    // click on Delivered used to charge the customer again and put the phone
    // back on the shelf a second time.
    const advanced = await tx.repair.updateMany({
      where: { id, status: repair.status },
      data: {
        status,
        diagnosis: String(formData.get("diagnosis") || repair.diagnosis || "") || null,
        repairCost: nextCost ? nextCost.toFixed(2) : repair.repairCost,
        completedAt: closing ? new Date() : repair.completedAt,
      },
    })
    if (advanced.count !== 1) {
      throw new ConflictError(`${repair.repairNumber} was already moved on by someone else. Refresh to see where it is now.`)
    }

    if (closing) {
      const shopUnit = !repair.customerId
      await tx.imeiRecord.update({
        where: { id: repair.imeiId },
        data: {
          status: shopUnit && status === "DELIVERED" ? "IN_STOCK" : "REPAIRED",
        },
      })
      if (shopUnit && status === "DELIVERED") {
        await returnStock(tx, {
          productId: repair.imei.productId,
          branchId: repair.branchId,
          quantity: 1,
          move: { kind: "REPAIR_IN", reference: repair.repairNumber, userId: user.id },
        })
      }
      if (status === "DELIVERED" && repair.customerId && nextCost > 0 && repair.status !== "DELIVERED") {
        const after = await shiftCustomerBalance(tx, repair.customerId, nextCost)
        await tx.ledgerEntry.create({
          data: {
            customerId: repair.customerId,
            type: "SALE",
            amount: nextCost.toFixed(2),
            balance: money(after.currentBalance).toFixed(2),
            reference: repair.repairNumber,
            description: `Repair ${repair.repairNumber} · ${repair.imei.product.name}`,
          },
        })
        await tx.financeEntry.create({
          data: {
            branchId: repair.branchId,
            account: "CASH",
            type: "INCOME",
            amount: nextCost.toFixed(2),
            reference: repair.repairNumber,
            description: `Repair charge ${repair.repairNumber}`,
          },
        })
      }
    }

    await tx.auditLog.create({
      data: {
        userId: user.id,
        action: "UPDATE",
        entityType: "Repair",
        entityId: repair.repairNumber,
        oldValue: repair.status,
        newValue: JSON.stringify({ status, cost: nextCost }),
        branchId: repair.branchId,
      },
    })
  })
  } catch (error) {
    return { error: shopError(error, "Could not move this repair on.") }
  }
  refreshOps()
  if (repair.customerId) revalidatePath(`/customers/${repair.customerId}`)
  return { success: true }
}

export async function getTransfers() {
  const user = await requireUser()
  const branchId = await viewBranchFilter(user)
  const rows = await prisma.stockTransfer.findMany({
    where: branchId
      ? { OR: [{ fromBranchId: branchId }, { toBranchId: branchId }] }
      : undefined,
    include: {
      fromBranch: true,
      toBranch: true,
      user: { select: { id: true, name: true, email: true, role: true, branchId: true } },
      receivedByUser: { select: { id: true, name: true, email: true } },
      items: { include: { product: true } },
    },
    orderBy: { createdAt: "desc" },
  })
  // Who accepted or rejected each closed transfer. Saved on the transfer since
  // the receiving shop's name went on the page; older ones are read from the
  // accept or reject line in Who did what.
  const undecided = rows.filter((row) => !row.receivedByUserId && (row.status === "RECEIVED" || row.status === "CANCELLED"))
  const decidedEarlier = undecided.length
    ? await prisma.auditLog.findMany({
        where: {
          entityType: "StockTransfer",
          action: "UPDATE",
          entityId: { in: undecided.map((row) => row.transferNumber) },
          OR: [{ newValue: { contains: '"RECEIVED"' } }, { newValue: { contains: '"CANCELLED"' } }],
        },
        select: { entityId: true, createdAt: true, user: { select: { name: true, email: true } } },
        orderBy: { createdAt: "asc" },
      })
    : []
  const deciderFromTrail = new Map<string, string>()
  for (const entry of decidedEarlier) {
    const who = entry.user?.name || entry.user?.email
    if (entry.entityId && who) deciderFromTrail.set(entry.entityId, who)
  }

  const serials = rows.flatMap((row) => parseTransferIds(row.notes ?? ""))
  const records = serials.length
    ? await prisma.imeiRecord.findMany({
        where: { OR: [{ imei1: { in: serials } }, { serialNumber: { in: serials } }] },
        include: { product: true },
      })
    : []
  return rows.map((row) => {
    const arrived = parseLabelledIds(row.notes ?? "", "Arrived")
    return {
      ...row,
      imeis: parseTransferIds(row.notes ?? "")
        .map((code) => records.find((item) => item.imei1 === code || item.serialNumber === code))
        .filter((item): item is (typeof records)[number] => Boolean(item)),
      /** Phones accepted at the receiving shop, for a transfer that was accepted in part. */
      arrivedImeis: row.status === "RECEIVED" && /\nArrived:|\nStayed at /.test(row.notes ?? "") ? arrived : null,
      /** Why it was turned back, written by whoever rejected it. */
      rejectedBecause: (row.notes ?? "").split("\n").find((line) => line.startsWith("Rejected: "))?.slice("Rejected: ".length) ?? null,
      /** Who sent it. */
      sentBy: row.user?.name || row.user?.email || null,
      /**
       * Who decided it at the receiving shop: accepted it (RECEIVED) or turned
       * it back (CANCELLED). Null while it waits.
       */
      receivedBy:
        row.receivedByUser?.name ||
        row.receivedByUser?.email ||
        (row.status === "RECEIVED" || row.status === "CANCELLED" ? deciderFromTrail.get(row.transferNumber) ?? null : null),
    }
  })
}

type TransferOutcome = { error?: string; errors?: string[]; success?: boolean }

export async function createTransfer(formData: FormData): Promise<TransferOutcome> {
  const user = await requireUser()
  let outcome: TransferOutcome
  try {
    outcome = await submitTransfer(formData)
  } catch (error) {
    outcome = { error: shopError(error, "Could not submit this transfer. Nothing left the shop.") }
  }
  // A refused transfer used to leave no trace: only the person at the screen
  // ever saw why. It goes into Who did what with the reason, so a shop that
  // cannot send stock can be put right without guessing.
  if (outcome.error) {
    const picked = String(formData.get("selectedImeis") || "").split(/[\s,;]+/).filter(Boolean).length
    await writeAudit({
      userId: user.id,
      action: "CREATE",
      entityType: "StockTransfer",
      entityId: "Refused",
      newValue: JSON.stringify({
        reason: outcome.error,
        reasons: outcome.errors?.slice(0, 10),
        fromBranchId: String(formData.get("fromBranchId") || ""),
        toBranchId: String(formData.get("toBranchId") || ""),
        phones: picked,
        accessoryLines: String(formData.get("accessoryLines") || "").slice(0, 500),
      }),
      branchId: String(formData.get("fromBranchId") || "") || user.branchId,
      success: false,
    }).catch(() => {})
  }
  return outcome
}

async function submitTransfer(formData: FormData): Promise<TransferOutcome> {
  const user = await requireUser()
  if (!(await can(user.role, "action.transfer"))) return { error: "You are not allowed to send goods to another shop. Ask the main admin." }
  const fromBranchId = String(formData.get("fromBranchId") || "")
  const toBranchId = String(formData.get("toBranchId") || "")
  if (!fromBranchId || !toBranchId) return { error: "Pick the sending shop and the receiving shop." }
  if (fromBranchId === toBranchId) return { error: "Choose two different Abu Twins shops." }

  const scoped = await scopedBranchId(user.role, user.branchId)
  if (scoped && fromBranchId !== scoped) return { error: "You can only send from your own shop." }
  const receiving = await prisma.branch.findFirst({ where: { id: toBranchId, isActive: true }, select: { id: true } })
  if (!receiving) return { error: "That receiving shop is not open. Pick another shop." }

  const selectedImeis = [
    ...new Set(
      String(formData.get("selectedImeis") || "")
        .split(/[\s,;]+/)
        .map((row) => row.trim())
        .filter(Boolean)
    ),
  ]
  let accessoryPicks: Array<{ productId: string; quantity: number }> = []
  try {
    const raw = String(formData.get("accessoryLines") || "").trim()
    if (raw) {
      const parsed = JSON.parse(raw) as Array<{ productId?: string; quantity?: number }>
      accessoryPicks = parsed
        .map((row) => ({
          productId: String(row.productId || ""),
          quantity: Math.floor(Number(row.quantity) || 0),
        }))
        .filter((row) => row.productId && row.quantity > 0)
    }
  } catch {
    return { error: "The selected accessory lines could not be read. Try again." }
  }

  const file = formData.get("file")
  const hasFile = file instanceof File && file.size > 0
  if (!selectedImeis.length && !accessoryPicks.length && !hasFile) {
    return { error: "Select the items to send, or upload a CSV list." }
  }

  const products = await prisma.product.findMany({ where: { isActive: true } })
  const bySku = new Map(products.map((row) => [row.sku.toLowerCase(), row]))
  const byName = new Map<string, typeof products>()
  for (const product of products) {
    const key = product.name.toLowerCase()
    const list = byName.get(key) ?? []
    list.push(product)
    byName.set(key, list)
  }

  type PhoneLine = { imei1: string; productId: string; color: string; extra: string }
  const phones: PhoneLine[] = []
  const accessoryQty = new Map<string, number>()
  const seen = new Set<string>()
  const errors: string[] = []

  if (selectedImeis.length || accessoryPicks.length) {
    if (selectedImeis.length) {
      const records = await prisma.imeiRecord.findMany({
        where: {
          OR: [{ imei1: { in: selectedImeis } }, { serialNumber: { in: selectedImeis } }],
        },
        include: { product: true },
      })
      const byCode = new Map<string, (typeof records)[number]>()
      for (const record of records) {
        for (const key of [record.imei1, record.serialNumber]) {
          if (key && !byCode.has(key)) byCode.set(key, record)
        }
      }
      for (const code of selectedImeis) {
        if (seen.has(code)) {
          errors.push(`${code} is listed twice.`)
          continue
        }
        seen.add(code)
        const record = byCode.get(code)
        if (!record) {
          errors.push(`${code} is not on this system.`)
          continue
        }
        if (record.status !== "IN_STOCK" || record.branchId !== fromBranchId) {
          errors.push(`${record.imei1} is not In shop at the sending shop.`)
          continue
        }
        phones.push({ imei1: record.imei1, productId: record.productId, color: "", extra: "" })
      }
    }
    for (const pick of accessoryPicks) {
      const product = products.find((row) => row.id === pick.productId)
      if (!product) {
        errors.push("One selected accessory is not on the active list.")
        continue
      }
      if (product.tracking !== "NONE") {
        errors.push(`${product.name} needs an IMEI. Select the phone number instead.`)
        continue
      }
      accessoryQty.set(product.id, (accessoryQty.get(product.id) ?? 0) + pick.quantity)
    }
  } else if (hasFile && file instanceof File) {
    if (file.size > 2_000_000) return { error: "That file is too big. Use a file under 2 MB." }
    let rows: Record<string, string>[]
    try {
      rows = await readTableFile(file)
    } catch {
      return { error: "We could not read that file. Save it as CSV or Excel and try again." }
    }
    if (!rows.length) return { error: "There is nothing under the header line in that file." }
    if (rows.length > 200) return { error: "Send up to 200 lines at a time." }

    const codes = rows
      .map((row) => cell(row, "imei", "imei1", "phone") || cell(row, "serial", "serial_number", "sn"))
      .filter(Boolean)
    const codeRecords = codes.length
      ? await prisma.imeiRecord.findMany({
          where: {
            OR: [{ imei1: { in: codes } }, { imei2: { in: codes } }, { serialNumber: { in: codes } }],
          },
          include: { product: true },
        })
      : []
    const byCode = new Map<string, (typeof codeRecords)[number]>()
    for (const record of codeRecords) {
      for (const key of [record.imei1, record.imei2, record.serialNumber]) {
        if (key && !byCode.has(key)) byCode.set(key, record)
      }
    }

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      const line = index + 2
      const imei = cell(row, "imei", "imei1", "phone")
      const serial = cell(row, "serial", "serial_number", "sn")
      const sku = cell(row, "item_code", "sku", "code")
      const name = cell(row, "name", "product", "item")
      const color = cell(row, "color")
      const extra = cell(row, "notes", "note", "remark")
      const qtyRaw = cell(row, "quantity", "qty", "pieces")
      const code = imei || serial

      if (!code && !sku && !name) continue

      if (code) {
        if (seen.has(code)) {
          errors.push(`Line ${line}: ${code} is listed twice.`)
          continue
        }
        seen.add(code)
        const record = byCode.get(code)
        if (!record) {
          errors.push(`Line ${line}: ${code} is not on this system.`)
          continue
        }
        if (record.status !== "IN_STOCK" || record.branchId !== fromBranchId) {
          errors.push(`Line ${line}: ${record.imei1} is not In shop at the sending shop.`)
          continue
        }
        if (sku && record.product.sku.toLowerCase() !== sku.toLowerCase()) {
          errors.push(`Line ${line}: ${record.imei1} belongs to ${record.product.sku}, not ${sku}.`)
          continue
        }
        phones.push({ imei1: record.imei1, productId: record.productId, color, extra })
        continue
      }

      const product =
        (sku ? bySku.get(sku.toLowerCase()) : undefined) ??
        (name && byName.get(name.toLowerCase())?.length === 1 ? byName.get(name.toLowerCase())![0] : undefined)
      if (!product) {
        errors.push(`Line ${line}: pick a known item code for this accessory, or put an IMEI on a phone line.`)
        continue
      }
      if (product.tracking !== "NONE") {
        errors.push(`Line ${line}: ${product.name} needs an IMEI or serial. Put the number in the IMEI or serial column.`)
        continue
      }
      const quantity = Number(qtyRaw || 0)
      if (!Number.isFinite(quantity) || quantity < 1) {
        errors.push(`Line ${line}: type how many ${product.name} pieces are leaving.`)
        continue
      }
      accessoryQty.set(product.id, (accessoryQty.get(product.id) ?? 0) + quantity)
    }
  }

  if (errors.length) return { error: errors[0], errors }
  if (!phones.length && accessoryQty.size === 0) {
    return { error: "Select at least one phone or accessory to transfer." }
  }

  if (phones.length + [...accessoryQty.values()].reduce((sum, n) => sum + n, 0) > 200) {
    return { error: "Send up to 200 units at a time." }
  }

  const qtyByProduct = new Map<string, number>()
  for (const phone of phones) {
    qtyByProduct.set(phone.productId, (qtyByProduct.get(phone.productId) ?? 0) + 1)
  }
  for (const [productId, quantity] of accessoryQty) {
    qtyByProduct.set(productId, (qtyByProduct.get(productId) ?? 0) + quantity)
  }

  const sendingStock = await prisma.inventory.findMany({
    where: { branchId: fromBranchId, productId: { in: [...qtyByProduct.keys()] } },
    select: { productId: true, quantity: true },
  })
  const heldByProduct = new Map(sendingStock.map((row) => [row.productId, row.quantity]))
  for (const [productId, quantity] of qtyByProduct) {
    if ((heldByProduct.get(productId) ?? 0) < quantity) {
      const product = products.find((row) => row.id === productId)
      return { error: `${product?.name ?? "This item"} does not have ${quantity} In shop at the sending shop.` }
    }
  }

  const imeis = phones.map((row) => row.imei1)
  const reserved = await reservedTransferImeiSet(fromBranchId)
  for (const imei1 of imeis) {
    if (reserved.has(imei1)) {
      return { error: `${imei1} is already on a shop-to-shop transfer waiting for the other shop to accept or reject.` }
    }
  }

  const transferNumber = generateDocNumber("TRF")

  // Stock stays In shop at the sending shop until the receiving shop accepts.
  // Reject cancels with no shelf move. Accept is when the stock leaves.
  let transfer: { transferNumber: string }
  try {
    transfer = await prisma.$transaction(async (tx) => {
      const created = await tx.stockTransfer.create({
        data: {
          transferNumber,
          fromBranchId,
          toBranchId,
          userId: user.id,
          status: "PENDING",
          sentAt: null,
          notes: imeis.length
            ? `IMEIs: ${imeis.join(",")}`
            : String(formData.get("notes") || "") || "Shop to shop transfer",
          items: {
            create: [...qtyByProduct.entries()].map(([productId, quantity]) => ({ productId, quantity })),
          },
        },
      })

      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: "CREATE",
          entityType: "StockTransfer",
          entityId: created.transferNumber,
          newValue: JSON.stringify({
            fromBranchId,
            toBranchId,
            status: "PENDING",
            imeis,
            items: [...qtyByProduct.entries()],
            note: "Submitted. Stock stays In shop at the sending shop until accept or reject.",
          }),
          branchId: fromBranchId,
        },
      })
      return created
    })
  } catch (error) {
    return { error: shopError(error, "Could not submit this transfer. Nothing left the shop.") }
  }

  // The receiving shop, and the CEO and main admin who may also accept it.
  const destStaff = await prisma.user.findMany({
    where: { isActive: true, OR: [{ branchId: toBranchId }, { role: { in: ["CEO", "SUPER_ADMIN"] } }] },
  })
  for (const staff of destStaff) {
    await notify(
      staff.id,
      "Shop to shop transfer waiting",
      `${transfer.transferNumber} · accept or reject. Stock is still In shop at the sending shop.`,
      "/transfers",
      "TRANSFER"
    )
  }
  refreshOps()
  return { success: true }
}


/** Tell the person who sent a transfer, and their shop's manager, what became of it. */
async function tellSender(transfer: { userId: string; fromBranchId: string; transferNumber: string; toBranch: { name: string } }, title: string, message: string) {
  const managers = await prisma.user.findMany({
    where: { isActive: true, role: "BRANCH_MANAGER", branchId: transfer.fromBranchId },
    select: { id: true },
  })
  for (const id of new Set([transfer.userId, ...managers.map((row) => row.id)])) {
    await notify(id, title, message, "/transfers", "TRANSFER")
  }
}

export async function receiveTransfer(formData: FormData) {
  const user = await requireUser()
  if (!(await can(user.role, "action.transfer"))) return { error: "You are not allowed to receive goods from another shop. Ask the main admin." }
  const id = String(formData.get("id") || "")
  const transfer = await prisma.stockTransfer.findUnique({
    where: { id },
    include: { items: { include: { product: true } }, toBranch: true, fromBranch: true },
  })
  if (!transfer) return { error: "We could not find that send." }
  if (transfer.status === "RECEIVED") return { error: "This transfer has already been accepted." }
  if (transfer.status === "CANCELLED") return { error: "This transfer was rejected. Nothing to accept." }
  if (!mayDecideTransfer(user, transfer.toBranchId)) {
    return { error: `Only ${transferDeciders(transfer.toBranch.name)} can accept this transfer.` }
  }

  // What arrived. Phones: those ticked on the list, or typed / scanned by any
  // of their numbers. Pieces: the quantity typed beside each line (all of it
  // when the box is left alone). Anything not accepted stays with the sending
  // shop, which may sell it on the receiving shop's behalf; a transfer no
  // longer has to arrive whole to be accepted.
  const expected = parseTransferIds(transfer.notes ?? "")
  const units = expected.length
    ? await prisma.imeiRecord.findMany({
        where: { imei1: { in: expected } },
        select: { imei1: true, imei2: true, serialNumber: true, status: true, branchId: true, productId: true },
      })
    : []
  const phoneByCode = new Map<string, string>()
  for (const unit of units) {
    for (const code of [unit.imei1, unit.imei2, unit.serialNumber]) if (code) phoneByCode.set(code, unit.imei1)
  }
  const scanned = parseScannedCodes(String(formData.get("imeis") || ""))
  const strangers = scanned.filter((code) => !phoneByCode.has(code) && !expected.includes(code))
  if (strangers.length) {
    return { error: `${strangers.slice(0, 5).join(", ")} ${strangers.length === 1 ? "is" : "are"} not on this transfer.` }
  }
  const arrivedSet = new Set(scanned.map((code) => phoneByCode.get(code) ?? code))
  const arrived = expected.filter((imei) => arrivedSet.has(imei))
  const leftBehind = expected.filter((imei) => !arrivedSet.has(imei))

  const pendingStyle = transfer.status === "PENDING"
  // A phone sold or moved at the sending shop since the transfer was made
  // cannot be received. Say which, so it can be unticked.
  const unitByImei = new Map(units.map((unit) => [unit.imei1, unit]))
  const gone = arrived.filter((imei) => {
    const unit = unitByImei.get(imei)
    if (!unit) return true
    return pendingStyle
      ? unit.status !== "IN_STOCK" || unit.branchId !== transfer.fromBranchId
      : unit.status !== "TRANSFERRED"
  })
  if (gone.length) {
    return {
      error: `${gone.slice(0, 5).join(", ")} ${gone.length === 1 ? "is" : "are"} no longer In shop at ${transfer.fromBranch.name} (sold or moved there). Untick ${gone.length === 1 ? "it" : "them"} and accept the rest.`,
    }
  }

  const phonesByProduct = new Map<string, number>()
  for (const imei of arrived) {
    const productId = unitByImei.get(imei)?.productId
    if (productId) phonesByProduct.set(productId, (phonesByProduct.get(productId) ?? 0) + 1)
  }
  const phoneProducts = new Set(units.map((unit) => unit.productId))
  const receivedByItem = new Map<string, number>()
  for (const item of transfer.items) {
    if (phoneProducts.has(item.productId)) {
      receivedByItem.set(item.id, Math.min(item.quantity, phonesByProduct.get(item.productId) ?? 0))
      continue
    }
    const typed = formData.get(`piece_${item.id}`)
    const qty = typed == null || String(typed).trim() === "" ? item.quantity : Math.floor(Number(typed))
    if (!Number.isFinite(qty) || qty < 0) return { error: `Type how many ${item.product.name} arrived, 0 or more.` }
    if (qty > item.quantity) return { error: `Only ${item.quantity} ${item.product.name} were sent. Type ${item.quantity} or fewer.` }
    receivedByItem.set(item.id, qty)
  }
  const anything = [...receivedByItem.values()].some((qty) => qty > 0)
  if (!anything) {
    return { error: "Nothing is marked as arrived. Tick what came, or reject the transfer if none of it did." }
  }

  try {
    await prisma.$transaction(async (tx) => {
      const lines = [
        transfer.notes ?? "",
        arrived.length ? `Arrived: ${arrived.join(",")}` : "",
        leftBehind.length ? `Stayed at ${transfer.fromBranch.name}: ${leftBehind.join(",")}` : "",
      ].filter(Boolean)
      const accepted = await tx.stockTransfer.updateMany({
        where: { id, status: { in: ["PENDING", "IN_TRANSIT"] } },
        data: { status: "RECEIVED", receivedAt: new Date(), sentAt: transfer.sentAt ?? new Date(), notes: lines.join("\n"), receivedByUserId: user.id },
      })
      if (accepted.count !== 1) {
        throw new ConflictError(`${transfer.transferNumber} was already closed by someone else. Refresh to see it.`)
      }

      if (pendingStyle) {
        await claimImeis(tx, {
          imei1s: arrived,
          branchId: transfer.fromBranchId,
          from: "IN_STOCK",
          data: { status: "IN_STOCK", branchId: transfer.toBranchId },
        })
      } else {
        // Older sends had already left the sending shelf: what arrived lands,
        // what did not goes back to the sending shop.
        await claimImeis(tx, {
          imei1s: arrived,
          branchId: transfer.fromBranchId,
          from: "TRANSFERRED",
          data: { status: "IN_STOCK", branchId: transfer.toBranchId },
        })
        await claimImeis(tx, {
          imei1s: leftBehind,
          branchId: transfer.fromBranchId,
          from: "TRANSFERRED",
          data: { status: "IN_STOCK", branchId: transfer.fromBranchId },
        })
      }
      for (const imei1 of arrived) {
        await tx.auditLog.create({
          data: {
            userId: user.id,
            action: "UPDATE",
            entityType: "IMEIRecord",
            entityId: imei1,
            oldValue: pendingStyle ? "IN_STOCK" : "TRANSFERRED",
            newValue: JSON.stringify({ status: "IN_STOCK", branchId: transfer.toBranchId, transfer: transfer.transferNumber }),
            branchId: transfer.toBranchId,
          },
        })
      }

      for (const item of transfer.items) {
        const received = receivedByItem.get(item.id) ?? 0
        const notReceived = item.quantity - received
        await tx.transferItem.update({ where: { id: item.id }, data: { receivedQty: received } })
        if (received > 0) {
          if (pendingStyle) {
            await drawStock(tx, {
              productId: item.productId,
              branchId: transfer.fromBranchId,
              quantity: received,
              label: item.product.name,
              move: { kind: "TRANSFER_OUT", reference: transfer.transferNumber, userId: user.id },
            })
          }
          await returnStock(tx, {
            productId: item.productId,
            branchId: transfer.toBranchId,
            quantity: received,
            move: { kind: "TRANSFER_IN", reference: transfer.transferNumber, userId: user.id },
          })
        }
        if (!pendingStyle && notReceived > 0) {
          await returnStock(tx, {
            productId: item.productId,
            branchId: transfer.fromBranchId,
            quantity: notReceived,
            move: { kind: "TRANSFER_IN", reference: transfer.transferNumber, userId: user.id },
          })
        }
      }

      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: "UPDATE",
          entityType: "StockTransfer",
          entityId: transfer.transferNumber,
          newValue: JSON.stringify({
            status: "RECEIVED",
            arrived,
            stayedAtSendingShop: leftBehind,
            pieces: transfer.items
              .filter((item) => !phoneProducts.has(item.productId))
              .map((item) => ({ item: item.product.name, sent: item.quantity, arrived: receivedByItem.get(item.id) ?? 0 })),
          }),
          branchId: transfer.toBranchId,
        },
      })
    })
  } catch (error) {
    return { error: shopError(error, "Could not accept this transfer.") }
  }
  await tellSender(
    transfer,
    leftBehind.length || [...receivedByItem.values()].some((qty, index) => qty < transfer.items[index]?.quantity)
      ? "Transfer accepted in part"
      : "Transfer accepted",
    `${transfer.transferNumber} was accepted at ${transfer.toBranch.name} by ${user.name || "the receiving shop"}.${leftBehind.length ? ` ${leftBehind.length} phone(s) stayed with you.` : ""}`
  ).catch(() => {})
  refreshOps()
  return { success: true }
}

export async function rejectTransfer(formData: FormData) {
  const user = await requireUser()
  if (!(await can(user.role, "action.transfer"))) {
    return { error: "You are not allowed to reject a shop-to-shop transfer. Ask the main admin." }
  }
  const id = String(formData.get("id") || "")
  const transfer = await prisma.stockTransfer.findUnique({
    where: { id },
    include: { items: { include: { product: true } }, toBranch: true, fromBranch: true },
  })
  if (!transfer) return { error: "We could not find that transfer." }
  if (transfer.status === "RECEIVED") return { error: "This transfer was already accepted." }
  if (transfer.status === "CANCELLED") return { error: "This transfer was already rejected." }
  if (!mayDecideTransfer(user, transfer.toBranchId)) {
    return { error: `Only ${transferDeciders(transfer.toBranch.name)} can reject this transfer.` }
  }
  // Why it was turned back is required, so the sending shop knows.
  const why = String(formData.get("reason") || "").trim()
  if (why.length < 3) return { error: "Write why you are rejecting this transfer." }

  const expected = parseTransferIds(transfer.notes ?? "")
  const wasInTransit = transfer.status === "IN_TRANSIT"

  try {
    await prisma.$transaction(async (tx) => {
      const closed = await tx.stockTransfer.updateMany({
        where: { id, status: { in: ["PENDING", "IN_TRANSIT"] } },
        data: {
          status: "CANCELLED",
          notes: [transfer.notes, `Rejected: ${why.slice(0, 500)}`].filter(Boolean).join("\n"),
          receivedByUserId: user.id,
        },
      })
      if (closed.count !== 1) {
        throw new ConflictError(`${transfer.transferNumber} was already closed. Refresh to see it.`)
      }

      // Legacy in-transit sends had already left the shelf. Put them back.
      if (wasInTransit) {
        if (expected.length) {
          await claimImeis(tx, {
            imei1s: expected,
            branchId: transfer.fromBranchId,
            from: "TRANSFERRED",
            data: { status: "IN_STOCK", branchId: transfer.fromBranchId },
          })
        }
        for (const item of transfer.items) {
          await returnStock(tx, {
            productId: item.productId,
            branchId: transfer.fromBranchId,
            quantity: item.quantity,
            move: { kind: "TRANSFER_IN", reference: transfer.transferNumber, userId: user.id },
          })
        }
      }

      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: "UPDATE",
          entityType: "StockTransfer",
          entityId: transfer.transferNumber,
          newValue: JSON.stringify({
            status: "CANCELLED",
            reason: why,
            note: wasInTransit
              ? "Rejected. Stock returned to the sending shop."
              : "Rejected. Stock never left the sending shop In shop record.",
          }),
          branchId: user.branchId ?? transfer.toBranchId,
        },
      })
    })
  } catch (error) {
    return { error: shopError(error, "Could not reject this transfer.") }
  }
  await tellSender(
    transfer,
    "Transfer rejected",
    `${transfer.transferNumber} was rejected at ${transfer.toBranch.name} by ${user.name || "the receiving shop"}: ${why}. The stock stays with you.`
  ).catch(() => {})
  refreshOps()
  return { success: true }
}

export async function getSupplierReturnCandidates() {
  const user = await requireUser()
  const branchId = await viewBranchFilter(user)
  const rows = await prisma.imeiRecord.findMany({
    where: {
      status: { in: ["FAULTY", "RETURNED"] },
      ...(branchId ? { branchId } : {}),
    },
    include: { product: true, supplier: true, branch: true },
    orderBy: { updatedAt: "desc" },
    take: 80,
  })
  return rows.map((row) => ({
    id: row.id,
    imei1: row.imei1,
    productName: row.product.name,
    supplierId: row.supplierId,
    supplierName: row.supplier?.name ?? "",
    shop: row.branch.name,
    status: row.status,
  }))
}

const supplierReturnImeiInclude = {
  product: { select: { id: true, name: true, costPrice: true } },
  supplier: { select: { id: true, name: true } },
  branch: { select: { name: true } },
  purchase: {
    include: {
      items: { select: { productId: true, costPrice: true } },
      openingStock: { select: { id: true } },
    },
  },
} as const

type SupplierReturnImei = {
  id: string
  imei1: string
  productId: string
  supplierId: string | null
  branchId: string
  status: string
  notes: string | null
  product: { id: string; name: string; costPrice: unknown }
  supplier: { id: string; name: string } | null
  branch: { name: string }
  purchase: {
    id: string
    invoiceNumber: string
    notes: string | null
    items: Array<{ productId: string; costPrice: unknown }>
    openingStock: { id: string } | null
  } | null
}

async function applySupplierReturnMoney(
  tx: Prisma.TransactionClient,
  record: SupplierReturnImei,
) {
  const plan = supplierReturnMoneyPlan({
    supplierId: record.supplierId,
    productId: record.productId,
    productCost: record.product.costPrice,
    purchase: record.purchase,
  })
  if (!plan.moneyMoves || !record.supplierId) return plan

  if (plan.reason === "bill" && record.purchase) {
    await tx.purchase.update({
      where: { id: record.purchase.id },
      data: { returnedAmount: { increment: plan.cost.toFixed(2) } },
    })
  } else if (plan.reason === "house-credit") {
    await tx.supplier.update({
      where: { id: record.supplierId },
      data: { creditBalance: { increment: plan.cost.toFixed(2) } },
    })
  }
  return plan
}

function toReturnLookup(row: SupplierReturnImei) {
  const plan = supplierReturnMoneyPlan({
    supplierId: row.supplierId,
    productId: row.productId,
    productCost: row.product.costPrice,
    purchase: row.purchase,
  })
  return {
    imei: row.imei1,
    productName: row.product.name,
    supplierId: row.supplierId || "",
    supplierName: row.supplier?.name || "",
    cost: plan.cost,
    invoice: row.purchase?.invoiceNumber || "",
    shop: row.branch.name,
    status: row.status,
    moneyMoves: plan.moneyMoves,
    moneyNote:
      plan.reason === "opening-stock"
        ? "Opening stock. Sending it back does not change what we owe."
        : plan.reason === "no-supplier"
          ? "This phone has no supplier on the record."
          : plan.reason === "no-cost"
            ? "No purchase cost is saved on this phone."
            : "",
  }
}

export async function lookupSupplierReturnImei(imei: string) {
  const user = await requireUser()
  const code = imei.replace(/[\s-]/g, "").trim()
  if (code.length < 4) return { error: "That number is too short. Scan the box again, or type every digit." }

  const row = await prisma.imeiRecord.findFirst({
    where: { OR: [{ imei1: code }, { serialNumber: code }] },
    include: supplierReturnImeiInclude,
  })
  if (!row) return { error: "We could not find that IMEI or serial on the system." }

  const scoped = await scopedBranchId(user.role, user.branchId)
  if (scoped && row.branchId !== scoped) {
    return { error: "You can only send back a phone from your own shop." }
  }
  if (row.status === "RETURNED_TO_SUPPLIER") {
    return { error: `${code} was already sent back to the supplier.` }
  }
  if (!isSupplierReturnableStatus(row.status)) {
    return { error: "You can only send back a phone that is in the shop, returned, or faulty." }
  }
  if (!row.supplierId) {
    return { error: "This IMEI has no supplier on the record. Ask records to attach the house before sending it back." }
  }
  return toReturnLookup(row as SupplierReturnImei)
}

export async function sendUnitsToSupplier(formData: FormData) {
  const user = await requireUser()
  // Return outward changes what we owe the supplier and takes stock off the
  // books, so it is the Vault Manager's, the shop Manager's, the CEO's or the
  // main admin's decision, never the till's.
  if (!canSendToSupplier(user.role)) {
    return { error: "Only the Vault Manager, the shop Manager, the CEO or the main admin can send goods back to a supplier." }
  }
  // The send-back list holds each unit's main number, which for a tablet or
  // laptop is its serial, so short numbers are allowed here.
  const imeis = parseUnitCodes(String(formData.get("imeis") || ""), "SERIAL")
  if (!imeis.length) return { error: "Scan the IMEIs or serials going back to the supplier." }

  const records = await prisma.imeiRecord.findMany({
    where: { imei1: { in: imeis } },
    include: supplierReturnImeiInclude,
  })
  if (records.length !== imeis.length) return { error: "We could not find one or more of those IMEIs or serials." }
  if (records.some((row) => !isSupplierReturnableStatus(row.status))) {
    return { error: "You can only send back a phone that is in the shop, returned, or faulty." }
  }
  if (records.some((row) => !row.supplierId)) {
    return { error: "One of these phones has no supplier on the record. The IMEI must already name the house." }
  }
  const houseIds = [...new Set(records.map((row) => row.supplierId).filter(Boolean))]
  if (houseIds.length > 1) {
    return { error: "Scan phones from one supplier only. These IMEIs belong to more than one house." }
  }

  const scoped = await scopedBranchId(user.role, user.branchId)
  if (scoped && records.some((row) => row.branchId !== scoped)) {
    return { error: "You can only send units from your own shop." }
  }

  const rtv = generateDocNumber("RTV")
  const houseName = records[0]?.supplier?.name || "supplier"

  try {
  await prisma.$transaction(async (tx) => {
    for (const record of records) {
      await claimImei(tx, {
        imeiId: record.id,
        branchId: record.branchId,
        label: record.imei1,
        from: record.status,
        data: {
          status: "RETURNED_TO_SUPPLIER",
          customerId: null,
          supplierId: record.supplierId,
          notes: [record.notes, `Sent back to ${houseName} on ${rtv}`].filter(Boolean).join(" · "),
        },
      })
      if (record.status === "IN_STOCK") {
        await drawStock(tx, {
          productId: record.productId,
          branchId: record.branchId,
          quantity: 1,
          label: record.imei1,
          move: { kind: "RETURN_TO_SUPPLIER", reference: rtv, userId: user.id },
        })
      }
      const moneyMove = await applySupplierReturnMoney(tx, record as SupplierReturnImei)
      // The returns outward record Reports reads.
      await recordSupplierReturnLine(tx, {
        reference: rtv,
        supplierId: record.supplierId,
        branchId: record.branchId,
        imeiId: record.id,
        productId: record.productId,
        purchaseId: record.purchaseId ?? null,
        cost: moneyMove.cost,
        moneyEffect: moneyMove.reason,
        source: "SEND_BACK",
        userId: user.id,
      })
      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: "UPDATE",
          entityType: "IMEIRecord",
          entityId: record.imei1,
          oldValue: record.status,
          newValue: JSON.stringify({
            status: "RETURNED_TO_SUPPLIER",
            supplierId: record.supplierId,
            rtv,
            cost: moneyMove.cost,
            moneyMoves: moneyMove.moneyMoves,
            reason: moneyMove.reason,
          }),
          branchId: record.branchId,
        },
      })
    }
    await tx.auditLog.create({
      data: {
        userId: user.id,
        action: "CREATE",
        entityType: "VendorReturn",
        entityId: rtv,
        newValue: JSON.stringify({
          supplierId: houseIds[0],
          supplierName: houseName,
          imeis,
          count: imeis.length,
        }),
        branchId: records[0]?.branchId,
      },
    })
  })
  } catch (error) {
    return { error: shopError(error, "Could not send these units back. Nothing was moved.") }
  }

  refreshOps()
  return { success: true }
}
