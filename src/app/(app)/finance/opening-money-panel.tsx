"use client"

import Link from "next/link"
import { useState } from "react"
import { ArrowDownLeft, ArrowUpRight, ChevronRight } from "lucide-react"
import { ActionForm } from "@/components/action-form"
import { DrilldownModal } from "@/components/drilldown-modal"
import { SectionCard } from "@/components/shared"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import {
  createBankAccount,
  getBankAccountLedger,
  saveBankOpening,
  saveOpeningCash,
  takeBankOffTheBooks,
  type NamedBankRow,
  type OpeningCashShop,
} from "@/app/actions/finance"
import { cn, formatCurrency } from "@/lib/utils"
import { formatShopWhen } from "@/lib/lagos-day"

export function OpeningMoneyPanel({
  shops,
  bankAccounts,
  canSet,
  canRemoveBank = false,
  openingCash,
  openingBank,
  supplierPaidNoBank = 0,
  canNameSupplierBanks = false,
}: {
  shops: OpeningCashShop[]
  bankAccounts: NamedBankRow[]
  canSet: boolean
  canRemoveBank?: boolean
  openingCash: number
  openingBank: number
  /** Supplier money that left by bank before payments named an account. */
  supplierPaidNoBank?: number
  /** Whoever pays suppliers can go and name the bank for those payments. */
  canNameSupplierBanks?: boolean
}) {
  const [drillAccount, setDrillAccount] = useState<NamedBankRow | null>(null)
  const [drillLines, setDrillLines] = useState<Awaited<ReturnType<typeof getBankAccountLedger>>>([])
  const [drillLoading, setDrillLoading] = useState(false)

  async function openDrill(account: NamedBankRow) {
    setDrillAccount(account)
    setDrillLines([])
    setDrillLoading(true)
    try {
      const lines = await getBankAccountLedger(account.id)
      setDrillLines(lines)
    } finally {
      setDrillLoading(false)
    }
  }

  const drillBalance = drillAccount
    ? drillAccount.openingBalance + drillAccount.salesReceived + drillAccount.depositsReceived - drillAccount.refundsPaid - drillAccount.supplierPaid
    : 0
  return (
    <>
    <SectionCard
      title="Money we started with"
      description="Cash and banks already there when this software started. Not opening stock."
    >
      <div className="space-y-6">
        <div className="flex flex-wrap gap-4 text-sm">
          <p>
            Opening cash: <span className="num font-semibold">{formatCurrency(openingCash)}</span>
          </p>
          <p>
            Opening banks: <span className="num font-semibold">{formatCurrency(openingBank)}</span>
          </p>
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Opening cash by shop</h3>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Shop</th>
                  <th className="px-3 py-2 text-right font-medium">Opening cash</th>
                  {canSet ? <th className="px-3 py-2 font-medium">Save a new figure</th> : null}
                </tr>
              </thead>
              <tbody>
                {shops.map((shop) => (
                  <tr key={shop.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <p className="font-medium">{shop.name}</p>
                      <p className="text-xs text-muted-foreground">{shop.code}</p>
                    </td>
                    <td className="px-3 py-2 text-right num font-semibold">{formatCurrency(shop.openingCash)}</td>
                    {canSet ? (
                      <td className="px-3 py-2">
                        <ActionForm
                          action={saveOpeningCash}
                          submit="Save opening cash for this shop"
                          pendingLabel="Saving opening cash for this shop"
                          successMessage={`Opening cash saved for ${shop.name}`}
                          resetOnSuccess={false}
                          className="flex flex-wrap items-end gap-2"
                          buttonClassName="mt-0"
                          size="sm"
                        >
                          <input type="hidden" name="branchId" value={shop.id} />
                          <div className="min-w-40 flex-1">
                            <Label htmlFor={`opening-cash-${shop.id}`} className="sr-only">
                              Opening cash at {shop.name}
                            </Label>
                            <Input
                              id={`opening-cash-${shop.id}`}
                              name="amount"
                              type="number"
                              min={0}
                              step="0.01"
                              defaultValue={shop.openingCash || ""}
                              placeholder="Cash in the till, in naira"
                              required
                            />
                          </div>
                        </ActionForm>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shops.length === 0 ? (
            <p className="text-sm text-muted-foreground">No shop is open to hold opening cash.</p>
          ) : null}
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Bank accounts</h3>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Bank</th>
                  <th className="px-3 py-2 font-medium">Account number</th>
                  <th className="px-3 py-2 font-medium">Shop</th>
                  <th className="px-3 py-2 text-right font-medium">Opening balance</th>
                  <th className="px-3 py-2 text-right font-medium">Sales into this account</th>
                  <th className="px-3 py-2 text-right font-medium">Cash from the till</th>
                  <th className="px-3 py-2 text-right font-medium">Refunds out</th>
                  <th className="px-3 py-2 text-right font-medium">Paid to suppliers</th>
                  <th className="px-3 py-2 text-right font-medium">Balance</th>
                  {canSet ? <th className="px-3 py-2 font-medium">Change</th> : null}
                </tr>
              </thead>
              <tbody>
                {bankAccounts.map((row) => (
                  <tr
                    key={row.id}
                    className="group cursor-pointer border-t border-border transition-colors hover:bg-muted/60"
                    onClick={() => void openDrill(row)}
                  >
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div>
                          <p className="font-medium group-hover:text-primary">{row.bankName}</p>
                          {row.accountName ? <p className="text-xs text-muted-foreground">{row.accountName}</p> : null}
                        </div>
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                      </div>
                    </td>
                    <td className="px-3 py-2 num">{row.accountNumber}</td>
                    <td className="px-3 py-2">{row.branchName}</td>
                    <td className="px-3 py-2 text-right num font-semibold">{formatCurrency(row.openingBalance)}</td>
                    <td className="px-3 py-2 text-right num">{formatCurrency(row.salesReceived)}</td>
                    <td className="px-3 py-2 text-right num">{formatCurrency(row.depositsReceived)}</td>
                    <td className="px-3 py-2 text-right num">{formatCurrency(row.refundsPaid)}</td>
                    <td className="px-3 py-2 text-right num">{formatCurrency(row.supplierPaid)}</td>
                    <td className="px-3 py-2 text-right num font-semibold text-primary">
                      {formatCurrency(row.openingBalance + row.salesReceived + row.depositsReceived - row.refundsPaid - row.supplierPaid)}
                    </td>
                    {canSet ? (
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <div className="flex flex-wrap items-end gap-2">
                          <ActionForm
                            action={saveBankOpening}
                            submit="Save this opening"
                            pendingLabel="Saving this opening"
                            successMessage={`Opening balance saved for ${row.bankName}`}
                            resetOnSuccess={false}
                            className="flex flex-wrap items-end gap-2"
                            buttonClassName="mt-0"
                            size="sm"
                          >
                            <input type="hidden" name="id" value={row.id} />
                            <Input
                              name="openingBalance"
                              type="number"
                              min={0}
                              step="0.01"
                              defaultValue={row.openingBalance || ""}
                              placeholder="Opening balance, in naira"
                              required
                              className="w-40"
                            />
                          </ActionForm>
                          {canRemoveBank ? (
                          <ActionForm
                            action={takeBankOffTheBooks}
                            submit="Take this bank off the books"
                            pendingLabel="Taking this bank off the books"
                            successMessage={`${row.bankName} is off the books`}
                            className="flex"
                            buttonClassName="mt-0"
                            size="sm"
                            variant="outline"
                            confirmModal={{
                              title: `Take ${row.bankName} off the books?`,
                              description: `Account ${row.accountNumber} will leave Money in and out. Who did what keeps this step.`,
                              confirmLabel: "Take this bank off the books",
                              cancelLabel: "Keep this bank",
                              tone: "danger",
                            }}
                          >
                            <input type="hidden" name="id" value={row.id} />
                          </ActionForm>
                          ) : null}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
                {bankAccounts.length === 0 ? (
                  <tr>
                    <td className="px-3 py-4 text-sm text-muted-foreground" colSpan={canSet ? 9 : 8}>
                      No bank account is on the books yet. Add GTBank, Access, or another account the shops use. Sell now Bank sales pick from this list.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {supplierPaidNoBank > 0 ? (
            <p className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-foreground">
              <span className="font-semibold">{formatCurrency(supplierPaidNoBank)} paid to suppliers names no bank account.</span>{" "}
              These payments were recorded before a transfer had to say which bank it left from, so they come off Bank as a
              whole and off none of the accounts above. Every new
              supplier payment names its bank and shows under Paid to suppliers on that account.
              {canNameSupplierBanks ? (
                <>
                  {" "}
                  <Link href="/finance/supplier-banks" className="font-semibold text-primary hover:underline">
                    Name the bank for these payments
                  </Link>
                </>
              ) : null}
            </p>
          ) : null}
        </div>

        {canSet && shops.length > 0 ? (
          <div className="max-w-xl space-y-3 rounded-lg border border-border p-4">
            <h3 className="text-sm font-semibold">Add a bank account</h3>
            <p className="text-sm text-muted-foreground">
              Type the bank name, the account number, and the money already in that account when this software started.
            </p>
            <ActionForm
              action={createBankAccount}
              submit="Save this bank account"
              pendingLabel="Saving this bank account"
              successMessage="Bank account saved"
              className="space-y-3"
            >
              {shops.length > 1 ? (
                <div className="space-y-1">
                  <Label htmlFor="bank-shop">Shop</Label>
                  <Select id="bank-shop" name="branchId" required>
                    {shops.map((shop) => (
                      <option key={shop.id} value={shop.id}>
                        {shop.name}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : (
                <input type="hidden" name="branchId" value={shops[0]?.id || ""} />
              )}
              <div className="space-y-1">
                <Label htmlFor="bank-name">Bank name</Label>
                <Input id="bank-name" name="bankName" placeholder="GTBank, Access Bank, or OPay" required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="bank-number">Account number</Label>
                <Input id="bank-number" name="accountNumber" inputMode="numeric" placeholder="Account number" required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="bank-holder">Name on the account</Label>
                <Input id="bank-holder" name="accountName" placeholder="Abu Twins Softskills, if it is on the account" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="bank-opening">Opening balance, in naira</Label>
                <Input
                  id="bank-opening"
                  name="openingBalance"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="Money already in this account"
                  required
                />
              </div>
            </ActionForm>
          </div>
        ) : canSet ? null : (
          <p className="text-sm text-muted-foreground">
            The main admin, the CEO, the accountant, or the records checker can type opening cash and add a bank.
          </p>
        )}
      </div>
    </SectionCard>

    {/* ── Per-account drilldown modal ─────────────────────────────────────── */}
    {drillAccount ? (
      <DrilldownModal
        open={Boolean(drillAccount)}
        onClose={() => { setDrillAccount(null); setDrillLines([]) }}
        eyebrow={`${drillAccount.bankName} · ${drillAccount.accountNumber}${drillAccount.accountName ? ` · ${drillAccount.accountName}` : ""} · ${drillAccount.branchName}`}
        title="All transactions on this account"
        summary={
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {[
              { label: "Opening balance", value: drillAccount.openingBalance, tone: "" },
              { label: "Sales received", value: drillAccount.salesReceived, tone: "text-success" },
              { label: "Cash from till", value: drillAccount.depositsReceived, tone: "text-success" },
              { label: "Refunds out", value: drillAccount.refundsPaid, tone: "text-warning" },
              { label: "Paid to suppliers", value: drillAccount.supplierPaid, tone: "text-warning" },
            ].map((item) => (
              <div key={item.label} className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-center">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{item.label}</p>
                <p className={cn("mt-0.5 text-base font-semibold tabular-nums", item.tone)}>{formatCurrency(item.value)}</p>
              </div>
            ))}
          </div>
        }
        download={{
          filename: `bank-${drillAccount.bankName}-${drillAccount.accountNumber}`,
          rows: () => [
            ["Date", "Type", "Category", "Description", "Ref", "Amount (₦)", "Balance (₦)"],
            ...drillLines.map((line) => [
              formatShopWhen(line.date),
              line.type === "IN" ? "In" : "Out",
              line.category,
              line.description,
              line.reference ?? "",
              line.type === "IN" ? line.amount : -line.amount,
              line.runningBalance,
            ]),
            [],
            ["Balance", "", "", "", "", "", drillBalance],
          ],
        }}
        width="wide"
      >
        {drillLoading ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">Loading transactions for this account</p>
        ) : drillLines.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">
            No transactions on this account yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left">
                <tr>
                  <th className="px-5 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Date</th>
                  <th className="px-5 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Category</th>
                  <th className="px-5 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Description</th>
                  <th className="hidden px-5 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:table-cell">Ref</th>
                  <th className="px-5 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Amount</th>
                  <th className="px-5 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Balance</th>
                </tr>
              </thead>
              <tbody>
                {drillLines.map((line) => (
                  <tr key={line.id} className="border-b border-border/60 hover:bg-muted/40">
                    <td className="whitespace-nowrap px-5 py-2.5 tabular-nums text-muted-foreground">
                      {formatShopWhen(line.date)}
                    </td>
                    <td className="px-5 py-2.5">
                      <span className={cn(
                        "inline-flex items-center gap-1 text-xs font-medium",
                        line.type === "IN" ? "text-success" : "text-warning"
                      )}>
                        {line.type === "IN"
                          ? <ArrowDownLeft className="h-3 w-3 shrink-0" />
                          : <ArrowUpRight className="h-3 w-3 shrink-0" />}
                        {line.category}
                      </span>
                    </td>
                    <td className="px-5 py-2.5">
                      <p className="text-sm">{line.description}</p>
                    </td>
                    <td className="hidden whitespace-nowrap px-5 py-2.5 sm:table-cell">
                      {line.reference ? (
                        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{line.reference}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className={cn(
                      "whitespace-nowrap px-5 py-2.5 text-right tabular-nums font-semibold",
                      line.type === "IN" ? "text-success" : "text-warning"
                    )}>
                      {line.type === "IN" ? "+" : "−"}{formatCurrency(line.amount)}
                    </td>
                    <td className="whitespace-nowrap px-5 py-2.5 text-right tabular-nums font-semibold">
                      {formatCurrency(line.runningBalance)}
                    </td>
                  </tr>
                ))}
                {/* Balance row */}
                <tr className="border-t-2 border-border bg-muted/40">
                  <td colSpan={4} className="px-5 py-2.5 text-sm font-semibold">Balance</td>
                  <td />
                  <td className="px-5 py-2.5 text-right tabular-nums text-lg font-semibold text-primary">
                    {formatCurrency(drillBalance)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </DrilldownModal>
    ) : null}
    </>
  )
}
