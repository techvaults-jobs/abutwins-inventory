import Link from "next/link"
import { Undo2 } from "lucide-react"
import { getSupplierReturnsHistory } from "@/app/actions/supplier-returns"
import { PageHeader } from "@/components/shared"
import { Button } from "@/components/ui/button"
import { requireUser } from "@/lib/session"
import { isShopOwner } from "@/lib/rbac"
import { ReturnsHistoryView } from "./returns-history-view"

export default async function ReturnsHistoryPage() {
  const [{ rows }, me] = await Promise.all([getSupplierReturnsHistory(), requireUser()])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Returns to suppliers"
        description="Every unit sent back to a supplier. Filter by supplier, date, or source. Export to Excel."
        actions={
          <Button asChild variant="outline">
            <Link href="/purchases/send-back">
              <Undo2 className="mr-1.5 h-4 w-4" />
              Send back now
            </Link>
          </Button>
        }
      />
      <ReturnsHistoryView rows={rows} canUndo={isShopOwner(me.role)} />
    </div>
  )
}
