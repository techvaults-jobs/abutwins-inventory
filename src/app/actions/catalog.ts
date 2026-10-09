"use server"

import { revalidatePath } from "next/cache"
import { Prisma, ProductTracking } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { watDayKey } from "@/lib/lagos-day"
import { requireUser } from "@/lib/session"
import { canAddItemName, canChangeCost, canChangePrices, canHardDelete, canManageCatalog, canSeePriceListCost, PRICE_SETTER_ROLES, setsStartingPrices } from "@/lib/rbac"
import { can } from "@/lib/permissions"
import { shopError } from "@/lib/shop-speak"
import { UNSAFE_KEYS } from "@/lib/table-file"
import { parseShopCondition, shopConditionHelp } from "@/lib/conditions"
import { makeOpeningSku } from "@/lib/opening-stock"
import { LIVE_UNIT_STATUSES } from "@/lib/unit-identity"
import { money } from "@/lib/utils"

async function findOrCreateBrand(name: string) {
  const wanted = name.trim()
  if (!wanted) return null
  const brands = await prisma.brand.findMany({ select: { id: true, name: true } })
  const hit = brands.find((row) => row.name.toLowerCase() === wanted.toLowerCase())
  if (hit) return hit.id
  const created = await prisma.brand.create({ data: { name: wanted } })
  return created.id
}

async function findOrCreateCategory(name: string) {
  const wanted = name.trim() || "Phones"
  const categories = await prisma.category.findMany({ select: { id: true, name: true } })
  const hit = categories.find((row) => row.name.toLowerCase() === wanted.toLowerCase())
  if (hit) return hit.id
  const created = await prisma.category.create({ data: { name: wanted } })
  return created.id
}

async function uniqueSku(base: string) {
  const cleaned = (base || "ITEM").slice(0, 60)
  let sku = cleaned
  let n = 2
  while (await prisma.product.findUnique({ where: { sku } })) {
    sku = `${cleaned.slice(0, 56)}-${n}`
    n += 1
    if (n > 99) return `${cleaned.slice(0, 50)}-${Date.now().toString(36).slice(-6)}`
  }
  return sku
}

async function shopsForScope(formData: FormData) {
  const scope = String(formData.get("shopScope") || "all")
  if (scope === "one") {
    const branchId = String(formData.get("branchId") || "")
    if (!branchId) return { error: "Pick the shop this name should show on, or choose All shops." }
    const shop = await prisma.branch.findFirst({ where: { id: branchId, isActive: true } })
    if (!shop) return { error: "That shop is not open." }
    return { shops: [shop] }
  }
  const shops = await prisma.branch.findMany({ where: { isActive: true } })
  if (shops.length === 0) return { error: "There is no open shop to put this name on." }
  return { shops }
}

/**
 * A new item saved without a selling price cannot be sold until it is priced,
 * so the people who price items are told straight away: the CEO, the main
 * admin, and the manager of the shop that added it.
 */
async function askOwnersToPrice(names: string[], byName: string, branchId: string | null) {
  if (names.length === 0) return
  const owners = await prisma.user.findMany({
    where: {
      isActive: true,
      role: { in: [...PRICE_SETTER_ROLES] },
      OR: [{ role: { not: "BRANCH_MANAGER" } }, ...(branchId ? [{ branchId }] : [])],
    },
    select: { id: true },
  })
  if (owners.length === 0) return
  const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "")
  await prisma.notification.createMany({
    data: owners.map((owner) => ({
      userId: owner.id,
      type: "SYSTEM" as const,
      title: names.length === 1 ? "A new item needs its prices" : `${names.length} new items need their prices`,
      message: `${byName} added ${shown}. It cannot be sold until you set its cost, lowest and selling price.`,
      actionUrl: names.length === 1 ? `/products?q=${encodeURIComponent(names[0])}` : "/products",
    })),
  })
}

async function putNameOnShops(productId: string, shopIds: string[]) {
  for (const branchId of shopIds) {
    await prisma.inventory.upsert({
      where: { productId_branchId: { productId, branchId } },
      create: { productId, branchId, quantity: 0 },
      update: {},
    })
  }
}

export async function getProductLookups() {
  await requireUser()
  const [brands, categories, branches] = await Promise.all([
    prisma.brand.findMany({ orderBy: { name: "asc" } }),
    prisma.category.findMany({ orderBy: { name: "asc" } }),
    prisma.branch.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }),
  ])
  return { brands, categories, branches }
}

export async function getProducts(search?: string) {
  const user = await requireUser()
  const rows = await prisma.product.findMany({
    where: {
      isActive: true,
      ...(search
        ? {
            OR: [
              { name: { contains: search } },
              { sku: { contains: search } },
            ],
          }
        : {}),
    },
    include: {
      brand: true,
      category: true,
      inventory: { include: { branch: true } },
      _count: { select: { imeiRecords: true } },
    },
    orderBy: { updatedAt: "desc" },
  })
  // A server action is a public endpoint: the price list hides cost on screen,
  // but this used to hand every cost price to anyone signed in who called it.
  if (canSeePriceListCost(user.role)) return rows
  return rows.map((row) => ({ ...row, costPrice: new Prisma.Decimal(0) }))
}

export async function createProduct(formData: FormData) {
  const user = await requireUser()
  if (!(await canAddItemName(user.role))) return { error: "You are not allowed to add items. Ask the main admin." }
  // The CEO, the main admin, the branch manager and catalog staff price the
  // item as they add it, so it can be sold at once. Anyone else adds the name
  // only: whatever the form sends, their new item starts with no prices.
  const pricesAllowed = await setsStartingPrices(user.role)

  const name = String(formData.get("name") ?? "").trim()
  if (!name) return { error: "Type the product name." }

  const brandName = String(formData.get("brandName") || "").trim()
  const brandIdField = String(formData.get("brandId") || "").trim()
  let brandId = brandIdField
  if (brandName) {
    brandId = (await findOrCreateBrand(brandName)) || ""
  }
  if (!brandId) return { error: "Type or pick a brand name." }

  const categoryName = String(formData.get("categoryName") || "").trim()
  const categoryIdField = String(formData.get("categoryId") || "").trim()
  if (!categoryName && !categoryIdField) {
    return { error: "Type the category, for example Phones, Laptops, Accessories, or Screen." }
  }
  const categoryId = categoryName
    ? await findOrCreateCategory(categoryName)
    : categoryIdField

  const condition = parseShopCondition(String(formData.get("condition") || "BRAND_NEW"))
  if (!condition) {
    return { error: "Pick How the phone looks: Brand New, Brand New (Locked), Brand New (N/A), UK, UK (Locked), Open Box, or Standard." }
  }

  const storage = String(formData.get("storage") || "").trim()
  const brand = await prisma.brand.findUnique({ where: { id: brandId } })
  let sku = String(formData.get("sku") ?? "").trim()
  if (sku) {
    const existing = await prisma.product.findUnique({ where: { sku } })
    if (existing) return { error: "That item code is already being used." }
  } else {
    sku = await uniqueSku(
      makeOpeningSku({
        brand: brand?.name || "ITEM",
        name,
        storage,
        condition,
      })
    )
  }

  const costPrice = pricesAllowed ? Number(formData.get("costPrice") || 0) : 0
  const sellingPrice = pricesAllowed ? Number(formData.get("sellingPrice") || 0) : 0
  const minimumPrice = pricesAllowed ? Number(formData.get("minimumPrice") || sellingPrice || 0) : 0
  if (
    ![costPrice, sellingPrice, minimumPrice].every((value) => Number.isFinite(value) && value >= 0)
  ) {
    return { error: "Cost, lowest and selling price must be numbers. Use 0 if you will set prices later." }
  }
  if (sellingPrice > 0 && minimumPrice > sellingPrice) {
    return { error: "The lowest price cannot be above the selling price." }
  }

  const tracking = String(formData.get("tracking") || "IMEI")
  if (!(tracking in ProductTracking)) return { error: "Pick how we count this item: IMEI, Serial number, or No number." }

  const shops = await shopsForScope(formData)
  if ("error" in shops) return { error: shops.error }

  const product = await prisma.product.create({
    data: {
      sku,
      name,
      description: String(formData.get("description") || "") || null,
      brandId,
      categoryId,
      condition,
      color: String(formData.get("color") || "") || null,
      storage: storage || null,
      ram: String(formData.get("ram") || "") || null,
      costPrice: costPrice.toFixed(2),
      minimumPrice: Math.max(0, minimumPrice).toFixed(2),
      sellingPrice: sellingPrice.toFixed(2),
      marketPrice: formData.get("marketPrice") ? Number(formData.get("marketPrice")).toFixed(2) : null,
      warrantyDays: Math.max(0, Number(formData.get("warrantyDays") || 0)),
      tracking: tracking as ProductTracking,
    },
  })

  await putNameOnShops(
    product.id,
    shops.shops.map((shop) => shop.id)
  )

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "CREATE",
      entityType: "Product",
      entityId: product.id,
      newValue: JSON.stringify({
        sku,
        name,
        shops: shops.shops.map((shop) => shop.code),
        pricesSet: sellingPrice > 0,
        ...(pricesAllowed ? { startingPrices: { costPrice, minimumPrice, sellingPrice } } : {}),
      }),
      branchId: user.branchId,
    },
  })
  if (!(sellingPrice > 0)) {
    await askOwnersToPrice([[name, storage].filter(Boolean).join(" ")], user.name || user.email, user.branchId)
  }

  revalidatePath("/products")
  revalidatePath("/products/new")
  revalidatePath("/inventory")
  revalidatePath("/pos")
  return { success: true }
}

/**
 * One item's prices, cost, lowest and selling, saved together: the Prices
 * panel on Business today, and Prices on a price list line for a branch
 * manager. Every move lands in the price history and Who did what.
 */
export async function setProductPrices(input: {
  id: string
  costPrice: number
  minimumPrice: number
  sellingPrice: number
  reason?: string
  /** Where the change was made, for the price history when no reason is typed. */
  from?: "owner" | "price-list"
}) {
  const user = await requireUser()
  if (!canChangeCost(user.role)) return { error: "Only the CEO, the main admin or a branch manager can change prices." }

  const next = {
    costPrice: Number(input.costPrice),
    minimumPrice: Number(input.minimumPrice),
    sellingPrice: Number(input.sellingPrice),
  }
  if (!Object.values(next).every((value) => Number.isFinite(value) && value >= 0)) {
    return { error: "Cost, lowest and selling price must be numbers of 0 or more." }
  }
  if (next.sellingPrice <= 0) return { error: "The selling price must be above 0." }
  if (next.minimumPrice > next.sellingPrice) return { error: "The lowest price cannot be above the selling price." }

  const product = await prisma.product.findUnique({ where: { id: input.id } })
  if (!product) return { error: "That item was not found. Refresh and try again." }

  const before = {
    costPrice: money(product.costPrice),
    minimumPrice: money(product.minimumPrice),
    sellingPrice: money(product.sellingPrice),
  }
  const moved = (Object.keys(next) as Array<keyof typeof next>).filter((key) => before[key] !== money(next[key]))
  if (moved.length === 0) return { success: true, message: "Those are already the prices." }

  const where = input.from === "price-list" ? "the price list" : "Business today"
  const reason = String(input.reason || "").trim() || `Changed on ${where}`
  const TYPE = { costPrice: "COST_PRICE", minimumPrice: "MINIMUM_PRICE", sellingPrice: "SELLING_PRICE" } as const

  await prisma.$transaction([
    prisma.product.update({
      where: { id: product.id },
      data: {
        costPrice: next.costPrice.toFixed(2),
        minimumPrice: next.minimumPrice.toFixed(2),
        sellingPrice: next.sellingPrice.toFixed(2),
      },
    }),
    ...moved.map((key) =>
      prisma.priceHistory.create({
        data: {
          productId: product.id,
          oldPrice: before[key].toFixed(2),
          newPrice: next[key].toFixed(2),
          priceType: TYPE[key],
          reason,
          changedBy: user.id,
        },
      })
    ),
    prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "UPDATE",
        entityType: "Product",
        entityId: product.id,
        oldValue: JSON.stringify(Object.fromEntries(moved.map((key) => [key, before[key]]))),
        newValue: JSON.stringify({
          ...Object.fromEntries(moved.map((key) => [key, next[key]])),
          reason,
          note: `Prices changed on ${where}: ${product.name} (${product.sku}).`,
        }),
        branchId: user.branchId,
        risk: moved.includes("costPrice") ? "MEDIUM" : "LOW",
      },
    }),
  ])

  revalidatePath("/owner")
  revalidatePath("/products")
  revalidatePath("/inventory")
  revalidatePath("/pos")
  return { success: true, message: `${product.name}: prices saved.` }
}

export async function updateSelectedPrices(formData: FormData) {
  const user = await requireUser()
  if (!canChangePrices(user.role)) return { error: "Only the CEO, the main admin or a branch manager can change prices." }

  const reason = String(formData.get("reason") || "Several prices updated together").trim() || "Several prices updated together"
  let parsed: unknown
  try {
    parsed = JSON.parse(String(formData.get("changes") || "[]"))
  } catch {
    return { error: "Tick the items and type each new selling price." }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { error: "Tick the items whose prices you want to change." }
  }
  if (parsed.length > 200) return { error: "Update up to 200 items at a time." }

  const changes: Array<{ id: string; sellingPrice: number }> = []
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue
    const id = String((row as { id?: unknown }).id || "")
    const sellingPrice = Number((row as { sellingPrice?: unknown }).sellingPrice)
    if (!id) continue
    changes.push({ id, sellingPrice })
  }
  if (changes.length === 0) return { error: "Tick the items whose prices you want to change." }

  const canFloor = await can(user.role, "action.override_floor")
  const products = await prisma.product.findMany({
    where: { id: { in: [...new Set(changes.map((row) => row.id))] } },
  })
  const byId = new Map(products.map((product) => [product.id, product]))
  const problems: string[] = []
  // oldMinimum is set when a mark-down goes under the item's lowest allowed
  // price. The lowest follows it down, so staff can sell at the new price.
  const work: Array<{ id: string; name: string; oldPrice: string; next: number; oldMinimum?: string }> = []

  for (const change of changes) {
    const product = byId.get(change.id)
    if (!product) {
      problems.push("One ticked item was not found. Refresh the page and try again.")
      continue
    }
    if (!Number.isFinite(change.sellingPrice) || change.sellingPrice <= 0) {
      problems.push(`${product.name}: selling price must be a number above 0.`)
      continue
    }
    if (change.sellingPrice < Number(product.minimumPrice) && !canFloor) {
      problems.push(`${product.name} is below the lowest allowed price. Raise it, or ask the main admin.`)
      continue
    }
    if (Number(product.sellingPrice) === change.sellingPrice) continue
    work.push({
      id: product.id,
      name: product.name,
      oldPrice: String(product.sellingPrice),
      next: change.sellingPrice,
      oldMinimum: change.sellingPrice < Number(product.minimumPrice) ? String(product.minimumPrice) : undefined,
    })
  }

  if (problems.length) return { error: problems.slice(0, 4).join(" ") }
  if (work.length === 0) return { error: "Those selling prices are already what you typed." }

  try {
    await prisma.$transaction(async (tx) => {
      for (const row of work) {
        const newPrice = row.next.toFixed(2)
        await tx.product.update({
          where: { id: row.id },
          data: row.oldMinimum ? { sellingPrice: newPrice, minimumPrice: newPrice } : { sellingPrice: newPrice },
        })
        if (row.oldMinimum) {
          await tx.priceHistory.create({
            data: {
              productId: row.id,
              oldPrice: row.oldMinimum,
              newPrice,
              priceType: "MINIMUM_PRICE",
              reason,
              changedBy: user.id,
            },
          })
        }
        await tx.priceHistory.create({
          data: {
            productId: row.id,
            oldPrice: row.oldPrice,
            newPrice,
            priceType: "SELLING_PRICE",
            reason,
            changedBy: user.id,
          },
        })
      }
      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: "UPDATE",
          entityType: "Product",
          entityId: work[0].id,
          oldValue: JSON.stringify(work.map((row) => ({ name: row.name, sellingPrice: Number(row.oldPrice) }))),
          newValue: JSON.stringify({
            updated: work.length,
            names: work.map((row) => row.name),
            reason,
          }),
          branchId: user.branchId,
        },
      })
    })
  } catch (error) {
    return { error: shopError(error, "We could not save those selling prices. Try again.") }
  }

  revalidatePath("/products")
  revalidatePath("/pos")
  revalidatePath("/inventory")
  return { success: true, updated: work.length }
}

export async function updateProductWarranty(formData: FormData) {
  const user = await requireUser()
  if (!(await canManageCatalog(user.role))) return { error: "You are not allowed to add or change items. Ask the main admin." }
  const id = String(formData.get("id") || "")
  const warrantyDays = Number(formData.get("warrantyDays") || 0)
  if (!id || warrantyDays < 0) return { error: "Enter valid warranty days (0 for no warranty)." }
  const product = await prisma.product.findUnique({ where: { id } })
  if (!product) return { error: "We could not find that item." }
  await prisma.product.update({ where: { id }, data: { warrantyDays } })
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "UPDATE",
      entityType: "Product",
      entityId: id,
      oldValue: String(product.warrantyDays),
      newValue: String(warrantyDays),
      branchId: user.branchId,
    },
  })
  revalidatePath("/products")
  revalidatePath("/imei")
  revalidatePath("/sales")
  return { success: true }
}

const TRACKING: Record<string, ProductTracking> = {
  imei: "IMEI",
  phone: "IMEI",
  serial: "SERIAL",
  none: "NONE",
  no_number: "NONE",
  nonumber: "NONE",
}

function keyName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")
}

function cell(row: Record<string, string>, ...names: string[]) {
  const wanted = new Set(names.map(keyName))
  for (const [key, value] of Object.entries(row)) {
    if (wanted.has(keyName(key)) && value.trim()) return value.trim()
  }
  return ""
}

function parseCsv(text: string) {
  const rows: string[][] = []
  let row: string[] = []
  let cellValue = ""
  let quoted = false
  const input = text.replace(/^\uFEFF/, "")
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        cellValue += '"'
        i += 1
      } else if (char === '"') {
        quoted = false
      } else {
        cellValue += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
      continue
    }
    if (char === "," || char === "\t") {
      row.push(cellValue)
      cellValue = ""
      continue
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i += 1
      row.push(cellValue)
      if (row.some((item) => item.trim())) rows.push(row)
      row = []
      cellValue = ""
      continue
    }
    cellValue += char
  }
  row.push(cellValue)
  if (row.some((item) => item.trim())) rows.push(row)
  return rows
}

function rowsFromSheet(text: string) {
  const table = parseCsv(text)
  if (table.length < 2) return []
  const headers = table[0].map((item) => item.trim())
  return table.slice(1).map((line) => {
    const row: Record<string, string> = {}
    headers.forEach((header, index) => {
      if (UNSAFE_KEYS.has(header)) return
      row[header] = line[index] ?? ""
    })
    return row
  })
}

async function readUpload(file: File) {
  const name = file.name.toLowerCase()
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const XLSX = await import("xlsx")
    const workbook = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: "buffer" })
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    if (!sheet) return []
    return XLSX.utils.sheet_to_json<Record<string, string | number>>(sheet, { defval: "" }).map((row) =>
      Object.fromEntries(
        Object.entries(row)
          .filter(([key]) => !UNSAFE_KEYS.has(key))
          .map(([key, value]) => [String(key), String(value ?? "").trim()])
      )
    )
  }
  return rowsFromSheet(await file.text())
}

export async function importProducts(formData: FormData) {
  const user = await requireUser()
  // The item list is loaded centrally. If three shops could each add items,
  // one phone would end up on the system under three different names.
  if (!(await can(user.role, "action.upload"))) {
    return { error: "Only the main admin and the person who loads stock can load the item list from a sheet." }
  }

  const file = formData.get("file")
  if (!(file instanceof File) || file.size === 0) return { error: "Choose an Excel or CSV file first." }
  if (file.size > 2_000_000) return { error: "That file is too big. Use a file under 2 MB." }

  let rows: Record<string, string>[]
  try {
    rows = await readUpload(file)
  } catch {
    return { error: "We could not read that file. Save it as Excel or CSV and try again." }
  }
  if (rows.length === 0) return { error: "There is no item under the header line in that file." }
  if (rows.length > 400) return { error: "Upload up to 400 products at a time." }

  const shopsPicked = await shopsForScope(formData)
  if ("error" in shopsPicked) return { error: shopsPicked.error }
  // Same rule as Add one item: only people who price items give new ones prices.
  const pricesAllowed = await setsStartingPrices(user.role)
  const unpriced: string[] = []

  const [brands, categories] = await Promise.all([
    prisma.brand.findMany(),
    prisma.category.findMany(),
  ])
  const brandIds = new Map(brands.map((row) => [row.name.toLowerCase(), row.id]))
  const categoryIds = new Map(categories.map((row) => [row.name.toLowerCase(), row.id]))

  let created = 0
  let skipped = 0
  const errors: string[] = []

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const line = index + 2
    // Sample rows on the handed-out sheet are never loaded.
    if (cell(row, "row_type", "type", "row").toUpperCase() === "SAMPLE") continue
    const skuCell = cell(row, "item_code", "sku", "code")
    const name = cell(row, "name", "product", "item", "product_name")
    const brandName = cell(row, "brand")
    const categoryName = cell(row, "category")
    if (!name || !brandName) {
      errors.push(`Line ${line}: product name and brand are required. Use the real name, for example iPhone 13 or MacBook Pro M3.`)
      continue
    }
    if (!categoryName) {
      errors.push(`Line ${line}: type the category, for example Phones, Laptops, Accessories, or Screen.`)
      continue
    }

    const trackingKey = keyName(cell(row, "tracking") || "IMEI")
    const tracking = TRACKING[trackingKey] || "IMEI"
    const condition = parseShopCondition(cell(row, "condition") || "BRAND_NEW")
    if (!condition) {
      errors.push(`Line ${line}: How the phone looks is not one we know. Use ${shopConditionHelp()}.`)
      continue
    }

    const costPrice = pricesAllowed ? Number(cell(row, "cost", "cost_price") || 0) : 0
    const sellingPrice = pricesAllowed ? Number(cell(row, "selling", "selling_price") || 0) : 0
    const minimumPrice = pricesAllowed
      ? Number(cell(row, "minimum", "minimum_price", "min", "lowest_price", "lowest") || sellingPrice)
      : 0
    if (!Number.isFinite(costPrice) || !Number.isFinite(sellingPrice) || sellingPrice < 0 || costPrice < 0) {
      errors.push(`Line ${line}: cost and sell price must be numbers. Leave them empty to register the name only.`)
      continue
    }

    let sku = skuCell
    if (sku) {
      const existing = await prisma.product.findUnique({ where: { sku } })
      if (existing) {
        skipped += 1
        continue
      }
    } else {
      sku = await uniqueSku(
        makeOpeningSku({
          brand: brandName,
          name,
          storage: cell(row, "storage"),
          condition,
        })
      )
    }

    let brandId = brandIds.get(brandName.toLowerCase())
    if (!brandId) {
      const brand = await prisma.brand.create({ data: { name: brandName } })
      brandId = brand.id
      brandIds.set(brandName.toLowerCase(), brandId)
    }
    let categoryId = categoryIds.get(categoryName.toLowerCase())
    if (!categoryId) {
      const category = await prisma.category.create({ data: { name: categoryName } })
      categoryId = category.id
      categoryIds.set(categoryName.toLowerCase(), categoryId)
    }

    const product = await prisma.product.create({
      data: {
        sku,
        name,
        brandId,
        categoryId,
        tracking,
        condition,
        color: cell(row, "color") || null,
        storage: cell(row, "storage") || null,
        ram: cell(row, "ram") || null,
        costPrice: costPrice.toFixed(2),
        minimumPrice: Math.max(0, minimumPrice).toFixed(2),
        sellingPrice: sellingPrice.toFixed(2),
        warrantyDays: Number(cell(row, "warranty_days", "warranty") || 0) || 0,
        description: cell(row, "description") || null,
      },
    })
    await putNameOnShops(
      product.id,
      shopsPicked.shops.map((shop) => shop.id)
    )
    created += 1
    if (!(sellingPrice > 0)) unpriced.push(name)
  }
  await askOwnersToPrice(unpriced, user.name || user.email, user.branchId)

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "CREATE",
      entityType: "Product",
      entityId: "bulk-upload",
      newValue: JSON.stringify({ created, skipped, errors: errors.length, file: file.name }),
      branchId: user.branchId,
    },
  })

  revalidatePath("/products")
  revalidatePath("/inventory")
  revalidatePath("/incoming")
  return { success: true, created, skipped, errors }
}

function cleanLabel(raw: FormDataEntryValue | null, label: string) {
  const name = String(raw ?? "").trim()
  if (!name) throw new Error(`Type the ${label}.`)
  return name
}

/**
 * Reseller markup for a category, as a percentage over cost. Left blank means
 * "no reseller quote for this category", which the till reads as 0 and falls
 * back to the standard price.
 */
function readMarkup(raw: FormDataEntryValue | null) {
  const text = String(raw ?? "").trim()
  if (!text) return { value: 0 }
  const parsed = Number(text)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { error: "Reseller markup must be a number from 0 up, like 12 for cost plus 12%." }
  }
  if (parsed > 500) return { error: "Reseller markup above 500% looks like a typing mistake." }
  return { value: Math.round(parsed * 100) / 100 }
}

export async function getCatalogTaxonomy() {
  await requireUser()
  const [brands, categories] = await Promise.all([
    prisma.brand.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { products: true } } },
    }),
    prisma.category.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { products: true } } },
    }),
  ])
  return { brands, categories }
}

export async function createBrand(formData: FormData) {
  const user = await requireUser()
  if (!(await canManageCatalog(user.role))) return { error: "You are not allowed to add brands. Ask the main admin." }
  try {
    const name = cleanLabel(formData.get("name"), "brand name")
    const exists = await prisma.brand.findUnique({ where: { name } })
    if (exists) return { error: `${name} is already on the brand list.` }
    await prisma.brand.create({ data: { name } })
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "CREATE",
        entityType: "Brand",
        entityId: name,
        newValue: JSON.stringify({ name }),
        branchId: user.branchId,
      },
    })
  } catch (error) {
    return { error: shopError(error, "Could not add that brand.") }
  }
  revalidatePath("/products")
  revalidatePath("/products/brands")
  revalidatePath("/products/new")
  return { success: true }
}

export async function updateBrand(formData: FormData) {
  const user = await requireUser()
  if (!(await canManageCatalog(user.role))) return { error: "You are not allowed to rename brands. Ask the main admin." }
  const id = String(formData.get("id") || "")
  try {
    const name = cleanLabel(formData.get("name"), "brand name")
    const existing = await prisma.brand.findUnique({ where: { id } })
    if (!existing) return { error: "We could not find that brand." }
    if (name !== existing.name) {
      const taken = await prisma.brand.findUnique({ where: { name } })
      if (taken) return { error: `${name} is already on the brand list.` }
    }
    await prisma.brand.update({ where: { id }, data: { name } })
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "UPDATE",
        entityType: "Brand",
        entityId: name,
        oldValue: existing.name,
        newValue: name,
        branchId: user.branchId,
      },
    })
  } catch (error) {
    return { error: shopError(error, "Could not rename that brand.") }
  }
  revalidatePath("/products")
  revalidatePath("/products/brands")
  revalidatePath("/products/new")
  return { success: true }
}

export async function deleteBrand(formData: FormData) {
  const user = await requireUser()
  if (!canHardDelete(user.role)) {
    return { error: "Only the CEO or the main admin can permanently remove a brand." }
  }
  if (!(await canManageCatalog(user.role))) return { error: "You are not allowed to remove brands. Ask the main admin." }
  const id = String(formData.get("id") || "")
  const brand = await prisma.brand.findUnique({
    where: { id },
    include: { _count: { select: { products: true } } },
  })
  if (!brand) return { error: "We could not find that brand." }
  if (brand._count.products > 0) {
    return {
      error: `${brand.name} still has ${brand._count.products} item${brand._count.products === 1 ? "" : "s"} on the price list. Move those items first.`,
    }
  }
  await prisma.brand.delete({ where: { id } })
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "DELETE",
      entityType: "Brand",
      entityId: brand.name,
      oldValue: brand.name,
      branchId: user.branchId,
    },
  })
  revalidatePath("/products")
  revalidatePath("/products/brands")
  revalidatePath("/products/new")
  return { success: true }
}

export async function createCategory(formData: FormData) {
  const user = await requireUser()
  if (!(await canManageCatalog(user.role))) return { error: "You are not allowed to add categories. Ask the main admin." }
  try {
    const name = cleanLabel(formData.get("name"), "category name")
    const description = String(formData.get("description") || "").trim() || null
    const markup = readMarkup(formData.get("resellerMarkup"))
    if ("error" in markup) return { error: markup.error }
    const exists = await prisma.category.findUnique({ where: { name } })
    if (exists) return { error: `${name} is already on the category list.` }
    await prisma.category.create({
      data: { name, description, resellerMarkup: markup.value.toFixed(2) },
    })
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "CREATE",
        entityType: "Category",
        entityId: name,
        newValue: JSON.stringify({ name, description, resellerMarkup: markup.value }),
        branchId: user.branchId,
      },
    })
  } catch (error) {
    return { error: shopError(error, "Could not add that category.") }
  }
  revalidatePath("/products")
  revalidatePath("/products/categories")
  revalidatePath("/products/new")
  revalidatePath("/pos")
  return { success: true }
}

export async function updateCategory(formData: FormData) {
  const user = await requireUser()
  if (!(await canManageCatalog(user.role))) return { error: "You are not allowed to edit categories. Ask the main admin." }
  const id = String(formData.get("id") || "")
  try {
    const name = cleanLabel(formData.get("name"), "category name")
    const description = String(formData.get("description") || "").trim() || null
    const markup = readMarkup(formData.get("resellerMarkup"))
    if ("error" in markup) return { error: markup.error }
    const existing = await prisma.category.findUnique({ where: { id } })
    if (!existing) return { error: "We could not find that category." }
    if (name !== existing.name) {
      const taken = await prisma.category.findUnique({ where: { name } })
      if (taken) return { error: `${name} is already on the category list.` }
    }
    await prisma.category.update({
      where: { id },
      data: { name, description, resellerMarkup: markup.value.toFixed(2) },
    })
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "UPDATE",
        entityType: "Category",
        entityId: name,
        oldValue: JSON.stringify({
          name: existing.name,
          description: existing.description,
          resellerMarkup: Number(existing.resellerMarkup),
        }),
        newValue: JSON.stringify({ name, description, resellerMarkup: markup.value }),
        branchId: user.branchId,
      },
    })
  } catch (error) {
    return { error: shopError(error, "Could not edit that category.") }
  }
  revalidatePath("/products")
  revalidatePath("/products/categories")
  revalidatePath("/products/new")
  revalidatePath("/pos")
  return { success: true }
}

export async function deleteCategory(formData: FormData) {
  const user = await requireUser()
  if (!canHardDelete(user.role)) {
    return { error: "Only the CEO or the main admin can permanently remove a category." }
  }
  if (!(await canManageCatalog(user.role))) return { error: "You are not allowed to remove categories. Ask the main admin." }
  const id = String(formData.get("id") || "")
  const category = await prisma.category.findUnique({
    where: { id },
    include: { _count: { select: { products: true } } },
  })
  if (!category) return { error: "We could not find that category." }
  if (category._count.products > 0) {
    return {
      error: `${category.name} still has ${category._count.products} item${category._count.products === 1 ? "" : "s"} on the price list. Move those items first.`,
    }
  }
  await prisma.category.delete({ where: { id } })
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "DELETE",
      entityType: "Category",
      entityId: category.name,
      oldValue: category.name,
      branchId: user.branchId,
    },
  })
  revalidatePath("/products")
  revalidatePath("/products/categories")
  revalidatePath("/products/new")
  return { success: true }
}

export async function updateProduct(formData: FormData) {
  const user = await requireUser()
  if (!(await canManageCatalog(user.role))) return { error: "You are not allowed to edit items. Ask the main admin." }
  const id = String(formData.get("id") || "")
  if (!id) return { error: "Item ID missing." }

  const name = String(formData.get("name") || "").trim()
  const sku = String(formData.get("sku") || "").trim()
  const text = (key: string) => String(formData.get(key) || "").trim() || null
  if (!name || !sku) return { error: "Name and Item Code (SKU) are required." }

  const existing = await prisma.product.findUnique({
    where: { id },
    include: { brand: true, category: true, inventory: { include: { branch: true } } },
  })
  if (!existing) return { error: "Item not found." }

  const condition = parseShopCondition(String(formData.get("condition") || existing.condition))
  if (!condition) return { error: "Pick How the phone looks from the list." }

  const trackingRaw = String(formData.get("tracking") || existing.tracking)
  if (!(trackingRaw in ProductTracking)) return { error: "Pick how we count this item: IMEI, Serial number, or No number." }
  const tracking = trackingRaw as ProductTracking

  // Prices on an item already on the list are for the price setters (CEO,
  // main admin, branch manager). Anyone else edits the details and the prices
  // stay exactly as they were, whatever the form sends.
  const pricesAllowed = canChangePrices(user.role)
  const costPrice = canChangeCost(user.role) ? Number(formData.get("costPrice") || 0) : money(existing.costPrice)
  const sellingPrice = pricesAllowed ? Number(formData.get("sellingPrice") || 0) : money(existing.sellingPrice)
  const minimumPrice = pricesAllowed ? Number(formData.get("minimumPrice") || sellingPrice) : money(existing.minimumPrice)
  if (![costPrice, sellingPrice, minimumPrice].every((value) => Number.isFinite(value) && value >= 0)) {
    return { error: "Cost, lowest price and selling price must be numbers. Use 0 if you will set them later." }
  }
  const warrantyDays = Math.floor(Number(formData.get("warrantyDays") ?? existing.warrantyDays))
  if (!Number.isFinite(warrantyDays) || warrantyDays < 0) return { error: "Warranty days must be 0 or more." }

  if (sku !== existing.sku) {
    const clash = await prisma.product.findUnique({ where: { sku } })
    if (clash) return { error: "That item code is already used by another item." }
  }

  const brandName = String(formData.get("brandName") || "").trim()
  const brandId = brandName ? await findOrCreateBrand(brandName) : existing.brandId
  if (!brandId) return { error: "Type or pick a brand name." }
  const categoryName = String(formData.get("categoryName") || "").trim()
  const categoryId = categoryName ? await findOrCreateCategory(categoryName) : existing.categoryId

  // Switching between IMEI and Serial number is always safe: each unit keeps
  // the number it was booked with, and new units follow the new choice.
  // Switching to or from No number is not, because the shelf count and the
  // numbered units would stop agreeing.
  if (tracking !== existing.tracking) {
    if (tracking === "NONE") {
      const liveUnits = await prisma.imeiRecord.count({
        where: { productId: id, status: { in: [...LIVE_UNIT_STATUSES] } },
      })
      if (liveUnits > 0) {
        return {
          error: `${liveUnits} unit(s) of ${existing.name} still have an IMEI or serial in a shop, on the way, or with the engineer. Sell, send back, or write them off on Reduce stock first, then change it to No number.`,
        }
      }
    } else if (existing.tracking === "NONE") {
      const holding = existing.inventory.filter((row) => row.quantity > 0 || row.incomingQty > 0)
      if (holding.length > 0) {
        const where = holding
          .map((row) => `${row.branch.name} (${row.quantity + row.incomingQty})`)
          .join(", ")
        return {
          error: `These shops still hold ${existing.name} as pieces with no number: ${where}. Reduce those to 0 on Reduce stock, change how we count it, then receive them again with each ${tracking === "SERIAL" ? "serial" : "IMEI"}.`,
        }
      }
    }
  }

  const before = {
    name: existing.name,
    sku: existing.sku,
    brand: existing.brand.name,
    category: existing.category.name,
    tracking: existing.tracking,
    condition: existing.condition,
    storage: existing.storage,
    ram: existing.ram,
    color: existing.color,
    warrantyDays: existing.warrantyDays,
    description: existing.description,
    costPrice: money(existing.costPrice),
    minimumPrice: money(existing.minimumPrice),
    sellingPrice: money(existing.sellingPrice),
  }
  const after = {
    name,
    sku,
    brand: brandName || existing.brand.name,
    category: categoryName || existing.category.name,
    tracking,
    condition,
    storage: text("storage"),
    ram: text("ram"),
    color: text("color"),
    warrantyDays,
    description: text("description"),
    costPrice: Number(costPrice.toFixed(2)),
    minimumPrice: Number(minimumPrice.toFixed(2)),
    sellingPrice: Number(sellingPrice.toFixed(2)),
  }
  const changed = (Object.keys(after) as Array<keyof typeof after>).filter(
    (key) => String(before[key] ?? "") !== String(after[key] ?? "")
  )
  if (changed.length === 0) return { success: true, message: "Nothing changed." }

  const reason = String(formData.get("reason") || "").trim() || null
  const priceMoves = (["costPrice", "minimumPrice", "sellingPrice"] as const)
    .filter((key) => changed.includes(key))
    .map((key) => ({
      productId: id,
      oldPrice: before[key].toFixed(2),
      newPrice: after[key].toFixed(2),
      priceType: key === "costPrice" ? "COST_PRICE" : key === "minimumPrice" ? "MINIMUM_PRICE" : "SELLING_PRICE",
      reason: reason || "Changed on Change details",
      changedBy: user.id,
    }))

  await prisma.$transaction([
    prisma.product.update({
      where: { id },
      data: {
        name,
        sku,
        brandId,
        categoryId,
        tracking,
        condition,
        storage: after.storage,
        ram: after.ram,
        color: after.color,
        warrantyDays,
        description: after.description,
        costPrice: costPrice.toFixed(2),
        minimumPrice: minimumPrice.toFixed(2),
        sellingPrice: sellingPrice.toFixed(2),
      },
    }),
    ...priceMoves.map((data) => prisma.priceHistory.create({ data })),
    prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "UPDATE",
        entityType: "Product",
        entityId: id,
        oldValue: JSON.stringify(Object.fromEntries(changed.map((key) => [key, before[key]]))),
        newValue: JSON.stringify({
          ...Object.fromEntries(changed.map((key) => [key, after[key]])),
          reason,
          note: `Item details changed: ${name} (${sku}). Changed: ${changed.join(", ")}.`,
        }),
        branchId: user.branchId,
        risk: changed.includes("tracking") || changed.includes("costPrice") ? "MEDIUM" : "LOW",
      },
    }),
  ])

  revalidatePath("/products")
  revalidatePath("/inventory")
  revalidatePath("/imei")
  revalidatePath("/imei/intake")
  revalidatePath("/pos")
  return { success: true }
}

export async function reduceInventoryStock(formData: FormData) {
  const user = await requireUser()
  if (!(await canManageCatalog(user.role))) return { error: "You are not allowed to adjust stock. Ask the main admin." }
  const productId = String(formData.get("productId") || "")
  const branchId = String(formData.get("branchId") || "")
  const reason = String(formData.get("reason") || "").trim()
  const imeiBlob = String(formData.get("imeis") || "").trim()

  if (!productId || !branchId) return { error: "Pick the item and the shop." }
  if (!reason) return { error: "Write why you are reducing stock, for example damaged, lost, or count correction." }

  const [inv, product] = await Promise.all([
    prisma.inventory.findUnique({
      where: { productId_branchId: { productId, branchId } },
      include: { branch: true },
    }),
    prisma.product.findUnique({ where: { id: productId } }),
  ])

  if (!inv || !product) return { error: "That item is not on the shelf list for this shop." }

  const tracked = product.tracking === "IMEI" || product.tracking === "SERIAL"

  if (tracked) {
    const codes = imeiBlob
      .split(/[\n,;]+/)
      .map((row) => row.replace(/[\s-]/g, "").trim())
      .filter(Boolean)
    if (!codes.length) {
      return {
        error:
          "This item uses IMEI or serial. Scan or type each unit you are writing off. You cannot reduce phones by a piece count alone.",
      }
    }
    const unique = [...new Set(codes)]
    if (unique.length !== codes.length) return { error: "The same IMEI or serial is listed twice. Remove the copy." }

    const records = await prisma.imeiRecord.findMany({
      where: {
        productId,
        branchId,
        status: "IN_STOCK",
        OR: unique.flatMap((code) => [{ imei1: code }, { serialNumber: code }]),
      },
    })
    if (records.length !== unique.length) {
      const found = new Set(records.flatMap((row) => [row.imei1, row.serialNumber].filter(Boolean) as string[]))
      const missing = unique.filter((code) => !found.has(code))
      return {
        error: `These numbers are not In shop for this item at ${inv.branch.name}: ${missing.join(", ")}.`,
      }
    }
    if (records.length > inv.quantity) {
      return { error: `Shop stock for ${product.name} at ${inv.branch.name} is only ${inv.quantity}. Count again.` }
    }

    const nextQty = Math.max(0, inv.quantity - records.length)
    await prisma.$transaction([
      ...records.map((row) =>
        prisma.imeiRecord.update({
          where: { id: row.id },
          data: { status: "DISPOSED", notes: reason },
        })
      ),
      prisma.inventory.update({
        where: { productId_branchId: { productId, branchId } },
        data: { quantity: nextQty },
      }),
      // A write-off is a correction by hand. Before the stock ledger existed it
      // moved the shelf and left nothing behind but an audit note.
      prisma.stockMovement.create({
        data: {
          productId,
          branchId,
          quantity: -records.length,
          kind: "HAND_CORRECTION",
          reference: reason,
          userId: user.id,
          businessDate: watDayKey(),
        },
      }),
      prisma.auditLog.create({
        data: {
          userId: user.id,
          action: "UPDATE",
          entityType: "Inventory",
          entityId: inv.id,
          oldValue: String(inv.quantity),
          newValue: JSON.stringify({
            quantity: nextQty,
            wroteOff: records.length,
            reason,
            numbers: records.map((row) => row.imei1),
            shop: inv.branch.name,
            product: product.name,
          }),
          branchId,
          risk: "HIGH",
        },
      }),
    ])

    revalidatePath("/products")
    revalidatePath("/inventory")
    revalidatePath("/imei")
    revalidatePath("/pos")
    return { success: true }
  }

  const reduceBy = Number(formData.get("reduceBy") || 0)
  if (!Number.isFinite(reduceBy) || reduceBy <= 0) return { error: "Enter how many pieces to take off the shelf." }
  if (reduceBy > inv.quantity) {
    return { error: `You cannot reduce by ${reduceBy}. ${inv.branch.name} only has ${inv.quantity} on the shelf.` }
  }

  const nextQty = Math.max(0, inv.quantity - reduceBy)

  await prisma.$transaction([
    prisma.inventory.update({
      where: { productId_branchId: { productId, branchId } },
      data: { quantity: nextQty },
    }),
    prisma.stockMovement.create({
      data: {
        productId,
        branchId,
        quantity: -reduceBy,
        kind: "HAND_CORRECTION",
        reference: reason,
        userId: user.id,
        businessDate: watDayKey(),
      },
    }),
    prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "UPDATE",
        entityType: "Inventory",
        entityId: inv.id,
        oldValue: String(inv.quantity),
        newValue: JSON.stringify({
          quantity: nextQty,
          reducedBy: reduceBy,
          reason,
          shop: inv.branch.name,
          product: product.name,
        }),
        branchId,
        risk: "HIGH",
      },
    }),
  ])

  revalidatePath("/products")
  revalidatePath("/inventory")
  revalidatePath("/pos")
  return { success: true }
}

export async function deleteProduct(formData: FormData) {
  const user = await requireUser()
  if (!(await canManageCatalog(user.role))) return { error: "You are not allowed to delete items. Ask the main admin." }
  if (!canHardDelete(user.role)) {
    return { error: "Only the CEO or the main admin can remove or hide an item from the catalog." }
  }
  const id = String(formData.get("id") || "")
  if (!id) return { error: "Item ID missing." }

  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      _count: {
        select: {
          saleItems: true,
          purchaseItems: true,
          imeiRecords: true,
          swaps: true,
        },
      },
      inventory: true,
    },
  })
  if (!product) return { error: "Item not found." }

  const totalStock = product.inventory.reduce((sum, row) => sum + row.quantity, 0)
  const hasHistory =
    product._count.saleItems > 0 ||
    product._count.purchaseItems > 0 ||
    product._count.imeiRecords > 0 ||
    product._count.swaps > 0

  if (hasHistory || totalStock > 0) {
    await prisma.product.update({
      where: { id },
      data: { isActive: false },
    })
    // A removal, even though the row stays for its history: recorded as one so
    // the CEO sees it with every other removal.
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "DELETE",
        entityType: "Product",
        entityId: `${product.name} (${product.sku})`,
        newValue: JSON.stringify({
          isActive: false,
          note: `Took ${product.name} (${product.sku}) off the active list. Its sales, stock and history are kept.`,
        }),
        branchId: user.branchId,
      },
    })
    revalidatePath("/products")
    revalidatePath("/inventory")
    revalidatePath("/pos")
    return { success: true, message: "Item has historical records, so it was deactivated and hidden from the active catalog." }
  }

  await prisma.$transaction([
    prisma.inventory.deleteMany({ where: { productId: id } }),
    prisma.product.delete({ where: { id } }),
    prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "DELETE",
        entityType: "Product",
        entityId: `${product.name} (${product.sku})`,
        newValue: JSON.stringify({ note: `Permanently deleted unused item ${product.name} (${product.sku}).` }),
        branchId: user.branchId,
      },
    }),
  ])

  revalidatePath("/products")
  revalidatePath("/inventory")
  revalidatePath("/pos")
  return { success: true, message: "Item permanently deleted." }
}

export async function resetAllProductWarrantiesToZero() {
  const user = await requireUser()
  if (!(await canManageCatalog(user.role))) return { error: "You are not allowed to update warranty settings. Ask the main admin." }
  await prisma.product.updateMany({
    data: { warrantyDays: 0 },
  })
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "UPDATE",
      entityType: "Product",
      entityId: "ALL",
      newValue: JSON.stringify({ warrantyDays: 0, note: "Reset all product warranties to 0 days per company policy" }),
      branchId: user.branchId,
    },
  })
  revalidatePath("/products")
  revalidatePath("/products/warranty")
  revalidatePath("/pos")
  return { success: true }
}

/** Statuses a phone can be moved to another item from. A sold phone stays on its invoice's item. */
const MOVABLE_UNIT_STATUSES = ["IN_STOCK", "FAULTY", "DISPOSED", "RECEIVED"] as const

/**
 * Put phones under the item they really are.
 *
 * Booking a phone under the wrong item (the wrong storage, say) left no way
 * out: Reduce stock wrote it off but kept its IMEI, so loading it again under
 * the right item was refused as "already on the system", and removing the
 * item only hid it. This moves the phones themselves, by IMEI or serial, to
 * an existing item or to a corrected copy of the item made on the spot. Shelf
 * counts follow phones that are in the shop, every move is on the stock ledger
 * and Who did what, and phones written off by mistake can be put back in the
 * shop on the way. A sold phone is left alone so its invoice does not change.
 */
export async function moveUnitsToItem(formData: FormData) {
  const user = await requireUser()
  if (!(await canManageCatalog(user.role))) return { error: "You are not allowed to move phones between items. Ask the main admin." }

  const codes = [
    ...new Set(
      String(formData.get("codes") || "")
        .split(/[\s,;]+/)
        .map((code) => code.replace(/-/g, "").trim())
        .filter(Boolean)
    ),
  ]
  if (!codes.length) return { error: "Type, paste or scan the IMEI or serial of each phone to move." }
  if (codes.length > 300) return { error: "Move up to 300 phones at a time." }
  const restore = formData.get("restoreWrittenOff") === "on" || formData.get("restoreWrittenOff") === "true"
  const note = String(formData.get("reason") || "").trim()

  const units = await prisma.imeiRecord.findMany({
    where: { OR: [{ imei1: { in: codes } }, { imei2: { in: codes } }, { serialNumber: { in: codes } }] },
    include: { product: { select: { id: true, name: true } }, branch: { select: { name: true } } },
  })
  const byCode = new Map<string, (typeof units)[number]>()
  for (const unit of units) for (const code of [unit.imei1, unit.imei2, unit.serialNumber]) if (code) byCode.set(code, unit)
  const missing = codes.filter((code) => !byCode.has(code))
  if (missing.length) return { error: `Not on the system: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ` and ${missing.length - 8} more` : ""}.` }
  const picked = [...new Map(codes.map((code) => [byCode.get(code)!.id, byCode.get(code)!])).values()]

  const stuck = picked.filter((unit) => !(MOVABLE_UNIT_STATUSES as readonly string[]).includes(unit.status))
  if (stuck.length) {
    return {
      error: `${stuck
        .slice(0, 5)
        .map((unit) => `${unit.imei1} (${unit.status.replace(/_/g, " ").toLowerCase()})`)
        .join(", ")} cannot be moved. Only phones in the shop, damaged or written off can; a sold one stays on its invoice's item.`,
    }
  }
  const pendingTransfers = await prisma.stockTransfer.findMany({ where: { status: "PENDING" }, select: { notes: true, transferNumber: true } })
  const onTransfer = picked.filter((unit) => pendingTransfers.some((row) => (row.notes ?? "").includes(unit.imei1)))
  if (onTransfer.length) return { error: `${onTransfer.map((unit) => unit.imei1).join(", ")} is on a shop-to-shop transfer waiting to be accepted. Settle that first.` }

  // Where they go: an item already on the list, or a corrected copy of the item they are on now.
  let target: { id: string; name: string; tracking: ProductTracking } | null = null
  const targetId = String(formData.get("targetProductId") || "").trim()
  if (targetId) {
    target = await prisma.product.findUnique({ where: { id: targetId }, select: { id: true, name: true, tracking: true } })
    if (!target) return { error: "That item is not on the list any more. Pick another." }
  } else {
    const sourceId = String(formData.get("copyFromProductId") || picked[0].productId)
    const source = await prisma.product.findUnique({ where: { id: sourceId }, include: { brand: true } })
    if (!source) return { error: "Pick the item to move them to." }
    const conditionRaw = String(formData.get("condition") || "").trim()
    const condition = conditionRaw ? parseShopCondition(conditionRaw) : source.condition
    if (!condition) return { error: "Pick the condition from the list." }
    const name = String(formData.get("name") || "").trim() || source.name
    const field = (key: string, fallback: string | null) => {
      const raw = formData.get(key)
      return raw == null ? fallback : String(raw).trim() || null
    }
    const storage = field("storage", source.storage)
    const ram = field("ram", source.ram)
    const color = field("color", source.color)
    const same = name === source.name && storage === source.storage && ram === source.ram && color === source.color && condition === source.condition
    if (same) return { error: "Change the storage, RAM, colour, condition or name for the corrected item, or pick an item already on the list." }
    const twin = await prisma.product.findFirst({
      where: { name, storage, ram, color, condition, brandId: source.brandId, isActive: true },
      select: { id: true, name: true, tracking: true },
    })
    target =
      twin ??
      (await prisma.product.create({
        data: {
          sku: await uniqueSku(makeOpeningSku({ brand: source.brand.name, name, storage: storage ?? "", condition })),
          name,
          description: source.description,
          brandId: source.brandId,
          categoryId: source.categoryId,
          condition,
          storage,
          ram,
          color,
          costPrice: source.costPrice,
          minimumPrice: source.minimumPrice,
          sellingPrice: source.sellingPrice,
          marketPrice: source.marketPrice,
          warrantyDays: source.warrantyDays,
          tracking: source.tracking,
        },
        select: { id: true, name: true, tracking: true },
      }))
  }
  if (target.tracking === "NONE") return { error: `${target.name} is counted without numbers. Phones can only go to an item that tracks an IMEI or serial.` }
  const already = picked.filter((unit) => unit.productId === target!.id)
  if (already.length === picked.length) return { error: `These phones are already under ${target.name}.` }
  const moving = picked.filter((unit) => unit.productId !== target!.id)

  const day = watDayKey()
  try {
    await prisma.$transaction(async (tx) => {
      for (const unit of moving) {
        const backInShop = restore && unit.status === "DISPOSED"
        const onShelf = unit.status === "IN_STOCK"
        const reference = `Moved ${unit.imei1} to ${target!.name}`
        if (onShelf) {
          // Off the old item's shelf. A count already short (an earlier
          // correction took it off without the phone) is not taken below zero.
          const off = await tx.inventory.updateMany({
            where: { productId: unit.productId, branchId: unit.branchId, quantity: { gt: 0 } },
            data: { quantity: { decrement: 1 } },
          })
          if (off.count) {
            await tx.stockMovement.create({
              data: { productId: unit.productId, branchId: unit.branchId, quantity: -1, kind: "HAND_CORRECTION", reference, userId: user.id, businessDate: day },
            })
          }
        }
        if (onShelf || backInShop) {
          await tx.inventory.upsert({
            where: { productId_branchId: { productId: target!.id, branchId: unit.branchId } },
            update: { quantity: { increment: 1 } },
            create: { productId: target!.id, branchId: unit.branchId, quantity: 1 },
          })
          await tx.stockMovement.create({
            data: {
              productId: target!.id,
              branchId: unit.branchId,
              quantity: 1,
              kind: "HAND_CORRECTION",
              reference: backInShop ? `Written off by mistake; ${unit.imei1} back in shop` : reference,
              userId: user.id,
              businessDate: day,
            },
          })
        }
        await tx.imeiRecord.update({
          where: { id: unit.id },
          data: {
            productId: target!.id,
            ...(backInShop ? { status: "IN_STOCK" } : {}),
            notes: [unit.notes, `Moved from ${unit.product.name} to ${target!.name}${note ? ` (${note})` : ""}`].filter(Boolean).join(" · ").slice(0, 1000),
          },
        })
        await tx.auditLog.create({
          data: {
            userId: user.id,
            action: "UPDATE",
            entityType: "IMEIRecord",
            entityId: unit.imei1,
            oldValue: JSON.stringify({ item: unit.product.name, status: unit.status }),
            newValue: JSON.stringify({ item: target!.name, status: backInShop ? "IN_STOCK" : unit.status, shop: unit.branch.name, reason: note || null }),
            branchId: unit.branchId,
            risk: "HIGH",
          },
        })
      }
    }, { timeout: 60_000 })
  } catch (error) {
    return { error: shopError(error, "The phones were not moved. Nothing changed.") }
  }

  for (const path of ["/products", "/inventory", "/imei", "/pos", "/products/activity"]) revalidatePath(path)
  const restored = moving.filter((unit) => restore && unit.status === "DISPOSED").length
  return {
    success: true,
    targetId: target.id,
    message: `${moving.length} phone${moving.length === 1 ? "" : "s"} now under ${target.name}${restored ? `, ${restored} back in the shop` : ""}.`,
  }
}
