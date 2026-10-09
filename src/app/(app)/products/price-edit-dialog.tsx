"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { setProductPrices } from "@/app/actions/catalog"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { formatCurrency } from "@/lib/utils"
import type { PriceRow } from "./price-list"

/**
 * Cost, lowest and selling price for one item, from Prices on a price list
 * line. For a price setter who does not edit the rest of the item (a branch
 * manager): Change on the line is for catalog staff.
 */
export function PriceEditDialog({
  product,
  onOpenChange,
}: {
  product: PriceRow | null
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={Boolean(product)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {product ? <PriceEditForm key={product.id} product={product} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function PriceEditForm({ product, onDone }: { product: PriceRow; onDone: () => void }) {
  const router = useRouter()
  const [cost, setCost] = useState(String(product.costPrice))
  const [lowest, setLowest] = useState(String(product.minimumPrice))
  const [selling, setSelling] = useState(String(product.sellingPrice))
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)

  const typed = { cost: Number(cost), lowest: Number(lowest), selling: Number(selling) }
  const changed =
    typed.cost !== product.costPrice || typed.lowest !== product.minimumPrice || typed.selling !== product.sellingPrice
  const underCost = typed.cost > 0 && typed.lowest < typed.cost

  async function save() {
    setBusy(true)
    const result = await setProductPrices({
      id: product.id,
      costPrice: typed.cost,
      minimumPrice: typed.lowest,
      sellingPrice: typed.selling,
      reason,
      from: "price-list",
    })
    setBusy(false)
    if ("error" in result && result.error) {
      toast.error(result.error)
      return
    }
    toast.success(("message" in result && result.message) || "Prices saved.")
    onDone()
    router.refresh()
  }

  const field = (label: string, value: string, set: (value: string) => void) => (
    <label className="block min-w-0 text-xs">
      <span className="mb-1 block font-medium text-muted-foreground">{label}</span>
      <Input
        type="number"
        inputMode="decimal"
        min={0}
        step="0.01"
        value={value}
        onChange={(event) => set(event.target.value)}
        className="tabular-nums"
        aria-label={`${label} for ${product.name}`}
      />
    </label>
  )

  return (
    <>
      <DialogHeader className="pr-8">
        <DialogTitle className="text-lg font-bold">Prices: {product.name}</DialogTitle>
        <DialogDescription>
          Item code {product.sku}. Now cost {formatCurrency(product.costPrice)}, lowest{" "}
          {formatCurrency(product.minimumPrice)}, selling {formatCurrency(product.sellingPrice)}. The new prices apply
          in every shop.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3 pt-2">
        <div className="grid grid-cols-3 gap-2">
          {field("Cost", cost, setCost)}
          {field("Lowest", lowest, setLowest)}
          {field("Selling", selling, setSelling)}
        </div>
        {underCost ? (
          <p className="text-xs text-warning">The lowest price is under cost, so staff could sell at a loss.</p>
        ) : null}
        <label className="block text-xs">
          <span className="mb-1 block font-medium text-muted-foreground">Why you are changing it (optional)</span>
          <Input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="New supplier price, market moved"
          />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button type="button" disabled={!changed || busy} onClick={save}>
            {busy ? "Saving" : "Save prices"}
          </Button>
        </div>
      </div>
    </>
  )
}
