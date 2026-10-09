"use server"

import { revalidatePath } from "next/cache"
import { Prisma, type UserRole } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { recordMovement } from "@/lib/concurrency"
import { can } from "@/lib/permissions"
import { canChangePrices, canSeeCost, isShopOwner, scopedBranchId } from "@/lib/rbac"
import { requireUser } from "@/lib/session"
import { readWorkbookGrids } from "@/lib/table-file"
import { makeOpeningSku, mapOpeningCondition } from "@/lib/opening-stock"
import {
  checkScreenChanges,
  cleanIdentity,
  planCorrection,
  type BookLine,
  type CorrectionPlan,
  type NewOpeningItem,
  type OpeningChange,
} from "@/lib/opening-book"
import { OPENING_STOCK_METHOD } from "@/lib/upload-purchase"
import { payablePurchaseWhere, purchaseBalance } from "@/lib/purchase-money"
import { healOpeningStockBills } from "@/lib/opening-stock-money"
import { money } from "@/lib/utils"
import { watDayKey } from "@/lib/lagos-day"

/**
 * Opening stock, per shop: loaded, corrected against a physical count, then
 * closed. The CEO or Super Admin can open a closed one again to fix it, with a
 * reason, and close it again when it is right.
 *
 * The opening bill's lines are the opening
 * figures: quantity, unit cost, and the IMEIs tied to the bill. A correction
 * changes the bill line and moves the shelf by the same difference, so goods
 * booked on other bills are never counted twice.
 */

const MAX_BYTES = 25_000_000

type Snapshot = { lines: BookLine[] }

function canCloseRole(role: UserRole) {
  return role === "CEO" || role === "SUPER_ADMIN" || role === "AUDITOR" || role === "ACCOUNTANT"
}

function canCorrectRole(role: UserRole) {
  return (
    role === "CEO" ||
    role === "SUPER_ADMIN" ||
    role === "AUDITOR" ||
    role === "ACCOUNTANT" ||
    role === "STOCK_UPLOADER"
  )
}

/**
 * Who may change a shop's opening figures. Loading stock (action.upload) used
 * to be enough, which let shop managers edit them too. The client wants the
 * opening and closing stock read-only for managers: they see every figure for
 * their shop, and the CEO, main admin, books desk and stock loaders change it.
 */
function mayCorrectOpening(role: UserRole, canUpload: boolean) {
  if (role === "BRANCH_MANAGER") return false
  return canCorrectRole(role) || canUpload
}

async function viewer() {
  const user = await requireUser()
  const [uploads, reports] = await Promise.all([can(user.role, "view.uploads"), can(user.role, "view.reports")])
  const canUpload = await can(user.role, "action.upload")
  return {
    user,
    allowed: uploads || reports || canCorrectRole(user.role) || canCloseRole(user.role),
    canCorrect: mayCorrectOpening(user.role, canUpload),
  }
}

function identityOf(row: { imei1: string; serialNumber: string | null }) {
  return row.serialNumber || row.imei1
}

async function liveLines(purchaseId: string, branchId: string): Promise<BookLine[]> {
  const [items, units] = await Promise.all([
    prisma.purchaseItem.findMany({
      where: { purchaseId },
      include: { product: { include: { brand: true, category: true } } },
      orderBy: { product: { name: "asc" } },
    }),
    prisma.imeiRecord.findMany({
      where: { purchaseId, branchId, status: "IN_STOCK" },
      select: { imei1: true, serialNumber: true, productId: true },
    }),
  ])
  const shelf = await prisma.inventory.findMany({
    where: { branchId, productId: { in: items.map((row) => row.productId) } },
    select: { productId: true, quantity: true },
  })
  const shelfBy = new Map(shelf.map((row) => [row.productId, row.quantity]))
  const unitsBy = new Map<string, string[]>()
  for (const unit of units) unitsBy.set(unit.productId, [...(unitsBy.get(unit.productId) ?? []), identityOf(unit)])

  return items.map((row) => ({
    productId: row.productId,
    sku: row.product.sku,
    name: row.product.name,
    brand: row.product.brand.name,
    category: row.product.category.name,
    condition: row.product.condition,
    storage: row.product.storage,
    tracking: row.product.tracking,
    openingQty: row.quantity,
    shelfQty: shelfBy.get(row.productId) ?? 0,
    costPrice: money(row.costPrice),
    minimumPrice: money(row.product.minimumPrice),
    sellingPrice: money(row.product.sellingPrice),
    identities: (unitsBy.get(row.productId) ?? []).sort(),
  }))
}

function totals(lines: BookLine[]) {
  return {
    value: lines.reduce((sum, line) => sum + line.openingQty * line.costPrice, 0),
    quantity: lines.reduce((sum, line) => sum + line.openingQty, 0),
    lines: lines.length,
  }
}

/** Every shop and where its opening stock has got to. */
export async function getOpeningShops() {
  const { user, allowed } = await viewer()
  if (!allowed) return []
  await healOpeningStockBills()
  const scoped = await scopedBranchId(user.role, user.branchId)
  const [shops, records] = await Promise.all([
    prisma.branch.findMany({
      where: { isActive: true, ...(scoped ? { id: scoped } : {}) },
      select: { id: true, name: true, code: true },
      orderBy: { name: "asc" },
    }),
    prisma.openingStock.findMany({ select: { branchId: true, status: true } }),
  ])
  const status = new Map(records.map((row) => [row.branchId, row.status]))
  return shops.map((shop) => ({ ...shop, status: status.get(shop.id) ?? null }))
}

export async function getOpeningBook(branchId: string) {
  const { user, allowed, canCorrect } = await viewer()
  if (!allowed) return null
  const scoped = await scopedBranchId(user.role, user.branchId, branchId)
  if (scoped && scoped !== branchId) return null

  const record = await prisma.openingStock.findUnique({
    where: { branchId },
    include: { branch: true, purchase: { select: { id: true, invoiceNumber: true, createdAt: true } } },
  })
  if (!record) return { record: null, lines: [] as BookLine[], canCorrect: false, canClose: false, canRemove: false }

  const closed = record.status === "CLOSED"
  let lines: BookLine[]
  if (closed && record.snapshot) {
    lines = (JSON.parse(record.snapshot) as Snapshot).lines
  } else {
    lines = await liveLines(record.purchaseId, branchId)
  }
  const [closer, reopener] = await Promise.all(
    [record.closedBy, record.reopenedBy].map((id) =>
      id ? prisma.user.findUnique({ where: { id }, select: { name: true, email: true } }) : null
    )
  )

  return {
    record: {
      id: record.id,
      status: record.status,
      shopName: record.branch.name,
      shopCode: record.branch.code,
      invoiceNumber: record.purchase.invoiceNumber,
      purchaseId: record.purchase.id,
      loadedAt: record.purchase.createdAt.toISOString(),
      closedAt: record.closedAt?.toISOString() ?? null,
      closedByName: closer ? closer.name || closer.email : null,
      reopenedAt: record.reopenedAt?.toISOString() ?? null,
      reopenedByName: reopener ? reopener.name || reopener.email : null,
      reopenReason: record.reopenReason,
      totals: closed
        ? {
            value: money(record.closedValue),
            quantity: record.closedQuantity ?? 0,
            lines: record.closedLines ?? 0,
          }
        : totals(lines),
    },
    lines,
    canCorrect: !closed && canCorrect,
    canClose: !closed && canCloseRole(user.role),
    canRemove: !closed && isShopOwner(user.role),
    canReopen: closed && isShopOwner(user.role),
  }
}

type Gate =
  | { error: string }
  | {
      userId: string
      /** Main admin or CEO: may move the lowest or selling price of an item already on the list. */
      pricesAllowed: boolean
      /** The CEO or main admin: may move its cost. */
      costAllowed: boolean
      record: { id: string; branchId: string; purchaseId: string; invoiceNumber: string; supplierId: string }
      lines: BookLine[]
    }

async function correctionGate(branchId: string): Promise<Gate> {
  const user = await requireUser()
  const canUpload = await can(user.role, "action.upload")
  if (!mayCorrectOpening(user.role, canUpload)) {
    return { error: "Opening stock is read-only for your job. The CEO, the main admin, the Auditor, the Accountant, or the stock loader can correct it." }
  }
  const record = await prisma.openingStock.findUnique({
    where: { branchId },
    include: { purchase: { select: { invoiceNumber: true, supplierId: true } } },
  })
  if (!record) return { error: "This shop has no opening stock yet. Load it from the Opening stock sheet first." }
  if (record.status === "CLOSED") {
    return { error: "This shop's opening stock is closed, so it can no longer be changed. Use Stock count or a supplier bill." }
  }
  const canCorrect = mayCorrectOpening(user.role, canUpload) || isShopOwner(user.role)
  return {
    userId: user.id,
    pricesAllowed: canCorrect || canChangePrices(user.role),
    costAllowed: canCorrect || canSeeCost(user.role),
    record: {
      id: record.id,
      branchId: record.branchId,
      purchaseId: record.purchaseId,
      invoiceNumber: record.purchase.invoiceNumber,
      supplierId: record.purchase.supplierId,
    },
    lines: await liveLines(record.purchaseId, branchId),
  }
}

/** Checks that need the database: IMEIs already elsewhere, and units that have a history. */
async function databaseProblems(plan: CorrectionPlan, lines: BookLine[], purchaseId: string) {
  const problems: string[] = []
  const bySku = new Map(lines.map((line) => [line.sku, line]))

  const adding = [
    ...plan.changes.flatMap((change) => change.addIdentities ?? []),
    ...plan.newItems.flatMap((item) => item.identities),
  ]
  if (adding.length) {
    const taken = await prisma.imeiRecord.findMany({
      where: { OR: [{ imei1: { in: adding } }, { serialNumber: { in: adding } }] },
      select: { imei1: true, serialNumber: true, branch: { select: { name: true } } },
    })
    for (const row of taken.slice(0, 20)) {
      problems.push(`${identityOf(row)} is already on the system at ${row.branch.name}. It cannot be added twice.`)
    }
  }

  const removing = plan.changes.flatMap((change) => change.removeIdentities ?? [])
  if (removing.length) {
    const rows = await prisma.imeiRecord.findMany({
      where: { purchaseId, OR: [{ imei1: { in: removing } }, { serialNumber: { in: removing } }] },
      select: {
        imei1: true,
        serialNumber: true,
        status: true,
        _count: { select: { saleItems: true, returns: true, repairs: true, swapsOld: true, swapsNew: true } },
      },
    })
    // Only phones booked on this opening stock, and still in the shop, can be
    // taken off it. Taking off any other number used to lower the shelf while
    // the phone stayed on the system, so loading it again under the right item
    // was refused as "already on the system".
    const onThisSheet = new Set(rows.flatMap((row) => [row.imei1, row.serialNumber].filter(Boolean) as string[]))
    for (const code of removing.filter((code) => !onThisSheet.has(code)).slice(0, 20)) {
      problems.push(
        `${code} was not booked on this opening stock, so it cannot be taken off here. To put a phone under the right item, open the item on Price list and use Move phones.`
      )
    }
    for (const row of rows.filter((row) => row.status !== "IN_STOCK")) {
      problems.push(`${identityOf(row)} is not in the shop (${row.status.replace(/_/g, " ").toLowerCase()}), so it cannot be taken off the opening stock.`)
    }
    for (const row of rows) {
      const used = Object.values(row._count).some((n) => n > 0)
      if (used) problems.push(`${identityOf(row)} already has a sale, return, repair or swap on it, so it cannot be taken off.`)    }
  }

  for (const change of plan.changes) {
    const line = bySku.get(change.sku)
    if (line && change.quantity !== undefined && change.quantity < line.openingQty) {
      const drop = line.openingQty - change.quantity
      if (drop > line.shelfQty) {
        problems.push(`${line.name}: the shelf only holds ${line.shelfQty}, so the opening count cannot come down by ${drop}.`)
      }
    }
  }

  const skus = new Set(lines.map((line) => line.sku))
  for (const item of plan.newItems) {
    const existing = await prisma.product.findFirst({
      where: { name: item.name, condition: item.condition, tracking: item.tracking, storage: item.storage },
      select: { sku: true },
    })
    if (existing && skus.has(existing.sku)) {
      problems.push(`${item.name} is already on this opening stock as ${existing.sku}. Put that item code on the row instead.`)
    }
  }
  return problems
}

function describe(plan: CorrectionPlan, lines: BookLine[]) {
  const bySku = new Map(lines.map((line) => [line.sku, line]))
  const naira = (n: number) => `₦${n.toLocaleString("en-NG")}`
  const rows: string[] = []
  let valueAfter = totals(lines).value

  for (const change of plan.changes) {
    const line = bySku.get(change.sku)
    if (!line) continue
    const parts: string[] = []
    const qtyBefore = line.openingQty
    const qtyAfter =
      change.promoteTracking || line.tracking !== "NONE"
        ? qtyBefore + (change.addIdentities?.length ?? 0) - (change.removeIdentities?.length ?? 0)
        : change.quantity ?? qtyBefore
    const cost = change.costPrice ?? line.costPrice
    if (qtyAfter !== qtyBefore) parts.push(`count ${qtyBefore} → ${qtyAfter}`)
    if (change.costPrice !== undefined) parts.push(`cost ${naira(line.costPrice)} → ${naira(change.costPrice)}`)
    if (change.minimumPrice !== undefined) parts.push(`lowest ${naira(line.minimumPrice)} → ${naira(change.minimumPrice)}`)
    if (change.sellingPrice !== undefined) parts.push(`standard ${naira(line.sellingPrice)} → ${naira(change.sellingPrice)}`)
    if (change.addIdentities?.length) parts.push(`add ${change.addIdentities.join(", ")}`)
    if (change.removeIdentities?.length) parts.push(`take off ${change.removeIdentities.join(", ")}`)
    valueAfter += qtyAfter * cost - qtyBefore * line.costPrice
    rows.push(`${line.name} (${line.sku}): ${parts.join(" · ")}`)
  }
  for (const item of plan.newItems) {
    const qty = item.tracking === "NONE" ? item.quantity : item.identities.length
    valueAfter += qty * item.costPrice
    rows.push(`NEW ${item.name} (${item.brand}): ${qty} at ${naira(item.costPrice)}, lowest ${naira(item.minimumPrice)}, standard ${naira(item.sellingPrice)}`)
  }
  return { rows, valueBefore: totals(lines).value, valueAfter }
}

type Tx = Prisma.TransactionClient

async function moveShelf(tx: Tx, productId: string, branchId: string, delta: number) {
  if (delta === 0) return
  const row = await tx.inventory.findUnique({ where: { productId_branchId: { productId, branchId } } })
  const next = Math.max(0, (row?.quantity ?? 0) + delta)
  await tx.inventory.upsert({
    where: { productId_branchId: { productId, branchId } },
    update: { quantity: next, lastStockCheck: new Date() },
    create: { productId, branchId, quantity: next, lastStockCheck: new Date() },
  })
  await recordMovement(tx, {
    productId,
    branchId,
    quantity: next - (row?.quantity ?? 0),
    move: { kind: "OPENING", reference: "Opening stock correction" },
  })
}

async function priceTrail(
  tx: Tx,
  productId: string,
  userId: string,
  type: string,
  before: number,
  after: number | undefined,
  reason: string
) {
  if (after === undefined || after === before) return
  await tx.priceHistory.create({
    data: { productId, oldPrice: before.toFixed(2), newPrice: after.toFixed(2), priceType: type, reason, changedBy: userId },
  })
}

async function applyPlan(
  gate: Exclude<Gate, { error: string }>,
  plan: CorrectionPlan,
  source: "sheet" | "screen"
) {
  const { record, lines, userId } = gate
  // Counts and numbers always correct. The cost only moves for the CEO; the
  // lowest and selling prices for the main admin and the CEO.
  plan = {
    ...plan,
    changes: plan.changes.map(({ costPrice, minimumPrice, sellingPrice, ...change }) => ({
      ...change,
      ...(gate.costAllowed ? { costPrice } : {}),
      ...(gate.pricesAllowed ? { minimumPrice, sellingPrice } : {}),
    })),
  }
  const bySku = new Map(lines.map((line) => [line.sku, line]))
  const reason = `Opening stock correction (${source === "sheet" ? "count sheet" : "on screen"}) on ${record.invoiceNumber}`
  const before = totals(lines).value

  await prisma.$transaction(
    async (tx) => {
      for (const change of plan.changes) {
        const line = bySku.get(change.sku)
        if (!line) continue

        if (change.costPrice !== undefined || change.minimumPrice !== undefined || change.sellingPrice !== undefined) {
          await tx.product.update({
            where: { id: line.productId },
            data: {
              ...(change.costPrice !== undefined ? { costPrice: change.costPrice.toFixed(2) } : {}),
              ...(change.minimumPrice !== undefined ? { minimumPrice: change.minimumPrice.toFixed(2) } : {}),
              ...(change.sellingPrice !== undefined ? { sellingPrice: change.sellingPrice.toFixed(2) } : {}),
            },
          })
          if (change.costPrice !== undefined) {
            // Sales already made carry the cost they were sold at. When that was
            // the mistyped opening cost (or no cost), the correction is the true
            // cost of the very unit they sold, so their profit is put right too.
            await tx.saleItem.updateMany({
              where: {
                productId: line.productId,
                sale: { branchId: record.branchId },
                costPrice: { in: [new Prisma.Decimal(line.costPrice), new Prisma.Decimal(0)] },
              },
              data: {
                costPrice: change.costPrice.toFixed(2),
              },
            })
          }
          await priceTrail(tx, line.productId, userId, "COST_PRICE", line.costPrice, change.costPrice, reason)
          await priceTrail(tx, line.productId, userId, "MINIMUM_PRICE", line.minimumPrice, change.minimumPrice, reason)
          await priceTrail(tx, line.productId, userId, "SELLING_PRICE", line.sellingPrice, change.sellingPrice, reason)
        }

        let qty = line.openingQty
        const tracking = change.promoteTracking ?? line.tracking
        if (change.promoteTracking) {
          await tx.product.update({
            where: { id: line.productId },
            data: { tracking: change.promoteTracking },
          })
        }
        if (tracking === "NONE") {
          if (change.quantity !== undefined) {
            await moveShelf(tx, line.productId, record.branchId, change.quantity - line.openingQty)
            qty = change.quantity
          }
        } else {
          for (const identity of change.addIdentities ?? []) {
            await tx.imeiRecord.create({
              data: {
                imei1: identity,
                serialNumber: tracking === "SERIAL" ? identity : null,
                productId: line.productId,
                branchId: record.branchId,
                supplierId: record.supplierId,
                purchaseId: record.purchaseId,
                status: "IN_STOCK",
                notes: `Opening stock correction · ${record.invoiceNumber}`,
              },
            })
          }
          const removing = change.removeIdentities ?? []
          let removed = 0
          if (removing.length) {
            removed = (
              await tx.imeiRecord.deleteMany({
                where: {
                  purchaseId: record.purchaseId,
                  status: "IN_STOCK",
                  OR: [{ imei1: { in: removing } }, { serialNumber: { in: removing } }],
                },
              })
            ).count
          }
          // The shelf drops only by the phones actually taken off.
          const delta = (change.addIdentities?.length ?? 0) - removed
          await moveShelf(tx, line.productId, record.branchId, delta)
          qty = line.openingQty + delta
        }

        const cost = change.costPrice ?? line.costPrice
        await tx.purchaseItem.updateMany({
          where: { purchaseId: record.purchaseId, productId: line.productId },
          data: { quantity: qty, receivedQty: qty, costPrice: cost.toFixed(2), totalAmount: (qty * cost).toFixed(2) },
        })
      }

      if (plan.newItems.length) await addNewItems(tx, gate, plan.newItems)

      const lineTotals = await tx.purchaseItem.findMany({
        where: { purchaseId: record.purchaseId },
        select: { totalAmount: true },
      })
      const total = lineTotals.reduce((sum, row) => sum + money(row.totalAmount), 0)
      await tx.purchase.update({
        where: { id: record.purchaseId },
        data: {
          totalAmount: total.toFixed(2),
          paidAmount: total.toFixed(2),
          paymentMethod: OPENING_STOCK_METHOD,
        },
      })

      await tx.auditLog.create({
        data: {
          userId,
          action: "UPDATE",
          entityType: "OpeningStock",
          entityId: record.invoiceNumber,
          oldValue: JSON.stringify({ value: before }),
          newValue: JSON.stringify({
            source,
            value: total,
            linesChanged: plan.changes.length,
            itemsAdded: plan.newItems.length,
            detail: describe(plan, lines).rows.slice(0, 200),
          }),
          branchId: record.branchId,
        },
      })
    },
    { timeout: 120_000, maxWait: 20_000 }
  )

  revalidateOpening()
}

async function addNewItems(tx: Tx, gate: Exclude<Gate, { error: string }>, items: NewOpeningItem[]) {
  const { record, userId } = gate
  const [brands, categories, shops] = await Promise.all([
    tx.brand.findMany(),
    tx.category.findMany(),
    tx.branch.findMany({ where: { isActive: true }, select: { id: true } }),
  ])
  const brandIds = new Map(brands.map((row) => [row.name.toLowerCase(), row.id]))
  const categoryIds = new Map(categories.map((row) => [row.name.toLowerCase(), row.id]))

  for (const item of items) {
    let brandId = brandIds.get(item.brand.toLowerCase())
    if (!brandId) {
      brandId = (await tx.brand.create({ data: { name: item.brand } })).id
      brandIds.set(item.brand.toLowerCase(), brandId)
    }
    let categoryId = categoryIds.get(item.category.toLowerCase())
    if (!categoryId) {
      categoryId = (await tx.category.create({ data: { name: item.category } })).id
      categoryIds.set(item.category.toLowerCase(), categoryId)
    }

    let product = await tx.product.findFirst({
      where: { name: item.name, brandId, condition: item.condition, tracking: item.tracking, storage: item.storage },
    })
    if (!product) {
      const base = makeOpeningSku({ brand: item.brand, name: item.name, storage: item.storage || "", condition: item.condition })
      let sku = base
      for (let n = 2; await tx.product.findUnique({ where: { sku }, select: { id: true } }); n += 1) {
        sku = `${base}-${n}`.slice(0, 60)
      }
      product = await tx.product.create({
        data: {
          sku,
          name: item.name,
          brandId,
          categoryId,
          condition: item.condition,
          storage: item.storage,
          tracking: item.tracking,
          costPrice: item.costPrice.toFixed(2),
          minimumPrice: item.minimumPrice.toFixed(2),
          sellingPrice: item.sellingPrice.toFixed(2),
          warrantyDays: 0,
          description: `Opening stock · found on the count · ${record.invoiceNumber}`,
        },
      })
      await tx.inventory.createMany({
        data: shops
          .filter((shop) => shop.id !== record.branchId)
          .map((shop) => ({ productId: product!.id, branchId: shop.id, quantity: 0 })),
      })
    }

    for (const identity of item.identities) {
      await tx.imeiRecord.create({
        data: {
          imei1: identity,
          serialNumber: item.tracking === "SERIAL" ? identity : null,
          productId: product.id,
          branchId: record.branchId,
          supplierId: record.supplierId,
          purchaseId: record.purchaseId,
          status: "IN_STOCK",
          notes: `Opening stock correction · ${record.invoiceNumber}`,
        },
      })
    }
    const qty = item.tracking === "NONE" ? item.quantity : item.identities.length
    await moveShelf(tx, product.id, record.branchId, qty)
    await tx.purchaseItem.create({
      data: {
        purchaseId: record.purchaseId,
        productId: product.id,
        quantity: qty,
        receivedQty: qty,
        costPrice: item.costPrice.toFixed(2),
        totalAmount: (qty * item.costPrice).toFixed(2),
      },
    })
    await tx.auditLog.create({
      data: {
        userId,
        action: "CREATE",
        entityType: "Product",
        entityId: product.sku,
        newValue: JSON.stringify({ name: item.name, openingStock: record.invoiceNumber, quantity: qty }),
        branchId: record.branchId,
      },
    })
  }
}

function revalidateOpening() {
  for (const path of ["/opening-stock", "/inventory", "/products", "/imei", "/purchases", "/reports", "/reconciliation", "/pos"]) {
    revalidatePath(path)
  }
}

export type CorrectionResult = {
  error?: string
  problems?: string[]
  preview?: { rows: string[]; valueBefore: number; valueAfter: number }
  applied?: boolean
}

/**
 * The filled-in count sheet. `mode` "preview" shows exactly what would change
 * and saves nothing; "apply" reads the same file again and saves it.
 */
export async function correctOpeningFromSheet(formData: FormData): Promise<CorrectionResult> {
  const gate = await correctionGate(String(formData.get("branchId") || ""))
  if ("error" in gate) return { error: gate.error }

  const file = formData.get("file")
  if (!(file instanceof File) || file.size === 0) return { error: "Choose the filled-in count sheet first." }
  if (file.size > MAX_BYTES) return { error: "That file is too big. Use a file under 25 MB." }

  let sheets: Array<{ sheet: string; grid: string[][] }>
  try {
    sheets = await readWorkbookGrids(file)
  } catch {
    return { error: "We could not read that Excel file. Save it again and try one more time." }
  }

  const plan = planCorrection(sheets, gate.lines)
  const problems = [...plan.problems, ...(await databaseProblems(plan, gate.lines, gate.record.purchaseId))]
  if (problems.length) {
    return { error: `${problems.length} line(s) need fixing. Nothing was changed.`, problems: problems.slice(0, 60) }
  }
  if (!plan.changes.length && !plan.newItems.length) {
    return { error: "That sheet matches the opening stock exactly. There is nothing to change." }
  }

  const preview = describe(plan, gate.lines)
  if (String(formData.get("mode")) !== "apply") return { preview }

  try {
    await applyPlan(gate, plan, "sheet")
  } catch {
    return { error: "We could not save the corrections. Nothing was changed. Try again." }
  }
  return { applied: true, preview }
}

/** Edits typed on the screen: counts, prices, and IMEIs added or taken off. */
export async function saveOpeningEdits(formData: FormData): Promise<CorrectionResult> {
  const gate = await correctionGate(String(formData.get("branchId") || ""))
  if ("error" in gate) return { error: gate.error }

  let raw: unknown
  try {
    raw = JSON.parse(String(formData.get("changes") || "[]"))
  } catch {
    return { error: "Nothing was changed." }
  }
  const plan = checkScreenChanges(raw, gate.lines)
  const problems = [...plan.problems, ...(await databaseProblems(plan, gate.lines, gate.record.purchaseId))]
  if (problems.length) return { error: problems.slice(0, 4).join(" "), problems }
  if (!plan.changes.length) return { error: "Those figures are already what is saved." }

  try {
    await applyPlan(gate, plan, "screen")
  } catch {
    return { error: "We could not save those changes. Nothing was changed. Try again." }
  }
  return { applied: true, preview: describe(plan, gate.lines) }
}

/**
 * Add a new item found on the shop floor directly to opening stock on screen.
 */
export async function addOpeningStockItem(formData: FormData): Promise<CorrectionResult> {
  const branchId = String(formData.get("branchId") || "")
  const gate = await correctionGate(branchId)
  if ("error" in gate) return { error: gate.error }

  const name = String(formData.get("name") || "").trim()
  const brand = String(formData.get("brand") || "").trim() || "Unbranded"
  const category = String(formData.get("category") || "").trim() || "General"
  const conditionRaw = String(formData.get("condition") || "BRAND_NEW").trim()
  const storage = String(formData.get("storage") || "").trim() || null
  const trackingRaw = String(formData.get("tracking") || "NONE").trim()
  const quantity = Number(formData.get("quantity") || 0)
  const costPrice = Number(formData.get("costPrice") || 0)
  const minimumPrice = Number(formData.get("minimumPrice") || 0)
  const sellingPrice = Number(formData.get("sellingPrice") || 0)
  const rawIdentities = String(formData.get("identities") || "")

  if (!name) return { error: "Product name is required." }
  if (costPrice < 0 || minimumPrice <= 0 || sellingPrice <= 0) {
    return { error: "Cost price must be 0 or more, and lowest/standard selling prices must be above 0." }
  }
  if (sellingPrice < minimumPrice) {
    return { error: "Standard selling price cannot be below the lowest selling price." }
  }

  const condition = mapOpeningCondition(conditionRaw) || "BRAND_NEW"
  const tracking = trackingRaw === "IMEI" || trackingRaw === "SERIAL" ? trackingRaw : "NONE"
  const identities =
    tracking === "NONE"
      ? []
      : [...new Set(rawIdentities.split(/[\n,]+/).map(cleanIdentity).filter(Boolean))]

  if (tracking !== "NONE" && identities.length === 0) {
    return { error: `Provide at least one ${tracking === "IMEI" ? "IMEI" : "Serial number"} for this item.` }
  }
  if (tracking === "NONE" && (quantity <= 0 || !Number.isInteger(quantity))) {
    return { error: "Counted quantity must be a whole number greater than 0." }
  }

  const newItem: NewOpeningItem = {
    name,
    brand,
    category,
    condition,
    storage,
    tracking,
    quantity: tracking === "NONE" ? quantity : identities.length,
    costPrice,
    minimumPrice,
    sellingPrice,
    identities,
  }

  const plan: CorrectionPlan = {
    changes: [],
    newItems: [newItem],
    problems: [],
  }

  const problems = await databaseProblems(plan, gate.lines, gate.record.purchaseId)
  if (problems.length) return { error: problems.slice(0, 4).join(" "), problems }

  try {
    await applyPlan(gate, plan, "screen")
  } catch {
    return { error: "We could not add the unlisted item. Try again." }
  }

  return { applied: true, preview: describe(plan, gate.lines) }
}

type RemoveResult = { error?: string; problems?: string[]; success?: boolean; removedLines?: number; removedUnits?: number }

async function openingUnits(purchaseId: string, productIds?: string[]) {
  return prisma.imeiRecord.findMany({
    where: { purchaseId, ...(productIds ? { productId: { in: productIds } } : {}) },
    select: {
      id: true,
      imei1: true,
      serialNumber: true,
      productId: true,
      branchId: true,
      status: true,
      _count: { select: { saleItems: true, returns: true, returnReplacements: true, repairs: true, swapsOld: true, swapsNew: true } },
    },
  })
}

/**
 * What taking these opening lines off would do to the shelf, and anything that
 * stops it: a unit already sold, moved, sent back or repaired, or pieces the
 * shelf no longer holds. Then the line is part of the shop's history.
 */
function planTakeOff(lines: BookLine[], units: Awaited<ReturnType<typeof openingUnits>>, branchId: string) {
  const names = new Map(lines.map((line) => [line.productId, line.name]))
  const problems: string[] = []
  for (const unit of units) {
    const who = `${names.get(unit.productId) ?? "Item"}: ${identityOf(unit)}`
    const used = Object.values(unit._count).some((n) => n > 0)
    if (used) problems.push(`${who} already has a sale, return, repair or swap on it.`)
    else if (unit.branchId !== branchId) problems.push(`${who} has been moved to another shop.`)
    else if (unit.status !== "IN_STOCK" && unit.status !== "FAULTY") {
      problems.push(`${who} is no longer on the shelf (${unit.status.toLowerCase().replace(/_/g, " ")}).`)
    }
  }
  const unitsOnShelf = new Map<string, number>()
  for (const unit of units) {
    if (unit.status === "IN_STOCK") unitsOnShelf.set(unit.productId, (unitsOnShelf.get(unit.productId) ?? 0) + 1)
  }
  const takeOff = lines
    .map((line) => ({
      line,
      quantity: line.tracking === "NONE" ? line.openingQty : unitsOnShelf.get(line.productId) ?? 0,
    }))
    .filter((row) => row.quantity > 0)
  for (const { line, quantity } of takeOff) {
    if (line.tracking === "NONE" && quantity > line.shelfQty) {
      problems.push(`${line.name}: opened with ${quantity} but the shelf holds ${line.shelfQty}. Some were sold or moved.`)
    }
  }
  return { problems, takeOff }
}

async function lowerShelves(
  tx: Tx,
  takeOff: ReturnType<typeof planTakeOff>["takeOff"],
  branchId: string,
  reference: string,
  userId: string
) {
  for (const { line, quantity } of takeOff) {
    const shelf = await tx.inventory.findUnique({
      where: { productId_branchId: { productId: line.productId, branchId } },
      select: { quantity: true },
    })
    const now = shelf?.quantity ?? 0
    const next = Math.max(0, now - quantity)
    if (next === now) continue
    await tx.inventory.update({
      where: { productId_branchId: { productId: line.productId, branchId } },
      data: { quantity: next, lastStockCheck: new Date() },
    })
    await recordMovement(tx, {
      productId: line.productId,
      branchId,
      quantity: next - now,
      move: { kind: "OPENING", reference, userId },
    })
  }
}

/**
 * Take chosen lines off a shop's opening stock, while it is still open: ticked
 * items, or every item in one category. Each line's IMEIs and serials are
 * deleted (so they can be loaded onto the right shop), the shelf comes down by
 * the opening count, and the line leaves the opening bill.
 */
export async function removeOpeningLines(formData: FormData): Promise<RemoveResult> {
  const branchId = String(formData.get("branchId") || "")
  const gate = await correctionGate(branchId)
  if ("error" in gate) return { error: gate.error }
  const { record, userId } = gate

  let wanted: string[]
  try {
    const raw = JSON.parse(String(formData.get("productIds") || "[]"))
    wanted = Array.isArray(raw) ? [...new Set(raw.map(String))] : []
  } catch {
    wanted = []
  }
  const lines = gate.lines.filter((line) => wanted.includes(line.productId))
  if (!lines.length) return { error: "Tick the items to remove first." }
  if (lines.length !== wanted.length) {
    return { error: "Some of those items are no longer on this opening stock. Refresh and tick them again." }
  }

  const productIds = lines.map((line) => line.productId)
  const units = await openingUnits(record.purchaseId, productIds)
  const { problems, takeOff } = planTakeOff(lines, units, branchId)
  if (problems.length) {
    return {
      error: `${problems.length} unit(s) on those items have already been used, so nothing was removed. Untick those items, or take off only the unused IMEIs.`,
      problems: problems.slice(0, 60),
    }
  }

  const before = totals(gate.lines)
  const removedValue = totals(lines).value
  const reason = String(formData.get("reason") || "").trim() || null
  const reference = `Opening stock lines removed · ${record.invoiceNumber}`
  try {
    await prisma.$transaction(
      async (tx) => {
        const stillOpen = await tx.openingStock.updateMany({
          where: { id: record.id, status: "OPEN" },
          data: { updatedAt: new Date() },
        })
        if (stillOpen.count !== 1) throw new Error("gone")

        await lowerShelves(tx, takeOff, branchId, reference, userId)
        await tx.imeiRecord.deleteMany({ where: { id: { in: units.map((unit) => unit.id) } } })
        await tx.purchaseItem.deleteMany({ where: { purchaseId: record.purchaseId, productId: { in: productIds } } })

        const left = await tx.purchaseItem.findMany({ where: { purchaseId: record.purchaseId }, select: { totalAmount: true } })
        const total = left.reduce((sum, row) => sum + money(row.totalAmount), 0)
        await tx.purchase.update({
          where: { id: record.purchaseId },
          data: { totalAmount: total.toFixed(2), paidAmount: total.toFixed(2), paymentMethod: OPENING_STOCK_METHOD },
        })
        await tx.auditLog.create({
          data: {
            userId,
            action: "DELETE",
            entityType: "OpeningStock",
            entityId: record.invoiceNumber,
            oldValue: JSON.stringify(before),
            newValue: JSON.stringify({
              value: total,
              removedLines: lines.length,
              removedValue,
              unitsDeleted: units.length,
              numbers: units.map(identityOf).slice(0, 2000),
              lines: lines.map((line) => `${line.name} (${line.sku}) · ${line.category} · ${line.openingQty}`).slice(0, 500),
              reason,
              note: `${lines.length} line(s) removed from opening stock.`,
            }),
            branchId,
            risk: "HIGH",
          },
        })
      },
      { timeout: 120_000, maxWait: 20_000 }
    )
  } catch (error) {
    if (error instanceof Error && error.message === "gone") {
      return { error: "This opening stock was closed or removed a moment ago. Refresh to see it." }
    }
    return { error: "We could not remove those items. Nothing was changed. Try again." }
  }

  revalidateOpening()
  return { success: true, removedLines: lines.length, removedUnits: units.length }
}

/**
 * Take a shop's whole opening stock off, while it is still open. For a sheet
 * loaded onto the wrong shop: every IMEI and serial it booked is deleted (so the
 * same file can be loaded onto the right shop), the shelf comes down by the
 * opening counts, and the opening bill goes. The shop is back to Not loaded.
 *
 * Refused if any of it has already been sold, moved, sent back or repaired,
 * because then the opening stock is part of the shop's history.
 */
export async function removeOpeningStock(formData: FormData): Promise<RemoveResult> {
  const user = await requireUser()
  if (!isShopOwner(user.role)) return { error: "Only the CEO or the main admin can remove a shop's opening stock." }

  const branchId = String(formData.get("branchId") || "")
  const record = await prisma.openingStock.findUnique({
    where: { branchId },
    include: { branch: true, purchase: { select: { invoiceNumber: true, notes: true, _count: { select: { incomingLots: true } } } } },
  })
  if (!record) return { error: "This shop has no opening stock to remove." }
  if (record.status === "CLOSED") {
    return { error: "This shop's opening stock is closed, so it can no longer be removed. Use Stock count or Reduce stock." }
  }
  const typed = String(formData.get("confirmName") || "").trim().toLowerCase()
  if (typed !== record.branch.name.trim().toLowerCase()) {
    return { error: `Type the shop name exactly as shown (${record.branch.name}) to confirm.` }
  }
  if (record.purchase._count.incomingLots > 0) {
    return { error: "Goods on the way were booked against this opening bill. Cancel them on Goods on the way first." }
  }

  const invoiceNumber = record.purchase.invoiceNumber
  const [lines, units] = await Promise.all([liveLines(record.purchaseId, branchId), openingUnits(record.purchaseId)])
  const { problems, takeOff } = planTakeOff(lines, units, branchId)
  if (problems.length) {
    return {
      error: `${problems.length} item(s) from this opening stock have already been used, so it cannot be removed as a whole. Remove the other items by ticking them instead.`,
      problems: problems.slice(0, 60),
    }
  }

  const before = totals(lines)
  const reference = `Opening stock removed · ${invoiceNumber}`
  try {
    await prisma.$transaction(
      async (tx) => {
        // Claim it first, so two people pressing Remove cannot both run.
        const claimed = await tx.openingStock.deleteMany({ where: { id: record.id, status: "OPEN" } })
        if (claimed.count !== 1) throw new Error("gone")

        await lowerShelves(tx, takeOff, branchId, reference, user.id)
        await tx.imeiRecord.deleteMany({ where: { id: { in: units.map((unit) => unit.id) } } })
        await tx.purchase.delete({ where: { id: record.purchaseId } })
        await tx.auditLog.create({
          data: {
            userId: user.id,
            action: "DELETE",
            entityType: "OpeningStock",
            entityId: invoiceNumber,
            oldValue: JSON.stringify({ shop: record.branch.name, ...before }),
            newValue: JSON.stringify({
              removed: true,
              shop: record.branch.name,
              unitsDeleted: units.length,
              numbers: units.map(identityOf).slice(0, 2000),
              lines: takeOff.map(({ line, quantity }) => `${line.name} (${line.sku}) −${quantity}`).slice(0, 500),
              reason: String(formData.get("reason") || "").trim() || null,
              note: `Opening stock for ${record.branch.name} removed. The shop is back to Not loaded.`,
            }),
            branchId,
            risk: "HIGH",
          },
        })
      },
      { timeout: 120_000, maxWait: 20_000 }
    )
  } catch (error) {
    if (error instanceof Error && error.message === "gone") {
      return { error: "Someone changed this opening stock a moment ago. Refresh to see it." }
    }
    return { error: "We could not remove this opening stock. Nothing was changed. Try again." }
  }

  revalidateOpening()
  revalidatePath("/dashboard")
  revalidatePath("/uploads")
  return { success: true }
}

/**
 * Close a shop's opening stock. After this only a CEO or Super Admin reopen can change it, and the shop
 * can start selling.
 */
export async function closeOpeningStock(formData: FormData): Promise<{ error?: string; problems?: string[]; success?: boolean }> {
  const user = await requireUser()
  if (!canCloseRole(user.role)) return { error: "Only the CEO, Auditor, Accountant, or Super Admin can close opening stock." }
  if (String(formData.get("confirm") || "") !== "yes") {
    return { error: "Tick the box to confirm the count is final." }
  }

  const branchId = String(formData.get("branchId") || "")
  const record = await prisma.openingStock.findUnique({
    where: { branchId },
    include: { branch: true, purchase: { select: { invoiceNumber: true, notes: true } } },
  })
  if (!record) return { error: "This shop has no opening stock to close." }
  if (record.status === "CLOSED") return { error: "This shop's opening stock is already closed." }

  const lines = await liveLines(record.purchaseId, branchId)
  const unpriced = lines.filter(
    (line) => line.openingQty > 0 && (line.costPrice <= 0 || line.minimumPrice <= 0 || line.sellingPrice <= 0)
  )
  if (unpriced.length) {
    return {
      error: `${unpriced.length} item(s) still have a zero price. Fill in the cost, lowest and standard selling price before closing.`,
      problems: unpriced.slice(0, 40).map((line) => `${line.name} (${line.sku})`),
    }
  }

  const sum = totals(lines)
  const closedAt = new Date()
  // Only what was really there goes into the closed copy.
  const snapshot: Snapshot = { lines: lines.filter((line) => line.openingQty > 0).map((line) => ({ ...line, shelfQty: line.openingQty })) }

  for (const line of lines.filter((l) => l.openingQty > 0)) {
    const before = await prisma.product.findUnique({ where: { id: line.productId }, select: { costPrice: true } })
    await prisma.product.update({
      where: { id: line.productId },
      data: {
        costPrice: line.costPrice.toFixed(2),
        minimumPrice: line.minimumPrice.toFixed(2),
        sellingPrice: line.sellingPrice.toFixed(2),
      },
    })
    // Sales made before the sheet was closed carry the cost the item had then:
    // none, or the figure since corrected on this sheet. Both become the
    // sheet's cost, the true cost of the unit sold.
    const wrongCosts = [new Prisma.Decimal(0)]
    if (before && money(before.costPrice) !== line.costPrice) wrongCosts.push(before.costPrice)
    await prisma.saleItem.updateMany({
      where: {
        productId: line.productId,
        sale: { branchId },
        costPrice: { in: wrongCosts },
      },
      data: {
        costPrice: line.costPrice.toFixed(2),
      },
    })
  }

  const done = await prisma.openingStock.updateMany({
    where: { id: record.id, status: "OPEN" },
    data: {
      status: "CLOSED",
      closedAt,
      closedBy: user.id,
      closedValue: sum.value.toFixed(2),
      closedQuantity: sum.quantity,
      closedLines: sum.lines,
      snapshot: JSON.stringify(snapshot),
    },
  })
  if (done.count !== 1) return { error: "Someone closed this opening stock a moment ago. Refresh to see it." }

  await prisma.purchase.update({
    where: { id: record.purchaseId },
    data: {
      notes: [record.purchase.notes, `Opening stock closed ${watDayKey(closedAt)} at ₦${sum.value.toLocaleString("en-NG")}.`]
        .filter(Boolean)
        .join(" "),
    },
  })
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "APPROVE",
      entityType: "OpeningStock",
      entityId: record.purchase.invoiceNumber,
      newValue: JSON.stringify({ closed: true, shop: record.branch.name, ...sum }),
      branchId,
      risk: "HIGH",
    },
  })

  revalidateOpening()
  revalidatePath("/dashboard")
  return { success: true }
}

/**
 * Open a closed opening stock again, so a wrong count or a guessed price can be
 * fixed. CEO or Super Admin only, and always with a reason.
 *
 * The shop keeps selling. Everything already sold stays sold: a correction
 * still cannot take the count below what is on the shelf, or take off a unit
 * that was sold. When it is right, close it again as before.
 */
export async function reopenOpeningStock(formData: FormData): Promise<{ error?: string; success?: boolean }> {
  const user = await requireUser()
  if (!isShopOwner(user.role)) return { error: "Only the CEO or Super Admin can reopen opening stock." }
  const branchId = String(formData.get("branchId") || "")
  const reason = String(formData.get("reason") || "").trim()
  if (reason.length < 5) return { error: "Say why it is being reopened, for example: prices on the sheet were guesses." }

  const record = await prisma.openingStock.findUnique({
    where: { branchId },
    include: { branch: true, purchase: { select: { invoiceNumber: true, notes: true } } },
  })
  if (!record) return { error: "This shop has no opening stock." }
  if (record.status !== "CLOSED") return { error: "This shop's opening stock is already open." }

  const reopenedAt = new Date()
  const done = await prisma.openingStock.updateMany({
    where: { id: record.id, status: "CLOSED" },
    data: {
      status: "OPEN",
      closedAt: null,
      closedBy: null,
      closedValue: null,
      closedQuantity: null,
      closedLines: null,
      snapshot: null,
      reopenedAt,
      reopenedBy: user.id,
      reopenReason: reason,
    },
  })
  if (done.count !== 1) return { error: "Someone reopened this opening stock a moment ago. Refresh to see it." }

  await prisma.purchase.update({
    where: { id: record.purchaseId },
    data: {
      notes: [record.purchase.notes, `Opening stock reopened ${watDayKey(reopenedAt)}: ${reason}.`]
        .filter(Boolean)
        .join(" "),
    },
  })
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "UPDATE",
      entityType: "OpeningStock",
      entityId: record.purchase.invoiceNumber,
      // The figures it was closed at, so the first close can still be read later.
      oldValue: JSON.stringify({
        closedAt: record.closedAt,
        closedBy: record.closedBy,
        value: money(record.closedValue),
        quantity: record.closedQuantity,
        lines: record.closedLines,
      }),
      newValue: JSON.stringify({ reopened: true, shop: record.branch.name, reason }),
      branchId,
      risk: "HIGH",
    },
  })

  revalidateOpening()
  revalidatePath("/dashboard")
  return { success: true }
}

/**
 * Opening stock for Reports: the fixed opening position of each shop, kept
 * apart from goods bought afterwards.
 */
export async function getOpeningReport(requestedBranchId?: string) {
  const user = await requireUser()
  await healOpeningStockBills()
  if (!(await can(user.role, "view.reports"))) return { shops: [], lines: [], boughtSince: [] }
  const scoped = await scopedBranchId(user.role, user.branchId, requestedBranchId)
  const branchId = scoped || requestedBranchId || null

  const records = await prisma.openingStock.findMany({
    where: branchId ? { branchId } : undefined,
    include: { branch: true, purchase: { select: { invoiceNumber: true } } },
  })

  const shops: Array<{
    shop: string
    code: string
    status: "OPEN" | "CLOSED"
    invoiceNumber: string
    value: number
    quantity: number
    lines: number
    closedAt: string | null
  }> = []
  const lines: Array<BookLine & { shop: string; status: "OPEN" | "CLOSED" }> = []

  for (const record of records) {
    const book =
      record.status === "CLOSED" && record.snapshot
        ? (JSON.parse(record.snapshot) as Snapshot).lines
        : (await liveLines(record.purchaseId, record.branchId)).filter((line) => line.openingQty > 0)
    const sum = totals(book)
    shops.push({
      shop: record.branch.name,
      code: record.branch.code,
      status: record.status,
      invoiceNumber: record.purchase.invoiceNumber,
      value: record.status === "CLOSED" ? money(record.closedValue) : sum.value,
      quantity: record.status === "CLOSED" ? record.closedQuantity ?? 0 : sum.quantity,
      lines: record.status === "CLOSED" ? record.closedLines ?? 0 : sum.lines,
      closedAt: record.closedAt?.toISOString() ?? null,
    })
    for (const line of book) lines.push({ ...line, shop: record.branch.code, status: record.status })
  }

  const bills = await prisma.purchase.findMany({
    where: {
      ...payablePurchaseWhere,
      ...(branchId ? { branchId } : {}),
    },
    include: { supplier: { select: { name: true } }, branch: { select: { code: true } } },
    orderBy: { createdAt: "desc" },
  })
  const boughtSince = bills.map((bill) => ({
    id: bill.id,
    invoiceNumber: bill.invoiceNumber,
    supplier: bill.supplier.name,
    shop: bill.branch.code,
    date: (bill.receivedDate ?? bill.createdAt).toISOString(),
    total: money(bill.totalAmount),
    paid: money(bill.paidAmount),
    owed: purchaseBalance(bill.totalAmount, bill.paidAmount, bill.returnedAmount).owed,
  }))

  // The opening shelf at cost is the CEO's to see. Everyone else still gets the
  // counts, the lines and the supplier bills, with the cost left out.
  if (!canSeeCost(user.role)) {
    for (const shop of shops) shop.value = 0
    for (const line of lines) line.costPrice = 0
  }

  return { shops, lines, boughtSince }
}

export type OpeningReport = Awaited<ReturnType<typeof getOpeningReport>>
export type OpeningBook = NonNullable<Awaited<ReturnType<typeof getOpeningBook>>>
export type { OpeningChange }
