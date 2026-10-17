"use server"

import { revalidatePath } from "next/cache"
import { ProductCondition, ProductTracking } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { recordMovement, setStock } from "@/lib/concurrency"
import { requireUser } from "@/lib/session"
import { can } from "@/lib/permissions"
import { canSetPricesOnBill } from "@/lib/roles"
import { readTableFile, readWorkbookGrids } from "@/lib/table-file"
import { makeOpeningSku, openingProductKey, planOpeningStock, tabHasCostColumn } from "@/lib/opening-stock"
import { fillFromUnitList, unitListName } from "@/lib/opening-book"
import { planCustomers, planImeis, planStock, type CatalogItem, type ShopRef } from "@/lib/upload-plan"
import {
  OPENING_STOCK_ALL_SHOPS,
  OPENING_STOCK_METHOD,
  OPENING_STOCK_SUPPLIER_OPTION,
  OPENING_STOCK_SUPPLIER_PHONE,
  UPLOAD_STOCK_SOURCE,
  attachPurchaseLine,
  isMarkedPaidOnUpload,
  isOpeningStockSupplierName,
} from "@/lib/upload-purchase"
import { generateDocNumber, money } from "@/lib/utils"
import { watDayKey } from "@/lib/lagos-day"
import { mapBillCondition, normalizeStorage } from "@/lib/item-specs"
import { displayPartyName } from "@/lib/party-key"
import { ensureOpeningStockSupplier, findDuplicateSupplier } from "@/lib/supplier-identity"
import { resolveWritableShopId, viewBranchFilter } from "@/lib/branch-scope"
import { canSeeAllBranches } from "@/lib/rbac"
import { purchaseBalance, SUPPLIER_PAYMENT_NOTE } from "@/lib/purchase-money"
import { listPayingBanks, resolveSupplierPayChannel } from "@/lib/supplier-pay"

/**
 * Loading the shop system from a sheet or by hand.
 *
 * Manual adds and Excel loads create a real Goods from supplier bill (PO-…)
 * so accountants can see supplier, submission value, and paid or not paid.
 */

const MAX_BYTES = 25_000_000
const MAX_ROWS = 20_000
const WRITE_CHUNK = 400

function chunks<T>(rows: T[], size: number) {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

export type UploadResult = {
  error?: string
  success?: boolean
  added?: number
  skipped?: number
  /** How many IMEI/serial repeats were folded into one entry. */
  duplicates?: number
  products?: number
  phones?: number
  pieces?: number
  /** Hard blockers when error is set; soft notices when success is set. */
  problems?: string[]
  invoiceNumber?: string
  purchaseId?: string
  submissionValue?: number
  paid?: boolean
  paidAmount?: number
  balanceOwed?: number
  /** Shipping fee taken off the uploaded value to get what the supplier is due. */
  shippingFee?: number
  /** Uploaded value less the shipping fee. */
  payable?: number
  /** The supplier the bill is under, so the screen can keep adding to it. */
  supplierId?: string
  /** True when the lines went onto a bill already on the system. */
  addedToBill?: boolean
  /** Set when Many at once (Excel) put the file on a supplier bill. */
  asSupplierBill?: boolean
  /** Set when the goods were booked as still on the way, not onto the shelf. */
  onTheWay?: boolean
  lotNumber?: string
  shops?: number
  shopNames?: string
}

export type BatchUploadItem = {
  productMode: "existing" | "new"
  productId?: string
  /** Model name only. Condition and storage are their own fields. */
  productName?: string
  brandId?: string
  categoryId?: string
  condition?: string
  storage?: string
  minimumPrice?: number
  sellingPrice?: number
  newProduct?: {
    name: string
    brandId: string
    categoryId: string
    condition: ProductCondition
    tracking: ProductTracking
    storage?: string
    costPrice: number
    minimumPrice: number
    sellingPrice: number
  }
  costPrice: number
  quantity: number
  tracking: ProductTracking
  identities?: string[]
}

export type BatchUploadPayload = {
  branchId: string
  supplierId?: string
  newSupplierName?: string
  newSupplierPhone?: string
  newSupplierCountry?: string
  newSupplierCity?: string
  invoiceNumber?: string
  uploadDate?: string
  amountPaid: number
  /** How what is paid now left us: TRANSFER or CASH. Needed when anything is paid. */
  paymentMethod?: string
  /** The bank account a transfer was sent from. */
  bankAccountId?: string
  /**
   * The part of the uploaded value that is shipping. It stays in the value of
   * the goods and comes off what is payable to the supplier.
   */
  shippingFee?: number
  /**
   * True when the goods have not reached the shop yet. The bill and its value
   * are recorded and the units wait on Goods on the way; nothing can be sold
   * until someone marks them received there.
   */
  onTheWay?: boolean
  /** When the goods are expected, for a bill that is still on the way. */
  expectedDate?: string
  notes?: string
  items: BatchUploadItem[]
}


async function readSheet(formData: FormData): Promise<{ rows: Record<string, string>[]; name: string } | { error: string }> {
  const file = formData.get("file")
  if (!(file instanceof File) || file.size === 0) return { error: "Choose an Excel or CSV file first." }
  if (file.size > MAX_BYTES) return { error: "That file is too big. Use a file under 25 MB." }
  let rows: Record<string, string>[]
  try {
    rows = await readTableFile(file)
  } catch {
    return { error: "We could not read that file. Save it as Excel or CSV and try again." }
  }
  if (!rows.length) return { error: "There is nothing under the header line in that file." }
  if (rows.length > MAX_ROWS) return { error: `Upload up to ${MAX_ROWS.toLocaleString("en-NG")} rows at a time. Split the sheet and send it in parts.` }
  return { rows, name: file.name }
}

async function requireUploader() {
  const user = await requireUser()
  if (!(await can(user.role, "action.upload"))) {
    return { error: "Only the main admin and the person who loads stock can load the shop from a sheet." as const }
  }
  return { user }
}

async function trail(userId: string, entity: string, detail: Record<string, unknown>, branchId: string | null) {
  await prisma.auditLog.create({
    data: {
      userId,
      action: "IMPORT",
      entityType: entity,
      entityId: "sheet-upload",
      newValue: JSON.stringify(detail),
      branchId,
    },
  })
}

type OpeningShopRef = { id: string; name: string; code: string }

async function resolveOpeningTargetShops(
  user: { role: Parameters<typeof canSeeAllBranches>[0]; branchId: string | null },
  requested: string
): Promise<{ shops: OpeningShopRef[] } | { error: string }> {
  const asked = requested.trim()
  if (asked === OPENING_STOCK_ALL_SHOPS) {
    if (!(await canSeeAllBranches(user.role))) {
      if (!user.branchId) return { error: "Your login is not tied to a shop. Ask the main admin." }
      const shop = await prisma.branch.findFirst({
        where: { id: user.branchId, isActive: true },
        select: { id: true, name: true, code: true },
      })
      if (!shop) return { error: "Your shop is not open." }
      return { shops: [shop] }
    }
    const shops = await prisma.branch.findMany({
      where: { isActive: true },
      select: { id: true, name: true, code: true },
      orderBy: { name: "asc" },
    })
    if (!shops.length) return { error: "There is no open shop to load." }
    return { shops }
  }
  const shopGate = await resolveWritableShopId(user, asked)
  if ("error" in shopGate) return { error: shopGate.error }
  const shop = await prisma.branch.findFirst({
    where: { id: shopGate.shopId, isActive: true },
    select: { id: true, name: true, code: true },
  })
  if (!shop) return { error: "Pick the shop this file belongs to: Iwo Road, Bodija, or Challenge, or pick All shops." }
  return { shops: [shop] }
}

async function bookOpeningStockShop(input: {
  shop: OpeningShopRef
  userId: string
  supplier: { id: string; name: string; country: string | null; city: string | null }
  note: string
  fileName: string
  plan: ReturnType<typeof planOpeningStock>
  productIdByKey: Map<string, string>
  costByProductId: Map<string, number>
}): Promise<{
  kept: boolean
  shopId: string
  invoiceNumber: string
  purchaseId: string
  phonesAdded: number
  pieceLines: number
  namesOnly: number
  alreadyCount: number
  billTotal: number
  notes: string[]
}> {
  const { shop, userId, supplier, note, fileName, plan, productIdByKey, costByProductId } = input
  const invoiceNumber = generateDocNumber("PO")
  const purchase = await prisma.purchase.create({
    data: {
      invoiceNumber,
      supplierId: supplier.id,
      branchId: shop.id,
      userId,
      status: "RECEIVED",
      totalAmount: "0.00",
      paidAmount: "0.00",
      paymentMethod: OPENING_STOCK_METHOD,
      source: UPLOAD_STOCK_SOURCE,
      sessionOpen: false,
      receivedDate: new Date(),
      originCountry: supplier.country,
      originCity: supplier.city,
      notes: [
        "Loaded from the opening stock Excel sheet. This is the shop's opening stock value. It is not a supplier bill to pay.",
        note || null,
        `File: ${fileName}`,
      ]
        .filter(Boolean)
        .join(" "),
    },
  })

  await prisma.openingStock.create({ data: { branchId: shop.id, purchaseId: purchase.id } })

  const unitPayload = plan.units.map((row) => {
    const productId = productIdByKey.get(row.productKey)
    if (!productId) throw new Error("Something went wrong while saving that item. Try the upload again.")
    return {
      imei1: row.identity.value,
      serialNumber: row.identity.kind === "serial" ? row.identity.value : null,
      productId,
      branchId: shop.id,
      supplierId: supplier.id,
      purchaseId: purchase.id,
      status: "IN_STOCK" as const,
      notes: `Opening stock · ${row.sheet} · ${invoiceNumber}`,
    }
  })

  const existingImeis = unitPayload.length
    ? await prisma.imeiRecord.findMany({
        where: {
          OR: [
            { imei1: { in: unitPayload.map((row) => row.imei1) } },
            {
              serialNumber: {
                in: unitPayload.map((row) => row.serialNumber).filter(Boolean) as string[],
              },
            },
          ],
        },
        select: { imei1: true, serialNumber: true },
      })
    : []
  const already = new Set(
    existingImeis.flatMap((row) => [row.imei1, row.serialNumber].filter(Boolean) as string[])
  )
  const freshUnits = unitPayload.filter(
    (row) => !already.has(row.imei1) && !(row.serialNumber && already.has(row.serialNumber))
  )

  let phonesAdded = 0
  const unitCounts = new Map<string, number>()
  for (let i = 0; i < freshUnits.length; i += 200) {
    const batch = freshUnits.slice(i, i + 200)
    await prisma.$transaction(async (tx) => {
      await tx.imeiRecord.createMany({ data: batch })
      const perShop = new Map<string, number>()
      for (const row of batch) {
        const key = `${row.productId}:${row.branchId}`
        perShop.set(key, (perShop.get(key) ?? 0) + 1)
        unitCounts.set(row.productId, (unitCounts.get(row.productId) ?? 0) + 1)
      }
      for (const [key, count] of perShop) {
        const [productId, branchId] = key.split(":")
        await tx.inventory.upsert({
          where: { productId_branchId: { productId, branchId } },
          update: { quantity: { increment: count } },
          create: { productId, branchId, quantity: count },
        })
        await recordMovement(tx, {
          productId,
          branchId,
          quantity: count,
          move: { kind: "RECEIVED", reference: invoiceNumber, userId },
        })
      }
    })
    phonesAdded += batch.length
  }

  let pieceLines = 0
  const pieceCounts = new Map<string, number>()
  for (const row of plan.quantities) {
    const productId = productIdByKey.get(row.productKey)
    if (!productId) continue
    await setStock(prisma, {
      productId,
      branchId: shop.id,
      quantity: row.quantity,
      lastStockCheck: true,
      move: { kind: "OPENING", reference: invoiceNumber, userId },
    })
    pieceCounts.set(productId, (pieceCounts.get(productId) ?? 0) + row.quantity)
    pieceLines += 1
  }

  const namesOnlyIds = [...new Set(productIdByKey.values())].filter(
    (productId) => !unitCounts.has(productId) && !pieceCounts.has(productId)
  )

  await prisma.$transaction(async (tx) => {
    for (const [productId, quantity] of unitCounts) {
      await attachPurchaseLine(tx, {
        purchaseId: purchase.id,
        productId,
        quantity,
        costPrice: costByProductId.get(productId) ?? 0,
        markedPaid: false,
      })
    }
    for (const [productId, quantity] of pieceCounts) {
      await attachPurchaseLine(tx, {
        purchaseId: purchase.id,
        productId,
        quantity,
        costPrice: costByProductId.get(productId) ?? 0,
        markedPaid: false,
      })
    }
    for (const productId of namesOnlyIds) {
      await attachPurchaseLine(tx, {
        purchaseId: purchase.id,
        productId,
        quantity: 0,
        costPrice: costByProductId.get(productId) ?? 0,
        markedPaid: false,
      })
    }
  })

  const notes: string[] = []
  if (phonesAdded === 0 && pieceLines === 0 && namesOnlyIds.length === 0) {
    await prisma.openingStock.deleteMany({ where: { purchaseId: purchase.id } })
    await prisma.purchase.delete({ where: { id: purchase.id } })
    await trail(
      userId,
      "OpeningStock",
      {
        shop: shop.name,
        file: fileName,
        phonesAdded: 0,
        phonesAlready: unitPayload.length,
        pieceLines: 0,
        note: "There was nothing new to add, so no supplier bill was saved.",
      },
      shop.id
    )
    if (unitPayload.length > 0) {
      notes.push(
        `${shop.name}: ${unitPayload.length} IMEI or serial number(s) were already on the system. Each stays as one entry and was not doubled.`
      )
    }
    return {
      kept: false,
      shopId: shop.id,
      invoiceNumber,
      purchaseId: purchase.id,
      phonesAdded: 0,
      pieceLines: 0,
      namesOnly: 0,
      alreadyCount: unitPayload.length,
      billTotal: 0,
      notes,
    }
  }

  const refreshed = await prisma.purchase.findUnique({
    where: { id: purchase.id },
    select: { totalAmount: true },
  })
  const billTotal = money(refreshed?.totalAmount)

  await prisma.purchase.update({
    where: { id: purchase.id },
    data: {
      paidAmount: billTotal.toFixed(2),
      paymentMethod: OPENING_STOCK_METHOD,
      notes: [
        "Loaded from the opening stock Excel sheet. This is the shop's opening stock value. It is not a supplier bill to pay.",
        note || null,
        `File: ${fileName}`,
      ]
        .filter(Boolean)
        .join(" "),
    },
  })

  await trail(
    userId,
    "OpeningStock",
    {
      shop: shop.name,
      file: fileName,
      invoiceNumber,
      supplier: supplier.name,
      phonesAdded,
      phonesAlready: unitPayload.length - phonesAdded,
      pieceLines,
      namesOnly: namesOnlyIds.length,
      submissionValue: billTotal,
      amountPaid: 0,
      balanceOwed: 0,
    },
    shop.id
  )

  const alreadyCount = unitPayload.length - phonesAdded
  if (alreadyCount > 0) {
    notes.push(
      `${shop.name}: ${alreadyCount} IMEI or serial number(s) were already on the system. Each stays as one entry and was not doubled. Staff can edit later on Correct and close opening stock or Phones and items.`
    )
  }
  if (namesOnlyIds.length > 0) {
    notes.push(
      `${shop.name}: ${namesOnlyIds.length} item name(s) were booked without an IMEI, serial, or piece count. Add those details on Correct and close opening stock.`
    )
  }

  return {
    kept: true,
    shopId: shop.id,
    invoiceNumber,
    purchaseId: purchase.id,
    phonesAdded,
    pieceLines,
    namesOnly: namesOnlyIds.length,
    alreadyCount,
    billTotal,
    notes,
  }
}

/**
 * Abu Twins opening stock: one workbook per shop, or All shops for the same names
 * on every open shop. Creates a Goods from supplier bill, missing item names,
 * books phones and serials In shop, and sets piece counts.
 */
export async function importOpeningStock(formData: FormData): Promise<UploadResult> {
  const gate = await requireUploader()
  if ("error" in gate) return { error: gate.error }
  const { user } = gate

  const file = formData.get("file")
  if (!(file instanceof File) || file.size === 0) return { error: "Choose the opening stock Excel file first." }
  if (file.size > MAX_BYTES) return { error: "That file is too big. Use a file under 25 MB." }

  const branchId = String(formData.get("branchId") || "")
  const shopPick = await resolveOpeningTargetShops(user, branchId)
  if ("error" in shopPick) return { error: shopPick.error }

  // A shop that already has its opening stock takes new goods on a supplier
  // bill. Picking a real supplier here used to be refused with "opening stock
  // is closed", so a sheet of new goods from a house we already deal with
  // could not be loaded at all. It now goes on that supplier's bill.
  const pickedId = String(formData.get("supplierId") || "").trim()
  const pickedHouse =
    pickedId && pickedId !== OPENING_STOCK_SUPPLIER_OPTION && pickedId !== "__new__"
      ? await prisma.supplier.findFirst({ where: { id: pickedId, isActive: true } })
      : null
  const shopsStarted = await prisma.openingStock.count({ where: { branchId: { in: shopPick.shops.map((shop) => shop.id) } } })
  if (shopsStarted > 0 && pickedHouse && !isOpeningStockSupplierName(pickedHouse.name) && pickedHouse.kind !== "NEIGHBOR") {
    if (shopPick.shops.length !== 1) {
      return { error: "A supplier bill is for one shop. Pick the shop the goods went to, not All shops." }
    }
    let sheets: Array<{ sheet: string; grid: string[][] }>
    try {
      sheets = await readWorkbookGrids(file)
    } catch {
      return { error: "We could not read that Excel file. Save it again and try one more time." }
    }
    const read = await billLinesFromGrids(sheets, file.name)
    if (read.error || !read.lines) return { error: read.error ?? "We could not read that sheet.", problems: read.problems }
    const note = String(formData.get("notes") || "").trim()
    const result = await batchUploadStock({
      branchId: shopPick.shops[0].id,
      supplierId: pickedHouse.id,
      invoiceNumber: generateDocNumber("PO"),
      uploadDate: watDayKey(),
      amountPaid: 0,
      notes: [`Loaded from ${file.name} on Many at once (Excel).`, note || null].filter(Boolean).join(" "),
      items: read.lines,
    })
    if (result.error) return result
    return {
      ...result,
      asSupplierBill: true,
      problems: [...(read.notes ?? []), ...(result.problems ?? [])].slice(0, 40),
    }
  }
  if (shopsStarted > 0 && pickedId === "__new__") {
    return {
      error: "This shop already has its opening stock, so new goods go on a supplier bill. Add the supplier on Suppliers (name and phone), then pick it here.",
    }
  }

  const alreadyOpen: string[] = []
  const targetShops: OpeningShopRef[] = []
  for (const shop of shopPick.shops) {
    const opening = await prisma.openingStock.findUnique({ where: { branchId: shop.id }, select: { status: true } })
    if (!opening) {
      targetShops.push(shop)
      continue
    }
    alreadyOpen.push(
      opening.status === "OPEN"
        ? `${shop.name} already has opening stock. Correct it with the count sheet on Correct & close opening stock.`
        : `${shop.name}'s opening stock is closed. New goods go on a supplier bill: pick the supplier above instead of Opening Stock.`
    )
  }
  if (!targetShops.length) {
    return {
      error: alreadyOpen[0] || "Pick the shop this file belongs to, or pick All shops.",
      problems: alreadyOpen.slice(0, 40),
    }
  }

  const note = String(formData.get("notes") || "").trim()
  const newSupplierName = String(formData.get("newSupplierName") || "").trim()
  const newSupplierPhone = String(formData.get("newSupplierPhone") || "").trim()
  const newSupplierCity = String(formData.get("newSupplierCity") || "").trim()
  const newSupplierCountry = String(formData.get("newSupplierCountry") || "").trim()
  let supplierId = String(formData.get("supplierId") || "").trim()
  if (supplierId === "__new__") supplierId = ""

  let supplier =
    supplierId && supplierId !== OPENING_STOCK_SUPPLIER_OPTION
      ? await prisma.supplier.findFirst({ where: { id: supplierId, isActive: true } })
      : null

  if (supplierId && supplierId !== OPENING_STOCK_SUPPLIER_OPTION && !supplier && !newSupplierName) {
    return { error: "That supplier is not on the list, or it is locked. Pick Opening Stock, pick another name, or add a new supplier." }
  }

  // Default house when the real supplier is not known yet. No phone needed.
  if (supplierId === OPENING_STOCK_SUPPLIER_OPTION || (!supplierId && !newSupplierName)) {
    supplier = await ensureOpeningStockSupplier()
  }

  if (newSupplierName) {
    if (!displayPartyName(newSupplierName)) {
      return { error: "Type the new supplier name, or pick Opening Stock from the list." }
    }
    const phoneToStore = newSupplierPhone || OPENING_STOCK_SUPPLIER_PHONE
    const clash = await findDuplicateSupplier({ name: newSupplierName, phone: newSupplierPhone || undefined })
    if (clash) return clash
    supplier = await prisma.supplier.create({
      data: {
        name: displayPartyName(newSupplierName),
        phone: phoneToStore,
        city: newSupplierCity || null,
        country: newSupplierCountry || null,
        kind: "SUPPLIER",
      },
    })
    revalidatePath("/suppliers")
  }

  if (!supplier) {
    return {
      error: "Pick Opening Stock when you do not know the house yet, pick a supplier from the list, or type a new supplier name.",
    }
  }
  if (supplier.kind === "NEIGHBOR") {
    return { error: "A neighboring shop is not a supplier carton. Use Buy from next door for that." }
  }

  let sheets: Array<{ sheet: string; grid: string[][] }>
  try {
    sheets = await readWorkbookGrids(file)
  } catch {
    return { error: "We could not read that Excel file. Save it again and try one more time." }
  }

  const trackingRaw = String(formData.get("tracking") || "ALL").trim().toUpperCase()
  const tracking = trackingRaw === "IMEI" || trackingRaw === "SERIAL" || trackingRaw === "NONE" ? trackingRaw : undefined

  const plan = planOpeningStock(sheets, { allowMissingPrices: true, tracking })
  if (plan.problems.length) {
    return {
      error: `${plan.problems.length} line(s) need fixing. Nothing was loaded.`,
      problems: plan.problems.slice(0, 40),
    }
  }
  if (!plan.products.length) {
    return {
      error:
        "We found no stock in that sheet. Use the PHONES, ACCESSORIES, SCREEN, and LAPTOPS tabs, and put PRODUCT NAME on the header row.",
    }
  }
  if (plan.units.length > 0 && targetShops.length > 1) {
    return {
      error:
        "An IMEI or serial belongs to one shop. Pick Iwo Road, Bodija, or Challenge. All shops is for names and piece counts that every shop should start with.",
    }
  }

  const [brands, categories] = await Promise.all([
    prisma.brand.findMany(),
    prisma.category.findMany(),
  ])
  const brandIds = new Map(brands.map((row) => [row.name.toLowerCase(), row.id]))
  const categoryIds = new Map(categories.map((row) => [row.name.toLowerCase(), row.id]))

  const productIdByKey = new Map<string, string>()
  const costByProductId = new Map<string, number>()
  let productsAdded = 0

  for (const draft of plan.products) {
    const key = [
      draft.name.toLowerCase(),
      draft.brand.toLowerCase(),
      draft.condition,
      (draft.storage || "").toLowerCase(),
      draft.tracking,
    ].join("|")

    let brandId = brandIds.get(draft.brand.toLowerCase())
    if (!brandId) {
      const brand = await prisma.brand.create({ data: { name: draft.brand } })
      brandId = brand.id
      brandIds.set(draft.brand.toLowerCase(), brandId)
    }
    let categoryId = categoryIds.get(draft.category.toLowerCase())
    if (!categoryId) {
      const category = await prisma.category.create({ data: { name: draft.category } })
      categoryId = category.id
      categoryIds.set(draft.category.toLowerCase(), categoryId)
    }

    const existing =
      (await prisma.product.findUnique({ where: { sku: draft.sku } })) ||
      (await prisma.product.findFirst({
        where: {
          name: draft.name,
          brandId,
          condition: draft.condition,
          tracking: draft.tracking,
          storage: draft.storage,
        },
      }))

    if (existing) {
      productIdByKey.set(key, existing.id)
      costByProductId.set(existing.id, draft.costPrice)
      if (draft.costPrice > 0 || draft.minimumPrice > 0 || draft.sellingPrice > 0) {
        await prisma.product.update({
          where: { id: existing.id },
          data: {
            ...(draft.costPrice > 0 ? { costPrice: draft.costPrice.toFixed(2) } : {}),
            ...(draft.minimumPrice > 0 ? { minimumPrice: draft.minimumPrice.toFixed(2) } : {}),
            ...(draft.sellingPrice > 0 ? { sellingPrice: draft.sellingPrice.toFixed(2) } : {}),
          },
        })
      }
      for (const shop of targetShops) {
        await prisma.inventory.upsert({
          where: { productId_branchId: { productId: existing.id, branchId: shop.id } },
          create: { productId: existing.id, branchId: shop.id, quantity: 0 },
          update: {},
        })
      }
      continue
    }

    const product = await prisma.product.create({
      data: {
        sku: draft.sku,
        name: draft.name,
        brandId,
        categoryId,
        tracking: draft.tracking,
        condition: draft.condition,
        storage: draft.storage,
        costPrice: draft.costPrice.toFixed(2),
        minimumPrice: draft.minimumPrice.toFixed(2),
        sellingPrice: draft.sellingPrice.toFixed(2),
        warrantyDays: 0,
        description: `Opening stock · ${draft.category}`,
      },
    })
    for (const shop of targetShops) {
      await prisma.inventory.upsert({
        where: { productId_branchId: { productId: product.id, branchId: shop.id } },
        create: { productId: product.id, branchId: shop.id, quantity: 0 },
        update: {},
      })
    }
    productIdByKey.set(key, product.id)
    costByProductId.set(product.id, draft.costPrice)
    productsAdded += 1
  }


  const loaded: Awaited<ReturnType<typeof bookOpeningStockShop>>[] = []
  const extraNotes = [...plan.skipped, ...alreadyOpen]
  for (const shop of targetShops) {
    const booked = await bookOpeningStockShop({
      shop,
      userId: user.id,
      supplier,
      note,
      fileName: file.name,
      plan,
      productIdByKey,
      costByProductId,
    })
    extraNotes.push(...booked.notes)
    if (booked.kept) loaded.push(booked)
  }

  revalidateStockViews()
  revalidatePath("/purchases")
  revalidatePath("/finance")
  revalidatePath("/suppliers")

  if (!loaded.length) {
    return {
      success: true,
      added: productsAdded,
      products: productsAdded,
      phones: 0,
      pieces: 0,
      skipped: extraNotes.filter((row) => row.includes("already on the system")).length,
      duplicates: plan.skipped.filter((row) => row.includes("twice") || row.includes("counted once")).length,
      problems: extraNotes.length ? extraNotes.slice(0, 40) : undefined,
      shops: 0,
    }
  }

  const phonesAdded = loaded.reduce((sum, row) => sum + row.phonesAdded, 0)
  const pieceLines = loaded.reduce((sum, row) => sum + row.pieceLines, 0)
  const namesOnly = loaded.reduce((sum, row) => sum + row.namesOnly, 0)
  const alreadyCount = loaded.reduce((sum, row) => sum + row.alreadyCount, 0)
  const billTotal = loaded.reduce((sum, row) => sum + row.billTotal, 0)
  const namedLoaded = loaded.map((row) => {
    const shop = targetShops.find((item) => item.id === row.shopId)
    return `${shop?.name ?? "Shop"} ${row.invoiceNumber}`
  })
  extraNotes.unshift(`Loaded opening stock for ${namedLoaded.join(", ")}.`)

  return {
    success: true,
    added: productsAdded + phonesAdded + pieceLines + namesOnly,
    products: productsAdded,
    phones: phonesAdded,
    pieces: pieceLines,
    skipped: alreadyCount,
    duplicates: plan.skipped.filter((row) => row.includes("twice") || row.includes("counted once")).length,
    problems: extraNotes.length ? extraNotes.slice(0, 40) : undefined,
    invoiceNumber: loaded.map((row) => row.invoiceNumber).join(", "),
    purchaseId: loaded[0].purchaseId,
    submissionValue: billTotal,
    paidAmount: 0,
    balanceOwed: 0,
    paid: true,
    shops: loaded.length,
    shopNames: namedLoaded.join(", "),
  }
}


/**
 * Step 3. The phones, one IMEI to a line.
 *
 * This is the one the shop asked for most. Booking a container in by hand, one
 * phone at a time, is where an evening goes.
 */
export async function importImeis(formData: FormData): Promise<UploadResult> {
  const gate = await requireUploader()
  if ("error" in gate) return { error: gate.error }
  const { user } = gate

  const read = await readSheet(formData)
  if ("error" in read) return { error: read.error }
  const { rows, name } = read

  const [items, suppliers, shops] = await Promise.all([
    prisma.product.findMany({ where: { isActive: true }, select: { id: true, sku: true, name: true, tracking: true } }),
    prisma.supplier.findMany({ select: { id: true, name: true } }),
    prisma.branch.findMany({ where: { isActive: true }, select: { id: true, name: true, code: true } }),
  ])
  const supplierByName = new Map(suppliers.map((s) => [s.name.toLowerCase(), s.id]))

  const plan = planImeis(rows, items as CatalogItem[], shops as ShopRef[])
  if (plan.problems.length) {
    return { error: `${plan.problems.length} line(s) need fixing. Nothing was loaded.`, problems: plan.problems.slice(0, 40) }
  }
  if (!plan.rows.length) return { error: "There is no phone on that sheet." }

  // A phone already on the system is left exactly as it is. Re-sending the same
  // container must never move a sold phone back onto the shelf.
  const existing = await prisma.imeiRecord.findMany({
    where: { imei1: { in: plan.rows.map((p) => p.imei1) } },
    select: { imei1: true },
  })
  const already = new Set(existing.map((row) => row.imei1))
  const fresh = plan.rows.filter((row) => !already.has(row.imei1))

  let added = 0
  for (let i = 0; i < fresh.length; i += 200) {
    const batch = fresh.slice(i, i + 200)
    await prisma.$transaction(async (tx) => {
      await tx.imeiRecord.createMany({
        data: batch.map((row) => ({
          imei1: row.imei1,
          imei2: row.imei2,
          serialNumber: row.serialNumber,
          productId: row.productId,
          branchId: row.branchId,
          supplierId: row.supplierName ? supplierByName.get(row.supplierName.toLowerCase()) ?? null : null,
          status: "IN_STOCK" as const,
          notes: row.notes,
        })),
      })
      // The shelf count follows the phones, so Shop stock and the IMEI list
      // agree from the very first day.
      const perShop = new Map<string, number>()
      for (const row of batch) {
        const key = `${row.productId}:${row.branchId}`
        perShop.set(key, (perShop.get(key) ?? 0) + 1)
      }
      for (const [key, count] of perShop) {
        const [productId, branchId] = key.split(":")
        await tx.inventory.upsert({
          where: { productId_branchId: { productId, branchId } },
          update: { quantity: { increment: count } },
          create: { productId, branchId, quantity: count },
        })
        await recordMovement(tx, {
          productId,
          branchId,
          quantity: count,
          move: { kind: "RECEIVED", reference: name, userId: user.id },
        })
      }
    })
    added += batch.length
  }

  const softNotes = [...(plan.notices ?? [])]
  if (already.size > 0) {
    softNotes.push(
      `${already.size} IMEI(s) were already on the system and were left as one entry each (not doubled). Staff can edit later on Phones and items.`
    )
  }

  await trail(
    user.id,
    "IMEIRecord",
    { added, alreadyOnSystem: already.size, duplicatesInSheet: plan.notices?.length ?? 0, file: name },
    user.branchId
  )
  revalidatePath("/imei")
  revalidatePath("/inventory")
  revalidatePath("/uploads")
  revalidatePath("/dashboard")
  return {
    success: true,
    added,
    skipped: already.size,
    duplicates: plan.notices?.length ?? 0,
    problems: softNotes.length ? softNotes.slice(0, 40) : undefined,
  }
}

/**
 * Step 2. How many of each countable item are on the shelf, per shop.
 * For cords, chargers and anything with no unique number.
 */
export async function importStock(formData: FormData): Promise<UploadResult> {
  const gate = await requireUploader()
  if ("error" in gate) return { error: gate.error }
  const { user } = gate

  const read = await readSheet(formData)
  if ("error" in read) return { error: read.error }
  const { rows, name } = read

  const [items, shops] = await Promise.all([
    prisma.product.findMany({ where: { isActive: true }, select: { id: true, sku: true, name: true, tracking: true } }),
    prisma.branch.findMany({ where: { isActive: true }, select: { id: true, name: true, code: true } }),
  ])

  const plan = planStock(rows, items as CatalogItem[], shops as ShopRef[])
  if (plan.problems.length) {
    return { error: `${plan.problems.length} line(s) need fixing. Nothing was loaded.`, problems: plan.problems.slice(0, 40) }
  }
  if (!plan.rows.length) return { error: "There is no shelf count on that sheet." }

  for (const row of plan.rows) {
    const shopGate = await resolveWritableShopId(user, row.branchId)
    if ("error" in shopGate) {
      return { error: `A line for another shop was refused: ${shopGate.error}` }
    }
    await setStock(prisma, {
      productId: row.productId,
      branchId: shopGate.shopId,
      quantity: row.quantity,
      lastStockCheck: true,
      move: { kind: "HAND_CORRECTION", reference: name, userId: user.id },
    })
    if (row.minStock !== null) {
      await prisma.inventory.update({
        where: { productId_branchId: { productId: row.productId, branchId: shopGate.shopId } },
        data: { minStock: row.minStock },
      })
    }
  }

  await trail(user.id, "Inventory", { lines: plan.rows.length, file: name }, user.branchId)
  revalidatePath("/inventory")
  revalidatePath("/uploads")
  revalidatePath("/dashboard")
  return { success: true, added: plan.rows.length }
}

/** Step 4. Customer names, so old debts and warranties can be attached. */
export async function importCustomers(formData: FormData): Promise<UploadResult> {
  const gate = await requireUploader()
  if ("error" in gate) return { error: gate.error }
  const { user } = gate

  const read = await readSheet(formData)
  if ("error" in read) return { error: read.error }
  const { rows, name } = read

  const shops = await prisma.branch.findMany({ where: { isActive: true }, select: { id: true, name: true, code: true } })
  const plan = planCustomers(rows, shops as ShopRef[])
  if (plan.problems.length) {
    return { error: `${plan.problems.length} line(s) need fixing. Nothing was loaded.`, problems: plan.problems.slice(0, 40) }
  }
  if (!plan.rows.length) return { error: "There is no customer on that sheet." }

  const existing = await prisma.customer.findMany({
    where: { phone: { in: plan.rows.map((p) => p.phone) } },
    select: { phone: true },
  })
  const already = new Set(existing.map((row) => row.phone))
  const fresh = plan.rows.filter((row) => !already.has(row.phone))

  if (fresh.length) {
    await prisma.customer.createMany({
      data: fresh.map((row) => ({
        name: row.name,
        phone: row.phone,
        branchId: row.branchId,
        email: row.email,
        address: row.address,
        creditLimit: row.creditLimit.toFixed(2),
      })),
    })
  }

  await trail(user.id, "Customer", { added: fresh.length, alreadyOnSystem: already.size, file: name }, user.branchId)
  revalidatePath("/customers")
  revalidatePath("/uploads")
  return { success: true, added: fresh.length, skipped: already.size }
}

function cleanIdentity(raw: string) {
  return raw.replace(/\s+/g, " ").trim()
}

function billLineName(item: BatchUploadItem) {
  return cleanIdentity(item.productName || item.newProduct?.name || "")
}

function billLineCondition(item: BatchUploadItem) {
  return mapBillCondition(item.condition || item.newProduct?.condition || "")
}

function billLineStorage(item: BatchUploadItem) {
  return normalizeStorage(item.storage || item.newProduct?.storage || "") || null
}

async function resolveBillProduct(
  item: BatchUploadItem,
  targetShopId: string
): Promise<{ productId: string; productName: string; createdProduct: boolean } | { error: string }> {
  const name = billLineName(item)
  const condition = billLineCondition(item)
  const storage = billLineStorage(item)
  const brandId = item.brandId || item.newProduct?.brandId || ""
  const categoryId = item.categoryId || item.newProduct?.categoryId || ""
  const tracking = item.tracking || item.newProduct?.tracking || "IMEI"
  const costPrice = Number(item.costPrice || item.newProduct?.costPrice || 0)
  const minimumPrice = Math.max(
    Number(item.minimumPrice || item.newProduct?.minimumPrice || 0),
    costPrice
  )
  const sellingPrice = Math.max(
    Number(item.sellingPrice || item.newProduct?.sellingPrice || 0),
    minimumPrice,
    costPrice
  )

  if (name && condition) {
    const existing =
      (brandId
        ? await prisma.product.findFirst({
            where: { name, brandId, condition, tracking, storage },
          })
        : await prisma.product.findFirst({
            where: { name, condition, tracking, storage },
          })) ||
      (item.productId
        ? await prisma.product.findUnique({ where: { id: item.productId } })
        : null)

    if (existing && existing.name.toLowerCase() === name.toLowerCase() && existing.condition === condition) {
      const sameStorage = (existing.storage || null) === storage
      if (sameStorage) {
        return { productId: existing.id, productName: existing.name, createdProduct: false }
      }
    }

    if (!brandId || !categoryId) {
      return { error: "Pick the item name, then pick the brand if this name is new." }
    }

    const [brand, category] = await Promise.all([
      prisma.brand.findUnique({ where: { id: brandId } }),
      prisma.category.findUnique({ where: { id: categoryId } }),
    ])
    if (!brand || !category) {
      return { error: "Pick the brand and the kind of item." }
    }

    const sku = makeOpeningSku({
      brand: brand.name,
      name,
      storage: storage || "",
      condition,
    })

    const bySku = await prisma.product.findUnique({ where: { sku } })
    if (bySku) {
      return { productId: bySku.id, productName: bySku.name, createdProduct: false }
    }

    const created = await prisma.product.create({
      data: {
        sku,
        name,
        brandId,
        categoryId,
        tracking,
        condition,
        storage,
        costPrice: costPrice.toFixed(2),
        minimumPrice: minimumPrice.toFixed(2),
        sellingPrice: sellingPrice.toFixed(2),
        warrantyDays: 0,
        description: "Added while loading stock",
      },
    })
    await prisma.inventory.create({
      data: { productId: created.id, branchId: targetShopId, quantity: 0 },
    })
    return { productId: created.id, productName: created.name, createdProduct: true }
  }

  if (item.productId) {
    const prod = await prisma.product.findUnique({ where: { id: item.productId } })
    if (!prod) return { error: "That item is not on the list." }
    return { productId: prod.id, productName: prod.name, createdProduct: false }
  }

  return { error: "Type the name of the item, then pick condition and storage." }
}

function revalidateStockViews() {
  revalidatePath("/uploads")
  revalidatePath("/incoming")
  revalidatePath("/products")
  revalidatePath("/imei")
  revalidatePath("/inventory")
  revalidatePath("/dashboard")
  revalidatePath("/pos")
  revalidatePath("/purchases")
  revalidatePath("/finance")
  revalidatePath("/suppliers")
  revalidatePath("/opening-stock")
  revalidatePath("/uploads/opening-stock")
  revalidatePath("/reports")
  revalidatePath("/audit/books")
}

/** What the upload screen shows about how far the shop has got. */
export async function getUploadProgress() {
  const user = await requireUser()
  if (!(await can(user.role, "view.uploads"))) return null
  const shopScope = await viewBranchFilter(user)
  const [items, withStock, phones, customers, branches, brands, categories, products, suppliers, openBill] =
    await Promise.all([
      prisma.product.count({ where: { isActive: true } }),
      prisma.inventory.count({ where: { quantity: { gt: 0 }, ...(shopScope ? { branchId: shopScope } : {}) } }),
      prisma.imeiRecord.count({ where: { status: "IN_STOCK", ...(shopScope ? { branchId: shopScope } : {}) } }),
      prisma.customer.count({ where: shopScope ? { branchId: shopScope } : undefined }),
      prisma.branch.findMany({
        where: {
          isActive: true,
          ...((await canSeeAllBranches(user.role)) ? {} : shopScope ? { id: shopScope } : {}),
        },
        select: { id: true, name: true, code: true },
        orderBy: { name: "asc" },
      }),
      prisma.brand.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
      prisma.category.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
      prisma.product.findMany({
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          sku: true,
          tracking: true,
          condition: true,
          storage: true,
          costPrice: true,
          minimumPrice: true,
          sellingPrice: true,
          brandId: true,
          categoryId: true,
          brand: { select: { name: true } },
        },
        orderBy: { name: "asc" },
      }),
      prisma.supplier.findMany({
        where: { isActive: true, kind: "SUPPLIER" },
        select: { id: true, name: true, phone: true, city: true, country: true },
        orderBy: { name: "asc" },
      }),
      prisma.purchase.findFirst({
        where: {
          userId: user.id,
          source: UPLOAD_STOCK_SOURCE,
          sessionOpen: true,
          ...(shopScope ? { branchId: shopScope } : {}),
        },
        select: {
          id: true,
          invoiceNumber: true,
          totalAmount: true,
          paidAmount: true,
          returnedAmount: true,
          shippingFee: true,
          paymentMethod: true,
          branchId: true,
          supplierId: true,
          branch: { select: { id: true, name: true, code: true } },
          supplier: { select: { id: true, name: true } },
          _count: { select: { items: true, imeiRecords: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
    ])

  const openingHouse = await ensureOpeningStockSupplier()
  const suppliersForForm = [
    {
      id: openingHouse.id,
      name: openingHouse.name,
      phone: openingHouse.phone,
      city: openingHouse.city,
      country: openingHouse.country,
    },
    ...suppliers.filter((row) => row.id !== openingHouse.id),
  ]

  const openUploadBill = openBill
    ? {
        id: openBill.id,
        invoiceNumber: openBill.invoiceNumber,
        branchId: openBill.branchId,
        supplierId: openBill.supplierId,
        shopName: openBill.branch.name,
        shopCode: openBill.branch.code,
        supplierName: openBill.supplier.name,
        submissionValue: money(openBill.totalAmount),
        paid: isMarkedPaidOnUpload(openBill.paymentMethod),
        // Same rule as the supplier ledger: what went back to them is not owed.
        owed: purchaseBalance(openBill).owed,
        lineCount: openBill._count.items,
        unitCount: openBill._count.imeiRecords,
      }
    : null

  return {
    items,
    withStock,
    phones,
    customers,
    branches,
    brands,
    categories,
    products: products.map((row) => ({
      ...row,
      costPrice: money(row.costPrice),
      minimumPrice: money(row.minimumPrice),
      sellingPrice: money(row.sellingPrice),
    })),
    suppliers: suppliersForForm,
    payingBanks: await listPayingBanks(user),
    openUploadBill,
  }
}

/**
 * A bill that Upload stock can keep adding to: one loaded on Upload stock,
 * not cancelled, in a shop this person can load. Null otherwise.
 */
export async function getBillToContinue(invoiceNumber: string) {
  const gate = await requireUploader()
  if ("error" in gate) return null
  const bill = await prisma.purchase.findUnique({
    where: { invoiceNumber: invoiceNumber.trim() },
    select: { invoiceNumber: true, supplierId: true, branchId: true, source: true, status: true, supplier: { select: { name: true } } },
  })
  if (!bill || bill.source !== UPLOAD_STOCK_SOURCE || bill.status === "CANCELLED") return null
  const shopGate = await resolveWritableShopId(gate.user, bill.branchId)
  if ("error" in shopGate || shopGate.shopId !== bill.branchId) return null
  return { invoiceNumber: bill.invoiceNumber, supplierId: bill.supplierId, branchId: bill.branchId, supplierName: bill.supplier.name }
}

export type BillSheetResult = {
  error?: string
  /** Lines the sheet could not give; nothing is filled in while any remain. */
  problems?: string[]
  /** Rows left out without stopping the rest, each saying why. */
  notes?: string[]
  fileName?: string
  lines?: BatchUploadItem[]
}

/**
 * Read a supplier's sheet into bill lines, without saving anything.
 *
 * The same workbook the shop already fills for opening stock: PRODUCT NAME,
 * BRAND, QTY/IMEI/SERIAL NO, CONDITION, SPECIFICATION, UNIT COST PRICE, on
 * the PHONES, ACCESSORIES, SCREEN and LAPTOPS tabs. The lines come back to the
 * bill form, where staff check them, add the shipping fee and what was paid,
 * and say whether the goods are in the shop or still on the way.
 */
export async function readBillWorkbook(formData: FormData): Promise<BillSheetResult> {
  const gate = await requireUploader()
  if ("error" in gate) return { error: gate.error }

  const file = formData.get("file")
  if (!(file instanceof File) || file.size === 0) return { error: "Choose the Excel or CSV file first." }
  if (file.size > MAX_BYTES) return { error: "That file is too big. Use a file under 25 MB." }

  let grids: Awaited<ReturnType<typeof readWorkbookGrids>>
  try {
    grids = await readWorkbookGrids(file)
  } catch {
    return { error: "We could not read that file. Save it as Excel or CSV and try again." }
  }
  return billLinesFromGrids(grids, file.name)
}

/** A workbook's tabs, read into supplier bill lines. Saves nothing. */
async function billLinesFromGrids(grids: Array<{ sheet: string; grid: string[][] }>, fileName: string): Promise<BillSheetResult> {
  if (grids.reduce((sum, tab) => sum + tab.grid.length, 0) > MAX_ROWS) {
    return { error: `Use a sheet of up to ${MAX_ROWS.toLocaleString("en-NG")} rows.` }
  }

  // A tab with no cost column is a checklist (names and IMEIs to tick), not
  // stock. Reading it as stock turned every name on it into a phone with no
  // IMEI, and the whole bill was refused.
  const leftOut = grids.filter((tab) => tab.grid.some((row) => row.some(Boolean)) && !tabHasCostColumn(tab.grid))
  const stockTabs = grids.filter((tab) => tabHasCostColumn(tab.grid))
  if (!stockTabs.length) {
    return {
      error:
        "No tab in that sheet has both PRODUCT NAME and UNIT COST PRICE on its header row. Download the template on this screen and copy the stock into it.",
    }
  }

  // The count sheet's layout: items on one tab with QTY, every IMEI on the
  // IMEI & SERIAL tab. That tab has no cost column, so it was dropped as a
  // checklist and every phone on the bill came back with no IMEI. When its
  // rows line up with a stock tab's, name for name, each IMEI is written into
  // its row there; otherwise it goes to the one item of that name (below).
  const { listTabs, byName } = fillFromUnitList(stockTabs, leftOut)

  // Read leniently so one bad row is named instead of the whole sheet being
  // refused without saying where; a bill still needs a cost on every item,
  // which is checked just below.
  const plan = planOpeningStock(stockTabs, { allowMissingPrices: true })
  // A number written twice is counted once and said so; any other row the
  // reader set aside would leave the bill short, so it stops the fill.
  const repeats = plan.skipped.filter((row) => row.includes("on this workbook twice"))
  const problems = [...plan.problems, ...plan.skipped.filter((row) => !repeats.includes(row))]
  if (!plan.products.length && !problems.length) {
    return {
      error:
        "We found no items in that sheet. Put PRODUCT NAME on the header row, with BRAND, QTY/IMEI/SERIAL NO, CONDITION, SPECIFICATION and UNIT COST PRICE beside it.",
    }
  }

  const [brands, categories] = await Promise.all([
    prisma.brand.findMany({ select: { id: true, name: true } }),
    prisma.category.findMany({ select: { id: true, name: true } }),
  ])
  const brandIds = new Map(brands.map((row) => [row.name.trim().toLowerCase(), row.id]))
  const categoryIds = new Map(categories.map((row) => [row.name.trim().toLowerCase(), row.id]))

  // Units of one model at different costs stay on their own lines, so each
  // keeps the cost written on its row.
  const unitsByKey = new Map<string, Map<number | null, string[]>>()
  for (const unit of plan.units) {
    const byCost = unitsByKey.get(unit.productKey) ?? new Map<number | null, string[]>()
    const cost = unit.cost ?? null
    byCost.set(cost, [...(byCost.get(cost) ?? []), unit.identity.value])
    unitsByKey.set(unit.productKey, byCost)
  }
  const qtyByKey = new Map(plan.quantities.map((row) => [row.productKey, row.quantity]))

  // IMEIs from a list tab that does not line up row for row: each goes to the
  // one tracked item of that name that has none on the stock tab.
  const seen = new Set(plan.units.map((unit) => unit.identity.value))
  const waiting = plan.products.filter(
    (draft) => (draft.tracking === "IMEI" || draft.tracking === "SERIAL") && !unitsByKey.has(openingProductKey(draft))
  )
  const unclear = new Set<string>()
  for (const unit of byName) {
    if (!unit.identity) continue
    const matches = waiting.filter((draft) => unitListName(draft.name) === unitListName(unit.name))
    if (!matches.length) continue
    if (matches.length > 1) {
      if (!unclear.has(unitListName(unit.name))) {
        unclear.add(unitListName(unit.name))
        problems.push(
          `${unit.sheet}: ${unit.name} is on the bill more than once (different specification or condition), so we cannot tell which IMEI is which. Keep the ${unit.sheet} rows in the same order as the items, one row per phone, or put each IMEI on its own row on the stock tab.`
        )
      }
      continue
    }
    if (seen.has(unit.identity)) {
      repeats.push(`${unit.sheet} line ${unit.line}: ${unit.identity} is on this workbook twice, so it is counted once.`)
      continue
    }
    seen.add(unit.identity)
    const key = openingProductKey(matches[0])
    const byCost = unitsByKey.get(key) ?? new Map<number | null, string[]>()
    byCost.set(null, [...(byCost.get(null) ?? []), unit.identity])
    unitsByKey.set(key, byCost)
  }

  const lines: BatchUploadItem[] = []
  const unknownBrands = new Set<string>()
  for (const draft of plan.products) {
    const key = openingProductKey(draft)
    const tracked = draft.tracking === "IMEI" || draft.tracking === "SERIAL"
    const costGroups: Array<{ cost: number; identities: string[]; quantity: number }> = tracked
      ? [...(unitsByKey.get(key) ?? new Map()).entries()].map(([cost, ids]) => ({ cost: cost ?? draft.costPrice, identities: ids, quantity: ids.length }))
      : [{ cost: draft.costPrice, identities: [], quantity: qtyByKey.get(key) ?? 0 }]
    const quantity = costGroups.reduce((sum, group) => sum + group.quantity, 0)
    if (quantity < 1) {
      problems.push(
        tracked
          ? `${draft.name}: no ${draft.tracking === "IMEI" ? "IMEI" : "serial number"} was given for it. A bill needs the number of every unit.`
          : `${draft.name}: how many pieces is missing.`
      )
      continue
    }
    if (costGroups.some((group) => !(group.cost > 0))) {
      problems.push(`${draft.name}: the unit cost price is missing. A supplier bill needs what each one cost.`)
      continue
    }
    const brandId = brandIds.get(draft.brand.trim().toLowerCase())
    if (!brandId) {
      unknownBrands.add(draft.brand)
      continue
    }
    for (const group of costGroups) {
      lines.push({
        productMode: "new",
        productId: "",
        productName: draft.name,
        brandId,
        categoryId: categoryIds.get(draft.category.trim().toLowerCase()) || "",
        condition: draft.condition,
        storage: normalizeStorage(draft.storage || ""),
        costPrice: group.cost,
        minimumPrice: draft.minimumPrice,
        sellingPrice: draft.sellingPrice,
        quantity: group.quantity,
        tracking: draft.tracking,
        identities: group.identities,
      })
    }
  }
  for (const brand of unknownBrands) {
    problems.push(`Brand "${brand}" is not on the brand list. Add it on Phones and items, or correct the spelling on the sheet.`)
  }

  if (problems.length) {
    return {
      error: `${problems.length} line${problems.length === 1 ? "" : "s"} on the sheet need${problems.length === 1 ? "s" : ""} fixing. Nothing was filled in.`,
      problems: problems.slice(0, 60),
    }
  }
  if (!lines.length) return { error: "There is nothing to put on a bill in that sheet." }
  return {
    lines,
    notes: [
      ...leftOut.filter((tab) => !listTabs.includes(tab)).map((tab) => `Tab ${tab.sheet} has no UNIT COST PRICE column, so it was read as a checklist and left out.`),
      ...repeats.slice(0, 40).map((row) => row.replace(/, so it is counted once\..*$/, ", so it is counted once.")),
    ],
    fileName,
  }
}

/**
 * Upload an entire batch of stock from the new Upload Stock Interface.
 * Handles supplier selection/creation, multiple items, dynamic IMEIs/serials,
 * initial amount paid calculation and balance tracking.
 */
export async function batchUploadStock(payload: BatchUploadPayload): Promise<UploadResult> {
  const gate = await requireUploader()
  if ("error" in gate) return { error: gate.error }
  const { user } = gate

  if (!payload.branchId) {
    return { error: "Pick the shop these goods are going to." }
  }

  const shopGate = await resolveWritableShopId(user, payload.branchId)
  if ("error" in shopGate) return { error: shopGate.error }
  const shop = await prisma.branch.findFirst({ where: { id: shopGate.shopId, isActive: true } })
  if (!shop) return { error: "That shop does not exist, or it is closed." }

  if (!payload.items || payload.items.length === 0) {
    return { error: "Add at least one item before you upload." }
  }

  // 1. Resolve Supplier
  let supplierId = payload.supplierId || ""
  let supplierName = ""
  // A shop's starting stock loaded here as "Opening Stock" became 85 million
  // naira of money owed that nobody owes. Opening stock has its own door.
  const openingStockRefusal = {
    error:
      "Opening stock does not go on a Supplier bill, because a Supplier bill is money owed. Use Upload stock → Many at once (Excel) for opening stock, or Correct & close opening stock to add a missing item. Pick the real supplier here.",
  }
  if (!supplierId && payload.newSupplierName) {
    if (isOpeningStockSupplierName(payload.newSupplierName)) return openingStockRefusal
    const sName = displayPartyName(payload.newSupplierName)
    const sPhone = (payload.newSupplierPhone || "").trim()
    if (!sPhone) return { error: "Type the new supplier phone number." }
    const clash = await findDuplicateSupplier({ name: sName, phone: sPhone })
    if (clash) return clash
    const newSupp = await prisma.supplier.create({
      data: {
        name: sName,
        phone: sPhone,
        country: payload.newSupplierCountry?.trim() || null,
        city: payload.newSupplierCity?.trim() || null,
        kind: "SUPPLIER",
      },
    })
    supplierId = newSupp.id
    supplierName = newSupp.name
  } else if (supplierId) {
    const supp = await prisma.supplier.findUnique({ where: { id: supplierId } })
    if (!supp) return { error: "We could not find that supplier." }
    if (isOpeningStockSupplierName(supp.name)) return openingStockRefusal
    supplierName = supp.name
  } else {
    return { error: "Pick a supplier, or type the name of a new one." }
  }

  // 2. Validate items. Duplicate IMEI/serial in this upload or already on the
  // system is kept as one entry — the upload continues; staff can edit later.
  const softNotes: string[] = []
  const seenInUpload = new Set<string>()
  const normalizedItems: typeof payload.items = []

  for (let i = 0; i < payload.items.length; i++) {
    const item = payload.items[i]
    if (item.quantity <= 0) {
      return { error: `Item #${i + 1} must have a quantity of 1 or more.` }
    }
    if (item.costPrice < 0) {
      return { error: `Item #${i + 1} cost price cannot be negative.` }
    }

    if (item.tracking !== "IMEI" && item.tracking !== "SERIAL") {
      normalizedItems.push({ ...item })
      continue
    }

    const rawIds = (item.identities || []).map((id) => cleanIdentity(id)).filter(Boolean)
    if (rawIds.length === 0) {
      return {
        error: `Item #${i + 1} needs ${item.tracking === "IMEI" ? "IMEI" : "serial"} numbers for the units you are loading.`,
      }
    }

    const uniqueIds: string[] = []
    for (const id of rawIds) {
      let value = id
      if (item.tracking === "IMEI") {
        const digits = id.replace(/\D/g, "")
        if (digits.length < 14) {
          return { error: `IMEI '${id}' is too short (must be at least 14 digits).` }
        }
        value = digits
      } else if (id.length < 3) {
        return { error: `Serial '${id}' is too short.` }
      }

      if (seenInUpload.has(value)) {
        softNotes.push(
          `Item #${i + 1}: ${value} appears more than once in this upload, so it is counted once.`
        )
        continue
      }
      seenInUpload.add(value)
      uniqueIds.push(value)
    }

    if (!uniqueIds.length) {
      softNotes.push(`Item #${i + 1}: every number was a duplicate of another line, so this line was skipped.`)
      continue
    }

    normalizedItems.push({
      ...item,
      identities: uniqueIds,
      quantity: uniqueIds.length,
    })
  }

  if (!normalizedItems.length) {
    return {
      error: "After removing duplicate numbers, there was nothing new to load. Check the IMEIs or serials.",
      problems: softNotes.slice(0, 40),
    }
  }

  const allIdentities = normalizedItems.flatMap((item) =>
    item.tracking === "IMEI" || item.tracking === "SERIAL" ? item.identities || [] : []
  )

  const alreadyOnSystem = new Set<string>()
  if (allIdentities.length > 0) {
    for (const batch of chunks(allIdentities, WRITE_CHUNK)) {
      const existingInDb = await prisma.imeiRecord.findMany({
        where: {
          OR: [{ imei1: { in: batch } }, { serialNumber: { in: batch } }],
        },
        select: { imei1: true, serialNumber: true },
      })
      for (const row of existingInDb) {
        if (row.imei1) alreadyOnSystem.add(row.imei1)
        if (row.serialNumber) alreadyOnSystem.add(row.serialNumber)
      }
    }
  }

  const itemsToLoad: typeof normalizedItems = []
  let skippedExisting = 0
  for (let i = 0; i < normalizedItems.length; i++) {
    const item = normalizedItems[i]
    if (item.tracking !== "IMEI" && item.tracking !== "SERIAL") {
      itemsToLoad.push(item)
      continue
    }
    const fresh = (item.identities || []).filter((id) => !alreadyOnSystem.has(id))
    const dropped = (item.identities || []).length - fresh.length
    if (dropped > 0) skippedExisting += dropped
    if (!fresh.length) continue
    itemsToLoad.push({ ...item, identities: fresh, quantity: fresh.length })
  }
  if (skippedExisting > 0) {
    softNotes.push(
      `${skippedExisting} IMEI or serial number(s) were already on the system. Each stays as one entry and was not doubled. Staff can edit stock later on Phones and items or Correct and close opening stock.`
    )
  }

  if (!itemsToLoad.length) {
    return {
      success: true,
      added: 0,
      phones: 0,
      pieces: 0,
      skipped: skippedExisting || allIdentities.length,
      duplicates: softNotes.filter((n) => n.includes("more than once") || n.includes("duplicate")).length,
      problems: softNotes.slice(0, 40),
    }
  }

  // Replace payload items with the deduped list for the rest of the upload.
  payload = { ...payload, items: itemsToLoad }

  // 3. Process products (create new products if needed)
  const resolvedItems: Array<{
    productId: string
    productName: string
    quantity: number
    costPrice: number
    tracking: ProductTracking
    identities: string[]
    createdProduct: boolean
  }> = []

  // One look-up per distinct item, however many lines carry it: a long bill
  // of one model used to ask the database the same questions on every line.
  const resolvedByKey = new Map<string, Awaited<ReturnType<typeof resolveBillProduct>>>()
  for (let i = 0; i < payload.items.length; i++) {
    const item = payload.items[i]
    const lookupKey = [billLineName(item).toLowerCase(), item.brandId || "", billLineCondition(item) || "", billLineStorage(item) || "", item.tracking, item.productId || ""].join("|")
    const resolved = resolvedByKey.get(lookupKey) ?? (await resolveBillProduct(item, shop.id))
    resolvedByKey.set(lookupKey, "error" in resolved ? resolved : { ...resolved, createdProduct: false })
    if ("error" in resolved) {
      return { error: `Item line #${i + 1}: ${resolved.error}` }
    }

    resolvedItems.push({
      productId: resolved.productId,
      productName: resolved.productName,
      quantity: item.quantity,
      costPrice: item.costPrice,
      tracking: item.tracking,
      identities: (item.identities || []).map((id) => cleanIdentity(id)).filter(Boolean),
      createdProduct: resolved.createdProduct,
    })
  }

  // Selling prices typed on the bill. A new item took them when it was made
  // just above. An item already on the price list changes price only for the
  // people who set prices; for anyone else the price list stays as it is and
  // the upload says so.
  type PriceMove = { productId: string; name: string; key: "minimumPrice" | "sellingPrice"; from: number; to: number }
  const priceMoves: PriceMove[] = []
  {
    const typed = new Map<string, { name: string; minimum: number; selling: number; cost: number }>()
    payload.items.forEach((item, index) => {
      const resolved = resolvedItems[index]
      if (!resolved || resolved.createdProduct) return
      const minimum = Math.max(0, Number(item.minimumPrice) || 0)
      const selling = Math.max(0, Number(item.sellingPrice) || 0)
      if (minimum <= 0 && selling <= 0) return
      typed.set(resolved.productId, { name: resolved.productName, minimum, selling, cost: resolved.costPrice })
    })
    if (typed.size) {
      const current = await prisma.product.findMany({
        where: { id: { in: [...typed.keys()] } },
        select: { id: true, minimumPrice: true, sellingPrice: true },
      })
      for (const row of current) {
        const want = typed.get(row.id)!
        const nextMinimum = want.minimum > 0 ? want.minimum : money(row.minimumPrice)
        const nextSelling = want.selling > 0 ? want.selling : money(row.sellingPrice)
        const minimumMoved = Math.abs(nextMinimum - money(row.minimumPrice)) > 0.005
        const sellingMoved = Math.abs(nextSelling - money(row.sellingPrice)) > 0.005
        if (!minimumMoved && !sellingMoved) continue
        if (nextSelling + 0.005 < nextMinimum) {
          return {
            error: `${want.name}: the selling price (₦${nextSelling.toLocaleString("en-NG")}) is below the lowest selling price (₦${nextMinimum.toLocaleString("en-NG")}). Raise the selling price or lower the lowest.`,
          }
        }
        if (minimumMoved) priceMoves.push({ productId: row.id, name: want.name, key: "minimumPrice", from: money(row.minimumPrice), to: nextMinimum })
        if (sellingMoved) priceMoves.push({ productId: row.id, name: want.name, key: "sellingPrice", from: money(row.sellingPrice), to: nextSelling })
      }
    }
  }
  const maySetPrices = canSetPricesOnBill(user.role)
  if (priceMoves.length && !maySetPrices) {
    const names = [...new Set(priceMoves.map((row) => row.name))]
    softNotes.push(
      `The selling prices typed for ${names.slice(0, 4).join(", ")}${names.length > 4 ? ` and ${names.length - 4} more` : ""} were not changed, because ${names.length === 1 ? "it is" : "they are"} already on the price list. Only the CEO, the main admin, a branch manager or the Vault Manager sets a price on a bill. Everything else on the bill was saved.`
    )
  }

  // A bill still on the way is received one item at a time against its bill
  // line, so each item sits on one line there. The same item typed twice is
  // folded into one line; two costs for one item cannot be told apart later.
  const onTheWay = payload.onTheWay === true
  let billLines = resolvedItems
  if (onTheWay) {
    const merged = new Map<string, (typeof resolvedItems)[number]>()
    for (const item of resolvedItems) {
      const existing = merged.get(item.productId)
      if (!existing) {
        merged.set(item.productId, { ...item, identities: [...item.identities] })
        continue
      }
      if (Math.abs(existing.costPrice - item.costPrice) > 0.005) {
        // One line per item while on the way, so two costs share one line at
        // their average. The bill total stays exactly what the sheet says.
        const together = existing.quantity + item.quantity
        const value = existing.costPrice * existing.quantity + item.costPrice * item.quantity
        softNotes.push(
          `${item.productName} came at two costs (₦${existing.costPrice.toLocaleString("en-NG")} and ₦${item.costPrice.toLocaleString("en-NG")}). On the way it is one line at ₦${money(value / together).toLocaleString("en-NG")} each; the bill total is unchanged.`
        )
        existing.costPrice = value / together
      }
      existing.quantity += item.quantity
      existing.identities.push(...item.identities)
      existing.createdProduct = existing.createdProduct || item.createdProduct
    }
    billLines = [...merged.values()]
  }

  // 4. Calculate Financials
  const invoiceNumber = payload.invoiceNumber || generateDocNumber("PO")
  // One physical invoice is one bill, however many sittings it takes to load.
  // A bill number already on the system, for the same supplier and shop, takes
  // the new lines; it used to fail on the repeated number, so a long invoice
  // was split across several bills.
  const existingBill = payload.invoiceNumber
    ? await prisma.purchase.findUnique({
        where: { invoiceNumber },
        select: {
          id: true,
          supplierId: true,
          branchId: true,
          source: true,
          status: true,
          totalAmount: true,
          paidAmount: true,
          returnedAmount: true,
          shippingFee: true,
          notes: true,
          receivedDate: true,
        },
      })
    : null
  if (existingBill) {
    if (existingBill.supplierId !== supplierId || existingBill.branchId !== shop.id) {
      return { error: `Bill ${invoiceNumber} is already on the system for another supplier or shop. Open that bill, or start a new one.` }
    }
    if (existingBill.source !== UPLOAD_STOCK_SOURCE || existingBill.status === "CANCELLED") {
      return { error: `Bill ${invoiceNumber} cannot take more items here. Start a new bill.` }
    }
  }
  const totalAmount = billLines.reduce((sum, item) => sum + item.quantity * item.costPrice, 0)
  const shippingFee = Math.max(0, money(payload.shippingFee))
  const billBefore = existingBill
    ? purchaseBalance(existingBill)
    : { billed: 0, shipping: 0, payable: 0, paid: 0, sentBack: 0, remaining: 0, owed: 0, surplus: 0 }
  if (shippingFee + billBefore.shipping > totalAmount + billBefore.billed + 0.005) {
    return {
      error: `The shipping fee (₦${shippingFee.toLocaleString("en-NG")}) is more than everything uploaded on this bill (₦${totalAmount.toLocaleString("en-NG")}). Check the figure.`,
    }
  }
  // The shipping fee is inside the uploaded value but is not the supplier's
  // money, so the supplier is due the value less the fee.
  const billAfter = purchaseBalance({
    totalAmount: billBefore.billed + totalAmount,
    paidAmount: billBefore.paid,
    returnedAmount: billBefore.sentBack,
    shippingFee: billBefore.shipping + shippingFee,
  })
  const payable = billAfter.owed
  const amountPaid = Math.max(0, Number(payload.amountPaid) || 0)
  if (amountPaid > payable + 0.005) {
    return {
      error: shippingFee > 0
        ? `You are paying ₦${amountPaid.toLocaleString("en-NG")}, but only ₦${payable.toLocaleString("en-NG")} is payable to the supplier after the shipping fee. Lower what you are paying now.`
        : `You are paying ₦${amountPaid.toLocaleString("en-NG")}, but this bill is only ₦${payable.toLocaleString("en-NG")}. Lower what you are paying now.`,
    }
  }
  // Money paid now leaves by transfer from a named bank, or in cash from the
  // till, so Money in and out can show where it went from.
  const payChannel = amountPaid > 0
    ? await resolveSupplierPayChannel(user, payload.paymentMethod || "", payload.bankAccountId || "")
    : null
  if (payChannel && "error" in payChannel) {
    return {
      error: payload.paymentMethod
        ? payChannel.error
        : "Say how you paid the supplier: by transfer (and from which bank) or in cash.",
    }
  }
  const balanceOwed = Math.max(0, payable - amountPaid)
  const fullyPaid = billAfter.payable > 0 && balanceOwed <= 0.005
  const uploadDate = payload.uploadDate ? new Date(payload.uploadDate) : new Date()
  const expectedDate = onTheWay && payload.expectedDate ? new Date(payload.expectedDate) : null
  const lotNumber = onTheWay ? generateDocNumber("IN") : null

  let totalPhones = 0
  let totalPieces = 0
  const totalProductsAdded = billLines.filter((i) => i.createdProduct).length

  const purchase = await prisma.$transaction(async (tx) => {
    // More lines on a bill already on the system: its figures grow, and a
    // line says when and how much was added, so the paper trail is whole.
    const po = existingBill
      ? await tx.purchase.update({
          where: { id: existingBill.id },
          data: {
            totalAmount: { increment: totalAmount.toFixed(2) },
            shippingFee: { increment: shippingFee.toFixed(2) },
            paidAmount: { increment: amountPaid.toFixed(2) },
            paymentMethod: fullyPaid ? "PAID_ON_UPLOAD" : billBefore.paid + amountPaid > 0 ? "PARTIAL_PAYMENT" : "UNPAID",
            ...(onTheWay && expectedDate ? { expectedDate } : {}),
            notes: [
              existingBill.notes,
              `Added ${billLines.length} line(s) worth ₦${totalAmount.toLocaleString("en-NG")} on ${uploadDate.toISOString().slice(0, 10)}${onTheWay ? " as goods still on the way" : ""}.`,
              amountPaid > 0 ? `Paid ₦${amountPaid.toLocaleString("en-NG")} with it.` : null,
              payload.notes || null,
            ]
              .filter(Boolean)
              .join(" "),
          },
        })
      : await tx.purchase.create({
      data: {
        invoiceNumber,
        supplierId,
        branchId: shop.id,
        userId: user.id,
        status: onTheWay ? "ORDERED" : "RECEIVED",
        totalAmount: totalAmount.toFixed(2),
        paidAmount: amountPaid.toFixed(2),
        shippingFee: shippingFee.toFixed(2),
        paymentMethod: fullyPaid ? "PAID_ON_UPLOAD" : amountPaid > 0 ? "PARTIAL_PAYMENT" : "UNPAID",
        source: UPLOAD_STOCK_SOURCE,
        sessionOpen: false,
        receivedDate: onTheWay ? null : uploadDate,
        expectedDate,
        createdAt: uploadDate,
        notes: [
          onTheWay ? `Uploaded on Stock Upload as goods still on the way (${lotNumber}).` : `Uploaded on Stock Upload.`,
          fullyPaid
            ? "This bill was paid in full when the stock was loaded."
            : amountPaid > 0
              ? `Partial payment of ₦${amountPaid.toLocaleString("en-NG")} on upload. Balance: ₦${balanceOwed.toLocaleString("en-NG")}.`
              : `Unpaid invoice. Balance: ₦${balanceOwed.toLocaleString("en-NG")}.`,
          shippingFee > 0
            ? `Shipping fee of ₦${shippingFee.toLocaleString("en-NG")} is inside the uploaded value and was taken off what the supplier is due.`
            : null,
          payload.notes || null,
        ]
          .filter(Boolean)
          .join(" "),
      },
    })

    // Record Finance Entry if initial payment made
    if (amountPaid > 0 && payChannel && !("error" in payChannel)) {
      await tx.financeEntry.create({
        data: {
          branchId: shop.id,
          // Cash is written the way Pay supplier writes it, so it leaves the
          // till. A transfer carries the bank account it was sent from.
          account: payChannel.account === "CASH" ? "CASH" : "SUPPLIER_PAYMENTS",
          bankAccountId: payChannel.bankAccountId,
          type: "EXPENSE",
          amount: amountPaid.toFixed(2),
          reference: invoiceNumber,
          description:
            payChannel.account === "CASH"
              ? `${SUPPLIER_PAYMENT_NOTE}${invoiceNumber} · ${supplierName} · paid in cash on upload`
              : `Supplier payment on upload for ${invoiceNumber} (${supplierName}) · from ${payChannel.from}`,
        },
      })
    }

    // Prices a price setter typed for items already on the price list.
    if (maySetPrices) {
      for (const move of priceMoves) {
        await tx.product.update({ where: { id: move.productId }, data: { [move.key]: move.to.toFixed(2) } })
        await tx.priceHistory.create({
          data: {
            productId: move.productId,
            oldPrice: move.from.toFixed(2),
            newPrice: move.to.toFixed(2),
            priceType: move.key === "minimumPrice" ? "MINIMUM_PRICE" : "SELLING_PRICE",
            reason: `Set on supplier bill ${invoiceNumber}`,
            changedBy: user.id,
          },
        })
        // The same line a price change on the price list leaves in Who did what.
        await tx.auditLog.create({
          data: {
            userId: user.id,
            action: "UPDATE",
            entityType: "Product",
            entityId: move.productId,
            oldValue: JSON.stringify({ [move.key]: move.from }),
            newValue: JSON.stringify({
              [move.key]: move.to,
              reason: `Set on supplier bill ${invoiceNumber}`,
              note: `Prices changed on supplier bill ${invoiceNumber}: ${move.name}.`,
            }),
            branchId: shop.id,
          },
        })
      }
    }

    // Goods still on the way wait on one carton until someone receives them.
    const lot = onTheWay
      ? await tx.incomingLot.create({
          data: {
            lotNumber: lotNumber!,
            branchId: shop.id,
            supplierId,
            purchaseId: po.id,
            userId: user.id,
            expectedDate,
            visible: false,
            notes: `Uploaded on supplier bill ${invoiceNumber}`,
          },
        })
      : null

    // Process each item
    for (const item of billLines) {
      const tracked = item.tracking === "IMEI" || item.tracking === "SERIAL"
      // Purchase Item. On a bill that already has this item, the line grows:
      // at the same cost it simply counts more; still on the way (received
      // against one line per item) two costs share the line at their average.
      const sameLine = existingBill
        ? await tx.purchaseItem.findFirst({
            where: {
              purchaseId: po.id,
              productId: item.productId,
              ...(onTheWay ? {} : { costPrice: item.costPrice.toFixed(2) }),
            },
          })
        : null
      if (sameLine) {
        const quantity = sameLine.quantity + item.quantity
        const lineTotal = money(sameLine.totalAmount) + item.quantity * item.costPrice
        await tx.purchaseItem.update({
          where: { id: sameLine.id },
          data: {
            quantity,
            receivedQty: onTheWay ? sameLine.receivedQty : sameLine.receivedQty + item.quantity,
            costPrice: (lineTotal / quantity).toFixed(2),
            totalAmount: lineTotal.toFixed(2),
          },
        })
      } else {
        await tx.purchaseItem.create({
          data: {
            purchaseId: po.id,
            productId: item.productId,
            quantity: item.quantity,
            receivedQty: onTheWay ? 0 : item.quantity,
            costPrice: item.costPrice.toFixed(2),
            totalAmount: (item.quantity * item.costPrice).toFixed(2),
          },
        })
      }

      if (lot) {
        // Counted as coming, not as stock: the shelf and the till do not see it.
        await tx.incomingItem.create({
          data: {
            lotId: lot.id,
            productId: item.productId,
            quantity: item.quantity,
            expectedQuantity: item.quantity,
            identity: tracked ? item.tracking : "NONE",
            identifiers: tracked ? item.identities.join("\n") : null,
          },
        })
        await tx.inventory.upsert({
          where: { productId_branchId: { productId: item.productId, branchId: shop.id } },
          update: { incomingQty: { increment: item.quantity } },
          create: { productId: item.productId, branchId: shop.id, quantity: 0, incomingQty: item.quantity },
        })
      } else {
        // Increase Shop Inventory
        await tx.inventory.upsert({
          where: { productId_branchId: { productId: item.productId, branchId: shop.id } },
          update: { quantity: { increment: item.quantity }, lastStockCheck: new Date() },
          create: { productId: item.productId, branchId: shop.id, quantity: item.quantity, lastStockCheck: new Date() },
        })
        await recordMovement(tx, {
          productId: item.productId,
          branchId: shop.id,
          quantity: item.quantity,
          move: { kind: "RECEIVED", reference: invoiceNumber, userId: user.id },
        })
      }

      // If IMEI / SERIAL, insert individual records
      if (tracked) {
        totalPhones += item.identities.length
        const unitRows = item.identities.map((id) => {
          const isImei = item.tracking === "IMEI"
          const imeiDigits = isImei ? id.replace(/\D/g, "") : null
          return {
            imei1: imeiDigits || id,
            serialNumber: !isImei ? id : null,
            productId: item.productId,
            branchId: shop.id,
            supplierId,
            purchaseId: po.id,
            status: lot ? ("INCOMING" as const) : ("IN_STOCK" as const),
            // Receiving finds a carton's units by its number in this note.
            notes: lot ? `Coming on ${lot.lotNumber} · ${invoiceNumber}` : `Uploaded via Stock Upload · ${invoiceNumber}`,
          }
        })
        for (const batch of chunks(unitRows, WRITE_CHUNK)) {
          await tx.imeiRecord.createMany({ data: batch })
        }
      } else {
        totalPieces += item.quantity
      }
    }

    if (existingBill) {
      // Where the whole bill stands now: every line in, some, or none yet.
      const lines = await tx.purchaseItem.findMany({ where: { purchaseId: po.id }, select: { quantity: true, receivedQty: true } })
      const allIn = lines.every((row) => row.receivedQty >= row.quantity)
      const someIn = lines.some((row) => row.receivedQty > 0)
      await tx.purchase.update({
        where: { id: po.id },
        data: {
          status: allIn ? "RECEIVED" : someIn ? "PARTIAL_RECEIVED" : "ORDERED",
          receivedDate: allIn ? existingBill.receivedDate ?? uploadDate : existingBill.receivedDate,
        },
      })
    }

    return po
  }, { timeout: 180_000, maxWait: 20_000 })

  // 6. Audit Trail
  await trail(
    user.id,
    "Purchase",
    {
      invoiceNumber,
      supplier: supplierName,
      shop: shop.name,
      totalAmount,
      shippingFee,
      payable,
      amountPaid,
      balanceOwed,
      paidFrom: payChannel && !("error" in payChannel) ? payChannel.from : null,
      pricesSet: maySetPrices ? priceMoves.map((row) => ({ item: row.name, price: row.key, from: row.from, to: row.to })) : [],
      onTheWay,
      lotNumber,
      itemsCount: billLines.length,
      phonesAdded: totalPhones,
      piecesAdded: totalPieces,
      action: "batch-stock-upload",
    },
    shop.id
  )

  revalidateStockViews()

  return {
    success: true,
    invoiceNumber,
    purchaseId: purchase.id,
    supplierId,
    addedToBill: Boolean(existingBill),
    submissionValue: totalAmount,
    paidAmount: amountPaid,
    balanceOwed,
    shippingFee,
    payable,
    onTheWay,
    lotNumber: lotNumber ?? undefined,
    paid: fullyPaid,
    phones: totalPhones,
    pieces: totalPieces,
    products: totalProductsAdded,
    added: totalPhones + totalPieces,
    skipped: skippedExisting,
    duplicates: softNotes.filter((n) => n.includes("more than once") || n.includes("duplicate")).length,
    problems: softNotes.length ? softNotes.slice(0, 40) : undefined,
  }
}

