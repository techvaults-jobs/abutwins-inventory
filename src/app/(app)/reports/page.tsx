import { getReportData } from "@/app/actions/finance"
import { prisma } from "@/lib/prisma"
import { returnedSaleLineIds, returnedValueBySale } from "@/lib/returned-value"
import { lineValueAfterOrderDiscount } from "@/lib/sale-money"
import { shopConditionLabel } from "@/lib/conditions"
import { getOpeningReport } from "@/app/actions/opening-stock"
import { getBranches } from "@/app/actions/parties"
import { PageHeader } from "@/components/shared"
import { formatWatLong, shopPeriodWindow, watDayKey, type ShopRange } from "@/lib/lagos-day"
import type { ReportsPack } from "@/lib/reports-pack"
import { getAppSettings } from "@/lib/settings"
import { requireUser } from "@/lib/session"
import { money } from "@/lib/utils"
import { receiptsInWindow } from "@/lib/receipts"
import { plainMoney } from "@/lib/plain"
import { canSeeCost } from "@/lib/rbac"
import { isLowStock, shelfKey } from "@/lib/stock-limits"
import { stockedPairs } from "@/lib/stocked-pairs"
import { ReportsClientView } from "./reports-client-view"
import { SupplierReturnsReport } from "./supplier-returns-report"
import { getSupplierReturnsReport } from "@/app/actions/supplier-returns"

function shopOf(branch: { name: string; code: string }) {
  return { name: branch.name, code: branch.code }
}

function asRange(value?: string): ShopRange {
  return value === "week" || value === "day" ? value : "month"
}

function periodLabel(range: ShopRange, from: string, to: string) {
  if (range === "day") return formatWatLong(from)
  return `${formatWatLong(from)} to ${formatWatLong(to)}`
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ branchId?: string; range?: string; date?: string }>
}) {
  const params = await searchParams
  const selectedBranchId = params.branchId || undefined
  const range = asRange(params.range)
  const date = params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : watDayKey()

  const [data, settings, user, branches, opening, supplierReturns] = await Promise.all([
    getReportData(selectedBranchId, range, date),
    getAppSettings(),
    requireUser(),
    getBranches(),
    getOpeningReport(selectedBranchId),
    getSupplierReturnsReport(selectedBranchId, range, date),
  ])

  const revenue = data.sales.reduce((sum, sale) => sum + money(sale.totalAmount), 0)
  // What returns already cleared on each invoice, so its balance reads true.
  const returnedOnSales = await returnedValueBySale(prisma, data.sales.map((sale) => sale.id))
  // Money in by the day it arrived (see receiptsInWindow), matching the till.
  const collected = data.receipts.total
  const expense = data.expenses.reduce((sum, row) => sum + money(row.amount), 0)
  // Stock is valued at cost for the CEO and at sell price for everyone else.
  const showCost = canSeeCost(user.role)
  const stock = data.inventory.reduce(
    (sum, row) => sum + row.quantity * money(showCost ? row.product.costPrice : row.product.sellingPrice),
    0
  )
  // Swap Deal value is the trade-in value of the swaps finished in the period,
  // the same figure as the list's "Swap Deal Value" column. The money the
  // customers paid on top (the balance) is shown beside it.
  const finishedSwaps = data.swaps.filter((row) => row.status === "COMPLETED")
  const swapValue = finishedSwaps.reduce((sum, row) => sum + money(row.tradeValue), 0)
  const swapBalance = finishedSwaps.reduce((sum, row) => sum + money(row.balanceAmount), 0)
  const owing = data.debtors.reduce((sum, row) => sum + money(row.currentBalance), 0)
  // Only lines this shop carries; an item it never stocked is not "low" there.
  const stocked = await stockedPairs(selectedBranchId)
  const lowStock = data.inventory.filter((row) =>
    isLowStock(
      { ...row, everStocked: row.quantity > 0 || stocked.has(shelfKey(row.productId, row.branchId)) },
      settings.lowStockThreshold
    )
  )

  // Every item on the period's invoices, for Total cost and for the list that
  // opens when a shop on Sales by shop is clicked. Cost is the one copied onto
  // the line at checkout (older lines carry 0 and fall back to today's cost,
  // as Profit does), and only goes out to someone who may see cost.
  const [saleLines, returnedLines] = await Promise.all([
    data.sales.length
      ? prisma.saleItem.findMany({
          where: { saleId: { in: data.sales.map((sale) => sale.id) } },
          select: {
            id: true,
            saleId: true,
            imeiId: true,
            quantity: true,
            unitPrice: true,
            totalPrice: true,
            costPrice: true,
            product: { select: { name: true, storage: true, condition: true, costPrice: true } },
            imei: { select: { imei1: true, serialNumber: true } },
          },
        })
      : Promise.resolve([]),
    returnedSaleLineIds(prisma),
  ])
  const saleById = new Map(data.sales.map((sale) => [sale.id, sale]))
  const shopLines = saleLines.flatMap((line) => {
    const sale = saleById.get(line.saleId)
    if (!sale) return []
    const unitCost = showCost ? money(line.costPrice) || money(line.product.costPrice) : 0
    return [
      {
        id: line.id,
        saleId: sale.id,
        invoice: sale.invoiceNumber,
        date: sale.saleDate.toISOString(),
        customer: sale.customer?.name ?? "Walk-in",
        shopId: sale.branch.id,
        shop: sale.branch.code,
        item: [line.product.name, line.product.storage, shopConditionLabel(line.product.condition)].filter(Boolean).join(" · "),
        unit: line.imei ? line.imei.imei1 || line.imei.serialNumber || "" : "",
        quantity: line.quantity,
        unitPrice: money(line.unitPrice),
        // What the line fetched once the whole-order discount is shared out,
        // so a shop's lines add up to its Total sales.
        sold: lineValueAfterOrderDiscount(line.totalPrice, sale),
        cost: unitCost * line.quantity,
        returned:
          returnedLines.saleItemIds.has(line.id) ||
          (line.imeiId ? returnedLines.imeiOnSale.has(`${sale.id}:${line.imeiId}`) : false),
      },
    ]
  })
  shopLines.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.invoice.localeCompare(b.invoice)))

  const shopRows = data.sales.reduce<
    Record<string, { id: string; code: string; name: string; revenue: number; cost: number; collected: number; tickets: number }>
  >((acc, sale) => {
    const key = sale.branch.id
    acc[key] = acc[key] ?? { id: key, code: sale.branch.code, name: sale.branch.name, revenue: 0, cost: 0, collected: 0, tickets: 0 }
    acc[key].revenue += money(sale.totalAmount)
    acc[key].tickets += 1
    return acc
  }, {})
  for (const line of shopLines) {
    if (shopRows[line.shopId]) shopRows[line.shopId].cost += line.cost
  }
  // Money in per shop on the same footing as the total: by the day it arrived.
  const shopWindow = shopPeriodWindow(data.period.from, range)
  await Promise.all(
    Object.entries(shopRows).map(async ([shopId, row]) => {
      row.collected = (await receiptsInWindow({ branchId: shopId, start: shopWindow.start, end: shopWindow.end })).total
    })
  )
  const byShop = Object.values(shopRows).sort((a, b) => b.revenue - a.revenue)

  const selectedBranch = branches.find((b) => b.id === selectedBranchId)
  const scope = selectedBranch ? `${selectedBranch.name} (${selectedBranch.code})` : "All shops together"
  const label = periodLabel(range, data.period.from, data.period.to)

  const pack: ReportsPack = {
    company: {
      name: settings.companyName,
      product: settings.productName,
      phone: settings.companyPhone,
      address: settings.companyAddress,
      email: settings.companyEmail,
      logo: settings.companyLogo,
      footer: settings.companyFooter,
    },
    scope,
    preparedAt: new Date().toISOString(),
    preparedBy: user.name || user.email,
    statementRef: `RP-${selectedBranch ? selectedBranch.code : "ALL"}-${range.toUpperCase()}-${data.period.from.replaceAll("-", "")}`,
    periodLabel: label,
    range,
    stockBasis: showCost ? "cost" : "sell",
    from: data.period.from,
    to: data.period.to,
    compare: data.prior,
    waiting: data.waiting,
    receipts: { onPeriodSales: data.receipts.onPeriodSales, debtsCollected: data.receipts.debtsCollected },
    totals: {
      revenue,
      salesReturns: data.salesReturns,
      collected,
      expenses: expense,
      stock,
      invoices: data.sales.length,
      owing,
      swaps: swapValue,
      swapBalance,
      returns: data.loggedReturns,
    },
    byShop,
    debtors: data.debtors.map((row) => ({
      id: row.id,
      name: row.name,
      shop: row.branch.code,
      amount: money(row.currentBalance),
    })),
    creditors: data.creditors.map((row) => ({
      id: row.id,
      invoice: row.invoiceNumber,
      supplier: row.supplier,
      shop: row.branch,
      owed: row.owed,
    })),
    supplierCredits: (data.supplierCredits ?? []).map((row) => ({
      id: row.id,
      invoice: row.invoiceNumber,
      supplier: row.supplier,
      shop: row.branch,
      owed: row.owed,
    })),
    supplierReturns: Object.values(
      supplierReturns.rows.reduce<
        Record<string, { supplier: string; units: number; value: number; lines: Array<{ reference: string; item: string; imei: string; shop: string; value: number }> }>
      >((acc, row) => {
        const entry = (acc[row.supplier] ??= { supplier: row.supplier, units: 0, value: 0, lines: [] })
        entry.units += 1
        entry.value += row.value
        entry.lines.push({ reference: row.reference, item: row.item, imei: row.imei, shop: row.shopCode, value: row.value })
        return acc
      }, {})
    ).sort((a, b) => b.value - a.value),
    lowStock: lowStock.map((row) => ({
      id: row.id,
      product: row.product.name,
      shop: row.branch.code,
      quantity: row.quantity,
      min: row.minStock,
    })),
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description={`Sales, money in, stock, and who still owes for ${label}.`}
      />
      <ReportsClientView
        pack={pack}
        // Only the fields the report reads. The rows arrive with their line
        // items, payments and full shop and customer records attached, which
        // made a month's report several megabytes on a phone.
        sales={data.sales.map((row) => ({
          id: row.id,
          invoiceNumber: row.invoiceNumber,
          totalAmount: money(row.totalAmount),
          paidAmount: money(row.paidAmount),
          returned: returnedOnSales.get(row.id) ?? 0,
          saleDate: row.saleDate,
          customer: row.customer ? { name: row.customer.name } : null,
          branch: shopOf(row.branch),
        }))}
        expenses={data.expenses.map((row) => ({
          id: row.id,
          expenseNumber: row.expenseNumber,
          category: row.category,
          amount: money(row.amount),
          description: row.description,
          date: row.date,
          branch: shopOf(row.branch),
        }))}
        inventory={data.inventory.map((row) => ({
          id: row.id,
          quantity: row.quantity,
          product: {
            name: row.product.name,
            costPrice: showCost ? money(row.product.costPrice) : 0,
            sellingPrice: money(row.product.sellingPrice),
          },
          branch: shopOf(row.branch),
        }))}
        swaps={data.swaps.map((row) => ({
          id: row.id,
          swapNumber: row.swapNumber,
          tradeValue: money(row.tradeValue),
          balanceAmount: money(row.balanceAmount),
          newProductPrice: money(row.newProductPrice),
          status: row.status,
          createdAt: row.completedAt ?? row.createdAt,
          customer: row.customer ? { name: row.customer.name } : null,
          newProduct: row.newProduct ? { name: row.newProduct.name } : null,
          branch: shopOf(row.branch),
        }))}
        returns={data.returns.map((row) => ({
          id: row.id,
          returnNumber: row.returnNumber,
          reason: row.reason,
          outcome: row.outcome,
          faultClass: row.faultClass,
          status: row.status,
          // The value that came back, as Sales returns counts it.
          refundAmount: money(row.returnValue) || money(row.refundAmount),
          createdAt: row.createdAt,
          customer: row.customer ? { name: row.customer.name } : null,
          branch: shopOf(row.branch),
          imei: row.imei ? { imei1: row.imei.imei1, product: { name: row.imei.product.name } } : null,
        }))}
        shopLines={shopLines}
        opening={plainMoney(opening)}
        branches={branches.map(({ id, name, code }) => ({ id, name, code }))}
        selectedBranchId={selectedBranchId}
        range={range}
        date={date}
      />
      {/* Returns outward: what went back to which supplier, how many, and the value. */}
      <SupplierReturnsReport rows={supplierReturns.rows} periodLabel={label} />
    </div>
  )
}

