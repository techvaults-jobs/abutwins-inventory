import Link from "next/link"
import { Plus, Undo2 } from "lucide-react"
import { getPurchases, getSupplierReturnCandidates } from "@/app/actions/ops"
import { PageHeader, StatCard, StatGrid } from "@/components/shared"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { formatCurrency, money } from "@/lib/utils"
import { isOpeningStockPurchase, purchaseBalance } from "@/lib/purchase-money"
import { PurchasesList, type PurchaseRow } from "./purchases-list"

export default async function PurchasesPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams
  const [purchases, returnUnits] = await Promise.all([getPurchases(q), getSupplierReturnCandidates()])
  const regularPurchases = purchases.filter((p) => !isOpeningStockPurchase(p))
  const openingPurchases = purchases.filter((p) => isOpeningStockPurchase(p))

  const expected = regularPurchases.reduce((sum, row) => sum + row.trace.expected, 0)
  const recorded = regularPurchases.reduce((sum, row) => sum + row.trace.recorded, 0)
  const sold = regularPurchases.reduce((sum, row) => sum + row.trace.sold, 0)
  const soldToday = regularPurchases.reduce((sum, row) => sum + row.trace.soldToday, 0)
  const inShop = regularPurchases.reduce((sum, row) => sum + row.trace.inShop, 0)
  const shortVsBill = regularPurchases.reduce((sum, row) => sum + row.trace.shortVsBill, 0)
  const billed = regularPurchases.reduce((sum, row) => sum + money(row.totalAmount), 0)
  const paid = regularPurchases.reduce((sum, row) => sum + money(row.paidAmount), 0)
  const balances = regularPurchases.map((row) => purchaseBalance(row))
  const owed = balances.reduce((sum, row) => sum + row.owed, 0)
  const sentBack = balances.reduce((sum, row) => sum + row.sentBack, 0)
  const shipping = balances.reduce((sum, row) => sum + row.shipping, 0)
  const surplus = balances.reduce((sum, row) => sum + row.surplus, 0)
  const openingValue = openingPurchases.reduce((sum, row) => sum + money(row.totalAmount), 0)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Goods from supplier"
        description="Supplier bills, what we paid, and what is still owed."
        actions={
          <>
            <Button asChild variant="outline">
              <Link href="/purchases/returns-history">
                Returns history
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/purchases/send-back">
                <Undo2 className="mr-1.5 h-4 w-4" /> Send back
                {returnUnits.length ? (
                  <span className="ml-1.5 rounded-full bg-warning-soft px-1.5 text-xs font-semibold text-warning">{returnUnits.length}</span>
                ) : null}
              </Link>
            </Button>
            <Button asChild>
              <Link href="/purchases/new">
                <Plus className="mr-1.5 h-4 w-4" /> Book expected goods
              </Link>
            </Button>
          </>
        }
      />

      <form className="grid grid-cols-[1fr_auto] gap-2">
        <Input name="q" defaultValue={q} placeholder="Which bill did a phone come on? Type its IMEI" aria-label="Find the bill by IMEI" />
        <Button type="submit">Find</Button>
      </form>
      {q ? (
        <p className="-mt-3 text-sm text-muted-foreground">
          Showing bills that match “{q}”.{" "}
          <Link href="/purchases" className="font-medium text-primary hover:underline">
            Show every bill
          </Link>
        </p>
      ) : null}

      {openingPurchases.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary-soft p-4 text-sm text-foreground">
          <div className="space-y-0.5">
            <p className="font-semibold text-primary">Opening stock {formatCurrency(openingValue)}</p>
            <p className="text-xs text-muted-foreground">Value only. Not a bill to pay.</p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/opening-stock">Count and close opening stock</Link>
          </Button>
        </div>
      ) : null}

      {/* The money first: what these bills came to, what we paid, what is left. */}
      <StatGrid>
        {/* The true purchase value: what was billed less what went back to the
            supplier, so a send-back shows here and not only on Send back. */}
        <StatCard
          lead
          label="Purchases after send-backs"
          value={formatCurrency(billed - sentBack)}
          hint={
            sentBack > 0
              ? `${formatCurrency(billed)} billed, ${formatCurrency(sentBack)} sent back`
              : `${regularPurchases.length} supplier bill${regularPurchases.length === 1 ? "" : "s"}`
          }
        />
        <StatCard
          label="Sent back to suppliers"
          value={formatCurrency(sentBack)}
          hint={sentBack > 0 ? "Tap to see the full record" : "Nothing sent back"}
          tone={sentBack > 0 ? "warning" : "neutral"}
          href="/purchases/returns-history"
        />
        {shipping > 0 ? (
          <StatCard
            label="Shipping fees"
            value={formatCurrency(shipping)}
            hint="Inside the value, not owed to suppliers"
          />
        ) : null}
        <StatCard
          label="Payment"
          value={formatCurrency(paid)}
          tone="success"
        />
        <StatCard
          label="Value owing"
          value={owed > 0 ? `-${formatCurrency(owed)}` : surplus > 0 ? formatCurrency(surplus) : formatCurrency(0)}
          tone={owed > 0 ? "warning" : surplus > 0 ? "success" : "neutral"}
        />
        <StatCard
          label="Never scanned in"
          value={String(shortVsBill)}
          hint={shortVsBill > 0 ? "On the bill, never entered this shop" : undefined}
          tone={shortVsBill > 0 ? "danger" : "success"}
        />
      </StatGrid>

      <StatGrid>
        <StatCard label="On these bills" value={String(expected)} />
        <StatCard label="Scanned into the shop" value={String(recorded)} />
        <StatCard
          label="Sold from these cartons"
          value={String(sold)}
          hint={soldToday ? `${soldToday} sold today` : undefined}
        />
        <StatCard
          label="Still on our shelf"
          value={String(inShop)}
          href="/reconciliation"
        />
      </StatGrid>

        <PurchasesList
          search={q}
          purchases={purchases.map(
            (row): PurchaseRow => {
              const balance = purchaseBalance(row)
              return {
                id: row.id,
                invoiceNumber: row.invoiceNumber,
                status: row.status,
                isOpening: isOpeningStockPurchase(row),
                supplier: row.supplier.name,
                origin: [row.originCity || row.supplier.city, row.originCountry || row.supplier.country].filter(Boolean).join(", "),
                shop: row.branch.name,
                item: row.items[0]?.product.name ?? "",
                itemCount: row.items.length,
                expectedDate: row.expectedDate?.toISOString() ?? null,
                when: (row.receivedDate ?? row.createdAt).toISOString(),
                received: Boolean(row.receivedDate),
                total: money(row.totalAmount),
                shipping: balance.shipping,
                sentBack: balance.sentBack,
                paid: money(row.paidAmount),
                owed: balance.owed,
                surplus: balance.surplus,
                comingLots: row.incomingLots.filter((lot) => lot.status === "COMING").length,
                trace: row.trace,
              }
            }
          )}
        />
    </div>
  )
}
