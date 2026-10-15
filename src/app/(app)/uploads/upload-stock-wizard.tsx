"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { PlusCircle, CheckCircle2, FileSpreadsheet, PackageCheck, PackagePlus, Truck } from "lucide-react"
import { toast } from "sonner"
import { batchUploadStock, readBillWorkbook, type BatchUploadPayload, type UploadResult } from "@/app/actions/uploads"
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

const ON_THE_WAY_PHASES = [
  "Checking each IMEI and serial on this bill",
  "Folding any duplicate numbers into one entry",
  "Recording the goods as still on the way",
  "Keeping them off the shelf until they are received",
  "Saving the supplier bill and what is still owed",
]

/** A bill already on the system that more items are being added to. */
type BillToContinue = { invoiceNumber: string; supplierId: string; branchId: string; supplierName: string }

export function UploadStockWizard({
  shops,
  suppliers,
  payingBanks,
  brands,
  categories,
  products,
  defaultInvoiceNumber,
  defaultUploadDate,
  startOnTheWay = false,
  continueBill,
}: {
  shops: Shop[]
  suppliers: Supplier[]
  /** Our bank accounts a transfer to the supplier can leave from. */
  payingBanks: Array<{ id: string; label: string }>
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
  /**
   * Open with "still on the way" already picked. Book goods coming uses the
   * same bill, so cost, shipping fee and selling prices go in before the
   * goods land.
   */
  startOnTheWay?: boolean
  /** Open on a bill already on the system, to add more of its items. */
  continueBill?: BillToContinue
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
  // One physical invoice is one bill, however many sittings it takes. While
  // `continuing` is set, everything saved goes onto that bill.
  const [continuing, setContinuing] = useState<BillToContinue | null>(continueBill ?? null)
  const [lastSaved, setLastSaved] = useState<BillToContinue | null>(null)
  const [invoiceNumber, setInvoiceNumber] = useState(continueBill?.invoiceNumber ?? defaultInvoiceNumber)
  const [uploadDate, setUploadDate] = useState(defaultUploadDate)
  const [branchId, setBranchId] = useState(continueBill?.branchId || shops[0]?.id || "")
  // Opening stock is never a supplier on a bill, so it is not on the list and
  // must not be the one picked to begin with. When it sat first, the list
  // showed the next supplier while the bill was sent under Opening stock, and
  // the upload was refused.
  const listedSuppliers = useMemo(
    () => suppliers.filter((supplier) => !isOpeningStockSupplierName(supplier.name)),
    [suppliers]
  )
  const [supplierMode, setSupplierMode] = useState<"existing" | "new">(listedSuppliers.length ? "existing" : "new")
  const [supplierId, setSupplierId] = useState(continueBill?.supplierId || listedSuppliers[0]?.id || "")
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
  const [shippingFee, setShippingFee] = useState<number>(0)
  // How what is paid now left us: a transfer from a named bank, or cash.
  const [payMethod, setPayMethod] = useState<"TRANSFER" | "CASH">("TRANSFER")
  const [payBankId, setPayBankId] = useState("")

  // Arrival state: in the shop now, or still on the way
  const [onTheWay, setOnTheWay] = useState(startOnTheWay)
  const [expectedDate, setExpectedDate] = useState("")

  // Calculations. The shipping fee is inside the uploaded value but is not the
  // supplier's money, so it comes off before working out what the supplier is due.
  const totalInvoiceValue = items.reduce((sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.costPrice) || 0), 0)
  const shippingTooHigh = shippingFee > totalInvoiceValue + 0.005
  const payable = Math.max(0, totalInvoiceValue - shippingFee)
  const balanceOwed = Math.max(0, payable - amountPaid)
  const payingTooMuch = amountPaid > payable + 0.005
  const isFullyPaid = payable > 0 && amountPaid >= payable - 0.005

  // Both stay the same from one draw to the next, so a line that did not
  // change is not drawn again when another line is typed in.
  const changeLine = useCallback((key: string, change: (line: BillLineItem) => BillLineItem) => {
    setItems((prev) => prev.map((line) => (line.key === key ? fitIdentities(change(line)) : line)))
  }, [])

  const removeLine = useCallback((key: string) => {
    setItems((prev) => (prev.length <= 1 ? prev : prev.filter((line) => line.key !== key)))
  }, [])

  // Fill the bill from a supplier's Excel sheet
  const sheetInput = useRef<HTMLInputElement>(null)
  const [readingSheet, setReadingSheet] = useState(false)
  const [sheetProblems, setSheetProblems] = useState<string[]>([])
  const [sheetNotes, setSheetNotes] = useState<string[]>([])

  /**
   * Read a sheet into lines on this bill. Nothing is saved: the lines land on
   * the form to be checked, and the bill is uploaded the usual way after.
   */
  async function fillFromSheet(file: File) {
    setReadingSheet(true)
    setSheetProblems([])
    setSheetNotes([])
    const data = new FormData()
    data.set("file", file)
    let result: Awaited<ReturnType<typeof readBillWorkbook>>
    try {
      result = await readBillWorkbook(data)
    } catch {
      setReadingSheet(false)
      toast.error("That sheet did not reach the shop system. Check your network and try again.")
      return
    }
    setReadingSheet(false)
    if (result.error || !result.lines) {
      setSheetProblems(result.problems ?? [])
      toast.error(result.error ?? "We could not read that sheet.")
      return
    }
    const fromSheet = result.lines.map((line) =>
      fitIdentities({
        ...blankLine(`line-${lineSeq.current++}`, { brandId: defaultBrandId, categoryId: defaultCategoryId }),
        ...line,
        categoryId: line.categoryId || defaultCategoryId,
      })
    )
    // Lines already typed stay; an untouched empty line makes way for the sheet.
    setItems((prev) => [...prev.filter((line) => line.productName?.trim()), ...fromSheet])
    setSheetNotes(result.notes ?? [])
    const units = fromSheet.reduce((sum, line) => sum + line.quantity, 0)
    toast.success(
      `${fromSheet.length} item${fromSheet.length === 1 ? "" : "s"} and ${units} unit${units === 1 ? "" : "s"} filled in from ${result.fileName}. Check them, then upload.`
    )
  }

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

    if (shippingTooHigh) {
      toast.error(`The shipping fee is more than everything on this bill (${formatCurrency(totalInvoiceValue)}). Check the figure.`)
      return
    }
    if (amountPaid > 0 && payMethod === "TRANSFER" && !payBankId) {
      toast.error("Pick the bank account the transfer to the supplier was sent from.")
      return
    }
    if (payingTooMuch) {
      toast.error(`You are paying more than is payable to the supplier (${formatCurrency(payable)}). Lower what you are paying now.`)
      return
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
      paymentMethod: amountPaid > 0 ? payMethod : undefined,
      bankAccountId: amountPaid > 0 && payMethod === "TRANSFER" ? payBankId : undefined,
      shippingFee,
      onTheWay,
      expectedDate: onTheWay && expectedDate ? expectedDate : undefined,
      notes: notes.trim() || undefined,
      items: items.map((line) => {
        const item: BatchUploadPayload["items"][number] & { key?: string } = { ...line }
        delete item.key
        return item
      }),
    }

    let result: UploadResult
    try {
      // The server allows a bill three minutes. Giving up sooner on this side
      // told staff a long bill had failed while it was still being saved.
      const UPLOAD_TIMEOUT_MS = 175_000
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), UPLOAD_TIMEOUT_MS)
      )
      result = await Promise.race([batchUploadStock(payload), timeoutPromise])
    } catch (err) {
      setBusy(false)
      const isTimeout = err instanceof Error && err.message === "timeout"
      toast.error(
        isTimeout
          ? `No answer from the shop system after 3 minutes. Open Goods from supplier and look for ${invoiceNumber} before trying again: it may have saved. If it is there, add only what is missing to it.`
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
        result.addedToBill
          ? `Added to bill ${result.invoiceNumber}${result.onTheWay ? " as goods on the way" : ""}`
          : result.onTheWay
            ? `Booked as goods on the way on ${result.invoiceNumber}. Nothing can be sold until it is received on Goods on the way`
            : `Stock uploaded on ${result.invoiceNumber}`,
        result.phones ? `${result.phones} phones ${result.onTheWay ? "expected" : "booked"}` : null,
        result.pieces ? `${result.pieces} pieces ${result.onTheWay ? "expected" : "added"}` : null,
        result.shippingFee ? `Shipping fee ${formatCurrency(result.shippingFee)} taken off, so ${formatCurrency(result.payable ?? 0)} is payable to the supplier` : null,
        result.paid ? "Fully settled" : `Owed ${formatCurrency(result.balanceOwed ?? 0)}`,
        ...soft,
      ]
        .filter(Boolean)
        .join(". ") + "."
    )
    setSoftNotes(result.problems ?? [])

    // Ready for the next lot. The bill just saved can take more of the same
    // invoice's items: the panel at the top offers it, and staying on it is one tap.
    const savedTo: BillToContinue = {
      invoiceNumber: result.invoiceNumber ?? invoiceNumber,
      supplierId: result.supplierId ?? supplierId,
      branchId,
      supplierName:
        listedSuppliers.find((row) => row.id === (result.supplierId ?? supplierId))?.name ?? (newSupplierName.trim() || "this supplier"),
    }
    setLastSaved(savedTo)
    if (continuing) {
      setContinuing(savedTo)
      setInvoiceNumber(savedTo.invoiceNumber)
    } else {
      setInvoiceNumber(generateDocNumber("PO"))
    }
    setAmountPaid(0)
    setShippingFee(0)
    setPayBankId("")
    setOnTheWay(startOnTheWay)
    setExpectedDate("")
    setNotes("")
    setItems([blankLine(`line-${lineSeq.current++}`, { brandId: defaultBrandId, categoryId: defaultCategoryId })])
    setSheetProblems([])
    setSheetNotes([])
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
        title={onTheWay ? `Booking goods on the way to ${shopLabel}` : `Uploading new stock to ${shopLabel}`}
        detail={`Booking ${unitCount} unit${unitCount === 1 ? "" : "s"} on supplier bill ${invoiceNumber}.`}
        phases={onTheWay ? ON_THE_WAY_PHASES : SUPPLIER_BILL_PHASES}
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
          <h2 className="text-base font-semibold tracking-tight">
            {onTheWay ? "Put goods still on the way on the system" : "Put a carton of goods on the system"}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {onTheWay
              ? "Fill in everything now: each item, its cost, its selling price, the shipping fee and what was paid. Nothing reaches the shelf or the till until the goods are received on Goods on the way."
              : "Type the product name, pick it, then fill condition and storage yourself. Scanning an IMEI only fills that box. It does not save until you press Upload this stock."}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card px-4 py-2 text-right">
          <p className="eyebrow">{continuing ? "Adding to bill" : "Bill number"}</p>
          <p className="font-mono text-sm font-semibold text-primary">{invoiceNumber}</p>
        </div>
      </header>

      {continuing ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-primary/20 bg-primary/5 px-5 py-3 text-sm">
          <p>
            Everything you save now goes onto bill <span className="font-mono font-semibold">{continuing.invoiceNumber}</span>{" "}
            from <span className="font-semibold">{continuing.supplierName}</span>, the same as the paper invoice. Save as
            often as you like.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setContinuing(null)
              setInvoiceNumber(generateDocNumber("PO"))
            }}
          >
            Start a new bill instead
          </Button>
        </div>
      ) : lastSaved ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-success/30 bg-success-soft px-5 py-3 text-sm">
          <p>
            Saved on bill <span className="font-mono font-semibold">{lastSaved.invoiceNumber}</span>. More items from the same
            paper invoice? Keep them on that one bill.
          </p>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => {
              setContinuing(lastSaved)
              setInvoiceNumber(lastSaved.invoiceNumber)
              setBranchId(lastSaved.branchId)
              setSupplierMode("existing")
              setSupplierId(lastSaved.supplierId)
            }}
          >
            Add more items to {lastSaved.invoiceNumber}
          </Button>
        </div>
      ) : null}

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
              <Select value={branchId} onChange={(e) => setBranchId(e.target.value)} required disabled={busy || Boolean(continuing)}>
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
                  disabled={busy || Boolean(continuing)}
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
                disabled={busy || listedSuppliers.length === 0 || Boolean(continuing)}
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

          {/*
            The client asked to load a bill before the goods land, so the value
            still expected is known. The same bill, the same lines; only where
            the goods are differs.
          */}
          <div className="rounded-lg border border-border p-3">
            <p className="eyebrow mb-2">Have these goods reached the shop?</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setOnTheWay(false)}
                disabled={busy}
                aria-pressed={!onTheWay}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  !onTheWay ? "border-primary bg-primary/5" : "border-border hover:bg-accent"
                }`}
              >
                <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <PackageCheck className="h-4 w-4 text-primary" /> Yes, they are in the shop
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  They go onto the shelf now and can be sold straight away.
                </span>
              </button>
              <button
                type="button"
                onClick={() => setOnTheWay(true)}
                disabled={busy}
                aria-pressed={onTheWay}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  onTheWay ? "border-primary bg-primary/5" : "border-border hover:bg-accent"
                }`}
              >
                <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Truck className="h-4 w-4 text-primary" /> Not yet, they are still on the way
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  The bill and its value are recorded. Nothing reaches the shelf or the till until it is received on Goods on the way.
                </span>
              </button>
            </div>
            {onTheWay ? (
              <label className="mt-3 block text-sm sm:max-w-xs">
                <span className="eyebrow mb-1 block">When they are expected (optional)</span>
                <Input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} disabled={busy} />
              </label>
            ) : null}
          </div>
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

          {/*
            The other way in: a whole bill from the supplier's sheet. It only
            fills the lines below; saving is still the button at the bottom.
          */}
          <div className="rounded-lg border border-dashed border-input p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-semibold">
                  <FileSpreadsheet className="h-4 w-4 text-primary" /> Fill this bill from an Excel sheet
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Download the template, fill one row for each phone (its IMEI in QTY/IMEI/SERIAL NO) with its cost and selling prices, then choose it here. Every row goes on this one bill. Tabs without UNIT COST PRICE are left out.
                </p>
              </div>
              <input
                ref={sheetInput}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ""
                  if (file) void fillFromSheet(file)
                }}
              />
              <div className="flex flex-wrap gap-2">
                <a
                  href="/templates/supplier-bill-template.xlsx"
                  download="Supplier bill template.xlsx"
                  className="inline-flex h-9 items-center rounded-md border border-input px-3 text-sm font-medium hover:bg-accent"
                >
                  Download the template
                </a>
                <Button type="button" size="sm" variant="outline" onClick={() => sheetInput.current?.click()} disabled={busy || readingSheet}>
                  {readingSheet ? "Reading the sheet" : "Choose the sheet"}
                </Button>
              </div>
            </div>
            {sheetProblems.length ? (
              <div className="mt-3 rounded-md border border-danger/30 bg-danger-soft p-3">
                <p className="text-sm font-semibold text-danger">Nothing was filled in. Fix these on the sheet and choose it again.</p>
                <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-xs text-foreground">
                  {sheetProblems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {sheetNotes.length ? (
              <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                {sheetNotes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : null}
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

          {/*
            Uploaded value, less the shipping fee, is what the supplier is due.
            Leave the shipping fee empty and the whole value is payable.
          */}
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-border p-4">
              <p className="eyebrow">Total uploaded value</p>
              <p className="mt-1 text-2xl font-semibold num">{formatCurrency(totalInvoiceValue)}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                From {items.length} line{items.length === 1 ? "" : "s"}, {unitCount} unit{unitCount === 1 ? "" : "s"}
              </p>
            </div>

            <div className={`rounded-lg border p-4 ${shippingTooHigh ? "border-danger/40 bg-danger-soft" : "border-border"}`}>
              <label className="block">
                <span className="eyebrow mb-1 block">Shipping fee (₦), if any</span>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={shippingFee || ""}
                  onChange={(e) => setShippingFee(Math.max(0, Number(e.target.value) || 0))}
                  placeholder="0.00"
                  disabled={busy}
                  className="text-lg font-semibold num"
                />
              </label>
              <p className="mt-2 text-xs text-muted-foreground">
                {shippingTooHigh
                  ? "This is more than everything on the bill. Check the figure."
                  : "It comes off the uploaded value. Leave it empty when there is none."}
              </p>
            </div>

            <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
              <p className="eyebrow">Payable to the supplier</p>
              <p className="mt-1 text-2xl font-semibold num">{formatCurrency(payable)}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {shippingFee > 0
                  ? `${formatCurrency(totalInvoiceValue)} less ${formatCurrency(shippingFee)} shipping`
                  : "No shipping fee, so the whole uploaded value"}
              </p>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className={`rounded-lg border p-4 ${payingTooMuch ? "border-danger/40 bg-danger-soft" : "border-border"}`}>
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
              <div className="mt-2 flex flex-wrap gap-3 text-xs">
                <button type="button" onClick={() => setAmountPaid(payable)} className="font-medium text-primary hover:underline">
                  Paid in full
                </button>
                <button type="button" onClick={() => setAmountPaid(0)} className="font-medium text-muted-foreground hover:underline">
                  Nothing paid yet
                </button>
                {payingTooMuch ? <span className="text-danger">More than is payable to the supplier.</span> : null}
              </div>
              {/* Asked only when money is paid now: transfer from which bank, or cash. */}
              {amountPaid > 0 ? (
                <div className="mt-3 grid gap-2 border-t border-border pt-3 sm:grid-cols-[140px_1fr]">
                  <label className="block text-sm">
                    <span className="eyebrow mb-1 block">Paid by</span>
                    <Select value={payMethod} onChange={(e) => setPayMethod(e.target.value === "CASH" ? "CASH" : "TRANSFER")} disabled={busy}>
                      <option value="TRANSFER">Transfer</option>
                      <option value="CASH">Cash</option>
                    </Select>
                  </label>
                  {payMethod === "TRANSFER" ? (
                    <label className="block text-sm">
                      <span className="eyebrow mb-1 block">From which bank account</span>
                      <Select
                        value={payBankId}
                        onChange={(e) => setPayBankId(e.target.value)}
                        disabled={busy}
                        required
                        emptyLabel="No bank account is set up. Add one on Money in and out first."
                      >
                        {payingBanks.length ? (
                          <option value="" disabled>
                            Pick the bank the transfer left from
                          </option>
                        ) : null}
                        {payingBanks.map((bank) => (
                          <option key={bank.id} value={bank.id}>
                            {bank.label}
                          </option>
                        ))}
                      </Select>
                    </label>
                  ) : (
                    <p className="self-end pb-2 text-xs text-muted-foreground">Cash leaves the till of the shop receiving the goods.</p>
                  )}
                </div>
              ) : null}
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
              Saved. Read these notes on what was folded into one entry or left as it was.
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
          {onTheWay ? " as goods still on the way. They stay off the shelf until received." : null}
        </p>
        <Button type="submit" size="lg" disabled={busy || totalInvoiceValue <= 0}>
          {busy ? (
            onTheWay ? "Booking these goods" : "Uploading this stock"
          ) : onTheWay ? (
            <>
              <Truck className="mr-2 h-4 w-4" /> Book as goods on the way
            </>
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
