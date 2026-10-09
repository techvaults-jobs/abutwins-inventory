"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { updateSelectedPrices } from "@/app/actions/catalog"
import { FilterChips } from "@/components/filter-chips"
import { StatusBadge } from "@/components/shared"
import { Select } from "@/components/ui/select"
import { countByStockCategory, matchesStockCategory, STOCK_CATEGORY_FILTERS } from "@/lib/stock-categories"
import { TablePager, usePagedRows } from "@/components/table-pager"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { formatCurrency } from "@/lib/utils"
import { PriceEditDialog } from "./price-edit-dialog"
import { ProductManageDialog } from "./product-manage-dialog"
import { Settings2, Tag } from "lucide-react"
import { trackingLabel } from "@/lib/unit-identity"

export type PriceRow = {
  id: string
  sku: string
  name: string
  brandId?: string
  brand: string
  categoryId?: string
  category?: string
  color: string | null
  storage: string | null
  ram?: string | null
  description?: string | null
  tracking: string
  condition: string
  costPrice: number
  minimumPrice: number
  sellingPrice: number
  warrantyDays: number
  units: number
  inventory?: Array<{ branchId: string; branchName: string; quantity: number }>
}

export function ProductPriceList({
  products,
  canEdit,
  canPrice = false,
  showCost = false,
  canRemove = false,
  initialQuery = "",
  brandNames = [],
  categoryNames = [],
}: {
  products: PriceRow[]
  /** Change item details (name, brand, how we count it) and reduce stock. */
  canEdit: boolean
  /** Tick items and change their prices: the CEO, the main admin and the branch manager. */
  canPrice?: boolean
  /** Show what each item cost us. Anyone else gets cost 0 from the server. */
  showCost?: boolean
  canRemove?: boolean
  initialQuery?: string
  brandNames?: string[]
  categoryNames?: string[]
}) {
  const router = useRouter()
  const [query, setQuery] = useState(initialQuery)
  const [ticked, setTicked] = useState<Record<string, boolean>>({})
  const [prices, setPrices] = useState<Record<string, string>>({})
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [managingProduct, setManagingProduct] = useState<PriceRow | null>(null)
  const [pricingProduct, setPricingProduct] = useState<PriceRow | null>(null)
  // A price setter without Change (a branch manager) gets Prices on each line
  // for the cost, lowest and selling price together.
  const pricesOnly = canPrice && !canEdit
  // The same category chips as Correct and close opening stock, so staff pick
  // Phones or Laptops the same way on both screens, then one exact category.
  const [group, setGroup] = useState<string>("ALL")
  const [exactCategory, setExactCategory] = useState("ALL")
  const [bulkMode, setBulkMode] = useState<"set" | "percent">("percent")
  const [bulkValue, setBulkValue] = useState("")

  const searched = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return products
    return products.filter((product) => {
      const hay = [product.name, product.sku, product.brand, product.category, product.color, product.storage, product.condition]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
      return words.every((word) => hay.includes(word))
    })
  }, [products, query])

  const groupCounts = useMemo(() => countByStockCategory(searched), [searched])
  const inGroup = useMemo(
    () => searched.filter((product) => matchesStockCategory(product.category, group)),
    [searched, group]
  )
  const exactCategories = useMemo(() => {
    const counts = new Map<string, number>()
    for (const product of inGroup) {
      const name = product.category || "No category"
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [inGroup])
  const visible = useMemo(
    () =>
      exactCategory === "ALL"
        ? inGroup
        : inGroup.filter((product) => (product.category || "No category") === exactCategory),
    [inGroup, exactCategory]
  )

  const pager = usePagedRows(visible, `${query}|${group}|${exactCategory}`)
  const selected = products.filter((product) => ticked[product.id])
  const viewLabel =
    exactCategory !== "ALL"
      ? exactCategory
      : group !== "ALL"
        ? STOCK_CATEGORY_FILTERS.find((row) => row.key === group)?.label ?? "this view"
        : query.trim()
          ? "this search"
          : "the list"
  const allVisibleTicked = visible.length > 0 && visible.every((product) => ticked[product.id])

  function tickRows(rows: PriceRow[], next: boolean) {
    setTicked((prev) => {
      const copy = { ...prev }
      for (const product of rows) copy[product.id] = next
      return copy
    })
    if (next) {
      setPrices((prev) => {
        const copy = { ...prev }
        for (const product of rows) {
          if (copy[product.id] == null || copy[product.id] === "") copy[product.id] = String(product.sellingPrice)
        }
        return copy
      })
    }
  }

  /** Put one new price, or the same % change, on every ticked item. */
  function applyBulk() {
    const value = Number(bulkValue)
    if (!Number.isFinite(value) || (bulkMode === "set" && value <= 0)) {
      toast.error(bulkMode === "set" ? "Type the new selling price." : "Type a percentage, such as -5 or 10.")
      return
    }
    if (!selected.length) {
      toast.error("Tick the items first.")
      return
    }
    setPrices((prev) => {
      const copy = { ...prev }
      for (const product of selected) {
        const next = bulkMode === "set" ? value : Math.round(product.sellingPrice * (1 + value / 100))
        copy[product.id] = String(Math.max(1, next))
      }
      return copy
    })
    toast.success(
      bulkMode === "set"
        ? `New price typed on ${selected.length} item${selected.length === 1 ? "" : "s"}. Check them, then save.`
        : `${value > 0 ? "+" : ""}${value}% typed on ${selected.length} item${selected.length === 1 ? "" : "s"}. Check them, then save.`
    )
  }

  function setTick(id: string, next: boolean, currentPrice: number) {
    setTicked((prev) => ({ ...prev, [id]: next }))
    if (next) {
      setPrices((prev) => (prev[id] == null || prev[id] === "" ? { ...prev, [id]: String(currentPrice) } : prev))
    }
  }


  async function onSave() {
    if (!canPrice) return
    if (selected.length === 0) {
      toast.error("Tick the items whose selling price you want to change.")
      return
    }
    const changes: Array<{ id: string; sellingPrice: number }> = []
    for (const product of selected) {
      const sellingPrice = Number(prices[product.id])
      if (!Number.isFinite(sellingPrice) || sellingPrice <= 0) {
        toast.error(`Type a selling price for ${product.name}.`)
        return
      }
      changes.push({ id: product.id, sellingPrice })
    }
    if (changes.length > 200) {
      toast.error("You can change up to 200 prices in one save.")
      return
    }

    const data = new FormData()
    data.set("changes", JSON.stringify(changes))
    data.set("reason", reason)
    setBusy(true)
    const outcome = await updateSelectedPrices(data)
    setBusy(false)
    if (outcome.error) {
      toast.error(outcome.error)
      return
    }
    const count = outcome.updated ?? changes.length
    toast.success(count === 1 ? "1 selling price saved." : `${count} selling prices saved.`)
    setTicked({})
    setPrices({})
    setReason("")
    router.refresh()
  }

  return (
    <div className="surface-card overflow-hidden">
      <div className="space-y-3 border-b border-border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find item code, model, brand or category"
            aria-label="Find item code, model, brand or category"
            className="min-w-0 flex-1 sm:max-w-xl"
          />
          <p className="text-sm text-muted-foreground">
            {visible.length === 1 ? "1 item" : `${visible.length} items`} in {viewLabel}
          </p>
        </div>
        <FilterChips
          label="Category"
          activeKey={group}
          onSelect={(key) => {
            setGroup(key)
            setExactCategory("ALL")
          }}
          chips={STOCK_CATEGORY_FILTERS.filter((row) => row.key === "ALL" || (groupCounts[row.key] ?? 0) > 0).map((row) => ({
            key: row.key,
            label: row.label,
            count: groupCounts[row.key] ?? 0,
          }))}
        />
        {exactCategories.length > 1 ? (
          <Select
            value={exactCategory}
            onChange={(event) => setExactCategory(event.target.value)}
            className="h-9 w-full sm:w-72"
            aria-label="Exact category"
          >
            <option value="ALL">Every category in this group ({inGroup.length})</option>
            {exactCategories.map(([name, count]) => (
              <option key={name} value={name}>
                {name} ({count})
              </option>
            ))}
          </Select>
        ) : null}
        {canPrice ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant={allVisibleTicked ? "outline" : "default"}
              size="sm"
              disabled={!visible.length}
              onClick={() => tickRows(visible, !allVisibleTicked)}
            >
              {allVisibleTicked ? `Untick all ${visible.length} in ${viewLabel}` : `Tick all ${visible.length} in ${viewLabel}`}
            </Button>
            {selected.length ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => tickRows(products, false)}>
                Untick everything
              </Button>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Ticking works across pages. Type new prices one by one, or for all ticked items at once below.
            </p>
          </div>
        ) : null}
      </div>
      {/* Phone: one card per item, so nothing is squeezed into a column. */}
      <ul className="divide-y divide-border md:hidden">
        {pager.pageRows.map((product) => {
          const chosen = Boolean(ticked[product.id])
          return (
            <li key={product.id} className={`flex gap-3 px-4 py-3 ${chosen ? "bg-primary-soft/60" : ""}`}>
              {canPrice ? (
                <input
                  type="checkbox"
                  className="mt-1 h-5 w-5 shrink-0"
                  checked={chosen}
                  onChange={(event) => setTick(product.id, event.target.checked, product.sellingPrice)}
                  aria-label={`Select ${product.name}`}
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium leading-snug">{product.name}</p>
                  <p className="shrink-0 font-semibold tabular-nums">{formatCurrency(product.sellingPrice)}</p>
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {product.category ? `${product.category} · ` : ""}
                  {product.brand} · {product.sku}
                </p>
                <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                  {showCost ? `Cost ${formatCurrency(product.costPrice)} · lowest` : "Lowest"} {formatCurrency(product.minimumPrice)} ·{" "}
                  {product.units} units
                </p>
                <div className="mt-2 flex items-center gap-2">
                  {canPrice && chosen ? (
                    <Input
                      type="number"
                      min={1}
                      step={1}
                      className="h-9 flex-1"
                      value={prices[product.id] ?? ""}
                      onChange={(event) => setPrices((prev) => ({ ...prev, [product.id]: event.target.value }))}
                      placeholder="New sell price"
                      aria-label={`New sell price for ${product.name}`}
                    />
                  ) : null}
                  {canEdit ? (
                    <Button type="button" size="sm" variant="outline" className="h-9 shrink-0" onClick={() => setManagingProduct(product)}>
                      <Settings2 className="mr-1.5 h-3.5 w-3.5" /> Change
                    </Button>
                  ) : null}
                  {pricesOnly ? (
                    <Button type="button" size="sm" variant="outline" className="h-9 shrink-0" onClick={() => setPricingProduct(product)}>
                      <Tag className="mr-1.5 h-3.5 w-3.5" /> Prices
                    </Button>
                  ) : null}
                </div>
              </div>
            </li>
          )
        })}
        {visible.length === 0 ? (
          <li className="px-4 py-8 text-sm text-muted-foreground">No items match this category or search.</li>
        ) : null}
      </ul>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr className="border-b border-border">
              {canPrice ? <th className="px-4 py-3">Select</th> : null}
              <th className="px-4 py-3">Item / item code</th>
              <th className="px-4 py-3">How it looks</th>
              <th className="px-4 py-3">{showCost ? "Cost / lowest / sell" : "Lowest / sell"}</th>
              {canPrice ? <th className="px-4 py-3">New sell price</th> : null}
              <th className="px-4 py-3">Warranty</th>
              <th className="px-4 py-3">Units</th>
              {canEdit || pricesOnly ? <th className="px-4 py-3 text-right">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {pager.pageRows.map((product) => {
              const chosen = Boolean(ticked[product.id])
              return (
                <tr key={product.id} className="border-b border-border/70">
                  {canPrice ? (
                    <td className="px-4 py-3 align-top">
                      <input
                        type="checkbox"
                        className="h-5 w-5"
                        checked={chosen}
                        onChange={(event) => setTick(product.id, event.target.checked, product.sellingPrice)}
                        aria-label={`Select ${product.name}`}
                      />
                    </td>
                  ) : null}
                  <td className="px-4 py-3">
                    <p className="font-medium">{product.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {product.sku} · {product.brand}
                      {product.category ? ` · ${product.category}` : ""}
                      {product.color ? ` · ${product.color}` : ""}
                      {product.storage ? ` ${product.storage}` : ""}
                      {` · ${trackingLabel(product.tracking)}`}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge value={product.condition} />
                  </td>
                  <td className="px-4 py-3">
                    {showCost ? `${formatCurrency(product.costPrice)} / ` : ""}
                    {formatCurrency(product.minimumPrice)} / {formatCurrency(product.sellingPrice)}
                  </td>
                  {canPrice ? (
                    <td className="px-4 py-3">
                      <Input
                        type="number"
                        min={1}
                        step={1}
                        disabled={!chosen}
                        value={prices[product.id] ?? ""}
                        onChange={(event) => setPrices((prev) => ({ ...prev, [product.id]: event.target.value }))}
                        placeholder="New sell price"
                        aria-label={`New sell price for ${product.name}`}
                      />
                    </td>
                  ) : null}
                  <td className="px-4 py-3">{product.warrantyDays} days</td>
                  <td className="px-4 py-3">{product.units}</td>
                  {canEdit ? (
                    <td className="px-4 py-3 text-right">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1.5 text-xs font-semibold hover:border-primary hover:text-primary"
                        onClick={() => setManagingProduct(product)}
                      >
                        <Settings2 className="h-3.5 w-3.5" />
                        <span>Change or remove</span>
                      </Button>
                    </td>
                  ) : null}
                  {pricesOnly ? (
                    <td className="px-4 py-3 text-right">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1.5 text-xs font-semibold hover:border-primary hover:text-primary"
                        onClick={() => setPricingProduct(product)}
                      >
                        <Tag className="h-3.5 w-3.5" />
                        <span>Prices</span>
                      </Button>
                    </td>
                  ) : null}
                </tr>
              )
            })}
            {visible.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-sm text-muted-foreground" colSpan={5 + (canPrice ? 2 : 0) + (canEdit || pricesOnly ? 1 : 0)}>
                  No items match the specified search parameters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <TablePager
        page={pager.page}
        pageCount={pager.pageCount}
        pageSize={pager.pageSize}
        total={pager.total}
        start={pager.start}
        end={pager.end}
        onPageChange={pager.setPage}
        onPageSizeChange={pager.setPageSize}
        noun="items"
      />
      {canPrice ? (
        <div className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] z-20 space-y-3 lg:bottom-0 border-t border-border bg-card/95 p-4 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold">
              {selected.length === 1 ? "1 item ticked" : `${selected.length} items ticked`}
            </p>
            {selected.length ? (
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex rounded-lg bg-muted p-0.5 text-xs font-semibold">
                  {(
                    [
                      ["percent", "Up or down by %"],
                      ["set", "One price for all"],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setBulkMode(mode)}
                      className={`rounded-md px-2.5 py-1.5 ${bulkMode === mode ? "bg-card shadow-sm" : "text-muted-foreground"}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <Input
                  type="number"
                  value={bulkValue}
                  onChange={(event) => setBulkValue(event.target.value)}
                  placeholder={bulkMode === "set" ? "₦ new price" : "e.g. -5"}
                  className="h-9 w-28"
                  aria-label={bulkMode === "set" ? "One new price for every ticked item" : "Percent change for every ticked item"}
                />
                <Button type="button" variant="outline" size="sm" onClick={applyBulk}>
                  Type on all ticked
                </Button>
              </div>
            ) : null}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why these prices changed"
              aria-label="Why these prices changed"
              className="sm:flex-1"
            />
            <Button type="button" onClick={onSave} disabled={busy || !selected.length}>
              {busy ? "Saving these prices" : `Save ${selected.length || ""} price${selected.length === 1 ? "" : "s"}`}
            </Button>
          </div>
        </div>
      ) : null}
      <ProductManageDialog
        product={managingProduct}
        open={Boolean(managingProduct)}
        onOpenChange={(open) => !open && setManagingProduct(null)}
        canRemove={canRemove}
        canPrice={canPrice}
        showCost={showCost}
        brandNames={brandNames}
        categoryNames={categoryNames}
      />
      <PriceEditDialog product={pricingProduct} onOpenChange={(open) => !open && setPricingProduct(null)} />
    </div>
  )
}
