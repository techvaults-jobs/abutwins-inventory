import Link from "next/link"
import { Plus } from "lucide-react"
import { getIncomingLots } from "@/app/actions/incoming"
import { IncomingList } from "./incoming-list"
import { PageHeader } from "@/components/shared"
import { Button } from "@/components/ui/button"
import { can, isShopOwner } from "@/lib/permissions"
import { requireUser } from "@/lib/session"

export default async function IncomingPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams
  const me = await requireUser()
  const lots = await getIncomingLots()
  const canBook = isShopOwner(me.role) || (await can(me.role, "action.incoming"))
  const canUpload = await can(me.role, "action.upload")

  return (
    <div className="space-y-5">
      <PageHeader
        title="Goods on the way"
        description="Left the supplier. Not counted into this shop yet."
        actions={
          canBook ? (
            <>
              {canUpload ? (
                <Button asChild variant="outline">
                  <Link href="/uploads">Upload a supplier bill still on the way</Link>
                </Button>
              ) : null}
              <Button asChild>
                <Link href="/incoming/new">
                  <Plus className="mr-1.5 h-4 w-4" /> Book goods coming
                </Link>
              </Button>
            </>
          ) : null
        }
      />
      <IncomingList lots={lots} canBook={canBook} isAdmin={isShopOwner(me.role)} initialStatus={status} />
    </div>
  )
}
