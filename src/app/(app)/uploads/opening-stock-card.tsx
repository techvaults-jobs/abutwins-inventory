"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { SectionCard } from "@/components/shared"
import { BrandBusyOverlay } from "@/components/brand-busy-overlay"
import { importOpeningStock, type UploadResult } from "@/app/actions/uploads"
import { listedSupplierClash } from "@/lib/party-key"
import { OPENING_STOCK_ALL_SHOPS, OPENING_STOCK_SUPPLIER_NAME, OPENING_STOCK_SUPPLIER_OPTION } from "@/lib/upload-purchase"
import { formatCurrency } from "@/lib/utils"

type Shop = { id: string; name: string; code: string }
type Supplier = { id: string; name: string; phone?: string | null; city: string | null; country: string | null }

const OPENING_PHASES = [
  "Opening your Excel file",
  "Checking every IMEI and serial",
  "Folding any duplicate numbers into one entry",
  "Booking phones and laptops In shop",
  "Setting piece counts on the shelf",
  "Saving the opening stock value",
]

/**
 * One Excel file per shop. Books what is already on the shelf as opening stock
 * value. There is no supplier payment on this load.
 */
export function OpeningStockCard({ shops, suppliers }: { shops: Shop[]; suppliers: Supplier[] }) {
  const router = useRouter()
  const formRef = useRef<HTMLFormElement>(null)
  const [busy, setBusy] = useState(false)
  const [busyShop, setBusyShop] = useState("")
  const [problems, setProblems] = useState<string[]>([])
  const [softNotes, setSoftNotes] = useState<string[]>([])
  const openingHouse =
    suppliers.find((row) => row.name.trim().toLowerCase() === OPENING_STOCK_SUPPLIER_NAME.toLowerCase()) || null
  const [supplierChoice, setSupplierChoice] = useState(OPENING_STOCK_SUPPLIER_OPTION)
  const [branchId, setBranchId] = useState(shops.length > 1 ? OPENING_STOCK_ALL_SHOPS : shops[0]?.id || "")
  const [trackingChoice, setTrackingChoice] = useState("ALL")
  const addingNewSupplier = supplierChoice === "__new__"
  const usingOpeningStock =
    supplierChoice === OPENING_STOCK_SUPPLIER_OPTION ||
    (openingHouse != null && supplierChoice === openingHouse.id)

  const allShops = branchId === OPENING_STOCK_ALL_SHOPS
  const shopLabel = allShops
    ? "all shops"
    : shops.find((shop) => shop.id === branchId)?.name ||
      shops.find((shop) => shop.id === branchId)?.code ||
      "this shop"

  const otherSuppliers = suppliers.filter(
    (row) => row.name.trim().toLowerCase() !== OPENING_STOCK_SUPPLIER_NAME.toLowerCase()
  )

  return (
    <SectionCard
      title="Load opening stock from the Excel sheet"
      description="Once per shop, or All shops for the same names on every open shop. Later cartons use Supplier bill."
    >
      <BrandBusyOverlay
        open={busy}
        title={`Uploading opening stock to ${busyShop || shopLabel}`}
        detail="Reading the Excel and booking what is on the shelf. This can take a minute for a full shop."
        phases={OPENING_PHASES}
      />

      <p className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-foreground">
        <span className="font-semibold">Shop already loaded its opening stock?</span> Pick one shop and the supplier the goods
        came from. The whole file goes on that supplier&apos;s bill, In shop, with nothing paid yet. Record the payment or a
        shipping fee on the bill afterwards. Use the template from Supplier bill for the right columns.
      </p>
      <p className="text-sm leading-relaxed text-muted-foreground">
        One file, with tabs for PHONES, ACCESSORIES, SCREEN and LAPTOPS. Pick All shops to put the same names on every
        open shop, or pick one shop. If you do not know every supplier yet, leave Supplier on Opening Stock. The file
        books phones and laptops In shop, sets the piece counts, and stores the opening stock value from the unit costs.
        That value is not a bill to pay. A tab can list only PRODUCT NAME. Pick How we count this file for this upload:
        all types from the tabs, phone IMEI, laptop serial, or pieces. A TRACKING column on the sheet (IMEI, SERIAL, or
        NONE) can still set one row. IMEI, serial, piece count, and prices can be added later on Correct and close
        opening stock.
      </p>

      <ul className="mt-3 grid gap-1 text-sm text-muted-foreground sm:grid-cols-2">
        <li>PHONES tab: one row per phone. Put the IMEI in QTY/IMEI/SERIAL NO when you have it. Leave it blank if you will add it later.</li>
        <li>LAPTOPS tab: one row per laptop. Put the serial in that same column when you have it.</li>
        <li>ACCESSORIES and SCREEN tabs: how many pieces are on the shelf, or leave the count blank and type it later.</li>
        <li>How we count this file: pick All types when the sheet has phones, laptops, and pieces together. Pick one type when this file is only that kind.</li>
        <li>Never make up an IMEI. An IMEI or serial belongs to one shop, so pick that shop when the sheet has those numbers. Super Admin, CEO, accountant, records checker, and stock uploader can finish missing details on Correct and close opening stock.</li>
      </ul>

      <form
        ref={formRef}
        className="mt-5 space-y-4"
        action={async (formData) => {
          if (!shops.length) {
            toast.error("No shop is open on this login. Ask the main admin to open a shop first.")
            return
          }
          if (!String(formData.get("branchId") || branchId).trim()) {
            toast.error("Pick All shops, or pick which shop this Excel belongs to.")
            return
          }
          if (addingNewSupplier) {
            const newName = String(formData.get("newSupplierName") || "").trim()
            if (!newName) {
              toast.error("Type the new supplier name, or pick Opening Stock from the list.")
              return
            }
            const clash = listedSupplierClash(
              suppliers,
              newName,
              String(formData.get("newSupplierPhone") || ""),
            )
            if (clash) {
              toast.error(clash)
              return
            }
          } else if (!String(formData.get("supplierId") || "").trim()) {
            toast.error("Pick Opening Stock, pick a supplier from the list, or choose Add new supplier.")
            return
          }
          const file = formData.get("file")
          if (!(file instanceof File) || file.size === 0) {
            toast.error("Choose the opening stock Excel file first.")
            return
          }

          const selectedId = String(formData.get("branchId") || branchId)
          const selectedShop = shops.find((shop) => shop.id === selectedId)
          setBusyShop(
            selectedId === OPENING_STOCK_ALL_SHOPS
              ? "all shops"
              : selectedShop
                ? `${selectedShop.name} (${selectedShop.code})`
                : shopLabel
          )
          setBusy(true)
          setProblems([])
          setSoftNotes([])
          let result: UploadResult
          try {
            result = await importOpeningStock(formData)
          } catch {
            setBusy(false)
            toast.error("That did not reach the shop system. Check your network and try again.")
            return
          }
          setBusy(false)
          if (result.error) {
            toast.error(result.error)
            setProblems(result.problems ?? [])
            return
          }
          if (result.asSupplierBill) {
            toast.success(
              [
                `Supplier bill ${result.invoiceNumber}`,
                result.phones ? `${result.phones} phone${result.phones === 1 ? "" : "s"} In shop` : null,
                result.pieces ? `${result.pieces} piece${result.pieces === 1 ? "" : "s"} added` : null,
                `owed ${formatCurrency(result.balanceOwed ?? 0)}. Record payment or a shipping fee on the bill`,
              ]
                .filter(Boolean)
                .join(" · ") + "."
            )
            setSoftNotes(result.problems ?? [])
            formRef.current?.reset()
            setSupplierChoice(OPENING_STOCK_SUPPLIER_OPTION)
            setTrackingChoice("ALL")
            router.refresh()
            return
          }
          const parts = [
            result.shopNames
              ? `Opening stock for ${result.shopNames}`
              : result.invoiceNumber
                ? `Opening stock ${result.invoiceNumber}`
                : null,
            result.products ? `${result.products} new item${result.products === 1 ? "" : "s"}` : null,
            result.phones ? `${result.phones} phone${result.phones === 1 ? "" : "s"} In shop` : null,
            result.pieces ? `${result.pieces} piece line${result.pieces === 1 ? "" : "s"}` : null,
            result.submissionValue != null ? `opening value ${formatCurrency(result.submissionValue)}` : null,
          ].filter(Boolean)
          const skippedBits = [
            result.duplicates ? `${result.duplicates} duplicate number(s) counted once` : null,
            result.skipped ? `${result.skipped} already on the system left as they are` : null,
          ].filter(Boolean)
          toast.success(
            `${parts.join(" · ") || "Nothing new to add"}${skippedBits.length ? `. ${skippedBits.join(" · ")}` : "."}`
          )
          setSoftNotes(result.problems ?? [])
          formRef.current?.reset()
          setSupplierChoice(OPENING_STOCK_SUPPLIER_OPTION)
          setTrackingChoice("ALL")
          setBranchId(shops.length > 1 ? OPENING_STOCK_ALL_SHOPS : shops[0]?.id || "")
          router.refresh()
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="eyebrow mb-1 block">Which shop</span>
            <Select
              name="branchId"
              required
              value={branchId}
              onChange={(event) => setBranchId(event.target.value)}
              disabled={busy}
            >
              {!shops.length ? <option value="">No shop available</option> : null}
              {shops.length > 1 ? <option value={OPENING_STOCK_ALL_SHOPS}>All shops</option> : null}
              {shops.map((shop) => (
                <option key={shop.id} value={shop.id}>
                  {shop.name} ({shop.code})
                </option>
              ))}
            </Select>
            {shops.length > 1 ? (
              <p className="mt-1 text-xs text-muted-foreground">
                All shops puts the same product names and piece counts on every open shop. An IMEI or serial belongs to
                one shop, so pick that shop when the sheet has those numbers.
              </p>
            ) : null}
          </label>

          <label className="block text-sm">
            <span className="eyebrow mb-1 block">Supplier</span>
            <Select
              name="supplierId"
              required
              disabled={busy}
              value={supplierChoice}
              onChange={(event) => setSupplierChoice(event.target.value)}
            >
              <option value={OPENING_STOCK_SUPPLIER_OPTION}>Opening Stock</option>
              {otherSuppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                  {supplier.city || supplier.country
                    ? ` · ${[supplier.city, supplier.country].filter(Boolean).join(", ")}`
                    : ""}
                </option>
              ))}
              <option value="__new__">Add new supplier</option>
            </Select>
            {usingOpeningStock ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Use Opening Stock when the house that supplied these goods is not known yet. No phone number is needed.
              </p>
            ) : null}
          </label>

          <label className="block text-sm sm:col-span-2">
            <span className="eyebrow mb-1 block">How we count this file</span>
            <Select
              name="tracking"
              required
              disabled={busy}
              value={trackingChoice}
              onChange={(event) => setTrackingChoice(event.target.value)}
            >
              <option value="ALL">All types (phones, laptops, and pieces from the tabs)</option>
              <option value="IMEI">Phone IMEI only</option>
              <option value="SERIAL">Laptop serial only</option>
              <option value="NONE">Pieces only (no IMEI)</option>
            </Select>
            <p className="mt-1 text-xs text-muted-foreground">
              All types follows PHONES, LAPTOPS, ACCESSORIES, and SCREEN tabs, or a TRACKING column on a row. Pick one
              type when this upload is only phones, only laptops, or only pieces.
            </p>
          </label>

          {addingNewSupplier ? (
            <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3 sm:col-span-2">
              <p className="text-xs font-semibold text-foreground">New supplier</p>
              <p className="text-xs text-muted-foreground">
                Type the house name. Phone is optional on opening stock if you do not have it yet.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Input name="newSupplierName" required placeholder="Supplier name" disabled={busy} />
                <Input name="newSupplierPhone" placeholder="Supplier phone number (optional)" disabled={busy} />
                <Input name="newSupplierCity" placeholder="City (optional)" disabled={busy} />
                <Input name="newSupplierCountry" placeholder="Country (optional)" disabled={busy} />
              </div>
            </div>
          ) : null}

          <label className="block text-sm sm:col-span-2">
            <span className="eyebrow mb-1 block">Note, or the waybill number</span>
            <Input name="notes" placeholder="Optional" disabled={busy} />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="file"
            name="file"
            accept=".xlsx,.xls"
            required
            disabled={busy}
            className="h-10 max-w-full flex-1 rounded-lg border border-dashed border-input bg-card px-3 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-secondary-foreground disabled:opacity-60"
          />
          <Button type="submit" disabled={busy || shops.length === 0} aria-busy={busy}>
            {busy ? (
              "Uploading opening stock"
            ) : (
              <>
                <Upload className="h-4 w-4" aria-hidden /> Upload opening stock
              </>
            )}
          </Button>
        </div>
      </form>

      {problems.length ? (
        <div className="mt-4 rounded-lg border border-danger/30 bg-danger-soft p-3">
          <p className="text-sm font-semibold text-danger">
            Fix these lines in the sheet, then upload it again. Nothing was loaded.
          </p>
          <ul className="mt-2 space-y-1">
            {problems.map((problem) => (
              <li key={problem} className="text-sm text-danger">
                {problem}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {softNotes.length ? (
        <div className="mt-4 rounded-lg border border-border bg-muted/40 p-3">
          <p className="text-sm font-semibold text-foreground">
            Upload completed. Duplicates were folded into one entry, or numbers already on the system were left as they are. You can edit stock later on Correct and close opening stock or Phones and items.
          </p>
          <ul className="mt-2 space-y-1">
            {softNotes.map((note) => (
              <li key={note} className="text-sm text-muted-foreground">
                {note}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </SectionCard>
  )
}
