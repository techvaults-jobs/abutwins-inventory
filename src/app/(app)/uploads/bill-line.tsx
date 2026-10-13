"use client"

import { memo, useState } from "react"
import { ListPlus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import type { BatchUploadItem } from "@/app/actions/uploads"
import { ItemNameSearch } from "@/components/item-name-search"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { BILL_CONDITION_OPTIONS, STORAGE_OPTIONS, mapBillCondition, normalizeStorage } from "@/lib/item-specs"
import { formatCurrency } from "@/lib/utils"

type Brand = { id: string; name: string }
export type BillProduct = {
  id: string
  name: string
  sku: string
  tracking: "IMEI" | "SERIAL" | "NONE"
  costPrice: number
  minimumPrice: number
  sellingPrice: number
  condition: string
  storage: string | null
  brandId: string
  categoryId: string
  brand: { name: string }
}

/** One line of the bill on screen. `key` only names the line here; it is never sent. */
export type BillLineItem = BatchUploadItem & { key: string }

/** One number box per unit, so the boxes always match How many. */
export function fitIdentities<T extends BatchUploadItem>(line: T): T {
  const qty = line.quantity || 1
  return {
    ...line,
    identities: line.tracking === "NONE" ? [] : Array.from({ length: qty }, (_, i) => line.identities?.[i] || ""),
  }
}

/** Several numbers at once: one per line, or split by commas or spaces. */
function splitCodes(raw: string) {
  return raw
    .split(/[\n\r,;\t ]+/)
    .map((code) => code.replace(/-/g, "").trim())
    .filter(Boolean)
}

function findVariant(products: BillProduct[], name: string, condition: string, storage: string) {
  const key = name.trim().toLowerCase()
  const size = normalizeStorage(storage)
  const look = mapBillCondition(condition)
  return products.find(
    (row) =>
      row.name.trim().toLowerCase() === key &&
      (!look || row.condition === look) &&
      normalizeStorage(row.storage || "") === size
  )
}

/**
 * One item on the supplier bill.
 *
 * Each line draws on its own. The whole bill used to redraw on every key
 * pressed, so a bill of 80 lines answered slower with each line added and
 * staff stopped at about ten. A line now redraws only when it changes.
 */
export const BillLine = memo(function BillLine({
  line,
  number,
  canRemove,
  busy,
  brands,
  catalogNames,
  products,
  defaultBrandId,
  defaultCategoryId,
  onChange,
  onRemove,
}: {
  line: BillLineItem
  number: number
  canRemove: boolean
  busy: boolean
  brands: Brand[]
  catalogNames: string[]
  products: BillProduct[]
  defaultBrandId: string
  defaultCategoryId: string
  onChange: (key: string, change: (line: BillLineItem) => BillLineItem) => void
  onRemove: (key: string) => void
}) {
  /**
   * What is typed in How many and not yet settled. Kept apart from the line's
   * quantity so the box can be cleared and retyped without snapping back to 1.
   */
  const [qtyText, setQtyText] = useState<string | null>(null)
  const [manyOpen, setManyOpen] = useState(false)
  const [manyText, setManyText] = useState("")

  const kindWord = line.tracking === "IMEI" ? "IMEI" : "serial"
  const filled = (line.identities || []).filter(Boolean).length

  function patch(change: Partial<BatchUploadItem>) {
    onChange(line.key, (current) => ({ ...current, ...change }))
  }

  function applyName(name: string) {
    onChange(line.key, (current) => {
      if (!name.trim()) return { ...current, productName: "", productId: "", productMode: "existing" }
      const key = name.trim().toLowerCase()
      const sample = products.find((row) => row.name.trim().toLowerCase() === key)
      const variant = findVariant(products, name, current.condition || "", current.storage || "")
      return {
        ...current,
        productName: name,
        productId: variant?.id || "",
        productMode: variant ? "existing" : "new",
        brandId: sample?.brandId || current.brandId || defaultBrandId,
        categoryId: sample?.categoryId || current.categoryId || defaultCategoryId,
        tracking: sample?.tracking || current.tracking || "IMEI",
        costPrice: variant?.costPrice ?? sample?.costPrice ?? current.costPrice,
        minimumPrice: variant?.minimumPrice ?? sample?.minimumPrice ?? current.minimumPrice,
        sellingPrice: variant?.sellingPrice ?? sample?.sellingPrice ?? current.sellingPrice,
      }
    })
  }

  function applyVariant(change: { condition?: string; storage?: string }) {
    onChange(line.key, (current) => {
      const condition = change.condition ?? current.condition ?? ""
      const storage = change.storage !== undefined ? normalizeStorage(change.storage) : current.storage || ""
      const variant = findVariant(products, current.productName || "", condition, storage)
      return {
        ...current,
        condition,
        storage,
        productId: variant?.id || "",
        productMode: variant ? "existing" : "new",
        costPrice: variant?.costPrice ?? current.costPrice,
        minimumPrice: variant?.minimumPrice ?? current.minimumPrice,
        sellingPrice: variant?.sellingPrice ?? current.sellingPrice,
        tracking: variant?.tracking || current.tracking,
      }
    })
  }

  function setQuantity(quantity: number) {
    const safe = Math.max(1, Math.floor(quantity) || 1)
    setQtyText(null)
    patch({ quantity: safe })
  }

  /**
   * Put a whole list of numbers on this line in one go. Boxes already filled
   * stay; the new numbers follow them, a number given twice is kept once, and
   * How many grows to fit. Returns true when at least one number went in.
   */
  function addMany(raw: string) {
    const codes = splitCodes(raw)
    if (!codes.length) {
      toast.error(`Paste or scan the ${kindWord} numbers first.`)
      return false
    }
    const short = codes.filter((code) =>
      line.tracking === "IMEI" ? code.replace(/\D/g, "").length < 14 : code.length < 3
    )
    const good = codes.filter((code) => !short.includes(code))
    const have = (line.identities || []).filter(Boolean)
    const merged = [...new Set([...have, ...good])]
    const added = merged.length - have.length
    const repeats = good.length - added
    if (!added) {
      toast.error(
        short.length
          ? `${short.length} number${short.length === 1 ? " is" : "s are"} too short: ${short.slice(0, 3).join(", ")}. Nothing was added.`
          : "Every one of those numbers is already on this line."
      )
      return false
    }
    onChange(line.key, (current) => ({ ...current, identities: merged, quantity: merged.length }))
    toast.success(
      [
        `${added} number${added === 1 ? "" : "s"} added. Item ${number} now has ${merged.length}.`,
        repeats ? `${repeats} given twice ${repeats === 1 ? "was" : "were"} kept once.` : null,
        short.length ? `${short.length} too short left out: ${short.slice(0, 3).join(", ")}.` : null,
      ]
        .filter(Boolean)
        .join(" ")
    )
    return true
  }

  function changeIdentity(index: number, value: string) {
    onChange(line.key, (current) => {
      const ids = [...(current.identities || [])]
      ids[index] = value.replace(/[\s-]/g, "")
      return { ...current, identities: ids }
    })
  }

  return (
    <div id={`bill-line-${line.key}`} className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          Item {number}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {line.tracking === "IMEI"
              ? "tracked by IMEI"
              : line.tracking === "SERIAL"
                ? "tracked by serial"
                : "counted in pieces"}
          </span>
        </p>
        {canRemove ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-danger hover:bg-danger-soft"
            onClick={() => onRemove(line.key)}
            disabled={busy}
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" /> Remove
          </Button>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-12">
        <label className="block text-sm sm:col-span-8">
          <span className="eyebrow mb-1 block">Item name</span>
          <ItemNameSearch names={catalogNames} value={line.productName || ""} onPick={applyName} disabled={busy} />
          <span className="mt-1 block text-xs text-muted-foreground">
            Only the product name. Condition, storage, cost, and how many sit beside it.
          </span>
        </label>

        <label className="block text-sm sm:col-span-4">
          <span className="eyebrow mb-1 block">Brand</span>
          <Select
            value={line.brandId || ""}
            onChange={(e) => patch({ brandId: e.target.value, productMode: "new", productId: "" })}
            disabled={busy}
            emptyLabel="Add brands on Phones and items first."
            required
          >
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.name}
              </option>
            ))}
          </Select>
        </label>

        <label className="block text-sm sm:col-span-3">
          <span className="eyebrow mb-1 block">Condition</span>
          <Select
            value={line.condition || ""}
            onChange={(e) => applyVariant({ condition: e.target.value })}
            disabled={busy}
            required
          >
            <option value="" disabled>
              Pick Brand New, Brand New (Locked), Brand New (N/A), UK, UK (Locked), Open Box, Standard, or Faulty
            </option>
            {BILL_CONDITION_OPTIONS.map((row) => (
              <option key={row.value} value={row.value}>
                {row.label}
              </option>
            ))}
          </Select>
        </label>

        <label className="block text-sm sm:col-span-3">
          <span className="eyebrow mb-1 block">Storage</span>
          <Select
            value={line.storage || ""}
            onChange={(e) => applyVariant({ storage: e.target.value })}
            disabled={busy}
            required={line.tracking !== "NONE"}
          >
            <option value="">{line.tracking === "NONE" ? "No storage for this item" : "Pick storage"}</option>
            {STORAGE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
            {line.storage && !(STORAGE_OPTIONS as readonly string[]).includes(line.storage) ? (
              <option value={line.storage}>{line.storage}</option>
            ) : null}
          </Select>
        </label>

        <label className="block text-sm sm:col-span-3">
          <span className="eyebrow mb-1 block">Cost price each (₦)</span>
          <Input
            type="number"
            min={0}
            step="0.01"
            value={line.costPrice || ""}
            onChange={(e) => patch({ costPrice: Number(e.target.value) || 0 })}
            required
            disabled={busy}
            className="num"
          />
        </label>

        <div className="block text-sm sm:col-span-3">
          <span className="eyebrow mb-1 block">How many</span>
          {/* Stepper: − | typed number | + */}
          <div className="flex h-10 items-stretch overflow-hidden rounded-md border border-input bg-card shadow-sm focus-within:ring-1 focus-within:ring-ring">
            <button
              type="button"
              aria-label="Remove one"
              disabled={busy || line.quantity <= 1}
              onClick={() => setQuantity(line.quantity - 1)}
              className="flex w-10 shrink-0 items-center justify-center text-lg font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              −
            </button>
            <input
              inputMode="numeric"
              pattern="[0-9]*"
              value={qtyText ?? String(line.quantity)}
              onChange={(e) => setQtyText(e.target.value.replace(/[^0-9]/g, ""))}
              onBlur={(e) => setQuantity(parseInt(e.target.value, 10))}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); setQuantity(parseInt((e.target as HTMLInputElement).value, 10)) }
                if (e.key === "ArrowUp") { e.preventDefault(); setQuantity(line.quantity + 1) }
                if (e.key === "ArrowDown") { e.preventDefault(); setQuantity(line.quantity - 1) }
              }}
              disabled={busy}
              required
              aria-label="How many"
              className="min-w-0 flex-1 bg-transparent text-center text-sm font-semibold tabular-nums focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              style={{ MozAppearance: "textfield" } as React.CSSProperties}
            />
            <button
              type="button"
              aria-label="Add one"
              disabled={busy}
              onClick={() => setQuantity(line.quantity + 1)}
              className="flex w-10 shrink-0 items-center justify-center text-lg font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              +
            </button>
          </div>
        </div>

        <label className="block text-sm sm:col-span-3">
          <span className="eyebrow mb-1 block">Lowest selling price (₦)</span>
          <Input
            type="number"
            min={0}
            step="0.01"
            value={line.minimumPrice || ""}
            onChange={(e) => patch({ minimumPrice: Number(e.target.value) || 0 })}
            disabled={busy}
            className="num"
          />
        </label>
      </div>

      <p className="flex flex-wrap justify-between gap-2 rounded-md bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground">
        <span>
          {line.quantity} × {formatCurrency(line.costPrice || 0)}
        </span>
        <span>
          Line total{" "}
          <strong className="num text-foreground">{formatCurrency((line.quantity || 0) * (line.costPrice || 0))}</strong>
        </span>
      </p>

      {/* One box per unit, opened by the quantity above. */}
      {line.tracking !== "NONE" ? (
        <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="eyebrow">
              Scan or type the {line.quantity} {kindWord === "IMEI" ? "IMEI numbers" : "serial numbers"}
              <span className="ml-2 font-normal normal-case tracking-normal text-muted-foreground">
                {filled} of {line.quantity} filled
              </span>
            </p>
            <Button type="button" size="sm" variant="outline" onClick={() => setManyOpen((open) => !open)} disabled={busy}>
              <ListPlus className="mr-1.5 h-4 w-4" /> {manyOpen ? "Close the list box" : "Add many numbers at once"}
            </Button>
          </div>

          {manyOpen ? (
            <div className="space-y-2 rounded-md border border-dashed border-input bg-card p-3">
              <p className="text-xs text-muted-foreground">
                Paste a list from Excel or WhatsApp, or click in the box and scan one phone after another. One number
                per line. How many grows to fit, so 80 or more go in at once.
              </p>
              <Textarea
                value={manyText}
                onChange={(e) => setManyText(e.target.value)}
                placeholder={kindWord === "IMEI" ? "356789012345678\n356789012345679\n356789012345680" : "One serial number per line"}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                className="min-h-[140px] font-mono text-xs"
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  {splitCodes(manyText).length} number{splitCodes(manyText).length === 1 ? "" : "s"} in the box
                </p>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || !manyText.trim()}
                  onClick={() => {
                    if (!addMany(manyText)) return
                    setManyText("")
                    setManyOpen(false)
                  }}
                >
                  Add these numbers to Item {number}
                </Button>
              </div>
            </div>
          ) : null}

          <div className="grid gap-2 sm:grid-cols-2">
            {Array.from({ length: line.quantity }).map((_, idIdx) => (
              <div key={idIdx} className="flex items-center gap-2">
                <span className="w-7 shrink-0 font-mono text-[11px] text-muted-foreground">{idIdx + 1}.</span>
                <Input
                  placeholder={kindWord === "IMEI" ? "15-digit IMEI" : "Serial number"}
                  value={line.identities?.[idIdx] || ""}
                  onChange={(e) => changeIdentity(idIdx, e.target.value)}
                  onPaste={(event) => {
                    // A list pasted into one box fills the line, not one long number.
                    const text = event.clipboardData.getData("text")
                    if (splitCodes(text).length < 2) return
                    event.preventDefault()
                    addMany(text)
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return
                    event.preventDefault()
                    const form = event.currentTarget.form
                    if (!form) return
                    const boxes = Array.from(form.querySelectorAll<HTMLInputElement>("input[data-scan-box='true']"))
                    const index = boxes.indexOf(event.currentTarget)
                    const next = boxes[index + 1]
                    if (next) next.focus()
                    else event.currentTarget.blur()
                  }}
                  data-scan-box="true"
                  required
                  disabled={busy}
                  autoComplete="off"
                  className="h-9 font-mono text-xs"
                />
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
})
