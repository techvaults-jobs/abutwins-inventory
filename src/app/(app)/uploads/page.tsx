import Link from "next/link"
import { FileSpreadsheet, PackagePlus, ScanLine } from "lucide-react"
import { PageHeader } from "@/components/shared"
import { getBillToContinue, getUploadProgress } from "@/app/actions/uploads"
import { watDayKey } from "@/lib/lagos-day"
import { generateDocNumber } from "@/lib/utils"
import { UploadStockWizard } from "./upload-stock-wizard"

export const dynamic = "force-dynamic"
export const maxDuration = 180

/**
 * Upload stock, section one: one supplier carton going onto the system today.
 *
 * Staff asked for two clear ways to load stock: many phones at once from Excel,
 * and one phone after another on a bill. This screen is the bill path. The Excel
 * path and the single-phone path sit one click away.
 */
export default async function UploadsPage({ searchParams }: { searchParams: Promise<{ bill?: string }> }) {
  const { bill } = await searchParams
  const progress = await getUploadProgress()
  if (!progress) return null
  // ?bill=PO-… opens straight onto that bill, to add more of its items.
  const continueBill = bill ? await getBillToContinue(bill) : null

  return (
    <div className="space-y-6">
      <PageHeader
        title="Upload stock · Supplier bill"
        description="Add phones that came with a supplier bill."
      />

      <div className="grid gap-3 md:grid-cols-3">
        <div className="surface-card border-primary/30 bg-primary/5 p-4">
          <p className="flex items-center gap-2 text-sm font-bold text-foreground">
            <PackagePlus className="h-4 w-4 text-primary" />
            This page: one by one or many
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Use the form below. Add one phone or a whole carton on the same bill: paste or scan many IMEIs at once, or fill the bill from an Excel sheet. Goods still on the way can be uploaded too, and stay off the shelf until received.
          </p>
        </div>
        <Link
          href="/uploads/opening-stock"
          className="surface-card p-4 transition-colors hover:border-primary/40 hover:bg-accent"
        >
          <p className="flex items-center gap-2 text-sm font-bold text-foreground">
            <FileSpreadsheet className="h-4 w-4 text-primary" />
            Many at once (Excel)
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Put a whole shop on the system from one Excel file. Use this once per shop when you first load what is already on the shelf.
          </p>
        </Link>
        <Link
          href="/imei/intake"
          className="surface-card p-4 transition-colors hover:border-primary/40 hover:bg-accent"
        >
          <p className="flex items-center gap-2 text-sm font-bold text-foreground">
            <ScanLine className="h-4 w-4 text-primary" />
            One phone at a time
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            A single phone already in your hand, with no supplier bill to type. Goes straight In shop.
          </p>
        </Link>
      </div>

      <UploadStockWizard
        shops={progress.branches}
        suppliers={progress.suppliers}
        payingBanks={progress.payingBanks}
        brands={progress.brands}
        categories={progress.categories}
        products={progress.products}
        defaultInvoiceNumber={generateDocNumber("PO")}
        defaultUploadDate={watDayKey()}
        continueBill={continueBill ?? undefined}
      />

      <div className="surface-card p-5">
        <h2 className="text-sm font-semibold">Which way should I use?</h2>
        <ul className="mt-2 space-y-2 text-sm text-muted-foreground">
          <li>
            <span className="font-medium text-foreground">New carton with a bill:</span> stay on this page. Pick the supplier, type the item name, pick condition and storage, add each phone or many lines, say what was paid.
          </li>
          <li>
            <span className="font-medium text-foreground">First time loading a shop:</span> open{" "}
            <Link href="/uploads/opening-stock" className="font-medium text-primary hover:underline">
              Many at once (Excel)
            </Link>
            .
          </li>
          <li>
            <span className="font-medium text-foreground">One phone, no bill:</span> open{" "}
            <Link href="/imei/intake" className="font-medium text-primary hover:underline">
              One phone at a time
            </Link>
            .
          </li>
          <li>
            <span className="font-medium text-foreground">Unpaid balance:</span> only on a Supplier bill. Opening stock is value only and is never money owed.
          </li>
          <li>
            <span className="font-medium text-foreground">Same IMEI twice:</span> the system stops the copy. Nothing already in the shop is changed.
          </li>
        </ul>
      </div>
    </div>
  )
}
