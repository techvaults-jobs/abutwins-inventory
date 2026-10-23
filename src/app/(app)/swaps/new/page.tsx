import { getProducts } from "@/app/actions/catalog"
import { getPosLookups } from "@/app/actions/sales"
import { FormScreen } from "@/components/shared"
import { prisma } from "@/lib/prisma"
import { SwapForm } from "../swap-form"

export default async function StartSwapPage() {
  const [lookups, products, bankAccounts] = await Promise.all([
    getPosLookups(),
    getProducts(),
    prisma.bankAccount.findMany({
      where: { isActive: true },
      include: { branch: { select: { name: true } } },
      orderBy: [{ bankName: "asc" }, { accountNumber: "asc" }],
    }),
  ])
  return (
    <FormScreen
      title="Start a swap"
      description="Customer's phone in, shop phone out, and the balance settled. It takes effect when you save, with no approval."
      backHref="/swaps"
    >
      <SwapForm
        successHref="/swaps"
        customers={lookups.customers.map((customer) => ({
          id: customer.id,
          name: customer.name,
          phone: customer.phone,
          branchId: customer.branchId,
        }))}
        models={[
          ...new Map(
            products
              .filter((product) => product.tracking !== "NONE")
              .map((product) => [
                product.name.toLowerCase(),
                { name: product.name, brand: product.brand.name, category: product.category.name },
              ])
          ).values(),
        ]}
        brands={[...new Set(products.map((product) => product.brand.name))].sort()}
        categories={[...new Set(products.map((product) => product.category.name))].sort()}
        branches={lookups.branches.map((branch) => ({ id: branch.id, name: branch.name }))}
        banks={bankAccounts.map((bank) => ({
          id: bank.id,
          branchId: bank.branchId,
          label: `${bank.bankName} ${bank.accountNumber}${bank.accountName ? ` · ${bank.accountName}` : ""} (${bank.branch.name})`,
        }))}
        defaultBranchId={lookups.branchId}
      />
    </FormScreen>
  )
}
