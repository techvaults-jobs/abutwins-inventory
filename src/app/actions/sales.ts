"use server"

import { revalidatePath } from "next/cache"
import { PaymentMethod } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { requireUser } from "@/lib/session"
import { canManageFinance, canSeeAllBranches, canSeeCost, canSell, scopedBranchId } from "@/lib/rbac"
import { can } from "@/lib/permissions"
import { getAppSettings, lowStockLimit } from "@/lib/settings"
import { letterheadFromSettings } from "@/lib/letterhead"
import { generateDocNumber, money } from "@/lib/utils"
import { ConflictError, claimImei, creditInvoice, drawStock, settle, shiftCustomerBalance } from "@/lib/concurrency"
import { canReachBranch, OTHER_SHOP, resolveWritableShopId, scopeRecord, viewBranchFilter } from "@/lib/branch-scope"
import { markParkedPosted } from "@/app/actions/parked"
import { isBlockedFromSell } from "@/lib/phone-look"
import { reservedTransferImeiSet, reservedSwapImeiSet } from "@/app/actions/ops"
import { shopPayChannel } from "@/lib/sale-money"
import { belowCost, blindTillPrices, discountOff, sellFloor, type PriceBasis } from "@/lib/pricing"
import { readPriceApproval } from "@/lib/price-approval"
import { dueAfterReturns, returnedValueBySale } from "@/lib/returned-value"
import { isWatDayKey, watBounds } from "@/lib/lagos-day"

/** Bank tenders before cash, so trimming an over-typed payment comes off the cash (the change). */
function bankFirst<T extends { method: string }>(tenders: T[]) {
  return [...tenders].sort((a, b) => Number(a.method === "CASH") - Number(b.method === "CASH"))
}

export async function getSales() {
  const user = await requireUser()
  const branchId = await viewBranchFilter(user)
  return prisma.sale.findMany({
    where: branchId ? { branchId } : undefined,
    include: { customer: true, branch: true, user: { select: { id: true, name: true, email: true, role: true, branchId: true } }, items: { include: { product: true, imei: true } }, payments: {
        select: {
          id: true,
          amount: true,
          method: true,
          reference: true,
          notes: true,
          paidAt: true,
          bankAccountId: true,
          bankAccount: { select: { bankName: true, accountNumber: true } },
          receivedByUser: { select: { name: true, email: true } },
        },
        orderBy: { paidAt: "asc" },
      } },
    orderBy: { saleDate: "desc" },
    take: 500,
  })
}

export async function getSale(id: string) {
  const user = await requireUser()
  // An invoice id is easy to guess or share. Without this check any member of
  // staff could open another shop's sale, and its customer, straight from the
  // address bar.
  return scopeRecord(user, await prisma.sale.findUnique({
    where: { id },
    include: {
      customer: true,
      branch: true,
      user: { select: { id: true, name: true, email: true, role: true, branchId: true } },
      items: { include: { product: true, imei: true } },
      payments: {
        include: {
          bankAccount: { select: { bankName: true, accountNumber: true, accountName: true } },
          receivedByUser: { select: { name: true, email: true } },
        },
        orderBy: { paidAt: "asc" },
      },
    },
  }))
}

const POS_IMEI_SNAPSHOT = 400

export async function getPosLookups() {
  const user = await requireUser()
  const canAll = await canSeeAllBranches(user.role)
  const viewShop = await viewBranchFilter(user)
  // Shop staff always sell in their own shop. Head office follows the shop picker.
  const branchId = canAll ? viewShop || user.branchId || undefined : user.branchId || undefined
  // Only a till for someone who may see cost carries it. Everyone else's has none to leak.
  const showCost = canSeeCost(user.role)
  const [products, customers, imeis, branches, bankAccounts] = await Promise.all([
    prisma.product.findMany({
      where: { isActive: true, condition: { not: "FAULTY" } },
      include: {
        brand: true,
        category: true,
        inventory: branchId ? { where: { branchId } } : true,
        _count: { select: { imeiRecords: true } },
      },
      orderBy: { name: "asc" },
    }),
    prisma.customer.findMany({
      where: branchId ? { branchId } : undefined,
      orderBy: { name: "asc" },
    }),
    prisma.imeiRecord.findMany({
      where: {
        status: "IN_STOCK",
        // A phone with no cosmetic grade recorded is an ordinary phone, not a
        // faulty one. `NOT: { cosmeticGrade: "FAULTY" }` drops those rows, because
        // SQL cannot compare NULL to a word — it hid every ungraded phone.
        OR: [{ cosmeticGrade: null }, { cosmeticGrade: { not: "FAULTY" } }],
        product: { condition: { not: "FAULTY" } },
        ...(branchId ? { branchId } : {}),
      },
      include: { product: { include: { brand: true, category: true } }, branch: true },
      orderBy: { createdAt: "desc" },
      take: POS_IMEI_SNAPSHOT,
    }),
    prisma.branch.findMany({
      where: {
        isActive: true,
        ...(canAll ? {} : user.branchId ? { id: user.branchId } : { id: "__none__" }),
      },
      orderBy: [{ isHq: "desc" }, { name: "asc" }],
    }),
    prisma.bankAccount.findMany({
      where: {
        isActive: true,
        ...(canAll ? {} : user.branchId ? { branchId: user.branchId } : { branchId: "__none__" }),
      },
      orderBy: [{ bankName: "asc" }, { accountNumber: "asc" }],
    }),
  ])
  const settings = await getAppSettings()
  const defaultBranchId = branchId || branches[0]?.id
  return {
    products: products.map((product) => ({
      id: product.id,
      name: product.name,
      sku: product.sku,
      ...tillPrices(
        {
          costPrice: money(product.costPrice),
          sellingPrice: money(product.sellingPrice),
          minimumPrice: money(product.minimumPrice),
          resellerMarkup: money(product.category.resellerMarkup),
        },
        showCost
      ),
      serialized: product.tracking !== "NONE",
      brand: { name: product.brand.name },
      category: { name: product.category.name },
      stock: product.inventory.map((row) => ({ branchId: row.branchId, quantity: row.quantity })),
      storage: product.storage,
      condition: product.condition,
      color: product.color,
    })),
    customers: customers.map((customer) => ({
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      branchId: customer.branchId,
      creditLimit: money(customer.creditLimit),
      currentBalance: money(customer.currentBalance),
    })),
    imeis: imeis.map((item) => mapTillImei(item, showCost)),
    branches: branches.map((branch) => ({
      id: branch.id,
      name: branch.name,
      code: branch.code,
    })),
    bankAccounts: bankAccounts.map((row) => ({
      id: row.id,
      branchId: row.branchId,
      bankName: row.bankName,
      accountNumber: row.accountNumber,
      accountName: row.accountName,
    })),
    branchId: defaultBranchId,
    allowBelowMinimum: settings.allowBelowMinimum,
    // The shop-wide switch grants the same freedom as the permission, the way it
    // already works for neighbour fills. It was being read here and then dropped.
    canOverrideFloor:
      settings.allowBelowMinimum || (await can(user.role, "action.override_floor")),
    canSeeCost: showCost,
    lowStockThreshold: settings.lowStockThreshold,

  }
}

/** Real prices for the CEO; for everyone else, a till with no cost in it. */
type TillPriceFields = Required<Omit<PriceBasis, "resellerQuote">> & { resellerQuote?: number }

function tillPrices(basis: Required<Omit<PriceBasis, "resellerQuote">>, showCost: boolean): TillPriceFields {
  return showCost ? basis : blindTillPrices(basis)
}

function mapTillImei(item: {
  id: string
  imei1: string
  serialNumber: string | null
  productId: string
  branchId: string
  cosmeticGrade: string | null
  product: {
    name: string
    sellingPrice: unknown
    minimumPrice: unknown
    costPrice: unknown
    storage: string | null
    condition: string
    color: string | null
    category?: { name: string; resellerMarkup?: unknown } | null
    brand?: { name: string } | null
  }
}, showCost: boolean) {
  return {
    id: item.id,
    imei1: item.imei1,
    serialNumber: item.serialNumber,
    productId: item.productId,
    branchId: item.branchId,
    cosmeticGrade: item.cosmeticGrade,
    product: {
      name: item.product.name,
      ...tillPrices(
        {
          sellingPrice: money(item.product.sellingPrice),
          minimumPrice: money(item.product.minimumPrice),
          costPrice: money(item.product.costPrice),
          resellerMarkup: money(item.product.category?.resellerMarkup),
        },
        showCost
      ),
      storage: item.product.storage,
      condition: item.product.condition,
      color: item.product.color,
      category: item.product.category?.name ?? null,
      brand: item.product.brand?.name ?? null,
    },
  }
}

/** Scan one In shop IMEI or serial without loading the whole shelf into the till. */
export async function findInStockImei(code: string, branchId?: string) {
  const user = await requireUser()
  const cleaned = code.replace(/[\s-]/g, "").trim()
  if (!cleaned) return { error: "Scan or type an IMEI first." }
  const shopGate = await resolveWritableShopId(user, branchId)
  if ("error" in shopGate) return { error: shopGate.error }
  const shop = shopGate.shopId
  const item = await prisma.imeiRecord.findFirst({
    where: {
      status: "IN_STOCK",
      branchId: shop,
      OR: [{ imei1: cleaned }, { serialNumber: cleaned }],
    },
    include: { product: { include: { brand: true, category: true } } },
  })
  if (!item) return { error: "That IMEI is not in this shop. Check Goods on the way, or check the shop." }
  if (isBlockedFromSell({ cosmeticGrade: item.cosmeticGrade, productCondition: item.product.condition })) {
    return { error: "That phone is Damaged. It cannot be sold. Open All phones and Set Good (sellable) if it is fixed." }
  }
  const reserved = await reservedTransferImeiSet(item.branchId)
  if (reserved.has(item.imei1) || (item.serialNumber && reserved.has(item.serialNumber))) {
    return {
      error:
        "That phone is on a shop-to-shop transfer waiting for the other shop to accept or reject. It stays In shop at the sending shop until then.",
    }
  }
  const reservedSwap = await reservedSwapImeiSet(item.branchId)
  if (reservedSwap.has(item.imei1) || (item.serialNumber && reservedSwap.has(item.serialNumber))) {
    return {
      error: "That device is on a Swap Deal waiting for approval. It cannot be sold yet.",
    }
  }
  return { imei: mapTillImei(item, canSeeCost(user.role)) }
}

/**
 * Find In shop phones or accessories by name, category, brand, storage, or IMEI
 * when the till's saved list is too short. Online only.
 */
export async function searchTillStock(query: string, branchId?: string) {
  const user = await requireUser()
  const cleaned = query.trim()
  if (cleaned.length < 2) return { imeis: [] as ReturnType<typeof mapTillImei>[], accessories: [] as Array<{
    id: string
    name: string
    sku: string
    sellingPrice: number
    minimumPrice: number
    costPrice: number
    resellerMarkup: number
    serialized: boolean
    brand: { name: string }
    category: { name: string }
    stock: Array<{ branchId: string; quantity: number }>
    storage?: string | null
    condition?: string | null
    color?: string | null
  }> }
  const shopGate = await resolveWritableShopId(user, branchId)
  if ("error" in shopGate) return { error: shopGate.error }
  const shop = shopGate.shopId
  const q = cleaned.toLowerCase()
  const imeiDigits = cleaned.replace(/[\s-]/g, "")

  const [imeiRows, productRows] = await Promise.all([
    prisma.imeiRecord.findMany({
      where: {
        status: "IN_STOCK",
        branchId: shop,
        // A phone with no cosmetic grade recorded is an ordinary phone, not a
        // faulty one. `NOT: { cosmeticGrade: "FAULTY" }` drops those rows, because
        // SQL cannot compare NULL to a word — it hid every ungraded phone.
        // This sits in AND so it cannot displace the search's own OR below.
        AND: [{ OR: [{ cosmeticGrade: null }, { cosmeticGrade: { not: "FAULTY" } }] }],
        product: { condition: { not: "FAULTY" } },
        OR: [
          { imei1: { contains: imeiDigits } },
          { serialNumber: { contains: cleaned } },
          { product: { name: { contains: cleaned } } },
          { product: { storage: { contains: cleaned } } },
          { product: { color: { contains: cleaned } } },
          { product: { brand: { name: { contains: cleaned } } } },
          { product: { category: { name: { contains: cleaned } } } },
        ],
      },
      include: { product: { include: { brand: true, category: true } } },
      orderBy: { updatedAt: "desc" },
      take: 40,
    }),
    prisma.product.findMany({
      where: {
        isActive: true,
        tracking: "NONE",
        condition: { not: "FAULTY" },
        inventory: { some: { branchId: shop, quantity: { gt: 0 } } },
        OR: [
          { name: { contains: cleaned } },
          { sku: { contains: cleaned } },
          { brand: { name: { contains: cleaned } } },
          { category: { name: { contains: cleaned } } },
          { storage: { contains: cleaned } },
          { color: { contains: cleaned } },
        ],
      },
      include: {
        brand: true,
        category: true,
        inventory: { where: { branchId: shop } },
      },
      take: 24,
    }),
  ])

  // Case-fold in JS so SQLite and Postgres both match "uk" / "Samsung".
  const imeis = imeiRows
    .filter((row) => {
      const hay = [
        row.imei1,
        row.serialNumber ?? "",
        row.product.name,
        row.product.storage ?? "",
        row.product.color ?? "",
        row.product.brand?.name ?? "",
        row.product.category?.name ?? "",
        formatConditionSearch(row.product.condition),
        row.cosmeticGrade ?? "",
      ]
        .join(" ")
        .toLowerCase()
      return hay.includes(q) || row.imei1.includes(imeiDigits)
    })
    .slice(0, 20)
    .map((row) => mapTillImei(row, canSeeCost(user.role)))

  const accessories = productRows
    .filter((product) => {
      const hay = [
        product.name,
        product.sku,
        product.brand.name,
        product.category.name,
        product.storage ?? "",
        product.color ?? "",
        product.condition,
      ]
        .join(" ")
        .toLowerCase()
      return hay.includes(q)
    })
    .slice(0, 12)
    .map((product) => ({
      id: product.id,
      name: product.name,
      sku: product.sku,
      sellingPrice: money(product.sellingPrice),
      minimumPrice: money(product.minimumPrice),
      costPrice: money(product.costPrice),
      resellerMarkup: money(product.category.resellerMarkup),
      serialized: false,
      brand: { name: product.brand.name },
      category: { name: product.category.name },
      stock: product.inventory.map((row) => ({ branchId: row.branchId, quantity: row.quantity })),
      storage: product.storage,
      condition: product.condition,
      color: product.color,
    }))

  return { imeis, accessories }
}

function formatConditionSearch(condition: string) {
  if (condition === "BRAND_NEW") return "brand new new"
  if (condition === "BRAND_NEW_LOCKED") return "brand new locked"
  if (condition === "BRAND_NEW_NA") return "brand new n/a na"
  if (condition === "UK_USED") return "uk used uk"
  if (condition === "UK_LOCKED") return "uk locked"
  if (condition === "OPEN_BOX" || condition === "OPENBOX") return "open box openbox"
  if (condition === "STANDARD") return "standard"
  if (condition === "FAULTY") return "faulty damaged"
  return condition.toLowerCase()
}

/** Newest In shop phones at one shop, for a shop-to-shop CSV. Caps at 50,000 lines. */
export async function getShopImeiSheet(branchId: string) {
  const user = await requireUser()
  if (!branchId) return { rows: [] as string[][], truncated: false }
  // It carries cost prices, so only people who move stock between shops get it.
  if (!(await can(user.role, "action.transfer"))) return { rows: [] as string[][], truncated: false }
  const scoped = await scopedBranchId(user.role, user.branchId, branchId)
  const shop = scoped || branchId
  // This sheet feeds shop-to-shop transfers, which are always valued at cost:
  // our own stock moving between our own shops is not a sale.
  const showCost = true
  const rows = await prisma.imeiRecord.findMany({
    where: { status: "IN_STOCK", branchId: shop },
    include: { product: { select: { sku: true, name: true, costPrice: true, sellingPrice: true } } },
    orderBy: { createdAt: "desc" },
    take: 50_000,
  })
  return {
    truncated: rows.length === 50_000,
    rows: [
      ["imei", "serial", "item_code", "name", "quantity", showCost ? "unit_cost" : "unit_price", "color", "notes"],
      ...rows.map((item) => [
        item.imei1,
        item.serialNumber ?? "",
        item.product.sku,
        item.product.name,
        "1",
        money(showCost ? item.product.costPrice : item.product.sellingPrice).toFixed(2),
        "",
        "",
      ]),
    ],
  }
}

export async function checkoutSale(input: {
  customerId?: string
  branchId: string
  paymentMethod: PaymentMethod
  paidAmount: number
  /** Named bank when money came in by bank. Required for Bank sales with money received. */
  bankAccountId?: string
  /** Transfer description, POS approval code, or any text the cashier saw on the terminal.
   *  Required when bank money is received. Written to Payment.reference so the admin can
   *  reconcile the cashier record against the bank or POS terminal. */
  paymentReference?: string
  /** Cash or Bank channel for a credit-sale deposit when only one channel is used. */
  depositMethod?: "CASH" | "TRANSFER"
  /** Cash and bank together on a credit deposit (or older parked full splits). */
  splitTenders?: Array<{ method: "CASH" | "TRANSFER" | "POS"; amount: number }>
  notes?: string
  wholesale?: boolean
  /** Money taken off the whole order, in naira. Bulk deals are recorded here. */
  orderDiscount?: number
  /** Why the order discount was given. Needed when it pushes a line under its floor. */
  discountReason?: string
  queuedAt?: string
  offlineId?: string
  /** The CEO or Super Admin's sign-off for this deal, from an approved price request. */
  priceApproval?: string
  /** The price request that approval came from, so it can be marked used. */
  priceRequestId?: string
  items: Array<{
    productId: string
    imeiId?: string
    quantity: number
    unitPrice: number
    warrantyDays?: number
    /** Why this line left the standard price. Needed under the floor or under cost. */
    priceReason?: string
  }>
}) {
  const user = await requireUser()
  if (!(await canSell(user.role))) return { error: "You are not allowed to sell. Ask the main admin." }
  const shopGate = await resolveWritableShopId(user, input.branchId)
  if ("error" in shopGate) return { error: shopGate.error }
  const saleShopId = shopGate.shopId
  if (!input.items.length) return { error: "Add at least one item." }
  // A day left unbalanced no longer stops the till. Selling is what the shop is
  // open to do; counting the money is a separate job, done when the cashier is
  // ready and for whichever day they are settling. See Balance the till.

  const settings = await getAppSettings()
  const products = await prisma.product.findMany({
    where: { id: { in: input.items.map((item) => item.productId) } },
    include: {
      _count: { select: { imeiRecords: true } },
      // The reseller markup lives on the category, and the floor needs it.
      category: { select: { resellerMarkup: true } },
    },
  })
  const productById = new Map(products.map((row) => [row.id, row]))
  // The lowest allowed price on the item is the floor, not the standard price.
  // Staff may price a deal anywhere from the floor up — that is what a reseller
  // price or a bulk discount is. Only CEO / Super Admin (override_floor) may go
  // under the floor, or under what the item cost us, and never without a reason.
  const hasFloorPermission = await can(user.role, "action.override_floor")
  // Credit limits are a separate judgement. Turning the price switch on must not
  // quietly hand out credit as well.
  const canOverrideCredit = hasFloorPermission
  // A seller without the permission can still sell under the floor when the CEO
  // or Super Admin signed this exact deal off on the till. The approver is
  // checked again here, so a signer who has since lost the right, or left, no
  // longer counts.
  let approvedBy: { id: string; name: string } | null = null
  if (!settings.allowBelowMinimum && !hasFloorPermission && input.priceApproval) {
    const claim = readPriceApproval(input.priceApproval, user.id, input)
    if (!claim) {
      return { error: "The CEO's approval no longer fits this sale. A price changed, or it is more than a day old. Ask for approval again." }
    }
    const approver = await prisma.user.findUnique({
      where: { id: claim.approverId },
      select: { id: true, name: true, role: true, isActive: true },
    })
    if (!approver?.isActive || !(await can(approver.role, "action.override_floor"))) {
      return { error: `${claim.approverName} can no longer approve prices. Ask the CEO or Super Admin.` }
    }
    approvedBy = { id: approver.id, name: approver.name || claim.approverName }
  }
  const canOverrideFloor = settings.allowBelowMinimum || hasFloorPermission || Boolean(approvedBy)
  const isReseller = Boolean(input.wholesale)
  // Worked out here, once, and reused for the floor check, the cost snapshot and
  // the discount recorded against each line.
  const priceLines = new Map<
    number,
    { floor: number; cost: number; list: number; reason: string }
  >()

  // One read for every tracked unit in the cart, and one for every branch stock
  // row, instead of a query per line. A 20 line cart used to fire 20 round trips.
  const imeiIds = input.items.map((item) => item.imeiId).filter((id): id is string => Boolean(id))
  const [cartImeis, stockRows] = await Promise.all([
    imeiIds.length
      ? prisma.imeiRecord.findMany({
          where: { id: { in: imeiIds } },
          select: {
            id: true,
            imei1: true,
            status: true,
            branchId: true,
            cosmeticGrade: true,
            product: { select: { condition: true, name: true } },
          },
        })
      : Promise.resolve([]),
    prisma.inventory.findMany({
      where: { branchId: saleShopId, productId: { in: input.items.map((item) => item.productId) } },
      select: { productId: true, quantity: true, minStock: true },
    }),
  ])
  const imeiById = new Map(cartImeis.map((row) => [row.id, row]))
  const stockByProduct = new Map(stockRows.map((row) => [row.productId, row]))
  const reservedOnTransfer = await reservedTransferImeiSet(saleShopId)
  const reservedOnSwap = await reservedSwapImeiSet(saleShopId)

  // Pieces wanted per product, so a cart holding the same accessory on two lines
  // is checked against stock once, on the combined figure. Phone IMEI lines are
  // checked here too (shelf must move with the IMEI), but drawn in the claim
  // loop below — never twice.
  const wantByProduct = new Map<string, number>()
  const shelfWantByProduct = new Map<string, number>()

  for (const [lineIndex, item] of input.items.entries()) {
    const product = productById.get(item.productId)
    if (!product) return { error: "One of the items in the cart is missing." }
    if (isBlockedFromSell({ productCondition: product.condition })) {
      return { error: `${product.name} is Damaged and cannot be sold.` }
    }
    if (!Number.isFinite(item.quantity) || item.quantity < 1) {
      return { error: `Enter how many ${product.name} the customer is buying.` }
    }
    if (item.imeiId && item.quantity !== 1) {
      return { error: "A phone with an IMEI or serial is always sold as 1 unit. Scan each unit separately." }
    }
    if (!item.imeiId && product.tracking !== "NONE") {
      return { error: `${product.name} needs an IMEI or serial. Scan or find that unit on Sell now.` }
    }
    if (!Number.isFinite(item.unitPrice) || item.unitPrice < 0) {
      return { error: `Enter a valid price for ${product.name}.` }
    }
    const basis = {
      costPrice: money(product.costPrice),
      minimumPrice: money(product.minimumPrice),
      sellingPrice: money(product.sellingPrice),
      resellerMarkup: money(product.category.resellerMarkup),
    }
    const floorPrice = sellFloor(basis, { reseller: isReseller })
    const reason = String(item.priceReason || "").trim()
    // A name a shop manager added has no prices until the CEO or main admin
    // sets them. With no floor it could go for any figure, so it waits.
    if (!(basis.sellingPrice > 0) && !(basis.minimumPrice > 0) && !canOverrideFloor) {
      return {
        error: `${product.name} has no price yet. Ask the CEO or the main admin to set its prices on the price list, then sell it.`,
      }
    }
    if (item.unitPrice < floorPrice) {
      if (!canOverrideFloor) {
        return {
          error: `${product.name} is below its lowest allowed price (₦${floorPrice.toLocaleString("en-NG")}). Raise it, or ask the CEO or Super Admin to approve it from the till.`,
        }
      }
      if (!reason) {
        return { error: `Say why ${product.name} is going below the lowest allowed price.` }
      }
    }
    if (belowCost(item.unitPrice, basis.costPrice)) {
      if (!canOverrideFloor) {
        return {
          error: `${product.name} is below what it cost us (₦${basis.costPrice.toLocaleString("en-NG")}). The shop loses money at that price. Ask the CEO or Super Admin to approve it from the till.`,
        }
      }
      if (!reason) {
        return { error: `Say why ${product.name} is being sold below cost.` }
      }
    }
    priceLines.set(lineIndex, {
      floor: floorPrice,
      cost: basis.costPrice,
      list: money(product.sellingPrice),
      reason,
    })
    if (item.imeiId) {
      const imei = imeiById.get(item.imeiId)
      if (!imei || imei.status !== "IN_STOCK") return { error: `IMEI ${imei?.imei1 ?? ""} is not available.` }
      if (imei.branchId !== saleShopId) return { error: `${imei.imei1} is not in this shop.` }
      if (isBlockedFromSell({ cosmeticGrade: imei.cosmeticGrade, productCondition: imei.product.condition })) {
        return { error: `${imei.imei1} is Damaged and cannot be sold.` }
      }
      if (reservedOnTransfer.has(imei.imei1)) {
        return {
          error: `${imei.imei1} is on a shop-to-shop transfer waiting for accept or reject. It cannot be sold yet.`,
        }
      }
      if (reservedOnSwap.has(imei.imei1)) {
        return {
          error: `${imei.imei1} is on a Swap Deal waiting for approval. It cannot be sold yet.`,
        }
      }
      shelfWantByProduct.set(item.productId, (shelfWantByProduct.get(item.productId) ?? 0) + (item.quantity || 1))
    } else if (product._count.imeiRecords > 0) {
      return { error: `${product.name} must be sold with an IMEI from this shop.` }
    } else {
      wantByProduct.set(item.productId, (wantByProduct.get(item.productId) ?? 0) + item.quantity)
      shelfWantByProduct.set(item.productId, (shelfWantByProduct.get(item.productId) ?? 0) + item.quantity)
    }
  }

  for (const [productId, wanted] of shelfWantByProduct) {
    const stock = stockByProduct.get(productId)
    if (!stock || stock.quantity < wanted) {
      return { error: `${productById.get(productId)?.name ?? "This item"} does not have enough units at this branch.` }
    }
  }

  // A phone scanned onto two lines of the same cart would otherwise be claimed
  // twice and sold once.
  const duplicateImei = imeiIds.find((id, index) => imeiIds.indexOf(id) !== index)
  if (duplicateImei) {
    return { error: `${imeiById.get(duplicateImei)?.imei1 ?? "That phone"} is on this sale twice. Remove one line.` }
  }

  const grossTotal = input.items.reduce((sum, item) => {
    const price = Number(item.unitPrice)
    const qty = Number(item.quantity)
    if (!Number.isFinite(price) || !Number.isFinite(qty) || price < 0 || qty < 1) return sum
    return sum + price * qty
  }, 0)

  // Money off the whole order, the way a bulk deal is actually struck. It is
  // checked against the same floors as a typed line price, so an order discount
  // cannot quietly do what a line price is not allowed to do.
  const rawDiscount = Number(input.orderDiscount ?? 0)
  const orderDiscount = Number.isFinite(rawDiscount) && rawDiscount > 0
    ? Math.min(money(rawDiscount), grossTotal)
    : 0
  const discountReason = String(input.discountReason || "").trim()
  if (orderDiscount > 0) {
    const floorTotal = input.items.reduce((sum, item, index) => {
      const line = priceLines.get(index)
      if (!line) return sum
      return sum + line.floor * Math.max(1, Number(item.quantity) || 1)
    }, 0)
    const costTotal = input.items.reduce((sum, item, index) => {
      const line = priceLines.get(index)
      if (!line) return sum
      return sum + line.cost * Math.max(1, Number(item.quantity) || 1)
    }, 0)
    const afterDiscount = grossTotal - orderDiscount
    if (afterDiscount < floorTotal || afterDiscount < costTotal) {
      const guard = Math.max(floorTotal, costTotal)
      if (!canOverrideFloor) {
        return {
          error: `That discount takes the sale to ₦${afterDiscount.toLocaleString("en-NG")}, under the ₦${guard.toLocaleString("en-NG")} this stock may go for. Lower the discount, or have the CEO or Super Admin approve it on the till.`,
        }
      }
      if (!discountReason) {
        return { error: "Say why this order is going below what the stock may be sold for." }
      }
    }
  }
  const subtotal = money(grossTotal - orderDiscount)
  const validSplits = (input.splitTenders ?? []).filter((t) => Number.isFinite(t.amount) && t.amount > 0)
  const isSplit = input.paymentMethod === "SPLIT_PAYMENT" || validSplits.length > 1
  const isCreditTill = input.paymentMethod === "CREDIT"
  // Cash or Bank on the till always takes the full sale total. Credit sales keep
  // the typed deposit (one channel, or cash and bank together). That stops a lagged
  // Amount paid from under-recording a raised price.
  const rawPaid = isSplit && validSplits.length > 0
    ? validSplits.reduce((sum, t) => sum + t.amount, 0)
    : isCreditTill && validSplits.length === 1
      ? validSplits[0].amount
      : isCreditTill
        ? input.paidAmount
        : input.paymentMethod === "CASH" ||
            input.paymentMethod === "TRANSFER" ||
            input.paymentMethod === "POS"
          ? subtotal
          : input.paidAmount

  const paid = money(Math.min(Math.max(0, Number.isFinite(Number(rawPaid)) ? Number(rawPaid) : 0), subtotal))
  const due = subtotal - paid
  // The tenders as they really landed. Cash and bank typed past the bill is
  // change handed back, so the extra comes off cash first, then bank. Saving
  // the typed amounts made the payment lines and the till's cash add up to
  // more than the invoice was paid, and the drawer came up short at close.
  const landedSplits = (() => {
    let over = money(validSplits.reduce((sum, t) => sum + t.amount, 0) - paid)
    const rows = validSplits.map((t) => ({ ...t, amount: money(t.amount) }))
    for (const cashFirst of [true, false]) {
      for (const row of rows) {
        if (over <= 0) break
        if ((shopPayChannel(row.method) === "CASH") !== cashFirst) continue
        const take = Math.min(row.amount, over)
        row.amount = money(row.amount - take)
        over = money(over - take)
      }
    }
    return rows.filter((row) => row.amount > 0)
  })()
  // Sale label: credit when anything is still owed (even if today's money was cash + bank).
  // Fully paid with two channels stays Split payment. Fully paid with one channel is Cash or Bank.
  const method: PaymentMethod =
    paid < subtotal
      ? "CREDIT"
      : isSplit
        ? "SPLIT_PAYMENT"
        : isCreditTill
          ? "CREDIT"
          : shopPayChannel(input.paymentMethod)

  // Money that actually came in today: Cash or Bank. Credit deposits use depositMethod
  // when there is only one channel; cash + bank uses the split lines.
  const receivedChannel: "CASH" | "TRANSFER" | "POS" =
    isSplit && validSplits[0]
      ? validSplits[0].method
      : validSplits.length === 1
        ? validSplits[0].method === "POS"
          ? "POS"
          : shopPayChannel(validSplits[0].method)
        : input.paymentMethod === "POS"
          ? "POS"
          : shopPayChannel(
              isCreditTill
                ? input.depositMethod || "TRANSFER"
                : input.paymentMethod
            )

  let bankAccountId: string | null = null
  // Bank money (full Bank sale, credit bank deposit, or the bank half of a split) must name the account.
  const bankOnSplits = validSplits.some((t) => shopPayChannel(t.method) === "TRANSFER")
  const moneyIsBank = receivedChannel !== "CASH"
  const needsNamedBank =
    paid > 0 &&
    input.paymentMethod !== "POS" &&
    (bankOnSplits || (!isSplit && moneyIsBank))
  if (needsNamedBank) {
    const wanted = String(input.bankAccountId || "").trim()
    if (!wanted) {
      return {
        error: "Pick which bank account received this money. Add banks under Money in and out if the list is empty.",
      }
    }
    const bank = await prisma.bankAccount.findFirst({
      where: { id: wanted, isActive: true, branchId: saleShopId },
      select: { id: true },
    })
    if (!bank) {
      return { error: "That bank account is not on the books for this shop. Pick another, or add it under Money in and out." }
    }
    bankAccountId = bank.id
  } else if (input.bankAccountId) {
    const bank = await prisma.bankAccount.findFirst({
      where: { id: String(input.bankAccountId), isActive: true, branchId: saleShopId },
      select: { id: true },
    })
    if (bank) bankAccountId = bank.id
  }

  if (due > 0 && !input.customerId) {
    return { error: "A credit sale or part payment needs a buyer name. A walk-in must pay everything now." }
  }

  if (input.customerId && due > 0) {
    const customer = await prisma.customer.findUnique({ where: { id: input.customerId } })
    if (!customer) return { error: "We could not find that customer." }
    const nextDebt = money(customer.currentBalance) + due
    if (money(customer.creditLimit) > 0 && nextDebt > money(customer.creditLimit) && !canOverrideCredit) {
      return { error: `${customer.name} would exceed the credit limit of ₦${money(customer.creditLimit).toLocaleString("en-NG")}.` }
    }
  }

  const invoiceNumber = generateDocNumber("INV")

  // Alerts are gathered while the books are being written and sent afterwards.
  // Fanning notifications out inside the transaction held stock rows locked for
  // as long as it took to write one row per member of staff.
  const lowStockAlerts: Array<{ productId: string; quantity: number; limit: number }> = []

  const posted = await settle(() =>
    prisma.$transaction(async (tx) => {
      const created = await tx.sale.create({
        data: {
          invoiceNumber,
          branchId: saleShopId,
          userId: user.id,
          customerId: input.customerId || null,
          saleType: input.wholesale ? "WHOLESALE" : "RETAIL",
          isWholesale: Boolean(input.wholesale),
          status: "COMPLETED",
          subtotal: grossTotal.toFixed(2),
          discount: orderDiscount.toFixed(2),
          discountReason: orderDiscount > 0 ? discountReason || null : null,
          priceApprovedById: approvedBy?.id ?? null,
          priceApprovedBy: approvedBy?.name ?? null,
          totalAmount: subtotal.toFixed(2),
          paidAmount: paid.toFixed(2),
          paymentMethod: method,
          notes: input.notes,
          items: {
            create: input.items.map((item, index) => {
              const line = priceLines.get(index)
              return {
                productId: item.productId,
                imeiId: item.imeiId || null,
                quantity: item.quantity,
                unitPrice: item.unitPrice.toFixed(2),
                totalPrice: (item.unitPrice * item.quantity).toFixed(2),
                // Cost is copied in here, on the day of the sale. Reading it
                // from the product later meant a new batch at a new exchange
                // rate rewrote the profit on sales already made.
                costPrice: (line?.cost ?? 0).toFixed(2),
                listPrice: (line?.list ?? 0).toFixed(2),
                discount: discountOff(line?.list ?? 0, item.unitPrice, item.quantity).toFixed(2),
                priceReason: line?.reason || null,
                warrantyDays: item.warrantyDays != null ? Math.max(0, Number(item.warrantyDays)) : 0,
              }
            }),
          },
          payments:
            paid > 0
              ? {
                  create: isSplit && landedSplits.length > 0
                    ? landedSplits.map((t) => ({
                        amount: t.amount.toFixed(2),
                        method: t.method,
                        bankAccountId: shopPayChannel(t.method) === "TRANSFER" ? bankAccountId : null,
                        reference: shopPayChannel(t.method) === "TRANSFER" ? (input.paymentReference?.trim() || null) : null,
                        receivedByUserId: user.id,
                      }))
                    : [
                        {
                          amount: paid.toFixed(2),
                          method: receivedChannel,
                          bankAccountId: receivedChannel === "CASH" ? null : bankAccountId,
                          reference: receivedChannel === "CASH" ? null : (input.paymentReference?.trim() || null),
                          receivedByUserId: user.id,
                        },
                      ],
                }
              : undefined,
        },
      })

      // The checks above are for a helpful message. These are the ones that
      // decide the sale: a guarded write that only lands while the unit is still
      // In shop here, so two tills cannot both sell the same phone.
      //
      // Shelf quantity must move with the IMEI. Before this, phones were marked
      // Sold while Shop stock still showed them on the shelf — the Home
      // "phone list vs shelf" gaps were that bug showing up.
      for (const item of input.items) {
        if (!item.imeiId) continue
        const claimed = imeiById.get(item.imeiId)
        const label = claimed?.imei1 ?? "That phone"
        await claimImei(tx, {
          imeiId: item.imeiId,
          branchId: saleShopId,
          label,
          data: {
            status: "SOLD",
            saleId: created.id,
            customerId: input.customerId || null,
          },
        })
        await drawStock(tx, {
          productId: item.productId,
          branchId: saleShopId,
          quantity: item.quantity || 1,
          label,
          move: { kind: "SALE", reference: invoiceNumber, userId: user.id },
        })
        await tx.auditLog.create({
          data: {
            userId: user.id,
            action: "UPDATE",
            entityType: "IMEIRecord",
            entityId: label,
            oldValue: "IN_STOCK",
            newValue: JSON.stringify({ status: "SOLD", invoice: invoiceNumber, shelfDrawn: item.quantity || 1 }),
            branchId: saleShopId,
          },
        })
      }

      for (const [productId, wanted] of wantByProduct) {
        await drawStock(tx, {
          productId,
          branchId: saleShopId,
          quantity: wanted,
          label: productById.get(productId)?.name ?? "This item",
          move: { kind: "SALE", reference: invoiceNumber, userId: user.id },
        })
      }

      if (input.customerId) {
        // The database does the addition and hands back the real figure, so two
        // clerks posting to one customer at the same time cannot overwrite each
        // other's debt.
        const customer = await shiftCustomerBalance(tx, input.customerId, due)
        const nextBalance = money(customer.currentBalance)
        if (
          due > 0 &&
          money(customer.creditLimit) > 0 &&
          nextBalance > money(customer.creditLimit) &&
          !canOverrideCredit
        ) {
          throw new ConflictError(
            `${customer.name} went over their credit limit while this sale was being typed. They now owe ₦${nextBalance.toLocaleString("en-NG")}. Collect first, or ask the main admin.`
          )
        }
        await tx.ledgerEntry.create({
          data: {
            customerId: input.customerId,
            type: "SALE",
            amount: subtotal.toFixed(2),
            balance: (nextBalance + paid).toFixed(2),
            reference: invoiceNumber,
            description: "Sale in the shop",
          },
        })
        if (paid > 0) {
          await tx.ledgerEntry.create({
            data: {
              customerId: input.customerId,
              type: "PAYMENT",
              amount: (-paid).toFixed(2),
              balance: nextBalance.toFixed(2),
              reference: invoiceNumber,
              description: "Money paid on an invoice",
            },
          })
        }
      }

      if (paid > 0) {
        if (isSplit && landedSplits.length > 0) {
          for (const t of landedSplits) {
            await tx.financeEntry.create({
              data: {
                branchId: saleShopId,
                account: t.method === "CASH" ? "CASH" : "BANK",
                type: "INCOME",
                amount: t.amount.toFixed(2),
                reference: invoiceNumber,
                description: `Sales revenue received (${t.method}): ${invoiceNumber}`,
              },
            })
          }
        } else {
          await tx.financeEntry.create({
            data: {
              branchId: saleShopId,
              account: receivedChannel === "CASH" ? "CASH" : "BANK",
              type: "INCOME",
              amount: paid.toFixed(2),
              reference: invoiceNumber,
              description: `Sales revenue received (${receivedChannel}): ${invoiceNumber}`,
            },
          })
        }
      }

      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: "CREATE",
          entityType: "Sale",
          entityId: invoiceNumber,
          newValue: JSON.stringify({
            total: subtotal,
            paid,
            method,
            ...(orderDiscount > 0
              ? { orderDiscount, discountReason: discountReason || null }
              : {}),
            ...(isSplit ? { splitTenders: landedSplits, typedTenders: validSplits } : {}),
            ...(approvedBy ? { priceApprovedBy: approvedBy.name, priceApprovedById: approvedBy.id } : {}),
            ...(input.queuedAt
              ? { postedFromOffline: true, queuedAt: input.queuedAt, offlineId: input.offlineId ?? null }
              : {}),
          }),
          branchId: saleShopId,
        },
      })

      for (const [productId] of wantByProduct) {
        const stock = await tx.inventory.findUnique({
          where: { productId_branchId: { productId, branchId: saleShopId } },
          select: { quantity: true, minStock: true },
        })
        if (!stock) continue
        const limit = lowStockLimit(stock.minStock, settings.lowStockThreshold)
        if (stock.quantity <= limit) lowStockAlerts.push({ productId, quantity: stock.quantity, limit })
      }

      return created
    })
  )

  if ("error" in posted) return { error: posted.error }
  const sale = posted.data

  await fanOutSaleAlerts({
    branchId: saleShopId,
    invoiceNumber,
    saleId: sale.id,
    due,
    customerId: input.customerId,
    lowStockAlerts: lowStockAlerts.map((row) => ({
      ...row,
      name: productById.get(row.productId)?.name ?? "Item",
    })),
  })

  if (input.offlineId) await markParkedPosted(input.offlineId, sale.id)
  if (input.priceRequestId && approvedBy) {
    // The approved ask has now been sold; it cannot be used again.
    await prisma.priceRequest.updateMany({
      where: { id: input.priceRequestId, sellerId: user.id, status: "APPROVED" },
      data: { status: "USED", saleId: sale.id },
    })
  }

  revalidatePath("/sales")
  revalidatePath("/pos")
  revalidatePath("/dashboard")
  revalidatePath("/finance")
  revalidatePath("/finance/close")
  revalidatePath("/reports")
  revalidatePath("/profits")
  revalidatePath("/customers")
  revalidatePath("/imei")
  revalidatePath("/inventory")
  revalidatePath("/audit/books")
  revalidatePath("/notifications")
  return { success: true, saleId: sale.id }
}

/**
 * Low stock and unpaid-invoice alerts, sent after the sale is safely written.
 * One createMany per alert type rather than a row at a time, so a shop with
 * twenty staff still costs two writes.
 */
async function fanOutSaleAlerts(input: {
  branchId: string
  invoiceNumber: string
  saleId: string
  due: number
  customerId?: string
  lowStockAlerts: Array<{ name: string; quantity: number; limit: number }>
}) {
  try {
    if (input.lowStockAlerts.length) {
      const staff = await prisma.user.findMany({
        where: {
          isActive: true,
          OR: [{ branchId: input.branchId }, { role: { in: ["VAULT_MANAGER", "CEO", "SUPER_ADMIN", "BRANCH_MANAGER"] } }],
        },
        select: { id: true },
      })
      const rows = staff.flatMap((person) =>
        input.lowStockAlerts.map((alert) => ({
          userId: person.id,
          type: "LOW_STOCK" as const,
          title: "An item is running low",
          message: `Only ${alert.quantity} ${alert.name} left in this shop. We warn you at ${alert.limit}.`,
          actionUrl: "/inventory",
        }))
      )
      if (rows.length) await prisma.notification.createMany({ data: rows })
    }

    if (input.due > 0 && input.customerId) {
      const [watchers, customer] = await Promise.all([
        prisma.user.findMany({
          where: {
            isActive: true,
            OR: [
              { role: { in: ["ACCOUNTANT", "CEO", "SUPER_ADMIN"] } },
              { role: "BRANCH_MANAGER", branchId: input.branchId },
            ],
          },
          select: { id: true },
        }),
        prisma.customer.findUnique({ where: { id: input.customerId }, select: { name: true } }),
      ])
      if (watchers.length) {
        await prisma.notification.createMany({
          data: watchers.map((person) => ({
            userId: person.id,
            type: "DUE_PAYMENT" as const,
            title: "This invoice is not fully paid",
            message: `${customer?.name ?? "The customer"} still owes ₦${input.due.toLocaleString("en-NG")} on ${input.invoiceNumber}`,
            actionUrl: `/sales/${input.saleId}`,
          })),
        })
      }
    }
  } catch {
    // The sale is already written and correct. A failed alert must never make
    // the till think the sale did not go through.
  }
}

export async function collectPayment(formData: FormData) {
  const user = await requireUser()
  // Same door as collecting on an invoice: it used to accept any signed-in job.
  if (!(await canSell(user.role)) && !(await canManageFinance(user.role))) {
    return { error: "You are not allowed to collect money from a customer. Ask the main admin." }
  }
  const customerId = String(formData.get("customerId"))
  const bankAccountIdRaw = String(formData.get("bankAccountId") || "").trim()
  const paymentReference = String(formData.get("paymentReference") || "").trim() || null
  const cashPart = Math.max(0, Number(formData.get("cashAmount") || 0) || 0)
  const bankPart = Math.max(0, Number(formData.get("bankAmount") || 0) || 0)
  const legacyAmount = Number(formData.get("amount") || 0)
  const legacyMethod = shopPayChannel(String(formData.get("method") || "TRANSFER"))

  const tenders: Array<{ method: "CASH" | "TRANSFER"; amount: number }> = []
  if (cashPart > 0 || bankPart > 0) {
    if (cashPart > 0) tenders.push({ method: "CASH", amount: cashPart })
    if (bankPart > 0) tenders.push({ method: "TRANSFER", amount: bankPart })
  } else if (legacyAmount > 0) {
    tenders.push({ method: legacyMethod, amount: legacyAmount })
  }

  const amount = tenders.reduce((sum, row) => sum + row.amount, 0)
  if (!customerId || amount <= 0) return { error: "Type how much was paid in cash, bank, or both." }

  const wantsBank = tenders.some((row) => row.method === "TRANSFER")
  if (wantsBank && !bankAccountIdRaw) {
    return { error: "Pick which bank account received this money." }
  }
  // The admin matches every bank collection to the bank statement by this.
  if (wantsBank && !paymentReference) {
    return { error: "Type the payment reference for the bank money." }
  }

  const payRef = generateDocNumber("PAY")
  const settleMethod =
    tenders.length > 1 ? ("SPLIT_PAYMENT" as const) : tenders[0].method

  const posted = await settle(() =>
    prisma.$transaction(async (tx) => {
      // Read the debt inside the posting, not before it. Two clerks taking money
      // from the same customer at once used to each work from the balance they
      // saw on their own screen, and the second write wiped out the first.
      const customer = await tx.customer.findUnique({
        where: { id: customerId },
        select: { id: true, name: true, branchId: true, currentBalance: true },
      })
      if (!customer) throw new ConflictError("We could not find that customer.")
      if (!(await canReachBranch(user, customer.branchId))) throw new ConflictError(OTHER_SHOP)
      const owing = money(customer.currentBalance)
      if (owing <= 0) throw new ConflictError("This customer does not owe us anything.")

      let bankAccountId: string | null = null
      if (wantsBank) {
        const bank = await tx.bankAccount.findFirst({
          where: { id: bankAccountIdRaw, isActive: true, branchId: customer.branchId },
          select: { id: true },
        })
        if (!bank) throw new ConflictError("That bank account is not on the books for this shop.")
        bankAccountId = bank.id
      }

      const collected = Math.min(amount, owing)
      // Scale tenders down if they typed more than still owed.
      let leftToTake = collected
      const applied: Array<{ method: "CASH" | "TRANSFER"; amount: number }> = []
      // Bank first: a transfer is exactly what the statement shows, while cash
      // typed past what is owed is change handed back.
      for (const row of bankFirst(tenders)) {
        if (leftToTake <= 0) break
        const take = Math.min(row.amount, leftToTake)
        if (take > 0) {
          applied.push({ method: row.method, amount: take })
          leftToTake -= take
        }
      }

      const after = await shiftCustomerBalance(tx, customerId, -collected)
      const next = money(after.currentBalance)
      if (next < -0.005) {
        throw new ConflictError(
          `${customer.name} was collected from while you were typing. Open their page again to see what is still owed.`
        )
      }

      await tx.ledgerEntry.create({
        data: {
          customerId,
          type: "PAYMENT",
          amount: (-collected).toFixed(2),
          balance: next.toFixed(2),
          reference: payRef,
          description: "Money collected on the customer account. Nothing on the invoice was changed",
        },
      })
      for (const row of applied) {
        await tx.financeEntry.create({
          data: {
            branchId: customer.branchId,
            account: row.method === "CASH" ? "CASH" : "BANK",
            type: "INCOME",
            amount: row.amount.toFixed(2),
            reference: payRef,
            description: `Money collected from ${customer.name}`,
          },
        })
      }

      // Peel cash then bank across open invoices so each payment line keeps its channel.
      const pool = applied.map((row) => ({ ...row }))
      const openSales = await tx.sale.findMany({
        where: { customerId, status: "COMPLETED" },
        orderBy: { saleDate: "asc" },
        select: { id: true, totalAmount: true, paidAmount: true, paymentMethod: true },
      })
      // What a return already took off each invoice. Without this a payment was
      // spread onto an invoice whose goods had come back, and that invoice
      // read as paid while a still-open one stayed owing.
      const returnedOn = await returnedValueBySale(tx, openSales.map((sale) => sale.id))
      for (const sale of openSales) {
        let due = dueAfterReturns(sale, returnedOn.get(sale.id) ?? 0)
        if (due <= 0) continue
        let appliedHere = 0
        for (const row of pool) {
          if (due <= 0 || row.amount <= 0) continue
          const take = Math.min(due, row.amount)
          await tx.payment.create({
            data: {
              saleId: sale.id,
              amount: take.toFixed(2),
              method: row.method,
              bankAccountId: row.method === "TRANSFER" ? bankAccountId : null,
              reference: row.method === "TRANSFER" ? paymentReference : payRef,
              notes: "Taken from what the customer paid on their account. The invoice was not changed.",
              receivedByUserId: user.id,
            },
          })
          row.amount -= take
          due -= take
          appliedHere += take
        }
        if (appliedHere > 0) {
          const credited = await creditInvoice(tx, sale.id, appliedHere)
          if (money(credited.paidAmount) >= money(credited.totalAmount)) {
            const finalMethod =
              settleMethod === "SPLIT_PAYMENT" || applied.length > 1 ? "SPLIT_PAYMENT" : applied[0].method
            await tx.sale.update({ where: { id: sale.id }, data: { paymentMethod: finalMethod } })
          }
        }
      }

      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: "CREATE",
          entityType: "LedgerEntry",
          entityId: payRef,
          newValue: JSON.stringify({ customerId, collected, tenders: applied, bankAccountId }),
          branchId: customer.branchId,
        },
      })
    })
  )

  if ("error" in posted) return { error: posted.error }

  revalidatePath("/customers")
  revalidatePath(`/customers/${customerId}`)
  revalidatePath("/finance")
  revalidatePath("/sales")
  revalidatePath("/dashboard")
  return { success: true }
}

export async function collectInvoicePayment(formData: FormData) {
  const user = await requireUser()
  if (!(await canSell(user.role)) && !(await canManageFinance(user.role))) {
    return { error: "You are not allowed to collect money on a sale. Ask the main admin." }
  }
  const saleId = String(formData.get("saleId") || "")
  const bankAccountIdRaw = String(formData.get("bankAccountId") || "").trim()
  const paymentReference = String(formData.get("paymentReference") || "").trim() || null
  const cashPart = Math.max(0, Number(formData.get("cashAmount") || 0) || 0)
  const bankPart = Math.max(0, Number(formData.get("bankAmount") || 0) || 0)
  const legacyAmount = Number(formData.get("amount") || 0)
  const legacyMethod = shopPayChannel(String(formData.get("method") || "TRANSFER"))

  const tenders: Array<{ method: "CASH" | "TRANSFER"; amount: number }> = []
  if (cashPart > 0 || bankPart > 0) {
    if (cashPart > 0) tenders.push({ method: "CASH", amount: cashPart })
    if (bankPart > 0) tenders.push({ method: "TRANSFER", amount: bankPart })
  } else if (legacyAmount > 0) {
    tenders.push({ method: legacyMethod, amount: legacyAmount })
  }

  const amount = tenders.reduce((sum, row) => sum + row.amount, 0)
  if (!saleId || amount <= 0) return { error: "Enter the amount collected in cash, bank, or both." }

  const sale = await prisma.sale.findUnique({
    where: { id: saleId },
    select: { id: true, status: true, branchId: true, customerId: true, invoiceNumber: true, totalAmount: true, paidAmount: true },
  })
  if (!sale) return { error: "We could not find that sale." }
  if (!(await canReachBranch(user, sale.branchId))) return { error: OTHER_SHOP }
  if (sale.status !== "COMPLETED") return { error: "You can only collect money on a sale that is finished." }
  const returned = (await returnedValueBySale(prisma, [sale.id])).get(sale.id) ?? 0
  if (dueAfterReturns(sale, returned) <= 0) {
    return {
      error: returned > 0 ? "Nothing is owed on this sale: a return has already cleared it." : "This sale is already fully paid.",
    }
  }

  const wantsBank = tenders.some((row) => row.method === "TRANSFER")
  let bankAccountId: string | null = null
  if (wantsBank) {
    if (!bankAccountIdRaw) return { error: "Pick which bank account received this money." }
    // The admin matches every bank collection to the bank statement by this.
    if (!paymentReference) return { error: "Type the payment reference for the bank money." }
    const bank = await prisma.bankAccount.findFirst({
      where: { id: bankAccountIdRaw, isActive: true, branchId: sale.branchId },
      select: { id: true },
    })
    if (!bank) return { error: "That bank account is not on the books for this shop." }
    bankAccountId = bank.id
  }

  const posted = await settle(() =>
    prisma.$transaction(async (tx) => {
      // What is still owed is read inside the posting. Two clerks collecting on
      // one invoice used to both work from the same starting figure, so the shop
      // banked two payments but the invoice only recorded one.
      const fresh = await tx.sale.findUnique({
        where: { id: saleId },
        select: { totalAmount: true, paidAmount: true },
      })
      if (!fresh) throw new ConflictError("We could not find that sale.")
      const due = dueAfterReturns(fresh, returned)
      if (due <= 0) {
        throw new ConflictError(`${sale.invoiceNumber} was settled while you were typing. Nothing is owed on it now.`)
      }
      const collected = Math.min(amount, due)
      let leftToTake = collected
      const applied: Array<{ method: "CASH" | "TRANSFER"; amount: number }> = []
      // Bank first: a transfer is exactly what the statement shows, while cash
      // typed past what is owed is change handed back.
      for (const row of bankFirst(tenders)) {
        if (leftToTake <= 0) break
        const take = Math.min(row.amount, leftToTake)
        if (take > 0) {
          applied.push({ method: row.method, amount: take })
          leftToTake -= take
        }
      }

      const credited = await creditInvoice(tx, sale.id, collected)
      if (money(credited.paidAmount) >= money(credited.totalAmount)) {
        const finalMethod = applied.length > 1 ? "SPLIT_PAYMENT" : applied[0].method
        await tx.sale.update({ where: { id: sale.id }, data: { paymentMethod: finalMethod } })
      }
      for (const row of applied) {
        await tx.payment.create({
          data: {
            saleId: sale.id,
            amount: row.amount.toFixed(2),
            method: row.method,
            bankAccountId: row.method === "TRANSFER" ? bankAccountId : null,
            reference: row.method === "TRANSFER" ? paymentReference : null,
            notes: "Money collected on a finished invoice. The items and IMEIs were not changed",
            receivedByUserId: user.id,
          },
        })
        await tx.financeEntry.create({
          data: {
            branchId: sale.branchId,
            account: row.method === "CASH" ? "CASH" : "BANK",
            type: "INCOME",
            amount: row.amount.toFixed(2),
            reference: sale.invoiceNumber,
            description: `Money collected on ${sale.invoiceNumber}`,
          },
        })
      }
      if (sale.customerId) {
        const after = await shiftCustomerBalance(tx, sale.customerId, -collected)
        const next = Math.max(0, money(after.currentBalance))
        await tx.ledgerEntry.create({
          data: {
            customerId: sale.customerId,
            type: "PAYMENT",
            amount: (-collected).toFixed(2),
            balance: next.toFixed(2),
            reference: sale.invoiceNumber,
            description: `Money collected on ${sale.invoiceNumber}`,
          },
        })
      }
      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: "CREATE",
          entityType: "Payment",
          entityId: sale.invoiceNumber,
          newValue: JSON.stringify({ collected, tenders: applied, bankAccountId, itemsUntouched: true }),
          branchId: sale.branchId,
        },
      })
    })
  )

  if ("error" in posted) return { error: posted.error }

  revalidatePath("/sales")
  revalidatePath(`/sales/${sale.id}`)
  if (sale.customerId) revalidatePath(`/customers/${sale.customerId}`)
  revalidatePath("/finance")
  revalidatePath("/dashboard")
  return { success: true }
}

export async function attachSaleCustomer(formData: FormData) {
  const user = await requireUser()
  if (!(await canSell(user.role)) && !(await canManageFinance(user.role))) {
    return { error: "You are not allowed to put a buyer name on this sale. Ask the main admin." }
  }

  const saleId = String(formData.get("saleId") || "")
  const existingId = String(formData.get("customerId") || "").trim()
  const name = String(formData.get("name") || "").trim()
  const phone = String(formData.get("phone") || "").trim()

  const sale = await prisma.sale.findUnique({
    where: { id: saleId },
    include: { items: true, imeis: true },
  })
  if (!sale) return { error: "We could not find that sale." }
  if (sale.customerId) return { error: "This sale already has a buyer name. The items stay as they are." }

  const scoped = await scopedBranchId(user.role, user.branchId)
  if (scoped && sale.branchId !== scoped) return { error: "You can only add a customer name on sales from your own shop." }

  let customer = existingId
    ? await prisma.customer.findUnique({ where: { id: existingId } })
    : phone
      ? await prisma.customer.findUnique({ where: { phone } })
      : null

  if (!customer) {
    if (!name || !phone) return { error: "Pick an existing customer or enter name and phone." }
    customer = await prisma.customer.create({
      data: {
        name,
        phone,
        branchId: sale.branchId,
      },
    })
  } else if (name && customer.name !== name && !existingId) {
    return { error: `Phone ${phone} already belongs to ${customer.name}. Pick them from the list.` }
  }

  if (scoped && customer.branchId !== scoped && customer.branchId !== sale.branchId) {
    return { error: "That customer belongs to another shop." }
  }

  const due = money(sale.totalAmount) - money(sale.paidAmount)
  if (due > 0) {
    const next = money(customer.currentBalance) + due
    const limit = money(customer.creditLimit)
    const hq = await can(user.role, "action.override_floor")
    if (limit > 0 && next > limit && !hq) {
      return { error: `Adding this unpaid sale would take ${customer.name} over their credit limit.` }
    }
  }

  const buyer = customer

  const posted = await settle(() =>
    prisma.$transaction(async (tx) => {
      // Only attach if the sale is still a walk-in. Two clerks naming the same
      // invoice at once would otherwise post the debt to the customer twice.
      const claimed = await tx.sale.updateMany({
        where: { id: sale.id, customerId: null },
        data: { customerId: buyer.id },
      })
      if (claimed.count !== 1) {
        throw new ConflictError("Someone else just put a customer name on this sale. Refresh to see it.")
      }
      await tx.imeiRecord.updateMany({
        where: { saleId: sale.id },
        data: { customerId: buyer.id },
      })
      if (due > 0) {
        const after = await shiftCustomerBalance(tx, buyer.id, due)
        await tx.ledgerEntry.create({
          data: {
            customerId: buyer.id,
            type: "SALE",
            amount: due.toFixed(2),
            balance: money(after.currentBalance).toFixed(2),
            reference: sale.invoiceNumber,
            description: `A buyer name was put on the unpaid sale ${sale.invoiceNumber}`,
          },
        })
      }
      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: "UPDATE",
          entityType: "Sale",
          entityId: sale.invoiceNumber,
          oldValue: "WALK_IN",
          newValue: JSON.stringify({ customerId: buyer.id, customer: buyer.name, itemsUntouched: true, due }),
          branchId: sale.branchId,
        },
      })
    })
  )

  if ("error" in posted) return { error: posted.error }

  revalidatePath("/sales")
  revalidatePath(`/sales/${sale.id}`)
  revalidatePath(`/customers/${customer.id}`)
  revalidatePath("/customers")
  revalidatePath("/returns")
  revalidatePath("/imei")
  revalidatePath("/pos")
  return { success: true }
}

/**
 * Every receipt for a stretch of days, for filing or handing to accounts.
 *
 * Read only. It reprints what the sales already say and changes nothing.
 */
export async function getReceiptsForRange(from: string, to: string) {
  const user = await requireUser()
  if (!(await can(user.role, "view.sales"))) return { error: "You are not allowed to see sales. Ask the main admin." as const }

  const branchId = await viewBranchFilter(user)
  // Shop days run midnight to midnight in Lagos, not on the server's clock.
  if (!isWatDayKey(from) || !isWatDayKey(to)) {
    return { error: "Pick the first day and the last day." as const }
  }
  const start = watBounds(from).start
  const end = new Date(watBounds(to).end.getTime() - 1)
  if (start > end) return { error: "The first day must come before the last day." as const }

  const sales = await prisma.sale.findMany({
    where: {
      status: "COMPLETED",
      saleDate: { gte: start, lte: end },
      ...(branchId ? { branchId } : {}),
    },
    include: {
      branch: true,
      user: { select: { name: true } },
      customer: { select: { name: true, phone: true } },
      items: { include: { product: true, imei: { select: { imei1: true } } } },
    },
    orderBy: { saleDate: "asc" },
    take: 500,
  })

  const settings = await getAppSettings()
  const brand = letterheadFromSettings(settings)
  return {
    receipts: sales.map((sale) => ({
      company: brand.name,
      tagline: brand.tagline,
      logoSrc: brand.logoSrc,
      footer: brand.footer,
      invoiceNumber: sale.invoiceNumber,
      branch: sale.branch.name,
      address: brand.address || sale.branch.address,
      shopPhone: brand.phone || sale.branch.phone,
      email: brand.email,
      cashier: sale.user.name ?? "Staff",
      customer: sale.customer?.name ?? null,
      customerPhone: sale.customer?.phone ?? null,
      soldAt: sale.saleDate.toISOString(),
      items: sale.items.map((item) => ({
        name: item.product.name,
        imei: item.imei?.imei1 ?? null,
        quantity: item.quantity,
        amount: money(item.totalPrice),
      })),
      total: money(sale.totalAmount),
      paid: money(sale.paidAmount),
      method: String(sale.paymentMethod),
      notes: sale.notes,
    })),
  }
}
