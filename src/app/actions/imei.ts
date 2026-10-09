"use server"

import { revalidatePath } from "next/cache"
import { PRODUCT_SPEC_SELECT } from "@/lib/product-specs"
import { IMEIStatus, type Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { recordMovement } from "@/lib/concurrency"
import { canReachBranch, viewBranchFilter } from "@/lib/branch-scope"
import { requireUser } from "@/lib/session"
import { canChangeCost, canManageCatalog, canSeeCost } from "@/lib/rbac"
import { can } from "@/lib/permissions"
import { recentWatDays, watBounds } from "@/lib/lagos-day"
import { IMEI_LIFE } from "@/lib/imei-life"
import { displayPartyName } from "@/lib/party-key"
import { findDuplicateSupplier } from "@/lib/supplier-identity"
import { formatDateTime, money } from "@/lib/utils"
import { normalizeStorage } from "@/lib/item-specs"
import { shopConditionLabel } from "@/lib/conditions"
import { phoneLookLabel } from "@/lib/phone-look"
import { statusLabel } from "@/lib/status"
import {
  cleanUnitCode,
  defaultIdentityFor,
  unitCodeProblem,
  unitIdentityColumns,
  unitIdentityKind,
  unitIdentityLabel,
  type UnitIdentityKind,
} from "@/lib/unit-identity"

/** Every number on the system that already names a unit, other than `exceptId`. */
async function unitCodesTaken(codes: string[], exceptId?: string) {
  const wanted = [...new Set(codes.filter(Boolean))]
  if (!wanted.length) return []
  const rows = await prisma.imeiRecord.findMany({
    where: {
      ...(exceptId ? { id: { not: exceptId } } : {}),
      OR: [{ imei1: { in: wanted } }, { imei2: { in: wanted } }, { serialNumber: { in: wanted } }],
    },
    select: { imei1: true, imei2: true, serialNumber: true },
  })
  const used = new Set(rows.flatMap((row) => [row.imei1, row.imei2, row.serialNumber].filter(Boolean) as string[]))
  return wanted.filter((code) => used.has(code))
}

function readIdentityKind(formData: FormData, fallback: UnitIdentityKind): UnitIdentityKind {
  const raw = String(formData.get("identityKind") || fallback).toUpperCase()
  return raw === "SERIAL" ? "SERIAL" : "IMEI"
}

function whenBounds(when?: string) {
  if (!when || when === "all") return null
  const days = when === "today" ? 1 : when === "week" ? 7 : when === "month" ? 30 : 0
  if (!days) return null
  const keys = recentWatDays(days)
  const newest = watBounds(keys[0])
  const oldest = watBounds(keys[keys.length - 1])
  return { start: oldest.start, end: newest.end }
}

export async function getImeiStatusCounts() {
  const user = await requireUser()
  const branchId = await viewBranchFilter(user)
  const rows = await prisma.imeiRecord.groupBy({
    by: ["status"],
    where: branchId ? { branchId } : {},
    _count: { _all: true },
  })
  const byStatus = Object.fromEntries(rows.map((row) => [row.status, row._count._all])) as Record<string, number>
  const total = rows.reduce((sum, row) => sum + row._count._all, 0)
  const byLife = Object.fromEntries(
    IMEI_LIFE.map((life) => [life.key, life.statuses.reduce((sum, status) => sum + (byStatus[status] ?? 0), 0)])
  ) as Record<string, number>
  return { total, byStatus, byLife }
}

/** The All phones filters, shared by the list and its download so both show the same phones. */
function imeiListWhere(branchId: string | null | undefined, search?: string, status?: string, life?: string, when?: string): Prisma.ImeiRecordWhereInput {
  const lifeBucket = IMEI_LIFE.find((row) => row.key === life)
  const range = whenBounds(when)
  return {
      ...(branchId ? { branchId } : {}),
      ...(status
        ? { status: status as IMEIStatus }
        : lifeBucket
          ? { status: { in: [...lifeBucket.statuses] } }
          : {}),
      ...(range ? { updatedAt: { gte: range.start, lt: range.end } } : {}),
      ...(search
        ? {
            OR: [
              { imei1: { contains: search } },
              { imei2: { contains: search } },
              { serialNumber: { contains: search } },
              { product: { name: { contains: search, mode: "insensitive" } } },
              // "256GB", "Blue" and the like find the phones that carry them.
              { product: { storage: { contains: search, mode: "insensitive" } } },
              { product: { color: { contains: search, mode: "insensitive" } } },
            ],
          }
        : {}),
  }
}

export async function getImeiRecords(search?: string, status?: string, life?: string, when?: string) {
  const user = await requireUser()
  const branchId = await viewBranchFilter(user)

  const rows = await prisma.imeiRecord.findMany({
    where: imeiListWhere(branchId, search, status, life, when),
    select: {
      id: true,
      imei1: true,
      serialNumber: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      cosmeticGrade: true,
      batteryHealth: true,
      product: { select: { name: true, warrantyDays: true, ...PRODUCT_SPEC_SELECT } },
      branch: { select: { code: true } },
      customer: { select: { name: true } },
      supplier: { select: { name: true } },
      sale: { select: { saleDate: true } },
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    take: 500,
  })

  // Hand only plain values to Client Components — no Prisma Decimal bags.
  return rows.map((row) => ({
    id: row.id,
    imei1: row.imei1,
    serialNumber: row.serialNumber,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    cosmeticGrade: row.cosmeticGrade,
    batteryHealth: row.batteryHealth,
    product: {
      name: row.product.name,
      warrantyDays: row.product.warrantyDays,
      storage: row.product.storage,
      ram: row.product.ram,
      color: row.product.color,
      condition: row.product.condition,
    },
    branch: { code: row.branch.code },
    customer: row.customer ? { name: row.customer.name } : null,
    supplier: row.supplier ? { name: row.supplier.name } : null,
    sale: row.sale ? { saleDate: row.sale.saleDate } : null,
  }))
}

export async function intakeImei(formData: FormData) {
  const user = await requireUser()
  if (!(await can(user.role, "action.intake"))) return { error: "You are not allowed to receive phones. Ask the main admin." }
  const imei1 = cleanUnitCode(String(formData.get("imei1") ?? ""))
  const productId = String(formData.get("productId") ?? "")
  const branchId = String(formData.get("branchId") ?? user.branchId ?? "")

  if (!productId || !branchId) return { error: "Pick the item and the shop." }

  const product = await prisma.product.findUnique({ where: { id: productId } })
  if (!product || !product.isActive) return { error: "That item is not on the active list." }

  const tracked = product.tracking !== "NONE"
  const quantityRaw = Number(formData.get("quantity") || (tracked ? 1 : 0))
  const quantity = tracked ? 1 : Math.floor(quantityRaw)
  if (!tracked && (!Number.isFinite(quantity) || quantity < 1)) {
    return { error: "Enter how many pieces you are putting on the shelf." }
  }
  const identityKind = readIdentityKind(formData, defaultIdentityFor(product.tracking))
  const identity = unitIdentityColumns({
    kind: identityKind,
    imei1,
    imei2: cleanUnitCode(String(formData.get("imei2") || "")),
    serialNumber: cleanUnitCode(String(formData.get("serialNumber") || "")),
  })
  if (tracked) {
    const problem = unitCodeProblem(identityKind, imei1)
    if (problem) return { error: problem }
    if (identity.imei2) {
      const imei2Problem = unitCodeProblem("IMEI", identity.imei2)
      if (imei2Problem) return { error: `IMEI 2: ${imei2Problem}` }
    }
  }

  // Only a price setter (CEO, main admin, branch manager) types prices here.
  // Anyone else receives at the price list's own prices, whatever the form sends.
  const typesPrices = canChangeCost(user.role)
  const costPrice = typesPrices ? Number(formData.get("costPrice") || 0) : money(product.costPrice)
  const minimumPrice = typesPrices ? Number(formData.get("minimumPrice") || 0) : money(product.minimumPrice)
  const sellingPrice = typesPrices ? Number(formData.get("sellingPrice") || 0) : money(product.sellingPrice)
  if (![costPrice, minimumPrice, sellingPrice].every((value) => Number.isFinite(value) && value >= 0)) {
    return { error: "Enter cost, lowest sell, and selling price as numbers." }
  }
  // A price that has fallen since we bought is a real thing (a phone ordered
  // last week can be worth less by the time it lands). The CEO or Super Admin
  // may mark the lowest sell under cost; everyone else is stopped here.
  // These guard prices someone types. The list's own prices are the CEO's to fix.
  if (typesPrices && minimumPrice < costPrice && !(await can(user.role, "action.override_floor"))) {
    return { error: "Lowest sell cannot sit below cost." }
  }
  if (typesPrices && sellingPrice < minimumPrice) {
    return { error: "Selling price cannot sit below the lowest sell." }
  }

  if (tracked) {
    const taken = await unitCodesTaken([identity.imei1, identity.imei2 ?? "", identity.serialNumber ?? ""])
    if (taken.length) return { error: `Already on the system: ${taken.join(", ")}.` }
  }

  let supplierId = String(formData.get("supplierId") || "").trim()
  if (supplierId === "__new__") supplierId = ""
  const newSupplierName = String(formData.get("newSupplierName") || "").trim()
  const newSupplierPhone = String(formData.get("newSupplierPhone") || "").trim()
  if (newSupplierName) {
    if (!newSupplierPhone) return { error: "Type the new supplier phone number." }
    const clash = await findDuplicateSupplier({ name: newSupplierName, phone: newSupplierPhone })
    if (clash) return clash
    const created = await prisma.supplier.create({
      data: {
        name: displayPartyName(newSupplierName),
        phone: newSupplierPhone,
        city: String(formData.get("newSupplierCity") || "").trim() || null,
      },
    })
    supplierId = created.id
    revalidatePath("/suppliers")
  }

  const cosmeticGrade = String(formData.get("cosmeticGrade") || "") || null
  const isFaulty = cosmeticGrade === "FAULTY"
  const status = isFaulty ? "FAULTY" : "IN_STOCK"
  // Receiving a phone never moves the list price unless the CEO is receiving it.
  const priceChanged =
    typesPrices &&
    (money(product.costPrice) !== costPrice ||
      money(product.minimumPrice) !== minimumPrice ||
      money(product.sellingPrice) !== sellingPrice)

  await prisma.$transaction(async (tx) => {
    if (priceChanged) {
      await tx.product.update({
        where: { id: productId },
        data: {
          costPrice: costPrice.toFixed(2),
          minimumPrice: minimumPrice.toFixed(2),
          sellingPrice: sellingPrice.toFixed(2),
        },
      })
    }

    if (tracked) {
      await tx.imeiRecord.create({
        data: {
          ...identity,
          productId,
          supplierId: supplierId || null,
          branchId,
          status,
          notes: String(formData.get("notes") || "") || null,
          cosmeticGrade,
          batteryHealth: null,
          conditionNotes: String(formData.get("conditionNotes") || "") || null,
          photoData: String(formData.get("photoData") || "") || null,
        },
      })
    }

    const addQty = tracked ? (isFaulty ? 0 : 1) : quantity
    if (addQty > 0) {
      await tx.inventory.upsert({
        where: { productId_branchId: { productId, branchId } },
        update: { quantity: { increment: addQty } },
        create: { productId, branchId, quantity: addQty },
      })
      await recordMovement(tx, {
        productId,
        branchId,
        quantity: addQty,
        move: { kind: "RECEIVED", reference: tracked ? imei1 : product.sku, userId: user.id },
      })
    }

    await tx.auditLog.create({
      data: {
        userId: user.id,
        action: "CREATE",
        entityType: tracked ? "IMEIRecord" : "Inventory",
        entityId: tracked ? imei1 : productId,
        newValue: JSON.stringify({
          productId,
          branchId,
          status: tracked ? status : "IN_STOCK",
          cosmeticGrade,
          identity: tracked ? unitIdentityLabel(identityKind) : null,
          quantity: tracked ? 1 : quantity,
          costPrice,
          minimumPrice,
          sellingPrice,
          note: isFaulty && tracked
            ? "Received as Faulty. Not added to sellable In shop stock."
            : priceChanged
              ? "Received on One phone at a time. Item prices updated."
              : "Received on One phone at a time.",
        }),
        branchId,
      },
    })
  })

  revalidatePath("/imei")
  revalidatePath("/inventory")
  revalidatePath("/products")
  revalidatePath("/pos")
  return { success: true }
}

export async function updateImeiCondition(formData: FormData) {
  const user = await requireUser()
  if (!(await can(user.role, "action.intake")) && !(await can(user.role, "action.repair"))) {
    return { error: "You are not allowed to change the condition of a phone. Ask the main admin." }
  }
  const id = String(formData.get("id") || "")
  if (!id) return { error: "Phone record missing." }

  const current = await prisma.imeiRecord.findUnique({ where: { id } })
  if (!current) return { error: "We could not find that phone." }

  if (current.status !== "IN_STOCK" && current.status !== "FAULTY") {
    return { error: "Only In shop or Damaged phones can change how they look here." }
  }

  const nextGrade = String(formData.get("cosmeticGrade") || "") || null
  const willBeDamaged = nextGrade === "FAULTY"
  const conditionNotes = String(formData.get("conditionNotes") || "") || null
  const photoData = String(formData.get("photoData") || "") || null

  // Picking Damaged / Faulty look moves shelf state with it. Picking a good look
  // while Damaged puts the phone back on sellable In shop stock.
  if (willBeDamaged && current.status === "IN_STOCK") {
    return applyShelfState({
      userId: user.id,
      current,
      shelfState: "DAMAGED",
      cosmeticGrade: "FAULTY",
      conditionNotes,
      photoData,
    })
  }

  if (!willBeDamaged && current.status === "FAULTY") {
    return applyShelfState({
      userId: user.id,
      current,
      shelfState: "GOOD",
      cosmeticGrade: nextGrade,
      conditionNotes,
      photoData,
    })
  }

  await prisma.imeiRecord.update({
    where: { id },
    data: {
      cosmeticGrade: nextGrade,
      conditionNotes,
      photoData,
    },
  })
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "UPDATE",
      entityType: "IMEIRecord",
      entityId: id,
      newValue: JSON.stringify({ cosmeticGrade: nextGrade }),
      branchId: user.branchId,
    },
  })

  revalidatePath("/imei")
  revalidatePath(`/imei/${id}`)
  revalidatePath("/inventory")
  revalidatePath("/pos")
  return { success: true }
}

export async function setImeiShelfState(formData: FormData) {
  const user = await requireUser()
  if (!(await can(user.role, "action.intake")) && !(await can(user.role, "action.repair"))) {
    return { error: "You are not allowed to change Good or Damaged on a phone. Ask the main admin." }
  }
  const id = String(formData.get("id") || "")
  const shelfState = String(formData.get("shelfState") || "").toUpperCase()
  if (!id) return { error: "Phone record missing." }
  if (shelfState !== "GOOD" && shelfState !== "DAMAGED") {
    return { error: "Pick Good (sellable) or Damaged." }
  }

  const current = await prisma.imeiRecord.findUnique({ where: { id } })
  if (!current) return { error: "We could not find that phone." }
  if (current.status !== "IN_STOCK" && current.status !== "FAULTY") {
    return { error: "Only In shop or Damaged phones can switch between Good and Damaged." }
  }

  return applyShelfState({
    userId: user.id,
    current,
    shelfState: shelfState as "GOOD" | "DAMAGED",
    cosmeticGrade: shelfState === "DAMAGED" ? "FAULTY" : current.cosmeticGrade === "FAULTY" ? "UK" : current.cosmeticGrade,
  })
}

async function applyShelfState(input: {
  userId: string
  current: {
    id: string
    productId: string
    branchId: string
    status: string
    cosmeticGrade: string | null
    imei1: string
  }
  shelfState: "GOOD" | "DAMAGED"
  cosmeticGrade?: string | null
  conditionNotes?: string | null
  photoData?: string | null
}) {
  const { userId, current, shelfState } = input
  const nextStatus = shelfState === "DAMAGED" ? "FAULTY" : "IN_STOCK"
  const nextGrade =
    input.cosmeticGrade !== undefined
      ? input.cosmeticGrade
      : shelfState === "DAMAGED"
        ? "FAULTY"
        : current.cosmeticGrade === "FAULTY"
          ? "UK"
          : current.cosmeticGrade

  if (current.status === nextStatus && (current.cosmeticGrade ?? null) === (nextGrade ?? null)) {
    return { success: true }
  }

  const leavingSellable = current.status === "IN_STOCK" && nextStatus === "FAULTY"
  const returningSellable = current.status === "FAULTY" && nextStatus === "IN_STOCK"

  await prisma.$transaction(async (tx) => {
    await tx.imeiRecord.update({
      where: { id: current.id },
      data: {
        status: nextStatus,
        cosmeticGrade: nextGrade,
        ...(input.conditionNotes !== undefined ? { conditionNotes: input.conditionNotes } : {}),
        ...(input.photoData !== undefined ? { photoData: input.photoData } : {}),
      },
    })

    if (leavingSellable) {
      await tx.inventory.updateMany({
        where: { productId: current.productId, branchId: current.branchId, quantity: { gt: 0 } },
        data: { quantity: { decrement: 1 } },
      })
      await recordMovement(tx, {
        productId: current.productId,
        branchId: current.branchId,
        quantity: -1,
        move: { kind: "HAND_CORRECTION", reference: current.imei1, userId },
      })
    }
    if (returningSellable) {
      await tx.inventory.upsert({
        where: { productId_branchId: { productId: current.productId, branchId: current.branchId } },
        update: { quantity: { increment: 1 } },
        create: { productId: current.productId, branchId: current.branchId, quantity: 1 },
      })
      await recordMovement(tx, {
        productId: current.productId,
        branchId: current.branchId,
        quantity: 1,
        move: { kind: "HAND_CORRECTION", reference: current.imei1, userId },
      })
    }

    await tx.auditLog.create({
      data: {
        userId,
        action: "UPDATE",
        entityType: "IMEIRecord",
        entityId: current.id,
        oldValue: JSON.stringify({ status: current.status, cosmeticGrade: current.cosmeticGrade }),
        newValue: JSON.stringify({
          status: nextStatus,
          cosmeticGrade: nextGrade,
          shelfState,
          note:
            shelfState === "DAMAGED"
              ? "Set Damaged. Taken off sellable In shop stock."
              : "Set Good (sellable). Back on In shop stock for Sell now.",
        }),
        branchId: current.branchId,
        risk: "MEDIUM",
      },
    })
  })

  revalidatePath("/imei")
  revalidatePath(`/imei/${current.id}`)
  revalidatePath("/inventory")
  revalidatePath("/pos")
  return { success: true }
}

/**
 * Correct the number a unit is known by, or say it is a serial and not an IMEI.
 * Tablets and some phones arrive with only a serial, and a number typed wrong at
 * intake used to be stuck on the unit for good. The unit keeps its own id, so
 * its sale, returns, repairs and swaps stay attached.
 */
export async function updateUnitIdentity(formData: FormData) {
  const user = await requireUser()
  if (!(await canManageCatalog(user.role))) {
    return { error: "Only the main admin, the CEO, or someone given Add items and change prices can correct a unit's number." }
  }
  const id = String(formData.get("id") || "")
  if (!id) return { error: "Unit record missing." }
  const reason = String(formData.get("reason") || "").trim()
  if (!reason) return { error: "Write why you are changing this number, for example typed wrong at intake." }

  const current = await prisma.imeiRecord.findUnique({ where: { id }, include: { product: true } })
  if (!current) return { error: "We could not find that unit." }
  if (!(await canReachBranch(user, current.branchId))) return { error: "That unit belongs to another shop." }

  const kind = readIdentityKind(formData, unitIdentityKind(current))
  const next = unitIdentityColumns({
    kind,
    imei1: cleanUnitCode(String(formData.get("imei1") || "")),
    imei2: cleanUnitCode(String(formData.get("imei2") || "")),
    serialNumber: cleanUnitCode(String(formData.get("serialNumber") || "")),
  })
  const problem = unitCodeProblem(kind, next.imei1)
  if (problem) return { error: problem }
  if (next.imei2) {
    const imei2Problem = unitCodeProblem("IMEI", next.imei2)
    if (imei2Problem) return { error: `IMEI 2: ${imei2Problem}` }
    if (next.imei2 === next.imei1) return { error: "IMEI 2 cannot be the same as IMEI 1." }
  }

  const before = { imei1: current.imei1, imei2: current.imei2, serialNumber: current.serialNumber }
  const beforeKind = unitIdentityKind(current)
  if (
    beforeKind === kind &&
    before.imei1 === next.imei1 &&
    (before.imei2 ?? null) === next.imei2 &&
    (before.serialNumber ?? null) === next.serialNumber
  ) {
    return { success: true, message: "Nothing changed." }
  }

  const taken = await unitCodesTaken([next.imei1, next.imei2 ?? "", next.serialNumber ?? ""], id)
  if (taken.length) return { error: `Another unit already has: ${taken.join(", ")}.` }

  await prisma.$transaction([
    prisma.imeiRecord.update({ where: { id }, data: next }),
    prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "UPDATE",
        entityType: "IMEIRecord",
        entityId: id,
        oldValue: JSON.stringify({ ...before, identity: unitIdentityLabel(beforeKind) }),
        newValue: JSON.stringify({
          ...next,
          identity: unitIdentityLabel(kind),
          reason,
          note: `Unit number corrected on ${current.product.name}: ${before.imei1} to ${next.imei1} (${unitIdentityLabel(kind)}).`,
        }),
        branchId: current.branchId,
        risk: "MEDIUM",
      },
    }),
  ])

  revalidatePath("/imei")
  revalidatePath(`/imei/${id}`)
  revalidatePath("/inventory")
  revalidatePath("/pos")
  return { success: true }
}

export async function getImeiDetail(id: string) {
  const user = await requireUser()
  const record = await prisma.imeiRecord.findFirst({
    where: { OR: [{ id }, { imei1: id }] },
    include: {
      product: { include: { brand: true, category: true } },
      branch: true,
      supplier: true,
      customer: true,
      sale: { include: { customer: true, branch: true } },
      purchase: { select: { id: true, invoiceNumber: true } },
      returns: { include: { customer: true }, orderBy: { createdAt: "desc" } },
      repairs: { include: { customer: true }, orderBy: { createdAt: "desc" } },
      swapsOld: { include: { customer: true, newProduct: true }, orderBy: { createdAt: "desc" } },
      swapsNew: { include: { customer: true, newProduct: true }, orderBy: { createdAt: "desc" } },
    },
  })
  // A phone belongs to the shop holding it. Looking one up by IMEI must not
  // become a way to read another shop's stock and sales history.
  if (!(await canReachBranch(user, record?.branchId))) return null
  if (!record) return null
  // Older lines were written against the unit's number. If the number was
  // corrected since, find the lines written under the earlier numbers too.
  const corrections = await prisma.auditLog.findMany({
    where: { entityType: "IMEIRecord", entityId: record.id, oldValue: { contains: "imei1" } },
    select: { oldValue: true },
  })
  const earlierNumbers = corrections.flatMap((row) => {
    try {
      const old = JSON.parse(row.oldValue || "{}") as { imei1?: unknown }
      return typeof old.imei1 === "string" ? [old.imei1] : []
    } catch {
      return []
    }
  })
  const logs = await prisma.auditLog.findMany({
    where: {
      entityId: { in: [...new Set([record.id, record.imei1, ...earlierNumbers])] },
    },
    include: { user: { select: { id: true, name: true, email: true, role: true, branchId: true } } },
    orderBy: { createdAt: "desc" },
    take: 40,
  })
  return { record, logs }
}

export async function getInventory() {
  const user = await requireUser()
  const branchId = await viewBranchFilter(user)
  return prisma.inventory.findMany({
    where: {
      ...(branchId ? { branchId } : {}),
      branch: { isActive: true },
    },
    include: {
      product: { include: { brand: true, category: true } },
      branch: true,
    },
    orderBy: [{ incomingQty: "desc" }, { quantity: "asc" }],
  })
}

export async function getInStockImeiCounts() {
  const user = await requireUser()
  const branchId = await viewBranchFilter(user)
  const rows = await prisma.imeiRecord.groupBy({
    by: ["productId", "branchId"],
    where: { status: "IN_STOCK", ...(branchId ? { branchId } : {}) },
    _count: { _all: true },
  })
  return rows.map((row) => ({
    productId: row.productId,
    branchId: row.branchId,
    count: row._count._all,
  }))
}

export async function getIncomingImeiCounts() {
  const user = await requireUser()
  const branchId = await viewBranchFilter(user)
  const rows = await prisma.imeiRecord.groupBy({
    by: ["productId", "branchId"],
    where: { status: "INCOMING", ...(branchId ? { branchId } : {}) },
    _count: { _all: true },
  })
  return rows.map((row) => ({
    productId: row.productId,
    branchId: row.branchId,
    count: row._count._all,
  }))
}

export async function getSerializedProductIds() {
  await requireUser()
  const rows = await prisma.product.findMany({
    where: { tracking: { in: ["IMEI", "SERIAL"] } },
    select: { id: true },
  })
  return rows.map((row) => row.id)
}

/**
 * Every phone on All phones under the current search and filters, with all
 * its details, for reconciling against a count or a supplier list in Excel.
 * Not capped at the 500 the screen shows. Cost is included only for those
 * who may see it.
 */
export async function exportImeiRecords(search?: string, status?: string, life?: string, when?: string) {
  const user = await requireUser()
  if (!(await can(user.role, "view.imei"))) return { error: "You are not allowed to download the phone list." }
  const branchId = await viewBranchFilter(user)
  const showCost = canSeeCost(user.role)
  const rows = await prisma.imeiRecord.findMany({
    where: imeiListWhere(branchId, search, status, life, when),
    select: {
      imei1: true,
      imei2: true,
      serialNumber: true,
      status: true,
      cosmeticGrade: true,
      batteryHealth: true,
      conditionNotes: true,
      createdAt: true,
      updatedAt: true,
      product: {
        select: {
          name: true,
          sku: true,
          ...PRODUCT_SPEC_SELECT,
          costPrice: true,
          sellingPrice: true,
          brand: { select: { name: true } },
          category: { select: { name: true } },
        },
      },
      branch: { select: { name: true, code: true } },
      customer: { select: { name: true, phone: true } },
      supplier: { select: { name: true } },
      purchase: { select: { invoiceNumber: true } },
      sale: { select: { invoiceNumber: true, saleDate: true } },
    },
    orderBy: [{ product: { name: "asc" } }, { imei1: "asc" }],
    take: 50_000,
  })
  const header = [
    "IMEI 1",
    "IMEI 2",
    "Serial",
    "Item",
    "Item code",
    "Brand",
    "Category",
    "Storage",
    "RAM",
    "Colour",
    "Condition",
    "How it looks",
    "Battery %",
    "Status",
    "Shop",
    "Shop code",
    "Customer",
    "Customer phone",
    "Supplier",
    "Supplier bill",
    "Invoice",
    "Sold on",
    "Booked in",
    "Last change",
    "Selling price",
    ...(showCost ? ["Cost"] : []),
    "Notes",
  ]
  const day = (date: Date | null | undefined) => (date ? formatDateTime(date) : "")
  return {
    truncated: rows.length === 50_000,
    rows: [
      header,
      ...rows.map((row) => [
        row.imei1,
        row.imei2 ?? "",
        row.serialNumber ?? "",
        row.product.name,
        row.product.sku,
        row.product.brand?.name ?? "",
        row.product.category?.name ?? "",
        normalizeStorage(row.product.storage),
        row.product.ram ?? "",
        row.product.color ?? "",
        shopConditionLabel(row.product.condition) || row.product.condition,
        row.cosmeticGrade ? phoneLookLabel(row.cosmeticGrade) : "",
        row.batteryHealth ?? "",
        statusLabel(row.status),
        row.branch.name,
        row.branch.code,
        row.customer?.name ?? "",
        row.customer?.phone ?? "",
        row.supplier?.name ?? "",
        row.purchase?.invoiceNumber ?? "",
        row.sale?.invoiceNumber ?? "",
        day(row.sale?.saleDate),
        day(row.createdAt),
        day(row.updatedAt),
        money(row.product.sellingPrice),
        ...(showCost ? [money(row.product.costPrice)] : []),
        row.conditionNotes ?? "",
      ]),
    ] as Array<Array<string | number>>,
  }
}
