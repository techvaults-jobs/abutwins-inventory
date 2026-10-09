import Link from "next/link"
import { mayDecideTransfer } from "@/lib/transfer-rights"
import { productSpecLine } from "@/lib/product-specs"
import { Plus } from "lucide-react"
import { getTransfers } from "@/app/actions/ops"
import { PageHeader } from "@/components/shared"
import { Button } from "@/components/ui/button"
import { requireUser } from "@/lib/session"
import { money } from "@/lib/utils"
import { TransfersList } from "./transfers-list"

export default async function TransfersPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams
  // A transfer moves our own stock between our own shops; it is not a sale,
  // so it is always valued at what the stock cost us, for everyone who
  // handles it (the owner's rule), never at selling price.
  const me = await requireUser()
  const atCost = true
  const transfers = await getTransfers()

  const listRows = transfers.map((transfer) => ({
    id: transfer.id,
    transferNumber: transfer.transferNumber,
    status: transfer.status,
    createdAt: transfer.createdAt,
    sentAt: transfer.sentAt,
    receivedAt: transfer.receivedAt,
    fromBranch: { code: transfer.fromBranch.code, name: transfer.fromBranch.name },
    toBranch: { code: transfer.toBranch.code, name: transfer.toBranch.name },
    items: transfer.items.map((item) => ({
      id: item.id,
      receivedQty: item.receivedQty,
      productId: item.productId,
      product: {
        name: item.product.name,
        specs: productSpecLine(item.product),
        sku: item.product.sku,
        costPrice: money(atCost ? item.product.costPrice : item.product.sellingPrice),
      },
      quantity: item.quantity,
    })),
    arrivedImeis: transfer.arrivedImeis,
    rejectedBecause: transfer.rejectedBecause,
    sentBy: transfer.sentBy,
    receivedBy: transfer.receivedBy,
    // Accept and reject: the CEO and the main admin for any shop, the receiving
    // shop's manager or vault manager for their own. Everyone else looks.
    canDecide: mayDecideTransfer(me, transfer.toBranchId),
    imeis: transfer.imeis.map((imei) => ({
      id: imei.id,
      imei1: imei.imei1,
      imei2: imei.imei2,
      serialNumber: imei.serialNumber,
      // Still at the sending shop and sellable? A phone sold there meanwhile
      // cannot be received, and the accept list says so.
      available:
        transfer.status === "PENDING"
          ? imei.status === "IN_STOCK" && imei.branchId === transfer.fromBranchId
          : transfer.status === "IN_TRANSIT"
            ? imei.status === "TRANSFERRED"
            : true,
      productId: imei.productId,
      name: imei.product.name,
      specs: productSpecLine(imei.product),
      costPrice: money(atCost ? imei.product.costPrice : imei.product.sellingPrice),
    })),
  }))

  return (
    <div className="space-y-5">
      <PageHeader
        title="Shop to shop (Stock Transfer)"
        description="Stock stays in shop at the sending branch until the receiving branch accepts."
        actions={
          <Button asChild>
            <Link href="/transfers/new">
              <Plus className="mr-1.5 h-4 w-4" /> Start a transfer
            </Link>
          </Button>
        }
      />
      <TransfersList transfers={listRows} atCost={atCost} initialStatus={status} />
    </div>
  )
}
