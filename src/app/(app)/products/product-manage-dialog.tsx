"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { deleteProduct, reduceInventoryStock, updateProduct } from "@/app/actions/catalog"
import { ActionForm } from "@/components/action-form"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { SHOP_CONDITION_OPTIONS } from "@/lib/conditions"
import { TRACKING_OPTIONS, trackingLabel } from "@/lib/unit-identity"
import { formatCurrency } from "@/lib/utils"
import type { PriceRow } from "./price-list"
import { AlertTriangle, ArrowRightLeft, Edit3, MinusCircle, Trash2 } from "lucide-react"
import { MoveUnitsForm } from "@/components/move-units-form"

export function ProductManageDialog({
  product,
  open,
  onOpenChange,
  canRemove = false,
  canPrice = false,
  showCost = false,
  brandNames = [],
  categoryNames = [],
}: {
  product: PriceRow | null
  open: boolean
  onOpenChange: (open: boolean) => void
  canRemove?: boolean
  /** Edit lowest and selling price (the price setters). The cost box also needs showCost. */
  canPrice?: boolean
  showCost?: boolean
  brandNames?: string[]
  categoryNames?: string[]
}) {
  const router = useRouter()
  const [tab, setTab] = useState<"edit" | "stock" | "move" | "delete">("edit")
  const [tracking, setTracking] = useState(product?.tracking ?? "IMEI")
  const [shownFor, setShownFor] = useState(product?.id)

  // The dialog stays mounted between items, so reset the picks when a new item opens.
  if (product && product.id !== shownFor) {
    setShownFor(product.id)
    setTracking(product.tracking)
    setTab("edit")
  }

  if (!product) return null

  const branches = product.inventory ?? []
  const tracked = product.tracking === "IMEI" || product.tracking === "SERIAL"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader className="pr-8">
          <DialogTitle className="text-lg font-bold">
            {canRemove ? `Change or remove: ${product.name}` : `Change: ${product.name}`}
          </DialogTitle>
          <DialogDescription>
            Item code {product.sku}. Brand {product.brand}. {product.units} on the shelf across shops.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 rounded-xl border border-border bg-muted/60 p-1">
          <button
            type="button"
            onClick={() => setTab("edit")}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition-all ${
              tab === "edit"
                ? "bg-primary text-primary-foreground shadow-xs"
                : "text-muted-foreground hover:bg-card hover:text-foreground"
            }`}
          >
            <Edit3 className="h-3.5 w-3.5" />
            <span>Change details</span>
          </button>
          <button
            type="button"
            onClick={() => setTab("stock")}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition-all ${
              tab === "stock"
                ? "bg-primary text-primary-foreground shadow-xs"
                : "text-muted-foreground hover:bg-card hover:text-foreground"
            }`}
          >
            <MinusCircle className="h-3.5 w-3.5" />
            <span>Reduce stock</span>
          </button>
          {tracked ? (
            <button
              type="button"
              onClick={() => setTab("move")}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition-all ${
                tab === "move"
                  ? "bg-primary text-primary-foreground shadow-xs"
                  : "text-muted-foreground hover:bg-card hover:text-foreground"
              }`}
            >
              <ArrowRightLeft className="h-3.5 w-3.5" />
              <span>Move phones</span>
            </button>
          ) : null}
          {canRemove ? (
          <button
            type="button"
            onClick={() => setTab("delete")}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition-all ${
              tab === "delete"
                ? "bg-danger text-danger-foreground shadow-xs"
                : "text-muted-foreground hover:bg-card hover:text-danger"
            }`}
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>Remove</span>
          </button>
          ) : null}
        </div>

        {tab === "edit" ? (
          <ActionForm
            action={async (formData) => {
              const res = await updateProduct(formData)
              if (res && "success" in res && res.success) {
                onOpenChange(false)
                router.refresh()
              }
              return res
            }}
            submit="Save item details"
            onCancel={() => onOpenChange(false)}
            successMessage="Item details saved"
            className="space-y-3 pt-2"
          >
            <input type="hidden" name="id" value={product.id} />
            <div>
              <label className="text-xs font-medium text-muted-foreground">Name</label>
              <Input name="name" defaultValue={product.name} required className="mt-1" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Brand</label>
                <Input name="brandName" list="manage-brand-names" defaultValue={product.brand} required className="mt-1" />
                <datalist id="manage-brand-names">
                  {brandNames.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Category</label>
                <Input
                  name="categoryName"
                  list="manage-category-names"
                  defaultValue={product.category ?? ""}
                  placeholder="Phones, Tablets, Laptops"
                  className="mt-1"
                />
                <datalist id="manage-category-names">
                  {categoryNames.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">How we count it</label>
              <Select name="tracking" value={tracking} onChange={(event) => setTracking(event.target.value)} className="mt-1">
                {TRACKING_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </Select>
              {tracking !== product.tracking ? (
                <p className="mt-1.5 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                  {tracking === "NONE"
                    ? "Every unit of this item with an IMEI or serial must be sold, sent back, or written off first. After this, staff count it by pieces."
                    : product.tracking === "NONE"
                      ? `Every shop must be at 0 pieces first. After this, each unit is received with its ${tracking === "SERIAL" ? "serial number" : "IMEI"}.`
                      : `Units already on the shelf keep the number they were booked with. New units will ask for ${tracking === "SERIAL" ? "a serial number" : "an IMEI"} first, and staff can still pick the other one on each unit.`}
                </p>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  Now: {trackingLabel(product.tracking)}. Pick Serial number for tablets and laptops that have no IMEI.
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Item code</label>
                <Input name="sku" defaultValue={product.sku} required className="mt-1 font-mono" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Condition</label>
                <Select name="condition" defaultValue={product.condition} className="mt-1">
                  {SHOP_CONDITION_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Storage</label>
                <Input name="storage" defaultValue={product.storage ?? ""} placeholder="128GB" className="mt-1" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Memory (RAM)</label>
                <Input name="ram" defaultValue={product.ram ?? ""} placeholder="8GB" className="mt-1" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Color</label>
                <Input name="color" defaultValue={product.color ?? ""} placeholder="Blue" className="mt-1" />
              </div>
            </div>
            {canPrice ? (
              <div className={`grid gap-3 ${showCost ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
                {showCost ? (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Cost</label>
                    <Input name="costPrice" type="number" min={0} step="0.01" defaultValue={product.costPrice} required className="mt-1" />
                  </div>
                ) : null}
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Lowest price</label>
                  <Input name="minimumPrice" type="number" min={0} step="0.01" defaultValue={product.minimumPrice} required className="mt-1" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Selling price</label>
                  <Input name="sellingPrice" type="number" min={0} step="0.01" defaultValue={product.sellingPrice} required className="mt-1" />
                </div>
              </div>
            ) : (
              <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                Lowest {formatCurrency(product.minimumPrice)} · selling {formatCurrency(product.sellingPrice)}
                {showCost ? ` · cost ${formatCurrency(product.costPrice)}` : ""}. The CEO, the main admin or a branch manager changes prices.
              </p>
            )}
            <div>
              <label className="text-xs font-medium text-muted-foreground">Warranty days (0 = no warranty)</label>
              <Input name="warrantyDays" type="number" min={0} step={1} defaultValue={product.warrantyDays} className="mt-1" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Short note about this item</label>
              <Textarea name="description" defaultValue={product.description ?? ""} rows={2} className="mt-1" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Why you are changing it (optional)</label>
              <Input name="reason" placeholder="Wrong brand, tablet has serial not IMEI, new supplier price" className="mt-1" />
            </div>
          </ActionForm>
        ) : null}

        {tab === "move" && tracked ? (
          <div className="space-y-3 pt-2">
            <p className="text-sm text-muted-foreground">
              Phones booked under {product.name} by mistake (the wrong storage, colour or condition)? Move them to the item
              they really are. Their IMEIs stay the same, the shelf counts follow them, and it is all kept on Who did what.
            </p>
            <MoveUnitsForm
              source={{
                id: product.id,
                name: product.name,
                storage: product.storage,
                ram: product.ram ?? null,
                color: product.color,
                condition: product.condition,
              }}
              onDone={() => onOpenChange(false)}
            />
          </div>
        ) : null}

        {tab === "stock" ? (
          <div className="space-y-4 pt-2">
            {tracked ? (
              <p className="rounded-xl border border-info/30 bg-info-soft px-3 py-2 text-xs text-info">
                Booked under the wrong item? Do not write it off here: use <button type="button" className="font-semibold underline" onClick={() => setTab("move")}>Move phones</button> so the phone keeps its IMEI and goes to the right item.
              </p>
            ) : null}
            <div className="rounded-xl border border-border bg-muted/30 p-3 text-xs">
              <p className="font-semibold text-foreground mb-1.5">On the shelf now</p>
              {branches.length ? (
                <div className="space-y-1">
                  {branches.map((b) => (
                    <div key={b.branchId} className="flex justify-between gap-2">
                      <span className="text-muted-foreground">{b.branchName}</span>
                      <span className="font-bold tabular-nums">{b.quantity} in shop</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground">No shop has this item on the shelf yet.</p>
              )}
              {tracked ? (
                <p className="mt-2 text-muted-foreground leading-relaxed">
                  This item is counted by {trackingLabel(product.tracking)}. Scan or type each unit you are writing off. The shelf count moves with those numbers.
                </p>
              ) : (
                <p className="mt-2 text-muted-foreground leading-relaxed">
                  Type how many pieces to take off the shelf, and why.
                </p>
              )}
            </div>

            <ActionForm
              action={async (formData) => {
                const res = await reduceInventoryStock(formData)
                if (res && "success" in res && res.success) {
                  onOpenChange(false)
                  router.refresh()
                }
                return res
              }}
              submit="Reduce stock now"
              onCancel={() => onOpenChange(false)}
              successMessage="Stock reduced"
              className="space-y-3"
            >
              <input type="hidden" name="productId" value={product.id} />
              <div>
                <label className="text-xs font-medium text-muted-foreground">Shop</label>
                <Select name="branchId" required className="mt-1">
                  <option value="">Pick the shop</option>
                  {branches.map((b) => (
                    <option key={b.branchId} value={b.branchId}>
                      {b.branchName} ({b.quantity} on shelf)
                    </option>
                  ))}
                </Select>
              </div>
              {tracked ? (
                <div>
                  <label className="text-xs font-medium text-muted-foreground">IMEI or serial to write off</label>
                  <textarea
                    name="imeis"
                    required
                    rows={4}
                    placeholder="One IMEI or serial per line"
                    className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                  />
                </div>
              ) : (
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Pieces to take off</label>
                  <Input
                    name="reduceBy"
                    type="number"
                    min={1}
                    required
                    placeholder="How many pieces"
                    className="mt-1"
                  />
                </div>
              )}
              <div>
                <label className="text-xs font-medium text-muted-foreground">Why</label>
                <Input
                  name="reason"
                  required
                  placeholder="Damaged screen, lost unit, or count correction"
                  className="mt-1"
                />
              </div>
            </ActionForm>
          </div>
        ) : null}

        {tab === "delete" && canRemove ? (
          <div className="space-y-4 pt-2">
            <div className="rounded-xl border border-danger/30 bg-danger-soft p-4 text-xs text-danger">
              <div className="flex items-center gap-2 font-bold mb-1">
                <AlertTriangle className="h-4 w-4" />
                <span>Remove this item from the active list</span>
              </div>
              <p className="leading-relaxed">
                If this item has sales, purchases, phone numbers, or stock left, it is hidden from Sell now and the price list so the books stay complete.
              </p>
              <p className="mt-1.5 leading-relaxed">
                If it was added by mistake and never used, it is deleted for good.
              </p>
            </div>

            <ActionForm
              action={async (formData) => {
                const res = await deleteProduct(formData)
                if (res && "success" in res && res.success) {
                  onOpenChange(false)
                  router.refresh()
                }
                return res
              }}
              submit="Remove this item"
              onCancel={() => onOpenChange(false)}
              successMessage="Item removed from the active list"
              confirmModal={{
                title: `Remove ${product.name}?`,
                description: "If it has history or stock, it is hidden. If it was never used, it is deleted for good.",
                confirmLabel: "Remove this item",
                tone: "danger",
              }}
              className="space-y-3"
            >
              <input type="hidden" name="id" value={product.id} />
              <p className="text-xs text-muted-foreground">
                Removing <strong>{product.name}</strong> ({product.sku}).
              </p>
            </ActionForm>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
