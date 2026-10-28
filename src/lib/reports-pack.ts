import type { PaperCompany } from "@/lib/letterhead"

export type ReportsPack = {
  company: PaperCompany
  scope: string
  preparedAt: string
  preparedBy: string
  statementRef: string
  periodLabel: string
  range: "day" | "week" | "month" | "custom"
  /**
   * What the stock figure is worth at. Cost for the CEO; at sell price for
   * everyone else, who may not see what items cost us.
   */
  stockBasis: "cost" | "sell"
  from: string
  to: string
  compare: {
    from: string
    to: string
    revenue: number
    collected: number
    expenses: number
  }
  /** Work on the Swap Deal and Returns screens not finished yet, and credit from this period's sales. */
  waiting: { swaps: number; swapBalance: number; returns: number; returnValue: number; periodDue: number }
  /** Money in this period split: on this period's sales, and debts collected on earlier ones. */
  receipts: { onPeriodSales: number; debtsCollected: number }
  totals: {
    /** Gross: every invoice in the period, as written. */
    revenue: number
    /** Value taken back on refunds and credit notes finished in the period. */
    salesReturns: number
    collected: number
    expenses: number
    stock: number
    invoices: number
    /** Everything customers owe now, whatever the period. */
    owing: number
    /** Trade-in value of swaps finished in the period. */
    swaps: number
    /** Money customers paid on top on those swaps. */
    swapBalance: number
    returns: number
  }
  /**
   * One row per shop. `cost` is what the items on those invoices cost us,
   * from the cost copied onto each line at checkout; 0 for anyone who may not
   * see cost (stockBasis "sell").
   */
  byShop: Array<{
    id: string
    code: string
    name: string
    /** Invoices in the period. */
    tickets: number
    /** Items on those invoices (pieces, phones count one each). */
    items: number
    /** Total sales: the invoices as written. */
    revenue: number
    /** Cost of everything on those invoices (0 for a role that may not see cost). */
    cost: number
    collected: number
    /** Refunds and credit notes finished in the period: what was taken back. */
    returns: number
    returnedItems: number
    /** What the returned items cost us when sold. */
    returnCost: number
  }>
  debtors: Array<{ id: string; name: string; shop: string; amount: number }>
  creditors: Array<{ id: string; invoice: string; supplier: string; shop: string; owed: number }>
  supplierCredits: Array<{ id: string; invoice: string; supplier: string; shop: string; owed: number }>
  lowStock: Array<{ id: string; product: string; shop: string; quantity: number; min: number }>
  /** Returns outward in the period, grouped by supplier. */
  supplierReturns?: Array<{
    supplier: string
    units: number
    value: number
    lines: Array<{ reference: string; item: string; imei: string; shop: string; value: number }>
  }>
}

export function reportsKpis(data: ReportsPack) {
  return [
    { label: "Total sales", value: data.totals.revenue, money: true },
    { label: "Sales returns", value: data.totals.salesReturns, money: true },
    { label: "Net sales", value: data.totals.revenue - data.totals.salesReturns, money: true },
    { label: "Total payments received", value: data.totals.collected, money: true },
    { label: "Approved expenses", value: data.totals.expenses, money: true },
    { label: data.stockBasis === "cost" ? "Stock at cost" : "Stock at sell price", value: data.totals.stock, money: true },
    { label: "Customers still owe, in total", value: data.totals.owing, money: true },
    { label: "Swap Deal value", value: data.totals.swaps, money: true },
  ]
}

/**
 * Sales by shop, from the invoices to what really happened: the client asked
 * that what customers returned comes off, and that the cost is the cost of
 * those actual sales. Total sales less refunds and credit notes finished in
 * the period is the actual sales; the cost of what was sold less the cost of
 * what came back is the cost of the actual sales. One shop's line, or several
 * added up (the All shops line).
 */
export function shopActuals(rows: ReportsPack["byShop"]) {
  const sum = (pick: (row: ReportsPack["byShop"][number]) => number) => rows.reduce((total, row) => total + pick(row), 0)
  const revenue = sum((row) => row.revenue)
  const returns = sum((row) => row.returns ?? 0)
  const cost = sum((row) => row.cost)
  const returnCost = sum((row) => row.returnCost ?? 0)
  const actualSales = revenue - returns
  const actualCost = cost - returnCost
  return {
    invoices: sum((row) => row.tickets),
    items: sum((row) => row.items ?? 0),
    revenue,
    returns,
    returnedItems: sum((row) => row.returnedItems ?? 0),
    actualSales,
    cost,
    returnCost,
    actualCost,
    profit: actualSales - actualCost,
    collected: sum((row) => row.collected),
  }
}
