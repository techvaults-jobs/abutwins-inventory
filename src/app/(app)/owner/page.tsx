import { redirect } from "next/navigation"
import { MOVE_WORDS } from "@/lib/stock-moves"
import { getOwnerBoard } from "@/app/actions/owner-board"
import { DaysOfCover, SalesTrend, StockValueByCategory, TopSellers } from "@/components/owner-charts"
import { ExportCsv } from "@/components/export-csv"
import { PageHeader, StatCard } from "@/components/shared"
import { formatWatLong } from "@/lib/lagos-day"
import { getProducts } from "@/app/actions/catalog"
import { PricesPanel } from "./prices-panel"
import { isShopOwner } from "@/lib/rbac"
import { requireUser } from "@/lib/session"
import { formatCurrency, money } from "@/lib/utils"
import { UpdatedStamp } from "@/components/updated-stamp"

export const dynamic = "force-dynamic"

/**
 * The two bands the board works in, shared with the chart so the headline count
 * and the colours on the bars can never tell different stories.
 * Under 3 days is red; under 10 is amber.
 */
const ORDER_TODAY_DAYS = 3
const ORDER_SOON_DAYS = 10


/** The owner's figures, on the same tile as every other screen: ink, one lead. */
function Figure({
  label,
  value,
  hint,
  tone = "neutral",
  lead = false,
}: {
  label: string
  value: string
  hint?: string
  tone?: "neutral" | "good" | "warning"
  lead?: boolean
}) {
  return <StatCard label={label} value={value} hint={hint} tone={tone === "warning" ? "warning" : "neutral"} lead={lead} />
}

export default async function OwnerBoardPage() {
  const board = await getOwnerBoard()
  if (!board) redirect("/dashboard")
  // The price desk, with cost and margin on every item: the CEO and the main
  // admin. A branch manager also changes prices, from the price list.
  const priceItems = isShopOwner((await requireUser()).role)
    ? (await getProducts()).map((product) => ({
        id: product.id,
        name: [product.name, product.storage, product.color].filter(Boolean).join(" · "),
        sku: product.sku,
        brand: product.brand.name,
        category: product.category.name,
        units: product.inventory.reduce((sum, row) => sum + row.quantity, 0),
        costPrice: money(product.costPrice),
        minimumPrice: money(product.minimumPrice),
        sellingPrice: money(product.sellingPrice),
      }))
    : null

  const { totals } = board
  // What we kept and what things cost are for the profit roles. The server has
  // already zeroed them for anyone else; this hides where they would show.
  const showProfit = board.canSeeProfit
  const profitToday = totals.soldValue - totals.soldCost
  const orderSoon = board.reorder.filter(
    (row) => row.daysLeft !== null && row.daysLeft <= ORDER_SOON_DAYS
  )
  const orderToday = orderSoon.filter((row) => (row.daysLeft as number) <= ORDER_TODAY_DAYS)
  const coverChart = board.reorder
    .filter((row) => row.daysLeft !== null)
    .slice(0, 10)
    .map((row) => ({
      item: row.item.length > 26 ? `${row.item.slice(0, 25)}…` : row.item,
      daysLeft: row.daysLeft as number,
      inShop: row.inShop,
      soldPerDay: row.soldPerDay,
    }))
  // Why stock moved today, biggest first, in the shop's own words.
  const movementTotals = new Map<string, number>()
  for (const shop of board.shops) {
    for (const row of shop.byKind) {
      movementTotals.set(row.kind, (movementTotals.get(row.kind) ?? 0) + row.quantity)
    }
  }
  const movementWords = [...movementTotals.entries()]
    .filter(([, qty]) => qty !== 0)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([kind, qty]) => `${MOVE_WORDS[kind] ?? kind} ${qty > 0 ? "+" : "−"}${Math.abs(qty)}`)

  const topChart = board.topSellers.map((row) => ({
    item: row.item.length > 26 ? `${row.item.slice(0, 25)}…` : row.item,
    units: row.units,
  }))

  const soldCsv = [
    ["Invoice", "Shop", "Item", "IMEI", "Customer", "Pieces", "Sold for", ...(showProfit ? ["We kept"] : [])],
    ...board.soldLines.map((row) => [
      row.invoice,
      row.shop,
      row.item,
      row.imei ?? "",
      row.customer,
      String(row.quantity),
      String(row.value),
      ...(showProfit ? [String(row.profit)] : []),
    ]),
  ]
  const orderCsv = [
    ["Item", "Kind", "In shop", "Sells per day", "Days left", `Sold in ${board.rateDays} days`, ...(showProfit ? ["Cost each"] : [])],
    ...board.reorder.map((row) => [
      row.item,
      row.category,
      String(row.inShop),
      String(row.soldPerDay),
      row.daysLeft === null ? "" : String(row.daysLeft),
      String(row.soldInPeriod),
      ...(showProfit ? [String(row.costPrice)] : []),
    ]),
    ...board.soldOut.map((row) => [
      row.item,
      row.category,
      "0",
      "",
      "0",
      String(row.soldInPeriod),
      ...(showProfit ? [""] : []),
    ]),
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Business today"
        description={`${formatWatLong(board.day)} · ${board.allShops ? "every shop" : board.shops[0]?.shop ?? "this shop"}`}
        actions={<UpdatedStamp at={new Date().toISOString()} />}
      />

      {/* What the owner asks first: what is in the shop, what left today. */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Figure
          label="Goods in the shop now"
          value={totals.inShopNow.toLocaleString("en-NG")}
          hint={showProfit ? `Worth ${formatCurrency(board.stockValueTotal)} at cost` : undefined}
        />
        <Figure
          lead
          label="Sold today"
          value={totals.sold.toLocaleString("en-NG")}
          hint={`${formatCurrency(totals.soldValue)} taken`}
        />
        {showProfit ? (
          <Figure
            label="We kept today"
            value={formatCurrency(profitToday)}
            tone={profitToday < 0 ? "warning" : "good"}
            hint={
              totals.soldValue > 0
                ? `${Math.round((profitToday / totals.soldValue) * 1000) / 10}% of what we sold`
                : "Nothing sold yet today"
            }
          />
        ) : (
          <Figure label="Came in today" value={totals.cameIn.toLocaleString("en-NG")} hint="Pieces booked onto the shelf" />
        )}
        <Figure
          label="Running out"
          value={String(orderSoon.length)}
          tone={orderSoon.length > 0 ? "warning" : "good"}
          hint={
            orderToday.length > 0
              ? `${orderToday.length} finish within ${ORDER_TODAY_DAYS} days`
              : `Under ${ORDER_SOON_DAYS} days of stock left`
          }
        />
      </div>

      {/* The owner's own sentence: opened with 70, sold 5, 65 left. */}
      <div className="surface-card p-5">
        <h3 className="font-semibold">How the shop moved today</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Every change to a shelf is written down as it happens, so this line is a record of the
          day rather than a guess at it.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-3 text-sm">
          {totals.reconciles ? (
            <>
              <span className="rounded-lg bg-muted px-3 py-2">
                Opened with <span className="font-semibold tabular-nums">{totals.openedWith}</span>
              </span>
              <span className="text-muted-foreground">+</span>
            </>
          ) : null}
          <span className="rounded-lg bg-muted px-3 py-2">
            Came in <span className="font-semibold tabular-nums">{totals.cameIn}</span>
          </span>
          <span className="text-muted-foreground">−</span>
          <span className="rounded-lg bg-muted px-3 py-2">
            Sold <span className="font-semibold tabular-nums">{totals.sold}</span>
          </span>
          {totals.movedOut > 0 ? (
            <>
              <span className="text-muted-foreground">−</span>
              <span className="rounded-lg bg-muted px-3 py-2">
                Moved to another shop{" "}
                <span className="font-semibold tabular-nums">{totals.movedOut}</span>
              </span>
            </>
          ) : null}
          <span className="text-muted-foreground">=</span>
          <span className="rounded-lg bg-primary-soft px-3 py-2 font-semibold text-primary">
            {totals.inShopNow} in the shop now
          </span>
        </div>

        {movementWords.length > 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            {movementWords.join(" · ")}
          </p>
        ) : null}

        {!totals.reconciles ? (
          <p className="mt-3 rounded-lg bg-warning-soft px-4 py-3 text-sm text-warning">
            What the shop opened with does not add up for this day. This should not happen now
            that every move is written down, so it points at stock changed outside the system.
            The figures above are each counted from their own record and are still right.
          </p>
        ) : null}

        {board.shops.length > 1 ? (
          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="text-left text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-2 font-medium">Shop</th>
                  <th className="py-2 text-right font-medium">Opened with</th>
                  <th className="py-2 text-right font-medium">Came in</th>
                  <th className="py-2 text-right font-medium">Sold</th>
                  <th className="py-2 text-right font-medium">In shop now</th>
                  <th className="py-2 text-right font-medium">Money taken</th>
                </tr>
              </thead>
              <tbody>
                {board.shops.map((row) => (
                  <tr key={row.branchId} className="border-b border-border/60">
                    <td className="py-2">{row.shop}</td>
                    <td className="py-2 text-right tabular-nums">
                      {row.openedWith ?? <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="py-2 text-right tabular-nums">{row.cameIn}</td>
                    <td className="py-2 text-right tabular-nums">{row.sold}</td>
                    <td className="py-2 text-right font-semibold tabular-nums">{row.inShopNow}</td>
                    <td className="py-2 text-right tabular-nums">{formatCurrency(row.soldValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {priceItems ? <PricesPanel items={priceItems} /> : null}

      {/* Money taken per day. One measure, one line. */}
      <div className="surface-card p-5">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h3 className="font-semibold">Money taken, last {board.trendDays} days</h3>
            <p className="text-sm text-muted-foreground">
              {showProfit ? "Hover any day to see the pieces sold and what the shop kept." : "Hover any day to see the pieces sold."}
            </p>
          </div>
          <p className="text-sm tabular-nums text-muted-foreground">
            {formatCurrency(board.trend.reduce((sum, row) => sum + row.value, 0))} over the period
          </p>
        </div>
        <SalesTrend data={board.trend} showProfit={showProfit} />
      </div>

      {/* The reorder list — the whole point of the board. */}
      <div className="surface-card p-5">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h3 className="font-semibold">What to order next</h3>
            <p className="text-sm text-muted-foreground">
              Days left is what is in the shop divided by how fast it has sold over the last{" "}
              {board.rateDays} days. Red finishes within {ORDER_TODAY_DAYS} days, amber within{" "}
              {ORDER_SOON_DAYS}.
            </p>
          </div>
          {board.reorder.length > 0 ? (
            <ExportCsv
              filename={`order-list-${board.day}.csv`}
              label="Extract the order list"
              rows={orderCsv}
            />
          ) : null}
        </div>
        {coverChart.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing has sold in the last {board.rateDays} days, so there is no sell rate to work from yet.
          </p>
        ) : (
          <DaysOfCover
            data={coverChart}
            orderTodayDays={ORDER_TODAY_DAYS}
            orderSoonDays={ORDER_SOON_DAYS}
          />
        )}

        {board.soldOut.length > 0 ? (
          <div className="mt-4 rounded-lg bg-warning-soft px-4 py-3">
            <p className="text-sm font-medium text-warning">
              {board.soldOut.length} item{board.soldOut.length === 1 ? "" : "s"} sold in the last{" "}
              {board.rateDays} days and are now finished
            </p>
            <p className="mt-1 text-xs text-warning">
              {board.soldOut
                .slice(0, 6)
                .map((row) => row.item)
                .join(" · ")}
              {board.soldOut.length > 6 ? ` and ${board.soldOut.length - 6} more` : ""}
            </p>
          </div>
        ) : null}
      </div>

      <div className={`grid gap-4 ${showProfit ? "xl:grid-cols-2" : ""}`}>
        <div className="surface-card p-5">
          <h3 className="font-semibold">Best sellers, last {board.rateDays} days</h3>
          <p className="mb-3 text-sm text-muted-foreground">Pieces sold. These are what to keep deep.</p>
          {topChart.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing sold in this period yet.</p>
          ) : (
            <TopSellers data={topChart} />
          )}
        </div>
        {showProfit ? (
        <div className="surface-card p-5">
          <h3 className="font-semibold">Where the money is sitting</h3>
          <p className="mb-3 text-sm text-muted-foreground">
            Value at cost of what is on the shelf, by kind of goods.
          </p>
          {board.stockValue.length === 0 ? (
            <p className="text-sm text-muted-foreground">The shop has no stock on the shelf.</p>
          ) : (
            <StockValueByCategory data={board.stockValue.slice(0, 8)} />
          )}
        </div>
        ) : null}
      </div>

      {/* The goods that actually left today, by name. */}
      <div className="surface-card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-4">
          <div>
            <h3 className="font-semibold">What left the shop today</h3>
            <p className="text-sm text-muted-foreground">
              {totals.sold} piece{totals.sold === 1 ? "" : "s"} on {board.soldLines.length} line
              {board.soldLines.length === 1 ? "" : "s"}
            </p>
          </div>
          {board.soldLines.length > 0 ? (
            <ExportCsv filename={`sold-${board.day}.csv`} label="Extract this list" rows={soldCsv} />
          ) : null}
        </div>
        {board.soldLines.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">Nothing has been sold today yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="text-left text-muted-foreground">
                <tr className="border-b border-border bg-muted/40">
                  <th className="px-5 py-3 font-medium">Item</th>
                  <th className="px-3 py-3 font-medium">Buyer</th>
                  <th className="px-3 py-3 text-right font-medium">Pieces</th>
                  <th className="px-3 py-3 text-right font-medium">Sold for</th>
                  {showProfit ? <th className="px-5 py-3 text-right font-medium">We kept</th> : null}
                </tr>
              </thead>
              <tbody>
                {board.soldLines.map((row) => (
                  <tr key={row.id} className="border-b border-border/60">
                    <td className="px-5 py-3">
                      <p className="font-medium">{row.item}</p>
                      <p className="text-xs text-muted-foreground">
                        {row.invoice} · {row.shop}
                        {row.imei ? ` · ${row.imei}` : ""}
                      </p>
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">{row.customer}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{row.quantity}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{formatCurrency(row.value)}</td>
                    {showProfit ? (
                      <td
                        className={`px-5 py-3 text-right tabular-nums ${
                          row.profit < 0 ? "font-medium text-danger" : ""
                        }`}
                      >
                        {formatCurrency(row.profit)}
                      </td>
                    ) : null}
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
