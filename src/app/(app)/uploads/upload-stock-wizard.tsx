"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { PlusCircle, CheckCircle2, PackagePlus } from "lucide-react"
import { toast } from "sonner"
import { batchUploadStock, type BatchUploadPayload, type UploadResult } from "@/app/actions/uploads"
import { BrandBusyOverlay } from "@/components/brand-busy-overlay"
import { preventEnterFromSubmitting } from "@/components/scan-field"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { listedSupplierClash } from "@/lib/party-key"
import { isOpeningStockSupplierName } from "@/lib/upload-purchase"
import { formatCurrency, generateDocNumber } from "@/lib/utils"
import { BillLine, fitIdentities, type BillLineItem, type BillProduct } from "./bill-line"

type Shop = { id: string; name: string; code: string }
type Supplier = { id: string; name: string; phone?: string | null; city: string | null; country: string | null }
type Brand = { id: string; name: string }
type Category = { id: string; name: string }
type Product = BillProduct

function blankLine(key: string, defaults?: { brandId?: string; categoryId?: string }): BillLineItem {
  return {
    key,
    productMode: "existing",
    productId: "",
    productName: "",
    brandId: defaults?.brandId || "",
    categoryId: defaults?.categoryId || "",
    condition: "",
    storage: "",
    costPrice: 0,
    minimumPrice: 0,
    sellingPrice: 0,
    quantity: 1,
    tracking: "IMEI",
    identities: [""],
  }
}

const SUPPLIER_BILL_PHASES = [
  "Checking each IMEI and serial on this bill",
  "Folding any duplicate numbers into one entry",
  "Booking phones onto the shelf",
  "Adding piece counts where there is no IMEI",
  "Saving the supplier bill and what is still owed",
]

export function UploadStockWizard({
  shops,
  suppliers,
  brands,
  categories,
  products,
  defaultInvoiceNumber,
  defaultUploadDate,
}: {
  shops: Shop[]
  suppliers: Supplier[]
  brands: Brand[]
  categories: Category[]
  products: Product[]
  /**
   * Both of these are worked out on the server and handed down.
   *
   * They used to be worked out during render with Date.now(), Math.random() and
   * the browser clock, so the server wrote one bill number into the HTML and the
   * browser drew a different one a moment later, and React threw the whole tree
   * away. The number only has to change per visit, not per render, so the server
   * is the right place to make it.
   */
  defaultInvoiceNumber: string
  defaultUploadDate: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [softNotes, setSoftNotes] = useState<string[]>([])
  const defaultBrandId = brands[0]?.id || ""
  const defaultCategoryId =
    categories.find((row) => /phone/i.test(row.name))?.id || categories[0]?.id || ""

  const catalogNames = useMemo(() => {
    const seen = new Set<string>()
    const names: string[] = []
    for (const row of products) {
      const name = row.name.trim()
      const key = name.toLowerCase()
      if (!name || seen.has(key)) continue
      seen.add(key)
      names.push(name)
    }
    return names
  }, [products])

  // Header state
  const [invoiceNumber, setInvoiceNumber] = useState(defaultInvoiceNumber)
  const [uploadDate, setUploadDate] = useState(defaultUploadDate)
  const [branchId, setBranchId] = useState(shops[0]?.id || "")
  // Opening stock is never a supplier on a bill, so it is not on the list and
  // must not be the one picked to begin with. When it sat first, the list
  // showed the next supplier while the bill was sent under Opening stock, and
  // the upload was refused.
  const listedSuppliers = useMemo(
    () => suppliers.filter((supplier) => !isOpeningStockSupplierName(supplier.name)),
    [suppliers]
  )
  const [supplierMode, setSupplierMode] = useState<"existing" | "new">(listedSuppliers.length ? "existing" : "new")
  const [supplierId, setSupplierId] = useState(listedSuppliers[0]?.id || "")
  const [newSupplierName, setNewSupplierName] = useState("")
  const [newSupplierPhone, setNewSupplierPhone] = useState("")
  const [newSupplierCountry, setNewSupplierCountry] = useState("")
  const [newSupplierCity, setNewSupplierCity] = useState("")
  const [notes, setNotes] = useState("")

  // Item Lines state
  const lineSeq = useRef(1)
  const [items, setItems] = useState<BillLineItem[]>([
    blankLine("line-0", { brandId: defaultBrandId, categoryId: defaultCategoryId }),
  ])

  // Payment state
  const [amountPaid, setAmountPaid] = useState<number>(0)

  // Calculations
  const totalInvoiceValue = items.reduce((sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.costPrice) || 0), 0)
  const balanceOwed = Math.max(0, totalInvoiceValue - amountPaid)
  const isFullyPaid = totalInvoiceValue > 0 && amountPaid >= totalInvoiceValue

  // Both stay the same from one draw to the next, so a line that did not
  // change is not drawn again when another line is typed in.
  const changeLine = useCallback((key: string, change: (line: BillLineItem) => BillLineItem) => {
    setItems((prev) => prev.map((line) => (line.key === key ? fitIdentities(change(line)) : line)))
  }, [])

  const removeLine = useCallback((key: string) => {
    setItems((prev) => (prev.length <= 1 ? prev : prev.filter((line) => line.key !== key)))
  }, [])

  function addItemLine() {
    const key = `line-${lineSeq.current++}`
    setItems((prev) => [...prev, blankLine(key, { brandId: defaultBrandId, categoryId: defaultCategoryId })])
    // On a long bill the new line is far below the button at the top.
    requestAnimationFrame(() => document.getElementById(`bill-line-${key}`)?.scrollIntoView({ block: "center", behavior: "smooth" }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!branchId) {
      toast.error("Pick the shop these goods are going to.")
      return
    }
    if (supplierMode === "existing" && !supplierId) {
      toast.error("Pick the supplier.")
      return
    }
    if (supplierMode === "new") {
      if (!newSupplierName.trim()) {
        toast.error("Type the name of the new supplier.")
        return
      }
      if (!newSupplierPhone.trim()) {
        toast.error("Type the new supplier phone number.")
        return
      }
      const clash = listedSupplierClash(suppliers, newSupplierName, newSupplierPhone)
      if (clash) {
        toast.error(clash)
        return
      }
    }

    // Validate IMEI rows
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (!item.productName?.trim()) {
        toast.error(`Item line #${i + 1}: type the name of the item, then pick it.`)
        return
      }
      if (!item.condition) {
        toast.error(`Item line #${i + 1}: pick How the phone looks from Brand New, Brand New (Locked), Brand New (N/A), UK, UK (Locked), Open Box, Standard, or Faulty.`)
        return
      }
      if (item.tracking !== "NONE" && !item.storage) {
        toast.error(`Item line #${i + 1}: pick the storage size.`)
        return
      }
      if (!item.brandId) {
        toast.error(`Item line #${i + 1}: pick the brand.`)
        return
      }
      if (item.tracking !== "NONE") {
        const ids = (item.identities || []).filter(Boolean)
        if (ids.length < item.quantity) {
          toast.error(`Item line #${i + 1} is missing ${item.quantity - ids.length} ${item.tracking === "IMEI" ? "IMEI" : "serial"} numbers.`)
          return
        }
      }
    }

    setBusy(true)
    setSoftNotes([])
    const payload: BatchUploadPayload = {
      branchId,
      supplierId: supplierMode === "existing" ? supplierId : undefined,
      newSupplierName: supplierMode === "new" ? newSupplierName.trim() : undefined,
      newSupplierPhone: supplierMode === "new" ? newSupplierPhone.trim() : undefined,
      newSupplierCountry: supplierMode === "new" ? newSupplierCountry.trim() : undefined,
      newSupplierCity: supplierMode === "new" ? newSupplierCity.trim() : undefined,
      invoiceNumber,
      uploadDate,
      amountPaid,
      notes: notes.trim() || undefined,
      items: items.map((line) => {
        const item: BatchUploadPayload["items"][number] & { key?: string } = { ...line }
        delete item.key
        return item
      }),
    }

    let result: UploadResult
    try {
      const UPLOAD_TIMEOUT_MS = 90_000
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), UPLOAD_TIMEOUT_MS)
      )
      result = await Promise.race([batchUploadStock(payload), timeoutPromise])
    } catch (err) {
      setBusy(false)
      const isTimeout = err instanceof Error && err.message === "timeout"
      toast.error(
        isTimeout
          ? "The upload is taking too long. The network may have dropped. Wait a moment and try again — duplicates are handled automatically."
          : "That did not reach the shop system. Check your network and try again."
      )
      return
    }
    setBusy(false)

    if (result.error) {
      toast.error(result.error)
      return
    }

    const soft = [
      result.duplicates ? `${result.duplicates} duplicate number(s) counted once` : null,
      result.skipped ? `${result.skipped} already on the system left as they are` : null,
    ].filter(Boolean)
    toast.success(
      [
        `Stock uploaded on ${result.invoiceNumber}`,
        result.phones ? `${result.phones} phones booked` : null,
        result.pieces ? `${result.pieces} pieces added` : null,
        result.paid ? "Fully settled" : `Owed ${formatCurrency(result.balanceOwed ?? 0)}`,
        ...soft,
      ]
        .filter(Boolean)
        .join(". ") + "."
    )
    setSoftNotes(result.problems ?? [])

    // Reset form with new PO
    setInvoiceNumber(generateDocNumber("PO"))
    setAmountPaid(0)
    setNotes("")
    setItems([blankLine(`line-${lineSeq.current++}`, { brandId: defaultBrandId, categoryId: defaultCategoryId })])
    router.refresh()
  }

  const unitCount = items.reduce((sum, item) => sum + (item.quantity || 0), 0)
  const shop = shops.find((row) => row.id === branchId)
  const shopLabel = shop ? `${shop.name} (${shop.code})` : "this shop"

  return (
    <form
      onSubmit={handleSubmit}
      onKeyDown={preventEnterFromSubmitting}
      className="surface-card overflow-visible"
    >
      <BrandBusyOverlay
        open={busy}
        title={`Uploading new stock to ${shopLabel}`}
        detail={`Booking ${unitCount} unit${unitCount === 1 ? "" : "s"} on supplier bill ${invoiceNumber}.`}
        phases={SUPPLIER_BILL_PHASES}
      />
      {/*
        The bill the client described: supplier at the top, the generated bill
        number and the date beside it, the item lines with cost, quantity and an
        IMEI box per unit, and the amount paid at the bottom working out what is
        left. No paid / not-paid buttons anywhere.
      */}
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border bg-muted/40 px-5 py-4">
        <div>
          <p className="eyebrow">Supplier bill</p>
          <h2 className="text-base font-semibold tracking-tight">Put a carton of goods on the system</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Type the product name, pick it, then fill condition and storage yourself. Scanning an IMEI only fills that box. It does not save until you press Upload this stock.
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card px-4 py-2 text-right">
          <p className="eyebrow">Bill number</p>
          <p className="font-mono text-sm font-semibold text-primary">{invoiceNumber}</p>
        </div>
      </header>

      <div className="space-y-6 p-5">
        <section className="space-y-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
              1
            </span>
            Supplier, shop and date
          </h3>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-sm">
              <span className="eyebrow mb-1 block">Which shop the goods go to</span>
              <Select value={branchId} onChange={(e) => setBranchId(e.target.value)} required disabled={busy}>
                {shops.map((shop) => (
                  <option key={shop.id} value={shop.id}>
                    {shop.name} ({shop.code})
                  </option>
                ))}
              </Select>
            </label>

            <label className="block text-sm">
              <span className="eyebrow mb-1 block">Date of this upload</span>
              <Input type="date" value={uploadDate} onChange={(e) => setUploadDate(e.target.value)} required disabled={busy} />
            </label>

            <div className="text-sm">
              <span className="eyebrow mb-1 block">Supplier</span>
              <div className="inline-flex w-full rounded-lg bg-muted p-0.5">
                <button
                  type="button"
                  onClick={() => setSupplierMode("existing")}
                  disabled={busy || listedSuppliers.length === 0}
                  className={`flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
                    supplierMode === "existing" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
                  }`}
                >
                  Already on the books
                </button>
                <button
                  type="button"
                  onClick={() => setSupplierMode("new")}
                  disabled={busy}
                  className={`flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
                    supplierMode === "new" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
                  }`}
                >
                  New supplier
                </button>
              </div>
            </div>
          </div>

          {supplierMode === "existing" ? (
            <label className="block text-sm">
              <span className="eyebrow mb-1 block">Which supplier</span>
              <Select
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                required
                disabled={busy || listedSuppliers.length === 0}
                emptyLabel="No supplier is on the list yet. Choose New supplier."
              >
                {listedSuppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                    {supplier.city || supplier.country
                      ? ` · ${[supplier.city, supplier.country].filter(Boolean).join(", ")}`
                      : ""}
                  </option>
                ))}
              </Select>
            </label>
          ) : (
            <div className="grid gap-3 rounded-lg border border-dashed border-input p-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="eyebrow mb-1 block">Supplier name</span>
                <Input
                  placeholder="e.g. Shenzhen Tech Link"
                  value={newSupplierName}
                  onChange={(e) => setNewSupplierName(e.target.value)}
                  required
                  disabled={busy}
                />
              </label>
              <label className="block text-sm">
                <span className="eyebrow mb-1 block">Phone</span>
                <Input
                  value={newSupplierPhone}
                  onChange={(e) => setNewSupplierPhone(e.target.value)}
                  required
                  disabled={busy}
                  placeholder="Supplier phone number"
                />
              </label>
              <label className="block text-sm">
                <span className="eyebrow mb-1 block">Country</span>
                <Input
                  placeholder="e.g. China, UAE, Nigeria"
                  value={newSupplierCountry}
                  onChange={(e) => setNewSupplierCountry(e.target.value)}
                  disabled={busy}
                />
              </label>
              <label className="block text-sm">
                <span className="eyebrow mb-1 block">City or market</span>
                <Input
                  placeholder="e.g. Shenzhen, Dubai, Lagos"
                  value={newSupplierCity}
                  onChange={(e) => setNewSupplierCity(e.target.value)}
                  disabled={busy}
                />
              </label>
            </div>
          )}
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                2
              </span>
              What is on this bill
            </h3>
            <Button type="button" size="sm" variant="outline" onClick={addItemLine} disabled={busy}>
              <PlusCircle className="mr-1.5 h-4 w-4" /> Add another item
            </Button>
          </div>

          <div className="space-y-3">
            {items.map((item, itemIdx) => (
              <BillLine
                key={item.key}
                line={item}
                number={itemIdx + 1}
                canRemove={items.length > 1}
                busy={busy}
                brands={brands}
                catalogNames={catalogNames}
                products={products}
                defaultBrandId={defaultBrandId}
                defaultCategoryId={defaultCategoryId}
                onChange={changeLine}
                onRemove={removeLine}
              />
            ))}
          </div>

          {/* The same button again under the last line, so a long bill is not scrolled back to the top for every item. */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-input px-4 py-3">
            <p className="text-sm text-muted-foreground">
              {items.length} item{items.length === 1 ? "" : "s"} and {unitCount} unit{unitCount === 1 ? "" : "s"} on this bill so far. Add as many as the bill has.
            </p>
            <Button type="button" size="sm" variant="outline" onClick={addItemLine} disabled={busy}>
              <PlusCircle className="mr-1.5 h-4 w-4" /> Add another item
            </Button>
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
              3
            </span>
            Payment
          </h3>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-border p-4">
              <p className="eyebrow">What this whole bill is worth</p>
              <p className="mt-1 text-2xl font-semibold num">{formatCurrency(totalInvoiceValue)}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                From {items.length} line{items.length === 1 ? "" : "s"}, {unitCount} unit{unitCount === 1 ? "" : "s"}
              </p>
            </div>

            <div className="rounded-lg border border-border p-4">
              <label className="block">
                <span className="eyebrow mb-1 block">What you are paying now (₦)</span>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={amountPaid || ""}
                  onChange={(e) => setAmountPaid(Math.max(0, Number(e.target.value) || 0))}
                  placeholder="0.00"
                  disabled={busy}
                  className="text-lg font-semibold num"
                />
              </label>
              <div className="mt-2 flex gap-3 text-xs">
                <button type="button" onClick={() => setAmountPaid(totalInvoiceValue)} className="font-medium text-primary hover:underline">
                  Paid in full
                </button>
                <button type="button" onClick={() => setAmountPaid(0)} className="font-medium text-muted-foreground hover:underline">
                  Nothing paid yet
                </button>
              </div>
            </div>

            <div className={`rounded-lg border p-4 ${isFullyPaid ? "border-success/30 bg-success-soft" : "border-border"}`}>
              <p className="eyebrow">What is still to be paid</p>
              <p className={`mt-1 text-2xl font-semibold num ${balanceOwed > 0 ? "text-warning" : "text-success"}`}>
                {formatCurrency(balanceOwed)}
              </p>
              <p className="mt-1 text-xs">
                {isFullyPaid ? (
                  <span className="inline-flex items-center gap-1 font-medium text-success">
                    <CheckCircle2 className="h-3.5 w-3.5" /> This bill is fully cleared
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    {amountPaid > 0 ? "Part paid." : "Nothing paid."} The balance stays owed on Goods from supplier.
                  </span>
                )}
              </p>
            </div>
          </div>

          <label className="block text-sm">
            <span className="eyebrow mb-1 block">Note, or the carton number</span>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Example: carton 4 from the Dubai cargo, waybill 88392"
              disabled={busy}
            />
          </label>
        </section>
      </div>

      {softNotes.length ? (
        <div className="border-t border-border px-5 py-3">
          <div className="rounded-lg border border-border bg-muted/40 p-3">
            <p className="text-sm font-semibold text-foreground">
              Upload completed. Duplicates were folded into one entry, or numbers already on the system were left as they are. You can edit stock later on Phones and items or Correct and close opening stock.
            </p>
            <ul className="mt-2 space-y-1">
              {softNotes.map((note) => (
                <li key={note} className="text-sm text-muted-foreground">
                  {note}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/40 px-5 py-3.5">
        <p className="text-sm text-muted-foreground">
          Ready to book <strong className="text-foreground">{unitCount}</strong> unit{unitCount === 1 ? "" : "s"} worth{" "}
          <strong className="text-foreground num">{formatCurrency(totalInvoiceValue)}</strong>
        </p>
        <Button type="submit" size="lg" disabled={busy || totalInvoiceValue <= 0}>
          {busy ? (
            "Uploading this stock"
          ) : (
            <>
              <PackagePlus className="mr-2 h-4 w-4" /> Upload this stock
            </>
          )}
        </Button>
      </footer>
    </form>
  )
}
