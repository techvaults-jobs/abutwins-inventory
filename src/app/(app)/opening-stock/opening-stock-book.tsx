"use client"

import { useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { CheckCircle2, Download, Eye, Loader2, Lock, LockOpen, Plus, Save, Trash2, Upload } from "lucide-react"
import {
  addOpeningStockItem,
  closeOpeningStock,
  correctOpeningFromSheet,
  removeOpeningLines,
  removeOpeningStock,
  reopenOpeningStock,
  saveOpeningEdits,
  type CorrectionResult,
  type OpeningBook,
} from "@/app/actions/opening-stock"
import { DrilldownModal } from "@/components/drilldown-modal"
import { FilterChips } from "@/components/filter-chips"
import { SectionCard, StatCard, StatGrid, TableEmpty, TableShell, TonePill, Toolbar } from "@/components/shared"
import { TablePager, usePagedRows } from "@/components/table-pager"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { downloadWorkbook } from "@/lib/download-table"
import { bookSheets, cleanIdentity, type BookLine } from "@/lib/opening-book"
import { countByStockCategory, matchesStockCategory, STOCK_CATEGORY_FILTERS } from "@/lib/stock-categories"
import { formatCondition } from "@/lib/status"
import { SHOP_CONDITION_OPTIONS } from "@/lib/conditions"
import { formatCurrency, formatDate } from "@/lib/utils"
import { watDayKey } from "@/lib/lagos-day"

type Edit = {
  quantity?: string
  costPrice?: string
  minimumPrice?: string
  sellingPrice?: string
  addIdentities?: string[]
  removeIdentities?: string[]
}

export function OpeningStockBook({ branchId, book }: { branchId: string; book: OpeningBook }) {
  const router = useRouter()
  const record = book.record!
  const closed = record.status === "CLOSED"
  const [query, setQuery] = useState("")
  const [categoryFilter, setCategoryFilter] = useState<string>("ALL")
  const [edits, setEdits] = useState<Record<string, Edit>>({})
  const [saving, setSaving] = useState(false)
  const [unitsFor, setUnitsFor] = useState<BookLine | null>(null)
  const [newUnits, setNewUnits] = useState("")
  const [showAddModal, setShowAddModal] = useState(false)
  const [ticked, setTicked] = useState<Set<string>>(() => new Set())
  const [removeReason, setRemoveReason] = useState("")
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removeProblems, setRemoveProblems] = useState<string[]>([])

  const categoryCounts = useMemo(() => countByStockCategory(book.lines), [book.lines])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return book.lines.filter((line) => {
      if (!matchesStockCategory(line.category, categoryFilter)) return false
      if (!needle) return true
      return [line.name, line.sku, line.brand, line.category, line.storage, line.condition, ...line.identities]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    })
  }, [book.lines, query, categoryFilter])
  const pager = usePagedRows(visible, `${categoryFilter}|${query}`)
  const dirty = Object.entries(edits).filter(([, edit]) => Object.values(edit).some((v) => (Array.isArray(v) ? v.length : v !== undefined)))
  const offShelf = book.lines.filter((line) => line.shelfQty !== line.openingQty)
  const fileBase = `opening-stock-${record.shopCode.toLowerCase()}-${watDayKey()}`

  const tickedLines = book.lines.filter((line) => ticked.has(line.productId))
  const tickedUnits = tickedLines.reduce((sum, line) => sum + line.openingQty, 0)
  const tickedValue = tickedLines.reduce((sum, line) => sum + line.openingQty * line.costPrice, 0)
  const categoryLabel = STOCK_CATEGORY_FILTERS.find((row) => row.key === categoryFilter)?.label ?? "this view"
  const allVisibleTicked = visible.length > 0 && visible.every((line) => ticked.has(line.productId))

  function toggle(productIds: string[], on: boolean) {
    setConfirmRemove(false)
    setRemoveProblems([])
    setTicked((prev) => {
      const next = new Set(prev)
      for (const id of productIds) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  async function removeTicked() {
    const data = new FormData()
    data.set("branchId", branchId)
    data.set("productIds", JSON.stringify([...ticked]))
    data.set("reason", removeReason)
    setRemoving(true)
    try {
      const outcome = await removeOpeningLines(data)
      setRemoving(false)
      if (outcome.error) {
        toast.error(outcome.error)
        setRemoveProblems(outcome.problems ?? [])
        return
      }
      toast.success(
        `Removed ${outcome.removedLines} item line(s)${outcome.removedUnits ? ` and ${outcome.removedUnits} IMEI or serial number(s)` : ""} from opening stock.`
      )
      setTicked(new Set())
      setConfirmRemove(false)
      setRemoveReason("")
      setRemoveProblems([])
      router.refresh()
    } catch {
      setRemoving(false)
      toast.error("That did not reach the shop system. Check your network and try again.")
    }
  }

  function edit(sku: string, patch: Edit) {
    setEdits((prev) => ({ ...prev, [sku]: { ...prev[sku], ...patch } }))
  }

  async function saveEdits() {
    const changes = dirty.map(([sku, e]) => ({
      sku,
      quantity: e.quantity,
      costPrice: e.costPrice,
      minimumPrice: e.minimumPrice,
      sellingPrice: e.sellingPrice,
      addIdentities: e.addIdentities,
      removeIdentities: e.removeIdentities,
    }))
    const data = new FormData()
    data.set("branchId", branchId)
    data.set("changes", JSON.stringify(changes))
    setSaving(true)
    let result: CorrectionResult
    try {
      result = await saveOpeningEdits(data)
    } catch {
      setSaving(false)
      toast.error("That did not reach the shop system. Check your network and try again.")
      return
    }
    setSaving(false)
    if (result.error) {
      toast.error(result.error)
      return
    }
    toast.success(`Saved. Opening stock is now worth ${formatCurrency(result.preview?.valueAfter ?? 0)} at cost.`)
    setEdits({})
    router.refresh()
  }

  function field(line: BookLine, key: "quantity" | "costPrice" | "minimumPrice" | "sellingPrice", saved: number) {
    const value = edits[line.sku]?.[key]
    if (!book.canCorrect || (key === "quantity" && line.tracking !== "NONE")) {
      return key === "quantity" ? <span className="num font-semibold">{saved}</span> : <span className="num">{formatCurrency(saved)}</span>
    }
    return (
      <Input
        type="number"
        min={0}
        step={key === "quantity" ? 1 : "0.01"}
        value={value ?? String(saved)}
        onChange={(event) => edit(line.sku, { [key]: event.target.value === String(saved) ? undefined : event.target.value })}
        aria-label={`${key} for ${line.name}`}
        className={`ml-auto h-8 text-right num ${key === "quantity" ? "w-20" : "w-28"} ${value !== undefined ? "border-warning" : ""}`}
      />
    )
  }

  return (
    <div className="space-y-5">
      <StatGrid>
        <StatCard
          label={closed ? "Opened with (closed)" : "Opening value so far"}
          value={formatCurrency(record.totals.value)}
          hint={`At cost · bill ${record.invoiceNumber}`}
          tone={closed ? "success" : "warning"}
          icon={closed ? <Lock className="h-4 w-4" /> : undefined}
        />
        <StatCard label="Units" value={String(record.totals.quantity)} hint={`${record.totals.lines} item lines`} />
        <StatCard
          label="Status"
          value={closed ? "Closed" : "Open"}
          hint={
            closed
              ? `Closed ${record.closedAt ? formatDate(record.closedAt) : ""} by ${record.closedByName ?? "—"}. Only the CEO or Super Admin can reopen it.`
              : record.reopenedAt
                ? "Reopened to fix. Close it again when it is right."
                : "Being counted and corrected."
          }
          tone={closed ? "success" : "warning"}
        />
        <StatCard label="Loaded" value={formatDate(record.loadedAt)} hint="The day the opening sheet went on the system" href={`/purchases/${record.purchaseId}`} />
      </StatGrid>

      {!closed ? (
        <SectionCard title="How to finish opening stock">
          <ol className="grid gap-2 text-sm text-muted-foreground md:grid-cols-4">
            <li><span className="font-semibold text-foreground">1. Download the count sheet.</span> Every item, category, count, cost, both selling prices, and every IMEI.</li>
            <li><span className="font-semibold text-foreground">2. Count the shelf.</span> Tap Phones, Accessories, Screen, or Laptop above the list to give each person their own group. Write what you really find in COUNTED QTY. Mark a missing phone NO.</li>
            <li><span className="font-semibold text-foreground">3. Correct.</span> Upload the filled sheet and check the preview, or change a line on screen below. Add a missing IMEI, serial, or piece count here. Super Admin, CEO, accountant, records checker, and stock uploader can change the list until it is closed.</li>
            <li><span className="font-semibold text-foreground">4. Close.</span> The CEO or main admin closes it when the count and every price are right. If something is found later, the CEO or Super Admin can reopen it.</li>
          </ol>
        </SectionCard>
      ) : null}

      {!closed && record.reopenedAt ? (
        <p className="rounded-lg border border-warning/30 bg-warning-soft p-3 text-sm text-warning">
          Reopened {formatDate(record.reopenedAt)} by {record.reopenedByName ?? "—"}
          {record.reopenReason ? `: ${record.reopenReason}` : ""}. Fix the lines below, then close it again.
          The shop keeps selling while it is open.
        </p>
      ) : null}

      {!closed && !book.canCorrect ? (
        <p className="rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">
          Read-only for your job. You see every opening and closing figure for this shop; the CEO, the main admin, the
          books desk or the stock loader corrects it.
        </p>
      ) : null}

      {book.canReopen ? <ReopenCard branchId={branchId} shop={record.shopName} /> : null}

      <div className="grid gap-4 xl:grid-cols-2">
        {book.canCorrect ? <SheetCorrection branchId={branchId} /> : null}
        {book.canClose ? <CloseCard branchId={branchId} value={record.totals.value} shop={record.shopName} /> : null}
      </div>

      {book.canRemove ? (
        <RemoveCard
          branchId={branchId}
          shop={record.shopName}
          value={record.totals.value}
          quantity={record.totals.quantity}
          lines={record.totals.lines}
        />
      ) : null}

      {!closed && offShelf.length ? (
        <p className="rounded-lg border border-warning/30 bg-warning-soft p-3 text-sm text-warning">
          {offShelf.length} item(s) have more or fewer on the shelf row than on the opening stock, usually because a supplier
          bill was booked for them too. Only the opening stock figure is corrected here.
        </p>
      ) : null}

      <FilterChips
        label="Count by category"
        activeKey={categoryFilter}
        onSelect={setCategoryFilter}
        chips={STOCK_CATEGORY_FILTERS.filter((row) => row.key === "ALL" || (categoryCounts[row.key] ?? 0) > 0).map((row) => ({
          key: row.key,
          label: row.label,
          count: categoryCounts[row.key] ?? 0,
        }))}
      />

      {book.canCorrect ? (
        <div
          className={`space-y-3 rounded-xl border p-3 text-sm ${
            ticked.size ? "border-danger/40 bg-danger-soft/40" : "border-border bg-muted/30"
          }`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">
              {ticked.size
                ? `${ticked.size} item(s) ticked · ${tickedUnits} unit(s) · ${formatCurrency(tickedValue)} at cost`
                : "Remove items: tick them in the list, or tick a whole category."}
            </span>
            <span className="flex flex-wrap gap-2 sm:ml-auto">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={visible.length === 0}
                onClick={() => toggle(visible.map((line) => line.productId), !allVisibleTicked)}
              >
                {allVisibleTicked
                  ? `Untick all ${visible.length} in ${categoryFilter === "ALL" && !query ? "the list" : categoryLabel}`
                  : `Tick all ${visible.length} in ${categoryFilter === "ALL" && !query ? "the list" : categoryLabel}`}
              </Button>
              {ticked.size ? (
                <>
                  <Button type="button" variant="ghost" size="sm" onClick={() => toggle([...ticked], false)}>
                    Clear ticks
                  </Button>
                  <Button type="button" variant="destructive" size="sm" onClick={() => setConfirmRemove(true)}>
                    <Trash2 className="mr-1.5 h-4 w-4" /> Remove {ticked.size} ticked
                  </Button>
                </>
              ) : null}
            </span>
          </div>
          {confirmRemove && ticked.size ? (
            <div className="space-y-2 border-t border-danger/30 pt-3">
              <p>
                This takes {ticked.size} item line(s) and {tickedUnits} unit(s) off {record.shopName}&apos;s opening stock.
                Their IMEIs and serials are deleted, so they can be loaded onto the right shop. Item names stay on the price
                list. Who did what keeps a copy.
              </p>
              <ul className="max-h-32 overflow-auto text-xs text-muted-foreground">
                {tickedLines.slice(0, 50).map((line) => (
                  <li key={line.productId}>
                    {line.name} · {line.category} · {line.openingQty}
                  </li>
                ))}
                {tickedLines.length > 50 ? <li>and {tickedLines.length - 50} more</li> : null}
              </ul>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={removeReason}
                  onChange={(event) => setRemoveReason(event.target.value)}
                  placeholder="Why, e.g. these belong to Iwo Road"
                  className="h-9 max-w-sm"
                />
                <Button type="button" variant="destructive" size="sm" onClick={removeTicked} disabled={removing}>
                  {removing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1.5 h-4 w-4" />}
                  Yes, remove {ticked.size} item(s)
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmRemove(false)} disabled={removing}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
          {removeProblems.length ? (
            <ul className="max-h-48 space-y-1 overflow-auto rounded-lg border border-danger/30 bg-danger-soft p-3 text-xs text-danger">
              {removeProblems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <TableShell
        caption={
          <>
            <Input
              placeholder="Find an item, item code, category, or IMEI"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-9 max-w-xs"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => downloadWorkbook(bookSheets(book.lines), `${fileBase}${closed ? "-closed" : "-count-sheet"}.xlsx`)}
              >
                <Download className="mr-1.5 h-4 w-4" /> {closed ? "Download (Excel)" : "Download count sheet (Excel)"}
              </Button>
              {book.canCorrect ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setShowAddModal(true)}>
                  <Plus className="mr-1.5 h-4 w-4" /> Add unlisted item
                </Button>
              ) : null}
              {book.canCorrect ? (
                <Button type="button" size="sm" onClick={saveEdits} disabled={saving || dirty.length === 0}>
                  {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
                  Save {dirty.length ? `${dirty.length} changed line${dirty.length === 1 ? "" : "s"}` : "changes"}
                </Button>
              ) : null}
            </div>
          </>
        }
        columns={[
          ...(book.canCorrect
            ? [
                {
                  label: (
                    <input
                      type="checkbox"
                      aria-label="Tick every item on this page"
                      checked={pager.pageRows.length > 0 && pager.pageRows.every((line) => ticked.has(line.productId))}
                      onChange={(event) => toggle(pager.pageRows.map((line) => line.productId), event.target.checked)}
                    />
                  ),
                  className: "w-8",
                },
              ]
            : []),
          { label: "Item" },
          { label: "Category" },
          { label: "Count", align: "right" },
          { label: "Unit cost", align: "right" },
          { label: "Lowest price", align: "right" },
          { label: "Standard price", align: "right" },
          { label: "Value at cost", align: "right" },
        ]}
        footer={
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
        }
      >
        {pager.pageRows.map((line) => {
          const e = edits[line.sku] ?? {}
          const qty =
            line.tracking === "NONE" && !(e.addIdentities?.length)
              ? Number(e.quantity ?? line.openingQty)
              : line.openingQty + (e.addIdentities?.length ?? 0) - (e.removeIdentities?.length ?? 0)
          const cost = Number(e.costPrice ?? line.costPrice)
          const spec = [line.storage, formatCondition(line.condition)].filter(Boolean).join(" · ")
          return (
            <tr key={line.sku} className={ticked.has(line.productId) ? "bg-danger-soft/40" : undefined}>
              {book.canCorrect ? (
                <td className="w-8">
                  <input
                    type="checkbox"
                    aria-label={`Tick ${line.name} to remove`}
                    checked={ticked.has(line.productId)}
                    onChange={(event) => toggle([line.productId], event.target.checked)}
                  />
                </td>
              ) : null}
              <td>
                <p className="font-medium">{line.name}</p>
                <p className="text-xs text-muted-foreground">
                  {line.brand} · <span className="font-mono">{line.sku}</span>
                  {spec ? ` · ${spec}` : ""}
                  {line.shelfQty !== line.openingQty && !closed ? ` · shelf row ${line.shelfQty}` : ""}
                </p>
                {line.tracking !== "NONE" ? (
                  <button type="button" className="mt-1 text-xs font-medium text-primary hover:underline" onClick={() => setUnitsFor(line)}>
                    {line.tracking === "IMEI" ? "IMEIs" : "Serials"} ({qty}){book.canCorrect ? " · add or take off" : ""}
                  </button>
                ) : book.canCorrect && line.openingQty === 0 ? (
                  <button type="button" className="mt-1 text-xs font-medium text-primary hover:underline" onClick={() => setUnitsFor(line)}>
                    Add IMEI or serial when you have it
                  </button>
                ) : null}
              </td>
              <td>
                <span className="inline-flex rounded-md bg-muted px-2 py-1 text-xs font-semibold text-foreground">
                  {line.category || "General"}
                </span>
              </td>
              <td className="text-right">
                {line.tracking === "NONE" ? (
                  field(line, "quantity", line.openingQty)
                ) : (
                  <button
                    type="button"
                    onClick={() => setUnitsFor(line)}
                    className="inline-flex items-center gap-1 font-semibold text-primary hover:underline"
                    title="Click to view and adjust IMEIs/serials"
                  >
                    <span className="num">{qty}</span>
                    {book.canCorrect ? <span className="text-[11px] font-normal text-muted-foreground">(edit)</span> : null}
                  </button>
                )}
              </td>
              <td className="text-right">{field(line, "costPrice", line.costPrice)}</td>
              <td className="text-right">{field(line, "minimumPrice", line.minimumPrice)}</td>
              <td className="text-right">{field(line, "sellingPrice", line.sellingPrice)}</td>
              <td className="text-right num font-semibold">{formatCurrency((Number.isFinite(qty) ? qty : 0) * (Number.isFinite(cost) ? cost : 0))}</td>
            </tr>
          )
        })}
        {visible.length === 0 ? <TableEmpty colSpan={book.canCorrect ? 8 : 7}>No item matches that category or search.</TableEmpty> : null}
      </TableShell>

      <DrilldownModal
        open={unitsFor !== null}
        onClose={() => {
          setUnitsFor(null)
          setNewUnits("")
        }}
        eyebrow={unitsFor?.sku}
        title={unitsFor ? `${unitsFor.name}: ${unitsFor.tracking === "IMEI" ? "IMEIs" : "serials"}` : ""}
        width="narrow"
        download={
          unitsFor
            ? {
                filename: `${fileBase}-${unitsFor.sku.toLowerCase()}-units`,
                rows: () => [["ITEM CODE", "PRODUCT NAME", "IMEI / SERIAL"], ...unitsFor.identities.map((id) => [unitsFor.sku, unitsFor.name, id])],
              }
            : undefined
        }
      >
        {unitsFor ? (
          <div className="space-y-4 p-5">
            {book.canCorrect ? (
              <div className="space-y-2">
                <label className="block text-sm">
                  <span className="eyebrow mb-1 block">Found on the shelf but not listed</span>
                  <textarea
                    value={newUnits}
                    onChange={(event) => setNewUnits(event.target.value)}
                    rows={3}
                    placeholder="One IMEI or serial per line"
                    className="w-full rounded-lg border border-input bg-card p-2 font-mono text-sm"
                  />
                </label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const found = newUnits.split(/[\n,]+/).map(cleanIdentity).filter(Boolean)
                    const current = edits[unitsFor.sku]?.addIdentities ?? []
                    edit(unitsFor.sku, { addIdentities: [...new Set([...current, ...found])].filter((id) => !unitsFor.identities.includes(id)) })
                    setNewUnits("")
                  }}
                >
                  Add to the list
                </Button>
              </div>
            ) : null}
            <ul className="divide-y divide-border rounded-lg border border-border text-sm">
              {(edits[unitsFor.sku]?.addIdentities ?? []).map((id) => (
                <li key={`add-${id}`} className="flex items-center justify-between px-3 py-2">
                  <span className="font-mono">{id}</span>
                  <span className="flex items-center gap-2">
                    <TonePill tone="success">Will be added</TonePill>
                    <button
                      type="button"
                      className="text-xs text-muted-foreground hover:underline"
                      onClick={() => edit(unitsFor.sku, { addIdentities: (edits[unitsFor.sku]?.addIdentities ?? []).filter((v) => v !== id) })}
                    >
                      Undo
                    </button>
                  </span>
                </li>
              ))}
              {unitsFor.identities.map((id) => {
                const removing = edits[unitsFor.sku]?.removeIdentities?.includes(id)
                return (
                  <li key={id} className="flex items-center justify-between px-3 py-2">
                    <span className={`font-mono ${removing ? "text-danger line-through" : ""}`}>{id}</span>
                    {book.canCorrect ? (
                      <button
                        type="button"
                        className={`text-xs font-medium hover:underline ${removing ? "text-muted-foreground" : "text-danger"}`}
                        onClick={() => {
                          const list = edits[unitsFor.sku]?.removeIdentities ?? []
                          edit(unitsFor.sku, { removeIdentities: removing ? list.filter((v) => v !== id) : [...list, id] })
                        }}
                      >
                        {removing ? "Keep" : "Not on the shelf"}
                      </button>
                    ) : null}
                  </li>
                )
              })}
              {unitsFor.identities.length === 0 ? (
                <li className="px-3 py-6 text-center text-muted-foreground">
                  None listed yet. Type each IMEI or serial when you have it, then save the changed lines.
                </li>
              ) : null}
            </ul>
            {book.canCorrect ? (
              <p className="text-xs text-muted-foreground">Changes here are saved with Save changed lines on the table.</p>
            ) : null}
          </div>
        ) : null}
      </DrilldownModal>

      {showAddModal ? (
        <AddItemModal
          branchId={branchId}
          open={showAddModal}
          onClose={() => setShowAddModal(false)}
        />
      ) : null}
    </div>
  )
}

function AddItemModal({
  branchId,
  open,
  onClose,
}: {
  branchId: string
  open: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [tracking, setTracking] = useState<"NONE" | "IMEI" | "SERIAL">("NONE")
  const [form, setForm] = useState({
    name: "",
    brand: "",
    category: "",
    condition: "BRAND_NEW",
    storage: "",
    quantity: "1",
    costPrice: "",
    minimumPrice: "",
    sellingPrice: "",
    identities: "",
  })

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!form.name.trim()) {
      toast.error("Enter the item name.")
      return
    }
    const cost = Number(form.costPrice)
    const min = Number(form.minimumPrice)
    const sell = Number(form.sellingPrice)
    if (cost < 0 || min <= 0 || sell <= 0) {
      toast.error("Cost price must be 0+, lowest and standard selling prices must be > 0.")
      return
    }
    if (sell < min) {
      toast.error("Standard selling price cannot be below the lowest selling price.")
      return
    }
    if (tracking === "NONE" && (Number(form.quantity) <= 0 || !Number.isInteger(Number(form.quantity)))) {
      toast.error("Counted quantity must be a whole number greater than 0.")
      return
    }
    if (tracking !== "NONE" && !form.identities.trim()) {
      toast.error(`Enter at least one ${tracking === "IMEI" ? "IMEI" : "serial number"}.`)
      return
    }

    const data = new FormData()
    data.set("branchId", branchId)
    data.set("name", form.name)
    data.set("brand", form.brand || "Unbranded")
    data.set("category", form.category || "General")
    data.set("condition", form.condition)
    data.set("storage", form.storage)
    data.set("tracking", tracking)
    data.set("quantity", form.quantity)
    data.set("costPrice", form.costPrice)
    data.set("minimumPrice", form.minimumPrice)
    data.set("sellingPrice", form.sellingPrice)
    data.set("identities", form.identities)

    setBusy(true)
    try {
      const outcome = await addOpeningStockItem(data)
      setBusy(false)
      if (outcome.error) {
        toast.error(outcome.error)
        return
      }
      toast.success(`Added ${form.name} to opening stock.`)
      onClose()
      router.refresh()
    } catch {
      setBusy(false)
      toast.error("Could not add this item. Try again.")
    }
  }

  return (
    <DrilldownModal
      open={open}
      onClose={onClose}
      eyebrow="Opening stock"
      title="Add a missing item"
      width="narrow"
      footer={false}
    >
      <form onSubmit={submit} className="space-y-4 p-5">
        <p className="text-xs text-muted-foreground">
          On the shelf, missing from the sheet. Add count, cost, and sell price.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-muted-foreground">Item name</label>
            <Input
              required
              placeholder="Example: iPhone 13 Pro Max"
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              className="mt-1"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground">Brand</label>
            <Input
              placeholder="e.g. Apple"
              value={form.brand}
              onChange={(e) => setForm((prev) => ({ ...prev, brand: e.target.value }))}
              className="mt-1"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground">Category</label>
            <Input
              placeholder="e.g. Smartphones"
              value={form.category}
              onChange={(e) => setForm((prev) => ({ ...prev, category: e.target.value }))}
              className="mt-1"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground">Condition</label>
            <select
              value={form.condition}
              onChange={(e) => setForm((prev) => ({ ...prev, condition: e.target.value }))}
              className="mt-1 flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm"
            >
              {SHOP_CONDITION_OPTIONS.map((row) => (
                <option key={row.value} value={row.value}>
                  {row.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground">Storage / Spec</label>
            <Input
              placeholder="e.g. 128GB"
              value={form.storage}
              onChange={(e) => setForm((prev) => ({ ...prev, storage: e.target.value }))}
              className="mt-1"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground">Tracking Type</label>
            <select
              value={tracking}
              onChange={(e) => setTracking(e.target.value as "NONE" | "IMEI" | "SERIAL")}
              className="mt-1 flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm"
            >
              <option value="NONE">Pieces (Accessories / General)</option>
              <option value="IMEI">Phone, IMEI</option>
              <option value="SERIAL">Serial (laptops)</option>
            </select>
          </div>
          {tracking === "NONE" ? (
            <div>
              <label className="block text-xs font-medium text-muted-foreground">Counted Quantity *</label>
              <Input
                type="number"
                min={1}
                required
                value={form.quantity}
                onChange={(e) => setForm((prev) => ({ ...prev, quantity: e.target.value }))}
                className="mt-1"
              />
            </div>
          ) : (
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-muted-foreground">
                {tracking === "IMEI" ? "IMEI Numbers" : "Serial Numbers"} (One per line) *
              </label>
              <textarea
                required
                rows={3}
                placeholder="Paste or scan one per line"
                value={form.identities}
                onChange={(e) => setForm((prev) => ({ ...prev, identities: e.target.value }))}
                className="mt-1 w-full rounded-md border border-input bg-card p-2 font-mono text-sm"
              />
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-muted-foreground">Unit Cost Price (₦) *</label>
            <Input
              type="number"
              min={0}
              step="0.01"
              required
              value={form.costPrice}
              onChange={(e) => setForm((prev) => ({ ...prev, costPrice: e.target.value }))}
              className="mt-1"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground">Lowest Selling Price (₦) *</label>
            <Input
              type="number"
              min={1}
              step="0.01"
              required
              value={form.minimumPrice}
              onChange={(e) => setForm((prev) => ({ ...prev, minimumPrice: e.target.value }))}
              className="mt-1"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-muted-foreground">Standard Selling Price (₦) *</label>
            <Input
              type="number"
              min={1}
              step="0.01"
              required
              value={form.sellingPrice}
              onChange={(e) => setForm((prev) => ({ ...prev, sellingPrice: e.target.value }))}
              className="mt-1"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />}
            Add to Opening Stock
          </Button>
        </div>
      </form>
    </DrilldownModal>
  )
}

function SheetCorrection({ branchId }: { branchId: string }) {
  const router = useRouter()
  const formRef = useRef<HTMLFormElement>(null)
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null)
  const [result, setResult] = useState<CorrectionResult | null>(null)

  async function run(mode: "preview" | "apply") {
    if (!formRef.current) return
    const data = new FormData(formRef.current)
    data.set("branchId", branchId)
    data.set("mode", mode)
    setBusy(mode)
    let outcome: CorrectionResult
    try {
      outcome = await correctOpeningFromSheet(data)
    } catch {
      setBusy(null)
      toast.error("That did not reach the shop system. Check your network and try again.")
      return
    }
    setBusy(null)
    if (outcome.error) {
      toast.error(outcome.error)
      setResult(outcome)
      return
    }
    if (outcome.applied) {
      toast.success(`Corrections saved. Opening stock is now worth ${formatCurrency(outcome.preview?.valueAfter ?? 0)} at cost.`)
      formRef.current.reset()
      setResult(null)
      router.refresh()
      return
    }
    setResult(outcome)
  }

  return (
    <SectionCard title="Upload the filled count sheet" description="Nothing is saved until you have seen the changes and pressed Save these corrections.">
      <form ref={formRef} onSubmit={(event) => event.preventDefault()} className="space-y-3">
        <input
          type="file"
          name="file"
          accept=".xlsx,.xls"
          required
          disabled={busy !== null}
          onChange={() => setResult(null)}
          className="h-10 w-full rounded-lg border border-dashed border-input bg-card px-3 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm"
        />
        <ul className="space-y-1 text-xs text-muted-foreground">
          <li>Blank cells keep what is saved. Only what you write changes.</li>
          <li>To take a phone off, write NO next to its IMEI. Add a found phone as a new row with its item code.</li>
          <li>An item that was never loaded: a new ITEMS row with ITEM CODE left blank, plus its prices and tracking.</li>
        </ul>
        <Toolbar>
          <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => run("preview")}>
            {busy === "preview" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Eye className="mr-1.5 h-4 w-4" />}
            See what will change
          </Button>
          {result?.preview && !result.error ? (
            <Button type="button" size="sm" disabled={busy !== null} onClick={() => run("apply")}>
              {busy === "apply" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Upload className="mr-1.5 h-4 w-4" />}
              Save these corrections
            </Button>
          ) : null}
        </Toolbar>
      </form>

      {result?.problems?.length ? (
        <div className="mt-3 rounded-lg border border-danger/30 bg-danger-soft p-3">
          <p className="text-sm font-semibold text-danger">Fix these in the sheet, then try again. Nothing was changed.</p>
          <ul className="mt-2 max-h-56 space-y-1 overflow-auto">
            {result.problems.map((problem) => (
              <li key={problem} className="text-xs text-danger">{problem}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {result?.preview && !result.error ? (
        <div className="mt-3 rounded-lg border border-border bg-muted/40 p-3">
          <p className="text-sm font-semibold">
            {result.preview.rows.length} change{result.preview.rows.length === 1 ? "" : "s"} · value {formatCurrency(result.preview.valueBefore)} →{" "}
            {formatCurrency(result.preview.valueAfter)}
          </p>
          <ul className="mt-2 max-h-72 space-y-1 overflow-auto text-xs">
            {result.preview.rows.map((row) => (
              <li key={row}>{row}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </SectionCard>
  )
}

function CloseCard({ branchId, value, shop }: { branchId: string; value: number; shop: string }) {
  const router = useRouter()
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problems, setProblems] = useState<string[]>([])

  async function close() {
    const data = new FormData()
    data.set("branchId", branchId)
    data.set("confirm", confirm ? "yes" : "")
    setBusy(true)
    try {
      const outcome = await closeOpeningStock(data)
      setBusy(false)
      if (outcome.error) {
        toast.error(outcome.error)
        setProblems(outcome.problems ?? [])
        return
      }
      toast.success(`${shop}'s opening stock is closed. The shop can now sell.`)
      router.refresh()
    } catch {
      setBusy(false)
      toast.error("That did not reach the shop system. Check your network and try again.")
    }
  }

  return (
    <SectionCard title="Close opening stock" description="CEO or main admin. Do this only when the count and the corrections are finished.">
      <p className="text-sm">
        Closing fixes <span className="font-semibold">{shop}</span>&apos;s opening stock at{" "}
        <span className="num font-semibold">{formatCurrency(value)}</span> at cost, with today&apos;s counts, IMEIs and prices.
        Nobody can edit it after that. If a price or count turns out wrong, the CEO or Super Admin can reopen it.
      </p>
      <label className="mt-3 flex items-start gap-2 text-sm">
        <input type="checkbox" checked={confirm} onChange={(event) => setConfirm(event.target.checked)} className="mt-1" />
        <span>The shelf has been counted and every correction is saved. This opening stock is final.</span>
      </label>
      <Button type="button" className="mt-3" onClick={close} disabled={!confirm || busy}>
        {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1.5 h-4 w-4" />}
        Close opening stock
      </Button>
      {problems.length ? (
        <ul className="mt-3 max-h-48 space-y-1 overflow-auto rounded-lg border border-danger/30 bg-danger-soft p-3 text-xs text-danger">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
      <p className="mt-3 text-xs text-muted-foreground">
        Want the paper first? Use Download above, or see <Link href="/reports" className="text-primary hover:underline">Reports</Link>.
      </p>
    </SectionCard>
  )
}

function ReopenCard({ branchId, shop }: { branchId: string; shop: string }) {
  const router = useRouter()
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)

  async function reopen() {
    const data = new FormData()
    data.set("branchId", branchId)
    data.set("reason", reason)
    setBusy(true)
    try {
      const outcome = await reopenOpeningStock(data)
      setBusy(false)
      if (outcome.error) {
        toast.error(outcome.error)
        return
      }
      toast.success(`${shop}'s opening stock is open again. Fix it, then close it.`)
      router.refresh()
    } catch {
      setBusy(false)
      toast.error("That did not reach the shop system. Check your network and try again.")
    }
  }

  return (
    <SectionCard
      title="Reopen opening stock"
      description="CEO or Super Admin. Use this when a count or a price was wrong after closing."
    >
      <p className="text-sm">
        Reopening lets staff correct <span className="font-semibold">{shop}</span>&apos;s opening stock again: counts,
        IMEIs, cost, lowest and standard selling price. The shop keeps selling. Anything already sold stays sold.
        Close it again when it is right.
      </p>
      <label className="mt-3 block text-sm">
        <span className="eyebrow mb-1 block">Why reopen?</span>
        <Input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="For example: prices on the sheet were guesses"
          aria-label="Reason for reopening"
        />
      </label>
      <Button type="button" variant="outline" className="mt-3" onClick={reopen} disabled={reason.trim().length < 5 || busy}>
        {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <LockOpen className="mr-1.5 h-4 w-4" />}
        Reopen opening stock
      </Button>
    </SectionCard>
  )
}

function RemoveCard({
  branchId,
  shop,
  value,
  quantity,
  lines,
}: {
  branchId: string
  shop: string
  value: number
  quantity: number
  lines: number
}) {
  const router = useRouter()
  const [typed, setTyped] = useState("")
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [problems, setProblems] = useState<string[]>([])
  const matches = typed.trim().toLowerCase() === shop.trim().toLowerCase()

  async function remove() {
    const data = new FormData()
    data.set("branchId", branchId)
    data.set("confirmName", typed)
    data.set("reason", reason)
    setBusy(true)
    try {
      const outcome = await removeOpeningStock(data)
      setBusy(false)
      if (outcome.error) {
        toast.error(outcome.error)
        setProblems(outcome.problems ?? [])
        return
      }
      toast.success(`${shop}'s opening stock was removed. Load the sheet onto the right shop now.`)
      router.refresh()
    } catch {
      setBusy(false)
      toast.error("That did not reach the shop system. Check your network and try again.")
    }
  }

  return (
    <SectionCard
      title="Remove all of this shop's opening stock"
      description="CEO or main admin. For a sheet loaded onto the wrong shop."
      className="border-danger/30"
    >
      <p className="text-sm">
        This takes all <span className="num font-semibold">{quantity}</span> unit(s) on{" "}
        <span className="num font-semibold">{lines}</span> line(s), worth{" "}
        <span className="num font-semibold">{formatCurrency(value)}</span> at cost, off{" "}
        <span className="font-semibold">{shop}</span>. Every IMEI and serial it loaded is deleted, so the same file can
        then be loaded onto the right shop from Upload stock. Item names stay on the price list. Who did what keeps a
        copy.
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        If any of it was already sold, moved, sent back or repaired, nothing is removed and you will see which ones.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why, e.g. loaded onto Bodija instead of Iwo Road" />
        <Input
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          placeholder={`Type ${shop} to confirm`}
          aria-label="Type the shop name to confirm"
        />
      </div>
      <Button type="button" variant="destructive" className="mt-3" onClick={remove} disabled={!matches || busy}>
        {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Trash2 className="mr-1.5 h-4 w-4" />}
        Remove {shop}&apos;s opening stock
      </Button>
      {problems.length ? (
        <ul className="mt-3 max-h-48 space-y-1 overflow-auto rounded-lg border border-danger/30 bg-danger-soft p-3 text-xs text-danger">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
    </SectionCard>
  )
}
