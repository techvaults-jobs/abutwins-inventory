import type { PaperCompany } from "@/lib/letterhead"

export type ReportsPack = {
  company: PaperCompany
  scope: string
  preparedAt: string
  preparedBy: string
  statementRef: string
  periodLabel: string
  range: "day" | "week" | "month"
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
  byShop: Array<{ id: string; code: string; name: string; tickets: number; revenue: number; cost: number; collected: number }>
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
