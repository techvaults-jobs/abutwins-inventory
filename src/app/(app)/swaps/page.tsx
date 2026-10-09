import Link from "next/link"
import { Plus } from "lucide-react"
import { getSwaps } from "@/app/actions/ops"
import { PageHeader } from "@/components/shared"
import { Button } from "@/components/ui/button"
import { money } from "@/lib/utils"
import { prisma } from "@/lib/prisma"
import { SwapsList } from "./swaps-list"

export default async function SwapsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams
  const [swaps, bankAccounts] = await Promise.all([
    getSwaps(),
    prisma.bankAccount.findMany({
      where: { isActive: true },
      include: { branch: { select: { name: true } } },
      orderBy: [{ bankName: "asc" }, { accountNumber: "asc" }],
    }),
  ])
  return (
    <div className="space-y-6">
      <PageHeader
        title="Swap Deal"
        description="Old device in, shop device out. Values, balance, approval, then stock moves."
        actions={
          <Button asChild>
            <Link href="/swaps/new">
              <Plus className="mr-1.5 h-4 w-4" /> Start a swap
            </Link>
          </Button>
        }
      />
      <SwapsList
        initialStatus={status}
        banks={bankAccounts.map((bank) => ({
          id: bank.id,
          branchId: bank.branchId,
          label: `${bank.bankName} ${bank.accountNumber}${bank.accountName ? ` · ${bank.accountName}` : ""} (${bank.branch.name})`,
        }))}
        swaps={swaps.map((swap) => ({
          id: swap.id,
          branchId: swap.branchId,
          swapNumber: swap.swapNumber,
          status: swap.status,
          tradeValue: money(swap.tradeValue),
          newProductPrice: money(swap.newProductPrice),
          balanceAmount: money(swap.balanceAmount),
          createdAt: swap.createdAt,
          approvedAt: swap.approvedAt,
          completedAt: swap.completedAt,
          customer: { name: swap.customer.name },
          oldDeviceCondition: swap.oldDeviceCondition,
          oldImei: {
            imei1: swap.oldImei.imei1,
            serialNumber: swap.oldImei.serialNumber,
            conditionNotes: swap.oldImei.conditionNotes,
            product: {
              name: swap.oldImei.product.name,
              storage: swap.oldImei.product.storage,
              brand: swap.oldImei.product.brand ? { name: swap.oldImei.product.brand.name } : null,
            },
          },
          newProduct: { name: swap.newProduct.name, storage: swap.newProduct.storage },
          newImei: swap.newImei ? { imei1: swap.newImei.imei1, serialNumber: swap.newImei.serialNumber } : null,
          invoice: swap.invoice,
          startedBy: swap.startedBy,
          approvedByName: swap.approvedByName,
          settledBy: swap.settledBy,
          money: swap.money,
        }))}
      />
    </div>
  )
}
