"use client"

import { useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { nameSupplierPaymentBank, type UnnamedSupplierPayment } from "@/app/actions/finance"
import { EmptyState } from "@/components/shared"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { formatShopWhen } from "@/lib/lagos-day"
import { formatCurrency } from "@/lib/utils"

type Bank = { id: string; label: string }

/** How many lines are drawn at once. The rest wait behind the supplier filter. */
const SHOWN = 200

export function NameBanksView({ rows, banks, total }: { rows: UnnamedSupplierPayment[]; banks: Bank[]; total: number }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [supplier, setSupplier] = useState("all")
  const [bankId, setBankId] = useState("")
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  /** Part of a bill's unrecorded payment, when it was paid from two banks. */
  const [amounts, setAmounts] = useState<Record<string, string>>({})

  const suppliers = useMemo(() => [...new Set(rows.map((row) => row.supplier))].sort((a, b) => a.localeCompare(b)), [rows])
  const filtered = useMemo(() => (supplier === "all" ? rows : rows.filter((row) => row.supplier === supplier)), [rows, supplier])
  const shown = filtered.slice(0, SHOWN)
  const amountOf = (row: UnnamedSupplierPayment) => {
    const typed = Number(amounts[row.key])
    return row.kind === "gap" && Number.isFinite(typed) && typed > 0 ? Math.min(typed, row.amount) : row.amount
  }
  const tickedRows = shown.filter((row) => ticked.has(row.key))
  const tickedTotal = tickedRows.reduce((sum, row) => sum + amountOf(row), 0)
  const allTicked = shown.length > 0 && tickedRows.length === shown.length

  function toggle(key: string) {
    setTicked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function save() {
    if (!tickedRows.length) {
      toast.error("Tick the payments that left from one bank account.")
      return
    }
    if (!bankId) {
      toast.error("Pick the bank account these payments left from.")
      return
    }
    startTransition(async () => {
      const result = await nameSupplierPaymentBank({
        keys: tickedRows.map((row) => row.key),
        bankAccountId: bankId,
        amounts: Object.fromEntries(tickedRows.filter((row) => row.kind === "gap").map((row) => [row.key, amountOf(row)])),
      })
      if ("error" in result && result.error) {
        toast.error(result.error)
        return
      }
      toast.success(
        `${result.named} payment${result.named === 1 ? "" : "s"} worth ${formatCurrency(result.total ?? 0)} now ${result.named === 1 ? "shows" : "show"} under ${result.bank} on Money in and out.`
      )
      setTicked(new Set())
      setAmounts({})
      router.refresh()
    })
  }

  if (!rows.length) {
    return (
      <EmptyState
        title="Every supplier payment names its bank"
        hint="Nothing is left to do here. New payments ask for the bank when they are made."
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="surface-card flex flex-wrap items-end justify-between gap-3 p-5">
        <div>
          <p className="eyebrow">Paid to suppliers with no bank named</p>
          <p className="mt-1 text-2xl font-semibold num">{formatCurrency(total)}</p>
        </div>
        <p className="max-w-xl text-sm text-muted-foreground">
          {rows.length} payment{rows.length === 1 ? "" : "s"}. Naming the bank changes nothing that was paid or is owed. The
          payment only moves onto the account it left, so that account&apos;s balance on Money in and out is true.
        </p>
      </div>

      {banks.length === 0 ? (
        <p className="rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-sm">
          No bank account is set up yet. Add the bank accounts on{" "}
          <Link href="/finance" className="font-medium text-primary hover:underline">
            Money in and out
          </Link>{" "}
          first, then come back.
        </p>
      ) : null}

      <div className="surface-card sticky top-16 z-10 flex flex-wrap items-end gap-3 p-4">
        <label className="block text-sm">
          <span className="eyebrow mb-1 block">Show payments to</span>
          <Select
            value={supplier}
            onChange={(event) => {
              setSupplier(event.target.value)
              setTicked(new Set())
            }}
            disabled={pending}
          >
            <option value="all">Every supplier</option>
            {suppliers.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </label>
        <label className="block min-w-[240px] flex-1 text-sm">
          <span className="eyebrow mb-1 block">The ticked payments left from</span>
          <Select value={bankId} onChange={(event) => setBankId(event.target.value)} disabled={pending || banks.length === 0}>
            <option value="" disabled>
              Pick the bank account
            </option>
            {banks.map((bank) => (
              <option key={bank.id} value={bank.id}>
                {bank.label}
              </option>
            ))}
          </Select>
        </label>
        <Button type="button" onClick={save} disabled={pending || !tickedRows.length || !bankId}>
          {pending
            ? "Saving"
            : tickedRows.length
              ? `Name this bank for ${tickedRows.length} payment${tickedRows.length === 1 ? "" : "s"} · ${formatCurrency(tickedTotal)}`
              : "Tick payments below"}
        </Button>
      </div>

      <div className="surface-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label="Tick every payment shown"
                    checked={allTicked}
                    disabled={pending}
                    onChange={() => setTicked(allTicked ? new Set() : new Set(shown.map((row) => row.key)))}
                  />
                </th>
                <th className="px-3 py-3">When</th>
                <th className="px-3 py-3">Supplier</th>
                <th className="px-3 py-3">Bill</th>
                <th className="px-3 py-3">Shop</th>
                <th className="px-3 py-3">What it is</th>
                <th className="px-4 py-3 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {shown.map((row) => (
                <tr key={row.key} className={ticked.has(row.key) ? "bg-primary/5" : "hover:bg-muted/30"}>
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label={`Tick the payment on ${row.invoiceNumber}`}
                      checked={ticked.has(row.key)}
                      disabled={pending}
                      onChange={() => toggle(row.key)}
                    />
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-muted-foreground">{formatShopWhen(row.date)}</td>
                  <td className="px-3 py-3 font-medium">{row.supplier}</td>
                  <td className="px-3 py-3">
                    <Link href={`/purchases/${row.billId}`} className="whitespace-nowrap font-medium text-primary hover:underline">
                      {row.invoiceNumber}
                    </Link>
                  </td>
                  <td className="px-3 py-3">{row.shop}</td>
                  <td className="px-3 py-3 text-muted-foreground">{row.what}</td>
                  <td className="px-4 py-3 text-right">
                    {row.kind === "gap" ? (
                      <div className="flex flex-col items-end gap-1">
                        <Input
                          type="number"
                          min={0}
                          max={row.amount}
                          step="0.01"
                          aria-label={`Amount from this bank on ${row.invoiceNumber}`}
                          value={amounts[row.key] ?? String(row.amount)}
                          onChange={(event) => setAmounts((prev) => ({ ...prev, [row.key]: event.target.value }))}
                          disabled={pending}
                          className="num h-9 w-40 text-right"
                        />
                        <span className="text-xs text-muted-foreground">
                          of {formatCurrency(row.amount)}. Lower it if two banks paid this bill.
                        </span>
                      </div>
                    ) : (
                      <span className="num font-semibold">{formatCurrency(row.amount)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length > shown.length ? (
          <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
            Showing the newest {shown.length} of {filtered.length}. Pick one supplier above, or name these and the next ones
            come up.
          </p>
        ) : null}
      </div>
    </div>
  )
}
