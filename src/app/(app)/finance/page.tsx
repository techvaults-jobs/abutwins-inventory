import { getFinance } from "@/app/actions/finance"
import { PageHeader } from "@/components/shared"
import { plainMoney } from "@/lib/plain"
import { canSeeShopTotals } from "@/lib/roles"
import { requireUser } from "@/lib/session"
import { FinanceClientView } from "./finance-client-view"

export default async function FinancePage() {
  // The expense rows and recent entries are for other screens; this one never shows them.
  const [{ expenses: _expenses, entries: _entries, ...rest }, user] = await Promise.all([getFinance(), requireUser()])
  // The till and the shop floor do not see the shop's totals. They are left out
  // here, not only hidden, so they never reach the browser.
  const showTotals = canSeeShopTotals(user.role)
  const data = showTotals
    ? { ...rest, showTotals }
    : { ...rest, showTotals, revenue: 0, expenditure: 0, supplierPayments: 0, netCashFlow: 0, cashRevenue: 0, bankRevenue: 0 }
  return (
    <div className="space-y-6">
      <PageHeader
        title="Money in & out"
        description="Cash, banks, money in from sales, and money out."
      />
      <FinanceClientView data={plainMoney(data)} />
    </div>
  )
}

