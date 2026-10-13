import { redirect } from "next/navigation"
import { getOpenPurchases } from "@/app/actions/incoming"
import { getProducts } from "@/app/actions/catalog"
import { getBranches, getSuppliers } from "@/app/actions/parties"
import { getUploadProgress } from "@/app/actions/uploads"
import { FormScreen, PageHeader } from "@/components/shared"
import { watDayKey } from "@/lib/lagos-day"
import { can, isShopOwner } from "@/lib/permissions"
import { requireUser } from "@/lib/session"
import { generateDocNumber } from "@/lib/utils"
import { UploadStockWizard } from "../../uploads/upload-stock-wizard"
import { IncomingForm } from "../incoming-form"

export const dynamic = "force-dynamic"
export const maxDuration = 180

export default async function BookGoodsComingPage() {
  const me = await requireUser()
  if (!(isShopOwner(me.role) || (await can(me.role, "action.incoming")))) redirect("/incoming")

  // Whoever loads supplier bills books goods coming on the full bill: cost,
  // selling price, shipping fee and payment all go in before the goods land.
  // The client found the short form here and could type none of them.
  const progress = (await can(me.role, "action.upload")) ? await getUploadProgress() : null
  if (progress) {
    return (
      <div className="space-y-6">
        <PageHeader
          backHref="/incoming"
          title="Book goods coming"
          description="The full supplier bill, before the goods land. Stock rises only when they are received."
        />
        <UploadStockWizard
          startOnTheWay
          shops={progress.branches}
          suppliers={progress.suppliers}
          payingBanks={progress.payingBanks}
          brands={progress.brands}
          categories={progress.categories}
          products={progress.products}
          defaultInvoiceNumber={generateDocNumber("PO")}
          defaultUploadDate={watDayKey()}
        />
      </div>
    )
  }

  const [products, branches, suppliers, purchases] = await Promise.all([getProducts(), getBranches(), getSuppliers(), getOpenPurchases()])
  return (
    <FormScreen
      title="Book goods coming"
      description="Scan IMEIs or type pieces. Stock rises only when they arrive and are received."
      backHref="/incoming"
    >
      <IncomingForm
        successHref="/incoming"
        products={products.map((product) => ({ id: product.id, name: product.name, tracking: product.tracking }))}
        branches={branches.filter((branch) => branch.isActive).map((branch) => ({ id: branch.id, name: branch.name, isHq: branch.isHq }))}
        suppliers={suppliers.map((supplier) => ({ id: supplier.id, name: supplier.name }))}
        purchases={purchases}
        defaultBranchId={me.branchId}
      />
    </FormScreen>
  )
}
