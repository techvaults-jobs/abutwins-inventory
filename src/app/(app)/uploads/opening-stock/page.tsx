import Link from "next/link"
import { PageHeader } from "@/components/shared"
import { getUploadProgress } from "@/app/actions/uploads"
import { OpeningStockCard } from "../opening-stock-card"

export const dynamic = "force-dynamic"
export const maxDuration = 180

/** Day-one stock for one shop, from the opening stock Excel sheet. */
export default async function OpeningStockPage() {
  const progress = await getUploadProgress()
  if (!progress) return null

  return (
    <div className="space-y-6">
      <PageHeader
        title="Upload stock · Many at once (Excel)"
        description="Load many items from one Excel file. A shop's first load is its opening stock; after that, pick the supplier and the file goes on that supplier's bill."
      />

      <div className="surface-card border-primary/30 bg-primary/5 p-4 text-sm text-muted-foreground">
        <p className="font-bold text-foreground">Need to add phones one after another instead?</p>
        <p className="mt-1">
          Open{" "}
          <Link href="/uploads" className="font-medium text-primary hover:underline">
            Supplier bill
          </Link>{" "}
          for a carton with a bill, or{" "}
          <Link href="/imei/intake" className="font-medium text-primary hover:underline">
            One phone at a time
          </Link>{" "}
          for a single phone with no bill.
        </p>
      </div>

      <OpeningStockCard shops={progress.branches} suppliers={progress.suppliers} />

      <div className="surface-card p-5">
        <h2 className="text-sm font-semibold">Before you upload</h2>
        <ul className="mt-2 space-y-2 text-sm text-muted-foreground">
          <li>Pick All shops to put the same names on Iwo Road, Bodija, and Challenge in one upload. Pick one shop when the sheet has IMEIs or serials, because a phone number belongs to one shop only.</li>
          <li>If you do not know the supplier house yet, pick Opening Stock. No phone number is needed for that option.</li>
          <li>The system makes its own opening stock number, so do not type one.</li>
          <li>
            There is no paid or unpaid on this sheet. The value is what the shop started with. New cartons with a bill
            go on Supplier bill, where payment belongs.
          </li>
          <li>Phones that are already on the system stay as one entry. Repeats in the file are counted once. Nothing is doubled. Staff can edit later on Correct and close opening stock or Phones and items.</li>
          <li>
            After this first load, new cartons go on{" "}
            <Link href="/uploads" className="font-medium text-primary hover:underline">
              Supplier bill
            </Link>
            , not on this Excel again.
          </li>
        </ul>
      </div>
    </div>
  )
}
