import { prisma } from "@/lib/prisma"
import { payablePurchaseWhere } from "@/lib/purchase-money"
import { returnQtyOf } from "@/lib/return-limits"
import { lineValueAfterOrderDiscount } from "@/lib/sale-money"
import { offInvoiceMoneyInWhere } from "@/lib/shop-cash"
import { shopConditionLabel } from "@/lib/conditions"
import { money } from "@/lib/utils"

/**
 * Reports by category: what each sales department sold, what came back, what
 * it cost and made, and the money received on it; and what was bought for it
 * from suppliers in the same period, so the auditor can set accessories
 * bought against accessories sold without opening every invoice.
 *
 * The totals are built from the same rows as the report's own cards, so the
 * category lines add up to Total sales, Sales returns and Payments received.
 */

/** Money that came in with no bill behind it (collected on account, extras on a replacement). */
export const NOT_ON_A_BILL = "__not_on_a_bill__"
/** An item whose product carries no category. */
export const NO_CATEGORY = "__no_category__"

export type CategorySalesRow = {
  id: string
  name: string
  /** Pieces sold on the period's invoices. */
  qty: number
  totalSales: number
  returns: number
  /** Total sales less returns. */
  actualSales: number
  /** Cost of what was sold, less the cost of what came back. 0 without cost rights. */
  actualCost: number
  profit: number
  received: number
}

export type CategoryBuyRow = {
  id: string
  name: string
  qtyBought: number
  bought: number
  qtySentBack: number
  sentBack: number
  netBought: number
  /** Pieces sold in the same period, to set against what was bought. */
  qtySold: number
}

export type CategoryReturnLine = {
  id: string
  categoryId: string
  returnNumber: string
  date: string
  shop: string
  customer: string
  item: string
  unit: string
  qty: number
  value: number
  cost: number
}

export type CategoryBuyLine = {
  id: string
  categoryId: string
  purchaseId: string
  invoice: string
  date: string
  supplier: string
  shop: string
  item: string
  qty: number
  unitCost: number
  total: number
}

export type CategorySendBackLine = {
  id: string
  categoryId: string
  reference: string
  purchaseId: string | null
  date: string
  supplier: string
  shop: string
  item: string
  unit: string
  cost: number
}

export type CategoryReport = {
  sales: CategorySalesRow[]
  buys: CategoryBuyRow[]
  returnLines: CategoryReturnLine[]
  buyLines: CategoryBuyLine[]
  sendBackLines: CategorySendBackLine[]
}

type ProductLite = {
  name: string
  storage: string | null
  condition: string
  costPrice: unknown
  categoryId: string
  category: { name: string }
}

const productSelect = {
  name: true,
  storage: true,
  condition: true,
  costPrice: true,
  categoryId: true,
  category: { select: { name: true } },
} as const

function itemName(product: ProductLite) {
  return [product.name, product.storage, shopConditionLabel(product.condition)].filter(Boolean).join(" · ")
}

export async function getCategoryReport(args: {
  branchId?: string | null
  start: Date
  end: Date
  showCost: boolean
  /** The period's completed sales, as the report already read them. */
  sales: Array<{ id: string; subtotal: unknown; discount: unknown; totalAmount: unknown }>
}): Promise<CategoryReport> {
  const shop = args.branchId ? { branchId: args.branchId } : {}
  const window = { gte: args.start, lt: args.end }
  const cost = (value: number) => (args.showCost ? value : 0)

  const [lines, finishedReturns, payments, legacy, offInvoice, purchases, sendBacks] = await Promise.all([
    args.sales.length
      ? prisma.saleItem.findMany({
          where: { saleId: { in: args.sales.map((sale) => sale.id) } },
          select: { saleId: true, quantity: true, totalPrice: true, costPrice: true, product: { select: productSelect } },
        })
      : Promise.resolve([]),
    // The same returns as the Sales returns card: refunds and credit notes finished in the period.
    prisma.stockReturn.findMany({
      where: { ...shop, status: "COMPLETED", outcome: { in: ["REFUND", "CREDIT_NOTE"] }, completedAt: window },
      select: {
        id: true,
        returnNumber: true,
        saleId: true,
        imeiId: true,
        quantity: true,
        notes: true,
        returnValue: true,
        refundAmount: true,
        completedAt: true,
        branch: { select: { code: true } },
        customer: { select: { name: true } },
        saleItem: { select: { quantity: true, costPrice: true, product: { select: productSelect } } },
        imei: { select: { imei1: true, product: { select: productSelect } } },
      },
    }),
    // The same money as Payments received (see receiptsInWindow), by the day it came in.
    prisma.payment.findMany({
      where: { paidAt: window, sale: { status: "COMPLETED", ...shop } },
      select: { saleId: true, amount: true },
    }),
    prisma.sale.findMany({
      where: { status: "COMPLETED", ...shop, saleDate: window, paidAmount: { gt: 0 }, payments: { none: {} } },
      select: { id: true, paidAmount: true, creditNoteUsed: true },
    }),
    prisma.financeEntry.findMany({
      where: { ...shop, account: { in: ["CASH", "BANK"] }, createdAt: window, ...offInvoiceMoneyInWhere },
      select: { amount: true, description: true },
    }),
    // Supplier bills dated in the period the way the Purchases list dates them:
    // the day the goods arrived, else the day the bill was made. Opening stock
    // is the shop's starting value, not a purchase, and cancelled bills are out.
    prisma.purchase.findMany({
      where: {
        ...shop,
        ...payablePurchaseWhere,
        OR: [{ receivedDate: window }, { receivedDate: null, createdAt: window }],
      },
      select: {
        id: true,
        invoiceNumber: true,
        createdAt: true,
        receivedDate: true,
        supplier: { select: { name: true } },
        branch: { select: { code: true } },
        items: { select: { id: true, quantity: true, costPrice: true, totalAmount: true, product: { select: productSelect } } },
      },
    }),
    prisma.supplierReturnLine.findMany({
      where: { ...shop, sentAt: window },
      select: {
        id: true,
        reference: true,
        purchaseId: true,
        sentAt: true,
        cost: true,
        supplier: { select: { name: true } },
        branch: { select: { code: true } },
        imei: { select: { imei1: true } },
        product: { select: productSelect },
      },
    }),
  ])

  const names = new Map<string, string>()
  const keyOf = (product: ProductLite | null | undefined) => {
    if (!product) return NO_CATEGORY
    names.set(product.categoryId, product.category.name)
    return product.categoryId
  }
  names.set(NO_CATEGORY, "No category")
  names.set(NOT_ON_A_BILL, "Not on a bill (collected on account)")

  const sales = new Map<string, CategorySalesRow>()
  const salesRow = (id: string) => {
    let row = sales.get(id)
    if (!row) {
      row = { id, name: "", qty: 0, totalSales: 0, returns: 0, actualSales: 0, actualCost: 0, profit: 0, received: 0 }
      sales.set(id, row)
    }
    return row
  }

  // Sold: each line at what it fetched after the order discount, scaled so
  // an invoice's lines come to its total, and the categories add up to Total
  // sales even on a bill whose lines and total drifted apart.
  const saleById = new Map(args.sales.map((sale) => [sale.id, sale]))
  const linesBySale = new Map<string, number>()
  for (const line of lines) {
    const sale = saleById.get(line.saleId)
    if (sale) linesBySale.set(line.saleId, (linesBySale.get(line.saleId) ?? 0) + lineValueAfterOrderDiscount(line.totalPrice, sale))
  }
  for (const line of lines) {
    const sale = saleById.get(line.saleId)
    if (!sale) continue
    const row = salesRow(keyOf(line.product))
    const value = lineValueAfterOrderDiscount(line.totalPrice, sale)
    const onLines = linesBySale.get(line.saleId) ?? 0
    row.qty += line.quantity
    row.totalSales += onLines > 0 ? (value * money(sale.totalAmount)) / onLines : value
    row.actualCost += cost((money(line.costPrice) || money(line.product.costPrice)) * line.quantity)
  }

  // Came back: the value off Total sales, and its cost off the cost of sales.
  // An older phone return names the phone, not the line: its cost is read off
  // the line on that invoice that sold it.
  const imeiLines = finishedReturns.filter((row) => !row.saleItem && row.imeiId && row.saleId)
  const soldImeiLines = imeiLines.length
    ? await prisma.saleItem.findMany({
        where: { OR: imeiLines.map((row) => ({ saleId: row.saleId!, imeiId: row.imeiId! })) },
        select: { saleId: true, imeiId: true, costPrice: true },
      })
    : []
  const imeiLineCost = new Map(soldImeiLines.map((line) => [`${line.saleId}:${line.imeiId}`, money(line.costPrice)]))
  const returnLines: CategoryReturnLine[] = []
  for (const back of finishedReturns) {
    const product = back.saleItem?.product ?? back.imei?.product ?? null
    const id = keyOf(product)
    const value = money(back.returnValue) || money(back.refundAmount)
    const qty = back.saleItem ? Math.min(returnQtyOf(back), back.saleItem.quantity) : 1
    const unitCost = back.saleItem
      ? money(back.saleItem.costPrice) || money(back.saleItem.product.costPrice)
      : imeiLineCost.get(`${back.saleId}:${back.imeiId}`) || money(back.imei?.product.costPrice)
    const row = salesRow(id)
    row.returns += value
    row.actualCost -= cost(unitCost * qty)
    returnLines.push({
      id: back.id,
      categoryId: id,
      returnNumber: back.returnNumber,
      date: (back.completedAt ?? new Date()).toISOString(),
      shop: back.branch.code,
      customer: back.customer.name,
      item: product ? itemName(product) : "Item not recorded",
      unit: back.imei?.imei1 ?? "",
      qty,
      value,
      cost: cost(unitCost * qty),
    })
  }

  // Money in, shared across a bill's items by what each fetched, so a bill
  // paid in part puts the same part on each of its categories.
  const paidSaleIds = [...new Set([...payments.map((row) => row.saleId), ...legacy.map((row) => row.id)])]
  const paidLines = paidSaleIds.length
    ? await prisma.saleItem.findMany({
        where: { saleId: { in: paidSaleIds } },
        select: { saleId: true, totalPrice: true, product: { select: productSelect }, sale: { select: { subtotal: true, discount: true } } },
      })
    : []
  const sharesBySale = new Map<string, Array<{ id: string; value: number }>>()
  for (const line of paidLines) {
    const list = sharesBySale.get(line.saleId) ?? []
    list.push({ id: keyOf(line.product), value: lineValueAfterOrderDiscount(line.totalPrice, line.sale) })
    sharesBySale.set(line.saleId, list)
  }
  const spread = (saleId: string, amount: number) => {
    const shares = sharesBySale.get(saleId) ?? []
    const whole = shares.reduce((sum, share) => sum + share.value, 0)
    if (!shares.length || whole <= 0) {
      salesRow(shares[0]?.id ?? NO_CATEGORY).received += amount
      return
    }
    for (const share of shares) salesRow(share.id).received += (amount * share.value) / whole
  }
  for (const row of payments) spread(row.saleId, money(row.amount))
  for (const row of legacy) {
    const amount = money(row.paidAmount) - money(row.creditNoteUsed)
    if (amount > 0.005) spread(row.id, amount)
  }
  for (const row of offInvoice) {
    const amount = money(row.amount)
    // The extra paid on a replacement is the day's dealing with no line to
    // share it on; collected on account is an old debt. Both sit together.
    if (amount > 0) salesRow(NOT_ON_A_BILL).received += amount
  }

  for (const row of sales.values()) {
    row.name = names.get(row.id) ?? "No category"
    row.actualSales = row.totalSales - row.returns
    row.profit = args.showCost ? row.actualSales - row.actualCost : 0
  }

  // Bought from suppliers, and sent back to them, in the same period.
  const buys = new Map<string, CategoryBuyRow>()
  const buyRow = (id: string) => {
    let row = buys.get(id)
    if (!row) {
      row = { id, name: "", qtyBought: 0, bought: 0, qtySentBack: 0, sentBack: 0, netBought: 0, qtySold: 0 }
      buys.set(id, row)
    }
    return row
  }
  const buyLines: CategoryBuyLine[] = []
  for (const bill of purchases) {
    for (const item of bill.items) {
      const id = keyOf(item.product)
      const row = buyRow(id)
      row.qtyBought += item.quantity
      row.bought += cost(money(item.totalAmount))
      buyLines.push({
        id: item.id,
        categoryId: id,
        purchaseId: bill.id,
        invoice: bill.invoiceNumber,
        date: (bill.receivedDate ?? bill.createdAt).toISOString(),
        supplier: bill.supplier.name,
        shop: bill.branch.code,
        item: itemName(item.product),
        qty: item.quantity,
        unitCost: cost(money(item.costPrice)),
        total: cost(money(item.totalAmount)),
      })
    }
  }
  const sendBackLines: CategorySendBackLine[] = []
  for (const line of sendBacks) {
    const id = keyOf(line.product)
    const row = buyRow(id)
    row.qtySentBack += 1
    row.sentBack += cost(money(line.cost))
    sendBackLines.push({
      id: line.id,
      categoryId: id,
      reference: line.reference,
      purchaseId: line.purchaseId,
      date: line.sentAt.toISOString(),
      supplier: line.supplier.name,
      shop: line.branch.code,
      item: itemName(line.product),
      unit: line.imei.imei1,
      cost: cost(money(line.cost)),
    })
  }
  // Sold beside bought, for every category that bought or sold anything.
  for (const [id, row] of sales) {
    if (id === NOT_ON_A_BILL) continue
    if (row.qty > 0) buyRow(id).qtySold = row.qty
  }
  for (const row of buys.values()) {
    row.name = names.get(row.id) ?? "No category"
    row.netBought = row.bought - row.sentBack
  }

  const byName = <T extends { id: string; name: string }>(a: T, b: T) =>
    Number(a.id.startsWith("__")) - Number(b.id.startsWith("__")) || a.name.localeCompare(b.name)
  buyLines.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.invoice.localeCompare(b.invoice)))
  sendBackLines.sort((a, b) => (a.date < b.date ? 1 : -1))
  returnLines.sort((a, b) => (a.date < b.date ? 1 : -1))

  return {
    sales: [...sales.values()].sort(byName),
    buys: [...buys.values()].sort(byName),
    returnLines,
    buyLines,
    sendBackLines,
  }
}
