"use client"

import { useEffect, useMemo, useState } from "react"
import { productSpecLine } from "@/lib/product-specs"
import Link from "next/link"
import { AlertTriangle, Coins, FileSpreadsheet, Layers, Printer, TrendingUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/select"
import { DataTable, type DataColumn } from "@/components/data-table"
import { FilterChips } from "@/components/filter-chips"
import { ShopTag, StatCard, StatGrid, TonePill } from "@/components/shared"
import { downloadTable } from "@/lib/download-table"
import { formatCurrency, money } from "@/lib/utils"
import { isLowStock } from "@/lib/stock-limits"
import { formatCondition } from "@/lib/status"
import { SHOP_CONDITION_OPTIONS } from "@/lib/conditions"
import { countByStockCategory, matchesStockCategory, STOCK_CATEGORY_FILTERS } from "@/lib/stock-categories"
import { watDayKey } from "@/lib/lagos-day"

type Branch = { id: string; name: string; code: string }
type InventoryRow = {
  id: string
  productId: string
  branchId: string
  quantity: number
  incomingQty: number
  minStock: number
  /** The shop holds this item or has any stock history for it. */
  everStocked: boolean
  product: {
    id: string
    name: string
    sku: string
    condition: string
    storage?: string | null
    ram?: string | null
    color?: string | null
    costPrice: number
    sellingPrice: number
    minimumPrice: number
    brand: { name: string }
    category: { name: string }
  }
  branch: { id: string; name: string; code: string }
}

type VaultCount = { productId: string; branchId: string; count: number }

/** Mark-up on cost, which is what the shop actually reasons in. */
function marginPct(cost: number, selling: number) {
  return cost > 0 ? ((selling - cost) / cost) * 100 : 0
}

export function InventoryClientView({
  rows,
  branches,
  vault,
  serializedIds,
  lowStockThreshold,
  showCost = false,
}: {
  rows: InventoryRow[]
  branches: Branch[]
  vault: VaultCount[]
  serializedIds: string[]
  lowStockThreshold: number
  /** Cost, profit and value at cost. The CEO's only; for anyone else the rows arrive with cost 0. */
  showCost?: boolean
}) {
  const [selectedBranch, setSelectedBranch] = useState(branches.length === 1 ? branches[0].id : "ALL")
  const [conditionFilter, setConditionFilter] = useState("ALL")
  const [categoryFilter, setCategoryFilter] = useState("ALL")
  const [search, setSearch] = useState("")
  const [stockFilter, setStockFilter] = useState<"ALL" | "LOW" | "GAP">("ALL")
  const serialized = useMemo(() => new Set(serializedIds), [serializedIds])

  const scoped = useMemo(() => {
    const query = search.trim().toLowerCase()
    return rows.filter((row) => {
      if (selectedBranch !== "ALL" && row.branchId !== selectedBranch) return false
      if (conditionFilter !== "ALL" && row.product.condition !== conditionFilter) return false
      if (!query) return true
      return (
        row.product.name.toLowerCase().includes(query) ||
        productSpecLine(row.product).toLowerCase().includes(query) ||
        row.product.sku.toLowerCase().includes(query) ||
        row.product.brand.name.toLowerCase().includes(query) ||
        row.product.category.name.toLowerCase().includes(query)
      )
    })
  }, [rows, selectedBranch, conditionFilter, search])

  /**
   * Counts per fixed category group (Phones, Accessories, Screen, Laptop,
   * Other) — same buckets used on the opening stock page.
   */
  const categoryCounts = useMemo(
    () => countByStockCategory(scoped.map((row) => ({ category: row.product.category.name }))),
    [scoped]
  )

  // A chip only shows while its group has stock behind it. Switching shop can
  // empty the chosen group, which would leave an empty table under a chip that
  // is no longer on screen, so the filter falls back to All.
  useEffect(() => {
    if (categoryFilter === "ALL") return
    if ((categoryCounts[categoryFilter] ?? 0) === 0) setCategoryFilter("ALL")
  }, [categoryCounts, categoryFilter])

  const imeiFor = useMemo(() => {
    const map = new Map<string, number>()
    for (const item of vault) map.set(`${item.productId}:${item.branchId}`, item.count)
    return map
  }, [vault])

  const isLow = (row: InventoryRow) => isLowStock(row, lowStockThreshold)
  const hasGap = (row: InventoryRow) =>
    serialized.has(row.productId) && (imeiFor.get(`${row.productId}:${row.branchId}`) ?? 0) !== row.quantity

  const inCategory = useMemo(
    () => scoped.filter((row) => matchesStockCategory(row.product.category.name, categoryFilter)),
    [scoped, categoryFilter]
  )
  // Rows with nothing on the shelf sink below the ones people came to read;
  // the order within each part is kept.
  const filtered = useMemo(
    () =>
      inCategory
        .filter((row) => (stockFilter === "LOW" ? isLow(row) : stockFilter === "GAP" ? hasGap(row) : true))
        .sort((a, b) => Number(b.quantity > 0) - Number(a.quantity > 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inCategory, stockFilter, imeiFor, serialized, lowStockThreshold]
  )

  const gaps = useMemo(
    () =>
      filtered
        .map((row) => ({ row, imeis: imeiFor.get(`${row.productId}:${row.branchId}`) ?? 0 }))
        .filter((item) => serialized.has(item.row.productId) && item.imeis !== item.row.quantity),
    [filtered, imeiFor, serialized]
  )

  const totals = useMemo(() => {
    const units = filtered.reduce((sum, row) => sum + row.quantity, 0)
    const cost = filtered.reduce((sum, row) => sum + row.quantity * money(row.product.costPrice), 0)
    const sales = filtered.reduce((sum, row) => sum + row.quantity * money(row.product.sellingPrice), 0)
    const lowLines = filtered.filter(isLow).length
    return { units, cost, sales, profit: sales - cost, margin: cost > 0 ? ((sales - cost) / cost) * 100 : 0, lowLines }
  }, [filtered, lowStockThreshold])

  const scopeLabel =
    selectedBranch === "ALL"
      ? "all shops"
      : branches.find((branch) => branch.id === selectedBranch)?.name ?? "this shop"

  /** Same rows, same order, same columns as the table on screen. */
  function tableRows() {
    return [
      [
        "Product name",
        "Item code",
        "Brand",
        "Category",
        "How it looks",
        "Shop",
        ...(showCost ? ["Cost"] : []),
        "Sell price",
        ...(showCost ? ["Profit per unit", "Profit %"] : []),
        "On shelf",
        "On the way",
        "IMEI count",
        ...(showCost ? ["Value at cost"] : []),
        "Value at sell price",
      ],
      ...filtered.map((row) => {
        const cost = money(row.product.costPrice)
        const selling = money(row.product.sellingPrice)
        const imeis = imeiFor.get(`${row.productId}:${row.branchId}`) ?? 0
        return [
          row.product.name,
          row.product.sku,
          row.product.brand.name,
          row.product.category.name,
          row.product.condition.replace(/_/g, " "),
          `${row.branch.name} (${row.branch.code})`,
          ...(showCost ? [cost.toFixed(2)] : []),
          selling.toFixed(2),
          ...(showCost ? [(selling - cost).toFixed(2), `${marginPct(cost, selling).toFixed(1)}%`] : []),
          String(row.quantity),
          String(row.incomingQty),
          serialized.has(row.productId) ? String(imeis) : "No IMEI",
          ...(showCost ? [(row.quantity * cost).toFixed(2)] : []),
          (row.quantity * selling).toFixed(2),
        ]
      }),
    ]
  }

  const COST_COLUMNS = new Set(["cost", "profit"])
  const allColumns: DataColumn<InventoryRow>[] = [
    {
      id: "item",
      header: "Item",
      sortValue: (row) => row.product.name,
      cell: (row) => (
        <div>
          <p className="font-medium">{row.product.name}</p>
          {productSpecLine(row.product) ? <p className="text-xs text-muted-foreground">{productSpecLine(row.product)}</p> : null}
          <Link
            href={`/products/activity/${row.product.id}`}
            onClick={(event) => event.stopPropagation()}
            className="text-xs font-medium text-primary hover:underline"
          >
            Item activity
          </Link>
          <p className="text-xs text-muted-foreground">
            {row.product.brand.name} · {formatCondition(row.product.condition)} · <span className="font-mono">{row.product.sku}</span>
          </p>
        </div>
      ),
    },
    { id: "shop", header: "Shop", sortValue: (row) => row.branch.code, cell: (row) => <ShopTag>{row.branch.code}</ShopTag> },
    {
      id: "cost",
      header: "Cost",
      align: "right",
      hideBelow: "lg",
      sortValue: (row) => money(row.product.costPrice),
      cell: (row) =>
        money(row.product.costPrice) > 0 ? formatCurrency(money(row.product.costPrice)) : <span className="text-muted-foreground">—</span>,
    },
    {
      id: "sell",
      header: "Sell price",
      align: "right",
      sortValue: (row) => money(row.product.sellingPrice),
      cell: (row) =>
        money(row.product.sellingPrice) > 0 ? (
          <span className="font-medium">{formatCurrency(money(row.product.sellingPrice))}</span>
        ) : (
          <TonePill tone="warning">Needs a price</TonePill>
        ),
    },
    {
      id: "profit",
      header: "Profit",
      align: "right",
      hideBelow: "xl",
      sortValue: (row) => marginPct(money(row.product.costPrice), money(row.product.sellingPrice)),
      cell: (row) => {
        const margin = marginPct(money(row.product.costPrice), money(row.product.sellingPrice))
        // No price or no cost yet: there is no margin to judge, so no red pill.
        if (!(money(row.product.sellingPrice) > 0) || !(money(row.product.costPrice) > 0)) {
          return <span className="text-muted-foreground">—</span>
        }
        return (
          <TonePill tone={margin >= 20 ? "success" : margin > 0 ? "warning" : "danger"}>
            {margin > 0 ? "+" : ""}
            {margin.toFixed(1)}%
          </TonePill>
        )
      },
    },
    {
      id: "shelf",
      header: "On shelf",
      align: "center",
      sortValue: (row) => row.quantity,
      cell: (row) => (
        <div>
          <span className={`num font-semibold ${isLow(row) ? "text-danger" : "text-foreground"}`}>{row.quantity}</span>
          {isLow(row) ? <p className="text-[11px] font-medium text-danger">Low stock</p> : null}
        </div>
      ),
    },
    {
      id: "incoming",
      header: "On the way",
      align: "center",
      hideBelow: "xl",
      sortValue: (row) => row.incomingQty,
      cell: (row) => <span className="num text-muted-foreground">{row.incomingQty > 0 ? `+${row.incomingQty}` : "—"}</span>,
    },
    {
      id: "imeis",
      header: "IMEIs",
      align: "center",
      hideBelow: "lg",
      cell: (row) => {
        if (!serialized.has(row.productId)) return <span className="text-xs text-muted-foreground">No IMEI</span>
        const imeis = imeiFor.get(`${row.productId}:${row.branchId}`) ?? 0
        const mismatch = imeis !== row.quantity
        return (
          <div>
            <span className={`num text-sm ${mismatch ? "font-semibold text-warning" : "text-muted-foreground"}`}>{imeis}</span>
            {mismatch ? <p className="text-[11px] font-medium text-warning">Does not match</p> : null}
          </div>
        )
      },
    },
    showCost
      ? {
          id: "value",
          header: "Value at cost",
          align: "right",
          sortValue: (row) => row.quantity * money(row.product.costPrice),
          cell: (row) => <span className="font-semibold">{formatCurrency(row.quantity * money(row.product.costPrice))}</span>,
        }
      : {
          id: "value",
          header: "Value at sell price",
          align: "right",
          sortValue: (row) => row.quantity * money(row.product.sellingPrice),
          cell: (row) => <span className="font-semibold">{formatCurrency(row.quantity * money(row.product.sellingPrice))}</span>,
        },
  ]
  const columns = showCost ? allColumns : allColumns.filter((column) => !COST_COLUMNS.has(column.id))

  const stamp = watDayKey()
  const categorySlug =
    categoryFilter === "ALL"
      ? ""
      : `-${(STOCK_CATEGORY_FILTERS.find((r) => r.key === categoryFilter)?.label ?? categoryFilter).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
  const fileBase = `inventory-ledger-${selectedBranch === "ALL" ? "all-branches" : selectedBranch}${categorySlug}-${stamp}`

  return (
    <div className="space-y-5">
      <StatGrid className="print:hidden">
        <StatCard
          label="Units on the shelf"
          value={totals.units.toLocaleString("en-NG")}
          hint={`${filtered.length} item${filtered.length === 1 ? "" : "s"} in ${scopeLabel}`}
          icon={<Layers className="h-4 w-4" />}
        />
        {showCost ? (
          <StatCard
            label="Value at cost"
            value={formatCurrency(totals.cost)}
            hint="What the phones and items on the shelf cost you."
            icon={<Coins className="h-4 w-4" />}
            tone="primary"
          />
        ) : null}
        <StatCard
          label="Value at sell price"
          value={formatCurrency(totals.sales)}
          hint={showCost ? `If every unit sold at list price: ${formatCurrency(totals.profit)} profit` : "If every unit sold at list price"}
          icon={<TrendingUp className="h-4 w-4" />}
          tone="success"
        />
        <StatCard
          label={showCost ? "Profit %" : "Low stock"}
          value={showCost ? `${totals.margin.toFixed(1)}%` : totals.lowLines.toLocaleString("en-NG")}
          hint={
            totals.lowLines > 0
              ? `${totals.lowLines} item${totals.lowLines === 1 ? "" : "s"} below the low-stock warning`
              : "Every item is above the low-stock warning"
          }
          // As a margin, amber only when it is thin; as a low-stock count, amber when any line is low.
          tone={showCost ? (totals.cost > 0 && totals.margin < 10 ? "warning" : "neutral") : totals.lowLines > 0 ? "warning" : "neutral"}
          icon={<AlertTriangle className="h-4 w-4" />}
        />
      </StatGrid>

      {gaps.length > 0 ? (
        <div className="flex flex-wrap items-start gap-3 rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning print:hidden">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">
              {gaps.length} item{gaps.length === 1 ? "" : "s"} where shop count and IMEI list do not match
            </p>
            <ul className="mt-1 space-y-0.5 text-xs">
              {gaps.slice(0, 4).map((item) => (
                <li key={item.row.id}>
                  {item.row.product.name} · {item.row.branch.name}: shelf {item.row.quantity}, IMEIs{" "}
                  {item.imeis}
                </li>
              ))}
              {gaps.length > 4 ? <li>and {gaps.length - 4} more</li> : null}
            </ul>
            <Link href="/reconciliation" className="mt-1.5 inline-block text-xs font-semibold underline">
              Open Stock count
            </Link>
          </div>
        </div>
      ) : null}

      {/*
        The client did not want the whole group shown at once: "we should be the
        one controlling what we want to view ... it would reduce the time we
        waste sorting out which shop has what."
      */}
      <DataTable
        className="print:hidden"
        rows={filtered}
        columns={columns}
        rowKey={(row) => row.id}
        noun="items"
        filterKey={`${selectedBranch}|${conditionFilter}|${categoryFilter}|${stockFilter}`}
        query={search}
        onQueryChange={setSearch}
        searchText={(row) => [row.product.name, productSpecLine(row.product), row.product.sku, row.product.brand.name, row.product.category.name].join(" ")}
        searchPlaceholder="Find item code, name or brand"
        actions={
          <>
            <Button variant="outline" size="sm" className="h-10" onClick={() => downloadTable(tableRows(), `${fileBase}.xlsx`, "xlsx")} aria-label="Download as Excel">
              <FileSpreadsheet className="h-4 w-4 sm:mr-1.5" />
              <span className="hidden sm:inline">Excel</span>
            </Button>
            <Button variant="outline" size="sm" className="hidden h-10 sm:inline-flex" onClick={() => downloadTable(tableRows(), `${fileBase}.csv`, "csv")}>
              CSV
            </Button>
            <Button variant="outline" size="sm" className="hidden h-10 sm:inline-flex" onClick={() => window.print()}>
              <Printer className="mr-1.5 h-4 w-4" /> Print
            </Button>
          </>
        }
        filters={
          <>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
              {branches.length > 1 ? (
                <Select value={selectedBranch} onChange={(event) => setSelectedBranch(event.target.value)} className="h-9 sm:w-52" aria-label="Shop">
                  <option value="ALL">All shops</option>
                  {branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name}
                    </option>
                  ))}
                </Select>
              ) : null}
              <Select value={conditionFilter} onChange={(event) => setConditionFilter(event.target.value)} className="h-9 sm:w-48" aria-label="How the phone looks">
                <option value="ALL">Any look</option>
                {SHOP_CONDITION_OPTIONS.map((row) => (
                  <option key={row.value} value={row.value}>
                    {row.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
              <FilterChips
                label="Category"
                activeKey={categoryFilter}
                onSelect={setCategoryFilter}
                chips={STOCK_CATEGORY_FILTERS.filter((row) => row.key === "ALL" || (categoryCounts[row.key] ?? 0) > 0).map((row) => ({
                  key: row.key,
                  label: row.label,
                  count: categoryCounts[row.key] ?? 0,
                }))}
              />
              <FilterChips
                label="Stock"
                activeKey={stockFilter}
                onSelect={(key) => setStockFilter(key as typeof stockFilter)}
                chips={[
                  { key: "ALL", label: "Everything" },
                  { key: "LOW", label: "Low stock", count: inCategory.filter(isLow).length, tone: "danger" },
                  { key: "GAP", label: "IMEI does not match", count: inCategory.filter(hasGap).length, tone: "warning" },
                ]}
              />
            </div>
          </>
        }
        card={(row) => {
          const cost = money(row.product.costPrice)
          const selling = money(row.product.sellingPrice)
          const margin = marginPct(cost, selling)
          return {
            title: row.product.name,
            subtitle: `${[productSpecLine(row.product), row.product.brand.name].filter(Boolean).join(" · ")} · ${row.branch.name}`,
            value: formatCurrency(selling),
            valueHint: showCost ? (
              <span className={margin >= 20 ? "text-success" : margin > 0 ? "text-warning" : "text-danger"}>
                {margin > 0 ? "+" : ""}
                {margin.toFixed(1)}%
              </span>
            ) : undefined,
            meta: (
              <>
                <span className={isLow(row) ? "font-semibold text-danger" : "font-medium text-foreground"}>
                  {row.quantity} on shelf{isLow(row) ? " · low" : ""}
                </span>
                {row.incomingQty > 0 ? <span>· +{row.incomingQty} on the way</span> : null}
                {hasGap(row) ? <span className="text-warning">· IMEI count {imeiFor.get(`${row.productId}:${row.branchId}`) ?? 0}</span> : null}
                {showCost ? <span>· cost {formatCurrency(cost)}</span> : null}
              </>
            ),
          }
        }}
        footer={(rows) => (
          <tr>
            <td colSpan={2} className="text-sm">Totals for {rows.length} item{rows.length === 1 ? "" : "s"}</td>
            {showCost ? <td className="hidden lg:table-cell" /> : null}
            <td />
            {showCost ? <td className="hidden xl:table-cell" /> : null}
            <td className="text-center tabular-nums">{rows.reduce((sum, row) => sum + row.quantity, 0).toLocaleString("en-NG")}</td>
            <td className="hidden xl:table-cell" />
            <td className="hidden lg:table-cell" />
            <td className="whitespace-nowrap text-right tabular-nums">
              {formatCurrency(
                rows.reduce(
                  (sum, row) => sum + row.quantity * money(showCost ? row.product.costPrice : row.product.sellingPrice),
                  0
                )
              )}
            </td>
          </tr>
        )}
        empty="No items match this shop, look, category or search."
      />

      {/* Printing keeps the full ledger on paper. */}
      <table className="data-table hidden print:table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Shop</th>
            {showCost ? <th className="text-right">Cost</th> : null}
            <th className="text-right">Sell</th>
            <th className="text-center">On shelf</th>
            <th className="text-right">{showCost ? "Value at cost" : "Value at sell price"}</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((row) => (
            <tr key={row.id}>
              <td>{row.product.name} · {row.product.sku}</td>
              <td>{row.branch.code}</td>
              {showCost ? <td className="text-right">{formatCurrency(money(row.product.costPrice))}</td> : null}
              <td className="text-right">{formatCurrency(money(row.product.sellingPrice))}</td>
              <td className="text-center">{row.quantity}</td>
              <td className="text-right">
                {formatCurrency(row.quantity * money(showCost ? row.product.costPrice : row.product.sellingPrice))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
