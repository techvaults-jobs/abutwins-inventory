"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Download, FileSpreadsheet } from "lucide-react"
import { toast } from "sonner"
import { createTransfer } from "@/app/actions/ops"
import { getShopImeiSheet } from "@/app/actions/sales"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { downloadTable } from "@/lib/download-table"
import { formatCurrency, money } from "@/lib/utils"
import { watDayKey } from "@/lib/lagos-day"

type Branch = { id: string; name: string; code?: string }
type Product = {
  id: string
  name: string
  sku: string
  serialized: boolean
  costPrice: number
  brand?: { name: string }
  category?: { name: string }
  stock: Array<{ branchId: string; quantity: number; units?: number }>
}

type PhonePick = {
  imei: string
  name: string
  sku: string
  costPrice: number
}

export function TransferForm({
  branches,
  destinations,
  products = [],
  defaultFromId,
  successHref,
  atCost = false,
}: {
  /** Shops this person may send from. */
  branches: Branch[]
  /** Shops stock may go to: every open shop. Falls back to `branches`. */
  destinations?: Branch[]
  products?: Product[]
  imeis?: unknown
  defaultFromId?: string | null
  successHref?: string
  /**
   * The CEO values a transfer at cost. Everyone else values it at sell price:
   * their "costPrice" fields already hold the selling price from the server.
   */
  atCost?: boolean
}) {
  const router = useRouter()
  const unitWord = atCost ? "Unit cost" : "Unit price"
  const valueWord = atCost ? "Cost value" : "Value at sell price"
  const [fromId, setFromId] = useState(defaultFromId || branches[0]?.id || "")
  const receivers = destinations?.length ? destinations : branches
  const [toId, setToId] = useState(() => receivers.find((row) => row.id !== (defaultFromId || branches[0]?.id))?.id || "")
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [phones, setPhones] = useState<PhonePick[]>([])
  const [phonesBusy, setPhonesBusy] = useState(false)
  const [pickedImeis, setPickedImeis] = useState<Record<string, boolean>>({})
  const [accessoryQty, setAccessoryQty] = useState<Record<string, string>>({})
  const [query, setQuery] = useState("")

  const fromShop = branches.find((row) => row.id === fromId)
  const toShop = receivers.find((row) => row.id === toId)
  const toOptions = receivers.filter((row) => row.id !== fromId)

  const accessories = useMemo(
    () =>
      products
        .filter((product) => !product.serialized)
        .map((product) => ({
          ...product,
          costPrice: money(product.costPrice),
          onShelf: product.stock.find((row) => row.branchId === fromId)?.quantity ?? 0,
        }))
        .filter((product) => product.onShelf > 0),
    [products, fromId]
  )

  /**
   * Items the sending shop has on its shelf but cannot pick, because a phone
   * travels by its own number and those numbers are not recorded. This is the
   * usual reason the packing table looks empty while Shop stock shows plenty,
   * and it used to leave staff staring at a blank screen.
   */
  const unpickable = useMemo(
    () =>
      products
        .filter((product) => product.serialized)
        .map((product) => {
          const shelf = product.stock.find((row) => row.branchId === fromId)
          const onShelf = shelf?.quantity ?? 0
          const withNumbers = shelf?.units ?? 0
          return { product, missing: onShelf - withNumbers, onShelf, withNumbers }
        })
        .filter((row) => row.missing > 0)
        .sort((a, b) => b.missing - a.missing),
    [products, fromId]
  )
  const unpickableTotal = unpickable.reduce((sum, row) => sum + row.missing, 0)

  const needle = query.trim().toLowerCase()

  const visiblePhones = useMemo(() => {
    const list = !needle
      ? phones
      : phones.filter(
          (row) =>
            row.imei.toLowerCase().includes(needle) ||
            row.name.toLowerCase().includes(needle) ||
            row.sku.toLowerCase().includes(needle)
        )
    return list.slice(0, 120)
  }, [phones, needle])

  const visibleAccessories = useMemo(() => {
    if (!needle) return accessories
    return accessories.filter(
      (row) =>
        row.name.toLowerCase().includes(needle) ||
        row.sku.toLowerCase().includes(needle) ||
        row.brand?.name?.toLowerCase().includes(needle) ||
        row.category?.name?.toLowerCase().includes(needle)
    )
  }, [accessories, needle])

  const selectedPhones = useMemo(
    () => phones.filter((row) => pickedImeis[row.imei]),
    [phones, pickedImeis]
  )

  const selectedAccessories = useMemo(
    () =>
      accessories
        .map((product) => {
          const qty = Math.min(product.onShelf, Math.max(0, Math.floor(Number(accessoryQty[product.id]) || 0)))
          return { product, qty }
        })
        .filter((row) => row.qty > 0),
    [accessories, accessoryQty]
  )

  const phoneQty = selectedPhones.length
  const accessoryCount = selectedAccessories.reduce((sum, row) => sum + row.qty, 0)
  const totalQty = phoneQty + accessoryCount
  const phoneCost = selectedPhones.reduce((sum, row) => sum + money(row.costPrice), 0)
  const accessoryCost = selectedAccessories.reduce(
    (sum, row) => sum + row.qty * money(row.product.costPrice),
    0
  )
  const totalCost = phoneCost + accessoryCost

  useEffect(() => {
    let cancelled = false
    setPhonesBusy(true)
    setPickedImeis({})
    setAccessoryQty({})
    void getShopImeiSheet(fromId).then((result) => {
      if (cancelled) return
      const header = result.rows[0] ?? []
      const imeiIdx = header.findIndex((col) => /imei/i.test(col))
      const nameIdx = header.findIndex((col) => /name/i.test(col))
      const skuIdx = header.findIndex((col) => /item_code|sku/i.test(col))
      const costIdx = header.findIndex((col) => /unit_cost|unit_price|cost/i.test(col))
      const next: PhonePick[] = []
      for (const row of result.rows.slice(1)) {
        const imei = String(row[imeiIdx >= 0 ? imeiIdx : 0] || "").trim()
        if (!imei) continue
        next.push({
          imei,
          name: String(row[nameIdx >= 0 ? nameIdx : 3] || "").trim() || "Phone",
          sku: String(row[skuIdx >= 0 ? skuIdx : 2] || "").trim(),
          costPrice: money(Number(row[costIdx >= 0 ? costIdx : -1] || 0) || 0),
        })
      }
      setPhones(next)
      setPhonesBusy(false)
    })
    return () => {
      cancelled = true
    }
  }, [fromId])

  useEffect(() => {
    if (!toOptions.some((row) => row.id === toId)) {
      setToId(toOptions[0]?.id || "")
    }
  }, [fromId, toId, toOptions])

  function extractSelection(format: "csv" | "xlsx") {
    if (totalQty < 1) {
      toast.error("Select phones or type piece quantities before you extract.")
      return
    }
    const rows: Array<Array<string | number>> = [
      [
        "From shop",
        "To shop",
        "Item",
        "IMEI or item code",
        "Qty to send",
        unitWord,
        valueWord,
      ],
      ...selectedPhones.map((row) => [
        fromShop?.name ?? "",
        toShop?.name ?? "",
        row.name,
        row.imei,
        1,
        money(row.costPrice).toFixed(2),
        money(row.costPrice).toFixed(2),
      ]),
      ...selectedAccessories.map(({ product, qty }) => [
        fromShop?.name ?? "",
        toShop?.name ?? "",
        product.name,
        product.sku,
        qty,
        money(product.costPrice).toFixed(2),
        (qty * money(product.costPrice)).toFixed(2),
      ]),
      [],
      ["Total qty to send", totalQty],
      [`Total ${valueWord.toLowerCase()}`, totalCost.toFixed(2)],
    ]
    const stamp = watDayKey()
    const base = `shop-to-shop-selection-${fromShop?.code ?? "from"}-to-${toShop?.code ?? "to"}-${stamp}`
    void downloadTable(rows, `${base}.${format}`, format)
    toast.success(format === "xlsx" ? "Excel extracted for this selection." : "CSV extracted for this selection.")
  }

  function extractAvailable(format: "csv" | "xlsx") {
    const rows: Array<Array<string | number>> = [
      [
        "Shop",
        "Kind",
        "Item",
        "IMEI or item code",
        "On hand",
        "Qty to send",
        unitWord,
        `${valueWord} if sent`,
      ],
      ...phones.map((row) => {
        const sending = pickedImeis[row.imei] ? 1 : 0
        return [
          fromShop?.name ?? "",
          "Phone",
          row.name,
          row.imei,
          1,
          sending,
          money(row.costPrice).toFixed(2),
          sending ? money(row.costPrice).toFixed(2) : "0.00",
        ]
      }),
      ...accessories.map((product) => {
        const qty = Math.min(product.onShelf, Math.max(0, Math.floor(Number(accessoryQty[product.id]) || 0)))
        return [
          fromShop?.name ?? "",
          "Piece item",
          product.name,
          product.sku,
          product.onShelf,
          qty,
          money(product.costPrice).toFixed(2),
          (qty * money(product.costPrice)).toFixed(2),
        ]
      }),
      [],
      ["Selected qty to send", totalQty],
      [`Selected ${valueWord.toLowerCase()}`, totalCost.toFixed(2)],
    ]
    const stamp = watDayKey()
    const base = `shop-to-shop-stock-${fromShop?.code ?? "shop"}-${stamp}`
    void downloadTable(rows, `${base}.${format}`, format)
    toast.success(format === "xlsx" ? "Excel extracted for this shop stock." : "CSV extracted for this shop stock.")
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // Only the "Yes, send it" button sends. Enter in a box, or a scanner's
    // Enter after a number, used to send the transfer with whatever was picked
    // so far, so a third item could never be added.
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null
    if (!confirming || submitter?.dataset.confirm !== "yes") {
      if (totalQty > 0) setConfirming(true)
      return
    }
    setConfirming(false)
    const form = event.currentTarget
    const data = new FormData(form)
    const imeis = Object.entries(pickedImeis)
      .filter(([, on]) => on)
      .map(([imei]) => imei)
    // Send the quantity the table shows. The box caps what it displays at what
    // is on the shelf, but used to send whatever was typed, so typing 5 when 3
    // were on hand read as 3 on screen and was refused by the server as 5.
    const shelfById = new Map(accessories.map((row) => [row.id, row.onShelf]))
    const accessoryLines = Object.entries(accessoryQty)
      .map(([productId, quantity]) => ({
        productId,
        quantity: Math.min(shelfById.get(productId) ?? 0, Math.max(0, Math.floor(Number(quantity) || 0))),
      }))
      .filter((row) => row.quantity > 0)
    data.set("selectedImeis", imeis.join("\n"))
    data.set("accessoryLines", JSON.stringify(accessoryLines))
    setBusy(true)
    setErrors([])
    const outcome = await createTransfer(data)
    setBusy(false)
    if (outcome.error) {
      toast.error(outcome.error)
      setErrors(outcome.errors ?? [outcome.error])
      return
    }
    toast.success("Transfer submitted. Stock stays In shop until the other shop accepts.")
    setPickedImeis({})
    setAccessoryQty({})
    form.reset()
    if (successHref) router.push(successHref)
    router.refresh()
  }

  /** Enter in the find box (or a scan) ticks the phone with that exact number. */
  function pickByCode(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return
    event.preventDefault()
    const code = query.replace(/[\s-]/g, "").trim()
    if (!code) return
    const hit = phones.find((row) => row.imei === code)
    if (!hit) {
      toast.error(`${code} is not a phone In shop at ${fromShop?.name ?? "this shop"}.`)
      return
    }
    setPickedImeis((current) => ({ ...current, [hit.imei]: true }))
    setQuery("")
    toast.success(`Picked ${hit.name}`)
  }

  return (
    <form
      onSubmit={onSubmit}
      onKeyDown={(event) => {
        // Prevent Enter from triggering form submission anywhere except the
        // explicit "Yes, send it" confirm button. Scanners press Enter after
        // a number; that Enter must tick the phone, not send the transfer.
        if (event.key !== "Enter") return
        const target = event.target as HTMLElement
        const isConfirmButton =
          target instanceof HTMLButtonElement &&
          target.type === "submit" &&
          target.dataset.confirm === "yes"
        if (!isConfirmButton) event.preventDefault()
      }}
      className="space-y-5"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-2 text-sm">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">From (Branch)</span>
          <Select
            name="fromBranchId"
            value={fromId}
            onChange={(event) => setFromId(event.target.value)}
            required
          >
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </Select>
        </label>

        <label className="block space-y-2 text-sm">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">To (Pick the branch)</span>
          <Select name="toBranchId" value={toId} onChange={(event) => setToId(event.target.value)} required>
            {toOptions.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </Select>
        </label>
      </div>

      <div className="space-y-3 rounded-xl border border-border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Select the items</p>
            <p className="text-xs text-muted-foreground">
              Find by IMEI, name, item code, or category. Type how many pieces to send. {valueWord} is {unitWord.toLowerCase()} × qty to send.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => extractAvailable("csv")}>
              <Download className="mr-1.5 h-4 w-4" /> Extract stock (CSV)
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => extractAvailable("xlsx")}>
              <FileSpreadsheet className="mr-1.5 h-4 w-4" /> Extract stock (Excel)
            </Button>
          </div>
        </div>

        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={pickByCode}
          placeholder="Find IMEI, item code, name, brand, or category. Scan an IMEI to pick it."
          aria-label="Find items to send"
        />

        {unpickableTotal > 0 ? (
          <div className="rounded-lg bg-warning-soft px-4 py-3 text-sm text-warning">
            <p className="font-medium">
              {unpickableTotal} unit{unpickableTotal === 1 ? "" : "s"} on this shop&apos;s shelf cannot be
              picked, because their phone numbers are not recorded
            </p>
            <p className="mt-1 text-xs">
              A phone travels by its own number, so it has to be on the phone list before it can be
              sent. Put the missing numbers in under Phone numbers (IMEI), then come back here.
            </p>
            <ul className="mt-2 space-y-0.5 text-xs">
              {unpickable.slice(0, 6).map((row) => (
                <li key={row.product.id}>
                  {row.product.name} — shelf shows {row.onShelf}, {row.withNumbers} ha
                  {row.withNumbers === 1 ? "s" : "ve"} a number, {row.missing} missing
                </li>
              ))}
              {unpickable.length > 6 ? <li>and {unpickable.length - 6} more items</li> : null}
            </ul>
          </div>
        ) : null}

        <div className="max-h-[60vh] overflow-auto rounded-lg border border-border">
          <table className="min-w-full text-sm">
            <thead className="sticky top-0 z-10 bg-muted text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-semibold">Item</th>
                <th className="hidden px-3 py-2 font-semibold sm:table-cell">IMEI or item code</th>
                <th className="px-3 py-2 text-center font-semibold">On hand</th>
                <th className="px-3 py-2 text-center font-semibold">Qty to send</th>
                <th className="hidden px-3 py-2 text-right font-semibold sm:table-cell">{unitWord}</th>
                <th className="px-3 py-2 text-right font-semibold">{valueWord}</th>
              </tr>
            </thead>
            <tbody>
              {phonesBusy ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                    Loading phones In shop at {fromShop?.name ?? "this branch"}
                  </td>
                </tr>
              ) : null}

              {!phonesBusy && visiblePhones.length === 0 && visibleAccessories.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                    {needle
                      ? `Nothing at ${fromShop?.name ?? "this branch"} matches "${query.trim()}".`
                      : unpickableTotal > 0
                        ? `${fromShop?.name ?? "This branch"} has nothing that can be picked. Its shelf shows ${unpickableTotal} unit${unpickableTotal === 1 ? "" : "s"}, but none of them have phone numbers recorded — see the note above.`
                        : `${fromShop?.name ?? "This branch"} has nothing In shop to send. Pick another sending branch.`}
                  </td>
                </tr>
              ) : null}

              {visiblePhones.map((phone) => {
                const sending = Boolean(pickedImeis[phone.imei])
                const unit = money(phone.costPrice)
                return (
                  <tr key={phone.imei} className="border-t border-border/70">
                    <td className="px-3 py-2">
                      <p className="font-medium">{phone.name}</p>
                      <p className="text-xs text-muted-foreground">Phone · qty 1</p>
                      <p className="font-mono text-xs text-muted-foreground sm:hidden">{phone.imei}</p>
                    </td>
                    <td className="hidden px-3 py-2 font-mono text-xs sm:table-cell">{phone.imei}</td>
                    <td className="px-3 py-2 text-center tabular-nums">1</td>
                    <td className="px-3 py-2 text-center">
                      <label className="inline-flex items-center gap-2">
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          checked={sending}
                          onChange={(event) =>
                            setPickedImeis((current) => ({ ...current, [phone.imei]: event.target.checked }))
                          }
                          aria-label={`Send ${phone.imei}`}
                        />
                        <span className="tabular-nums font-semibold">{sending ? "1" : "0"}</span>
                      </label>
                    </td>
                    <td className="hidden px-3 py-2 text-right tabular-nums sm:table-cell">{formatCurrency(unit)}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">
                      {formatCurrency(sending ? unit : 0)}
                    </td>
                  </tr>
                )
              })}

              {visibleAccessories.map((product) => {
                const raw = accessoryQty[product.id] ?? ""
                const qty = Math.min(product.onShelf, Math.max(0, Math.floor(Number(raw) || 0)))
                const unit = money(product.costPrice)
                return (
                  <tr key={product.id} className="border-t border-border/70">
                    <td className="px-3 py-2">
                      <p className="font-medium">{product.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {[product.brand?.name, product.category?.name].filter(Boolean).join(" · ") || "Piece item"}
                      </p>
                      <p className="font-mono text-xs text-muted-foreground sm:hidden">{product.sku}</p>
                    </td>
                    <td className="hidden px-3 py-2 font-mono text-xs sm:table-cell">{product.sku}</td>
                    <td className="px-3 py-2 text-center tabular-nums font-semibold">{product.onShelf}</td>
                    <td className="px-3 py-2 text-center">
                      <Input
                        type="number"
                        min={0}
                        max={product.onShelf}
                        step={1}
                        value={raw}
                        onChange={(event) =>
                          setAccessoryQty((current) => ({ ...current, [product.id]: event.target.value }))
                        }
                        placeholder="0"
                        aria-label={`Qty to send of ${product.name}`}
                        className="mx-auto h-9 w-20 text-center sm:w-24 font-semibold tabular-nums"
                      />
                    </td>
                    <td className="hidden px-3 py-2 text-right tabular-nums sm:table-cell">{formatCurrency(unit)}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">
                      {formatCurrency(qty * unit)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {phones.length > visiblePhones.length && !needle ? (
          <p className="text-xs text-muted-foreground">
            Showing the first {visiblePhones.length} phones. Type in Find to narrow the list.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-3">
          <div className="text-sm">
            <p>
              <span className="text-muted-foreground">Qty to send: </span>
              <strong className="tabular-nums">{totalQty}</strong>
              <span className="text-muted-foreground">
                {" "}
                ({phoneQty} phone{phoneQty === 1 ? "" : "s"}
                {accessoryCount ? ` · ${accessoryCount} piece${accessoryCount === 1 ? "" : "s"}` : ""})
              </span>
            </p>
            <p className="mt-1">
              <span className="text-muted-foreground">{valueWord}: </span>
              <strong className="tabular-nums">{formatCurrency(totalCost)}</strong>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" disabled={totalQty < 1} onClick={() => extractSelection("csv")}>
              <Download className="mr-1.5 h-4 w-4" /> Extract selection (CSV)
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={totalQty < 1} onClick={() => extractSelection("xlsx")}>
              <FileSpreadsheet className="mr-1.5 h-4 w-4" /> Extract selection (Excel)
            </Button>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-warning/40 bg-warning-soft px-3 py-2 text-xs text-warning">
        After you submit, wait for the receiving branch to accept or reject. Stock stays on the sending branch In shop record until they accept. Accept and Reject stay the same.
      </div>

      {confirming ? (
        <div className="space-y-3 rounded-xl border border-primary/40 bg-primary-soft p-4">
          <p className="text-sm">
            Send <span className="font-semibold">{totalQty}</span> item{totalQty === 1 ? "" : "s"} from{" "}
            <span className="font-semibold">{fromShop?.name}</span> to <span className="font-semibold">{toShop?.name}</span>
            {totalCost > 0 ? <> · {valueWord.toLowerCase()} {formatCurrency(totalCost)}</> : null}?
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" data-confirm="yes" disabled={busy}>
              {busy ? "Sending" : "Yes, send it"}
            </Button>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)} disabled={busy}>
              Keep picking
            </Button>
          </div>
        </div>
      ) : (
        <Button type="submit" disabled={busy || totalQty < 1} className="w-full sm:w-auto">
          Send transfer ({totalQty} item{totalQty === 1 ? "" : "s"})
        </Button>
      )}

      {errors.length ? (
        <ul className="list-disc pl-5 text-sm text-warning">
          {errors.slice(0, 12).map((error) => (
            <li key={error}>{error}</li>
          ))}
          {errors.length > 12 ? <li>And {errors.length - 12} more lines to fix.</li> : null}
        </ul>
      ) : null}
    </form>
  )
}
