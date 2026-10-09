import Link from "next/link"
import { productFullName } from "@/lib/product-specs"
import { Plus } from "lucide-react"
import { getInStockForReplace, getReturns } from "@/app/actions/ops"
import { PageHeader } from "@/components/shared"
import { Button } from "@/components/ui/button"
import { money } from "@/lib/utils"
import { prisma } from "@/lib/prisma"
import { requireUser } from "@/lib/session"
import { isShopOwner } from "@/lib/roles"
import { ReturnsList } from "./returns-list"

export default async function ReturnsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams
  const [rows, stock, bankAccounts, me] = await Promise.all([
    getReturns(),
    getInStockForReplace(),
    // Refunds leave by bank, from a named account.
    prisma.bankAccount.findMany({
      where: { isActive: true },
      include: { branch: { select: { name: true } } },
      orderBy: [{ bankName: "asc" }, { accountNumber: "asc" }],
    }),
    requireUser(),
  ])
  return (
    <div className="space-y-6">
      <div className="space-y-5">
        <PageHeader
          title="Returns"
          description="Return value, replacement value, and the balance. A return takes effect as soon as it is saved: the item is back in stock and the money is settled."
          actions={
            <Button asChild>
              <Link href="/returns/new">
                <Plus className="mr-1.5 h-4 w-4" /> Log a return
              </Link>
            </Button>
          }
        />
        <ReturnsList
          initialStatus={status}
          // Only what the list shows. Spreading the whole row sent the staff
          // member's login record, password hash included, to the browser.
          rows={rows.map((row) => ({
            id: row.id,
            branchId: row.branchId,
            returnNumber: row.returnNumber,
            status: row.status,
            reason: row.reason,
            outcome: row.outcome,
            faultClass: row.faultClass,
            notes: row.notes,
            refundAmount: row.refundAmount != null ? money(row.refundAmount) : null,
            createdAt: row.createdAt,
            approvedAt: row.approvedAt,
            completedAt: row.completedAt,
            customer: { id: row.customer.id, name: row.customer.name },
            invoice: row.invoice
              ? {
                  id: row.invoice.id,
                  invoiceNumber: row.invoice.invoiceNumber,
                  total: money(row.invoice.totalAmount),
                  paid: money(row.invoice.paidAmount),
                }
              : null,
            returnValue: row.returnValue != null ? money(row.returnValue) : row.refundAmount != null ? money(row.refundAmount) : null,
            replacementValue: row.replacementValue != null ? money(row.replacementValue) : null,
            balanceAmount: row.balanceAmount != null ? money(row.balanceAmount) : null,
            imei: row.imei
              ? {
                  id: row.imei.id,
                  imei1: row.imei.imei1,
                  serialNumber: row.imei.serialNumber,
                  productName: productFullName(row.imei.product),
                }
              : null,
            replacementImei: row.replacementImei
              ? {
                  id: row.replacementImei.id,
                  imei1: row.replacementImei.imei1,
                  serialNumber: row.replacementImei.serialNumber,
                  productName: productFullName(row.replacementImei.product),
                }
              : null,
            saleItem: row.saleItem
              ? {
                  id: row.saleItem.id,
                  productName: productFullName(row.saleItem.product),
                  quantity: row.saleItem.quantity,
                }
              : null,
          }))}
          // The CEO and the main admin reconfirm on Apply and may change the course of action.
          canReconfirm={isShopOwner(me.role)}
          banks={bankAccounts.map((bank) => ({
            id: bank.id,
            branchId: bank.branchId,
            label: `${bank.bankName} ${bank.accountNumber}${bank.accountName ? ` · ${bank.accountName}` : ""} (${bank.branch.name})`,
          }))}
          stock={stock.map((row) => ({
            id: row.id,
            imei1: row.imei1,
            serialNumber: row.serialNumber,
            branchId: row.branchId,
            product: { name: productFullName(row.product), sellingPrice: money(row.product.sellingPrice) },
          }))}
        />
      </div>
    </div>
  )
}
