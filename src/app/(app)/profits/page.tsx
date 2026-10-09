import { getPriceChanges, getProfitData } from "@/app/actions/finance"
import { PageHeader } from "@/components/shared"
import { ExportCsv } from "@/components/export-csv"
import { formatCurrency, formatDate } from "@/lib/utils"
import { formatCondition } from "@/lib/status"
import { watDayKey } from "@/lib/lagos-day"

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

export default async function ProfitsPage() {
  const [data, priceChanges] = await Promise.all([getProfitData(), getPriceChanges()])
  const givenAway = priceChanges.lines.reduce((sum, row) => sum + row.off, 0)
  const lossMakers = priceChanges.lines.filter((row) => row.belowCost)
  const shopProfit = data.shopLines.reduce((sum, row) => sum + row.profit, 0)
  const net = shopProfit - data.expenses

  const shopCsvRows = [
    ["Invoice", "Shop", "Date", "Product", "Storage", "How it looks", "Color", "Quantity", "Cost price", "Sold for", "Profit"],
    ...data.shopLines.map((row) => [
      row.invoice,
      row.shop,
      formatDate(row.date),
      row.item,
      row.storage ?? "",
      row.condition ? formatCondition(row.condition) : "",
      row.color ?? "",
      String(row.quantity),
      String(row.cost),
      String(row.sell),
      String(row.profit),
    ]),
  ]

  const priceCsvRows = [
    ["Invoice", "Date", "Shop", "Sold by", "Customer", "Item", "Standard", "Charged", "Off", "Off %", "Cost", "Below cost", "Reseller", "Reason", "Approved by"],
    ...priceChanges.lines.map((row) => [
      row.invoice,
      formatDate(row.date),
      row.shop,
      row.soldBy,
      row.customer,
      row.item,
      String(row.list),
      String(row.charged),
      String(row.off),
      String(row.offPercent),
      String(row.cost),
      row.belowCost ? "Yes" : "No",
      row.reseller ? "Yes" : "No",
      row.reason,
      row.approvedBy,
    ]),
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Profit"
        description="Sell price minus cost, after shop bills."
        actions={
          <ExportCsv
            filename={`profit-${watDayKey()}.csv`}
            label="Extract full profit list"
            rows={shopCsvRows}
          />
        }
      />
      <div className="grid gap-4 md:grid-cols-3">
        <div className="surface-card p-5">
          <p className="text-sm text-muted-foreground">Profit from our own stock</p>
          <p className="text-2xl font-semibold">{formatCurrency(shopProfit)}</p>
        </div>
        <div className="surface-card p-5">
          <p className="text-sm text-muted-foreground">Approved shop bills</p>
          <p className="text-2xl font-semibold">{formatCurrency(data.expenses)}</p>
        </div>
        <div className="surface-card p-5">
          <p className="text-sm text-muted-foreground">What is left</p>
          <p className="text-2xl font-semibold">{formatCurrency(net)}</p>
        </div>
      </div>
      {data.byShop.length ? (
        <div className="surface-card overflow-hidden">
          <h3 className="border-b border-border px-5 py-4 font-semibold">Profit by shop</h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="text-left text-foreground/80">
                <tr className="border-b border-border bg-muted/40">
                  <th className="px-5 py-3 font-semibold">Shop</th>
                  <th className="px-3 py-3 font-semibold">Our stock</th>
                  <th className="px-3 py-3 font-semibold">Shop bills</th>
                  <th className="px-5 py-3 font-semibold">Left for this shop</th>
                </tr>
              </thead>
              <tbody>
                {data.byShop.map((row) => (
                  <tr key={row.name} className="border-b border-border/70">
                    <td className="px-5 py-3">{row.name}</td>
                    <td className="px-3 py-3">{formatCurrency(row.shopProfit)}</td>
                    <td className="px-3 py-3">{formatCurrency(row.expenses)}</td>
                    <td className="px-5 py-3 font-semibold">{formatCurrency(row.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="surface-card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-4">
          <h3 className="font-semibold">Sales from our own stock</h3>
          <ExportCsv
            filename={`own-stock-margins-${watDayKey()}.csv`}
            label="Extract this list"
            rows={shopCsvRows}
          />
        </div>
        {data.shopLines.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">No sales from our own stock in this period yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="text-left text-foreground/80">
                <tr className="border-b border-border bg-muted/40">
                  <th className="px-5 py-3 font-semibold">Invoice</th>
                  <th className="px-3 py-3 font-semibold">Phone / item</th>
                  <th className="px-3 py-3 font-semibold">Cost price</th>
                  <th className="px-3 py-3 font-semibold">Sold for</th>
                  <th className="px-5 py-3 font-semibold">Profit</th>
                </tr>
              </thead>
              <tbody>
                {data.shopLines.slice(0, 40).map((row) => (
                  <tr key={row.id} className="border-b border-border/70">
                    <td className="px-5 py-3">
                      {row.invoice}
                      <p className="text-muted-foreground">{row.shop} · {formatDate(row.date)}</p>
                    </td>
                    <td className="px-3 py-3">
                      <p className="font-semibold text-foreground">{productLine(row)}</p>
                    </td>
                    <td className="px-3 py-3 tabular-nums font-medium">{formatCurrency(row.cost)}</td>
                    <td className="px-3 py-3 tabular-nums">{formatCurrency(row.sell)}</td>
                    <td className="px-5 py-3 tabular-nums font-semibold text-success">{formatCurrency(row.profit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="surface-card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-4">
          <div>
            <h3 className="font-semibold">Price changes</h3>
            <p className="text-sm text-muted-foreground">
              Every line sold for less than the standard price. {formatCurrency(givenAway)} given away
              {lossMakers.length > 0 ? `, ${lossMakers.length} sold below cost` : ""}.
            </p>
          </div>
          {priceChanges.lines.length > 0 ? (
            <ExportCsv
              filename={`price-changes-${watDayKey()}.csv`}
              label="Extract this list"
              rows={priceCsvRows}
            />
          ) : null}
        </div>
        {priceChanges.lines.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">
            Nothing has been sold below its standard price yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="text-left text-foreground/80">
                <tr className="border-b border-border bg-muted/40">
                  <th className="px-5 py-3 font-semibold">Invoice</th>
                  <th className="px-3 py-3 font-semibold">Item</th>
                  <th className="px-3 py-3 font-semibold">Standard</th>
                  <th className="px-3 py-3 font-semibold">Charged</th>
                  <th className="px-3 py-3 font-semibold">Off</th>
                  <th className="px-5 py-3 font-semibold">Why</th>
                </tr>
              </thead>
              <tbody>
                {priceChanges.lines.slice(0, 60).map((row) => (
                  <tr key={row.id} className="border-b border-border/70">
                    <td className="px-5 py-3">
                      {row.invoice}
                      <p className="text-muted-foreground">
                        {row.shop} · {formatDate(row.date)} · {row.soldBy}
                      </p>
                    </td>
                    <td className="px-3 py-3">
                      <p className="font-semibold text-foreground">{row.item}</p>
                      <p className="text-muted-foreground">
                        {row.customer}
                        {row.reseller ? " · reseller" : ""}
                      </p>
                    </td>
                    <td className="px-3 py-3 tabular-nums text-muted-foreground">{formatCurrency(row.list)}</td>
                    <td className="px-3 py-3 tabular-nums font-medium">{formatCurrency(row.charged)}</td>
                    <td className="px-3 py-3 tabular-nums">
                      {formatCurrency(row.off)}
                      {row.offPercent > 0 ? (
                        <p className="text-muted-foreground">{row.offPercent}%</p>
                      ) : null}
                    </td>
                    <td className="px-5 py-3">
                      {row.belowCost ? (
                        <p className="font-medium text-danger">Below cost {formatCurrency(row.cost)}</p>
                      ) : null}
                      <p className={row.reason ? "" : "text-muted-foreground"}>
                        {row.reason || row.orderDiscountReason || "No reason recorded"}
                      </p>
                      {row.orderDiscount > 0 ? (
                        <p className="text-muted-foreground">
                          Whole order also had {formatCurrency(row.orderDiscount)} off
                        </p>
                      ) : null}
                      {row.approvedBy ? (
                        <p className="text-muted-foreground">Approved by {row.approvedBy}</p>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
