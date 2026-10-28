import { getPriceChanges, getProfitData } from "@/app/actions/finance"
import { PageHeader } from "@/components/shared"
import { formatCondition } from "@/lib/status"
import { asReportRange, formatWatLong, isWatDayKey, watDayKey } from "@/lib/lagos-day"
import { ProfitView, type ProfitLine } from "./profit-view"

function productLine(row: {
  item: string
  storage?: string | null
  condition?: string | null
  color?: string | null
}) {
  return [row.item, row.storage, row.condition ? formatCondition(row.condition) : null, row.color]
    .filter(Boolean)
    .join(" · ")
}

export default async function ProfitsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; date?: string; from?: string }>
}) {
  const params = await searchParams
  // The client asked to see profit for a chosen period, from any day to any
  // day, the same choices as Reports. This month so far opens, as on Reports,
  // so the two screens can be read side by side; All time is one pick away.
  const range = params.range === "all" ? "all" : asReportRange(params.range)
  const date = params.date && isWatDayKey(params.date) ? params.date : watDayKey()
  const from = range === "custom" && params.from && isWatDayKey(params.from) ? params.from : undefined

  const data = await getProfitData(range, date, from)
  const priceChanges = await getPriceChanges(200, data.period)

  const period = data.period
  const periodLabel = !period
    ? "all time, every sale on the system"
    : period.from === period.to
      ? formatWatLong(period.from)
      : `${formatWatLong(period.from)} to ${formatWatLong(period.to)}`

  const lines: ProfitLine[] = data.shopLines.map((row) => ({
    id: row.id,
    invoice: row.invoice,
    shop: row.shop,
    date: row.date.toISOString(),
    item: productLine(row),
    unit: row.unit,
    quantity: row.quantity,
    cost: row.cost,
    sell: row.sell,
    profit: row.profit,
    costIsSnapshot: row.costIsSnapshot,
  }))

  return (
    <div className="space-y-6">
      <PageHeader title="Profit" description={`What we sold, what it cost us, and what is left after shop bills, for ${periodLabel}.`} />
      <ProfitView
        range={range}
        from={period?.from ?? date}
        date={period?.to ?? date}
        periodLabel={periodLabel}
        lines={lines}
        byShop={data.byShop}
        expenses={data.expenses}
        invoices={data.invoices}
        invoiceTotal={data.invoiceTotal}
        tax={data.tax}
        returnedValue={data.returnedValue}
        mismatched={data.mismatched}
        priceChanges={priceChanges.lines.map((row) => ({ ...row, date: row.date.toISOString() }))}
      />
    </div>
  )
}
