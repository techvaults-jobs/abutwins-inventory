import Link from "next/link"
import { notFound } from "next/navigation"
import { reverseSupplierPayment } from "@/app/actions/access"
import { cancelSupplierBill } from "@/app/actions/corrections"
import { CancelRecordCard } from "@/components/cancel-record-card"
import { bookPurchaseAsComing } from "@/app/actions/incoming"
import { getPurchase, receivePurchaseImeis, setPurchaseShippingFee } from "@/app/actions/ops"
import { listPayingBanks } from "@/lib/supplier-pay"
import { PaySupplierForm } from "../pay-supplier-form"
import { CorrectLineCost } from "../correct-line-cost"
import { canChangeCost } from "@/lib/roles"
import { shopConditionLabel } from "@/lib/conditions"
import { ExportCsv } from "@/components/export-csv"
import { prisma } from "@/lib/prisma"
import { can } from "@/lib/permissions"
import { canManageFinance, isShopOwner } from "@/lib/rbac"
import { requireUser } from "@/lib/session"
import { ActionForm } from "@/components/action-form"
import { PageHeader, StatusBadge } from "@/components/shared"
import { WorkflowSteps } from "@/components/workflow-steps"
import { Input } from "@/components/ui/input"
import { ScanList } from "@/components/scan-field"
import { statusLabel } from "@/lib/status"
import { formatCurrency, formatDate, formatDateTime, money } from "@/lib/utils"
import { isOpeningStockPurchase, purchaseBalance } from "@/lib/purchase-money"
import { productFullName, productSpecLine } from "@/lib/product-specs"

export default async function PurchaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [me, purchase] = await Promise.all([requireUser(), getPurchase(id)])
  if (!purchase) notFound()
  const opening = await prisma.openingStock.findUnique({
    where: { purchaseId: purchase.id },
    select: { status: true, branchId: true },
  })
  const isOpening = isOpeningStockPurchase({
    invoiceNumber: purchase.invoiceNumber,
    openingStock: opening,
  })
  const item = purchase.items[0]
  const remaining = item ? item.quantity - item.receivedQty : 0
  const billMoney = purchaseBalance(purchase)
  // The units on this bill that went back to the supplier, so the bill shows
  // its true value and exactly what was returned.
  const sentBackUnits = await prisma.imeiRecord.findMany({
    where: { purchaseId: purchase.id, status: "RETURNED_TO_SUPPLIER" },
    select: { id: true, imei1: true, serialNumber: true, updatedAt: true, product: { select: { name: true } } },
    orderBy: { updatedAt: "desc" },
  })
  const maySetShipping =
    !isOpening && purchase.status !== "CANCELLED" && ((await canManageFinance(me.role)) || (await can(me.role, "action.upload")))
  // A bill uploaded as still on the way waits on one carton on Goods on the
  // way. It is received there, whole, not unit by unit from this page.
  const waitingLot = purchase.incomingLots.find((lot) => lot.status === "COMING" || lot.status === "PENDING_APPROVAL")
  const receivedOnGoodsOnTheWay = purchase.source === "UPLOAD_STOCK" && Boolean(waitingLot)
  const cancelNote = (purchase.notes ?? "").split("\n").reverse().find((line) => line.startsWith("Cancelled by ")) ?? null
  const due = isOpening || purchase.status === "CANCELLED" ? 0 : billMoney.owed
  const payingBanks = due > 0 ? await listPayingBanks(me) : []
  const surplus = isOpening ? 0 : billMoney.surplus
  const step = isOpening
    ? (opening?.status === "CLOSED" ? 2 : 1)
    : purchase.status === "RECEIVED" && due <= 0
      ? 3
      : purchase.status === "RECEIVED" || purchase.status === "PARTIAL_RECEIVED"
        ? 2
        : purchase.incomingLots.some((lot) => lot.status === "COMING")
          ? 1
          : 0
  const origin = [purchase.originCity || purchase.supplier.city, purchase.originCountry || purchase.supplier.country]
    .filter(Boolean)
    .join(", ")
  const { trace, lines } = purchase
  const linesTotal = lines.reduce((sum, line) => sum + line.lineTotal, 0)
  const billTotal = money(purchase.totalAmount)
  const linesUnits = lines.reduce((sum, line) => sum + line.quantity, 0)
  /**
   * A unit back in the shop that still carries a sale: it came back after the
   * sale (a return), or the sale itself was cancelled. Said plainly, so "In
   * shop" beside an invoice does not read as a mistake.
   */
  const backAfterSale = (row: (typeof purchase.imeiRecords)[number]) => {
    if (!row.sale || !(row.status === "IN_STOCK" || row.status === "RECEIVED" || row.status === "RETURNED")) return null
    return row.sale.status === "COMPLETED" ? "Came back after sale" : `Sale ${statusLabel(row.sale.status).toLowerCase()}`
  }
  const csvRows: string[][] = ([
    ["Item", "IMEI or serial", "Cost", "Status", "Shop", "Invoice", "Sold at", "Customer"],
    ...purchase.imeiRecords.map((row) => [
      productFullName(row.product),
      row.imei1,
      row.unitCost,
      backAfterSale(row) ? `${statusLabel(row.status)} (${backAfterSale(row)?.toLowerCase()})` : statusLabel(row.status),
      row.branch.name,
      row.sale?.invoiceNumber ?? "",
      row.sale?.saleDate ? formatDateTime(row.sale.saleDate) : "",
      row.customer?.name ?? "",
    ]),
    [],
    ["What is on this bill"],
    ["Item", "On the bill", "Unit cost", "Line total", "Scanned in", "In shop", "Sold"],
    ...lines.map((line) => [
      productFullName(line),
      line.quantity,
      line.unitCost,
      line.lineTotal,
      line.tracked ? line.scanned : line.receivedQty,
      line.tracked ? line.inShop : "",
      line.tracked ? line.sold : "",
    ]),
    ["Total", linesUnits, "", linesTotal],
  ] as Array<Array<string | number>>).map((row) => row.map((cell) => String(cell)))

  return (
    <div className="space-y-6">
      <PageHeader
        backHref="/purchases"
        title={purchase.invoiceNumber}
        description={
          isOpening
            ? `Opening stock · ${purchase.branch.name} · ${formatDate(purchase.createdAt)}`
            : `${purchase.supplier.name}${origin ? ` from ${origin}` : ""} · ${purchase.branch.name} · ${formatDate(purchase.createdAt)}`
        }
      />
      {isOpening ? (
        <div className="surface-card space-y-3 p-5 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold">Opening stock {formatCurrency(money(purchase.totalAmount))}</p>
            <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
              Value only. Not a bill to pay.
            </span>
          </div>
          {purchase.notes ? <p className="text-muted-foreground">{purchase.notes}</p> : null}
          {opening ? (
            <p className="text-sm">
              {opening.status === "OPEN" ? "Still being counted. " : "Closed. "}
              <Link href={`/opening-stock?branchId=${opening.branchId}`} className="font-medium text-primary hover:underline">
                {opening.status === "OPEN" ? "Count and close" : "See opening stock"}
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}
      <WorkflowSteps
        current={step}
        steps={
          isOpening
            ? ["Loaded", "Counted", "Closed"]
            : ["On the bill", "Coming", "In this shop", "Paid"]
        }
      />
      {trace.shortVsBill > 0 || trace.tracking === "NONE" ? (
        <div className="surface-card space-y-2 p-5 text-sm">
          {trace.shortVsBill > 0 ? (
            <p className="text-warning">
              {trace.shortVsBill} unit{trace.shortVsBill === 1 ? "" : "s"} on this bill were never scanned.
            </p>
          ) : null}
          {trace.tracking === "NONE" ? (
            <p className="text-muted-foreground">This item has no unique number. Sold can mix more than one carton.</p>
          ) : null}
        </div>
      ) : null}
      {!isOpening && (billMoney.sentBack > 0 || sentBackUnits.length > 0) ? (
        <div className="surface-card space-y-3 border-warning/30 p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold">Sent back to the supplier</p>
              <p className="text-sm text-muted-foreground">
                Billed {formatCurrency(billMoney.billed)} · sent back{" "}
                <span className="font-medium text-warning">{formatCurrency(billMoney.sentBack)}</span>
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground">True value of this bill</p>
              <p className="text-xl font-semibold tabular-nums">{formatCurrency(billMoney.remaining)}</p>
            </div>
          </div>
          {sentBackUnits.length ? (
            <ul className="divide-y divide-border rounded-lg border border-border text-sm">
              {sentBackUnits.map((unit) => (
                <li key={unit.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span className="min-w-0">
                    <span className="font-medium">{unit.product.name}</span>{" "}
                    <span className="font-mono text-xs text-muted-foreground">
                      {unit.imei1}
                      {unit.serialNumber && unit.serialNumber !== unit.imei1 ? ` · ${unit.serialNumber}` : ""}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">Sent back {formatDate(unit.updatedAt)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2 sm:gap-4 xl:grid-cols-4">
        <div className="surface-card min-w-0 p-3 sm:p-5">
          <p className="text-sm text-muted-foreground">Status</p>
          <StatusBadge value={purchase.status} />
          <p className="mt-3 text-sm">
            {billMoney.shipping > 0 ? "Uploaded value" : "Value"} {formatCurrency(money(purchase.totalAmount))}
            {billMoney.shipping > 0 ? (
              <span className="block text-xs text-muted-foreground">
                Shipping fee −{formatCurrency(billMoney.shipping)} · payable to supplier {formatCurrency(billMoney.payable)}
              </span>
            ) : null}
            {billMoney.sentBack > 0 ? (
              <span className="block text-xs text-warning">After send-backs {formatCurrency(billMoney.remaining)}</span>
            ) : null}
          </p>
        </div>
        <div className="surface-card min-w-0 p-3 sm:p-5">
          <p className="text-sm text-muted-foreground">On the supplier bill</p>
          <p className="text-2xl font-semibold">{lines.length > 1 ? linesUnits : trace.expected}</p>
          <p className="text-sm text-muted-foreground">
            {lines.length > 1 ? (
              <a href="#bill-lines" className="text-primary hover:underline">
                {lines.length} different items · see the breakdown
              </a>
            ) : (
              item?.product.name
            )}
          </p>
          {origin ? <p className="mt-2 text-sm text-muted-foreground">{origin}</p> : null}
          {purchase.expectedDate ? <p className="text-sm text-muted-foreground">Due {formatDate(purchase.expectedDate)}</p> : null}
        </div>
        <div className="surface-card min-w-0 p-3 sm:p-5">
          <p className="text-sm text-muted-foreground">Scanned into the shop</p>
          <p className="text-2xl font-semibold">{trace.recorded}</p>
          <p className="text-sm text-muted-foreground">Never scanned {trace.shortVsBill}</p>
        </div>
        <div className="surface-card min-w-0 p-3 sm:p-5">
          <p className="text-sm text-muted-foreground">{isOpening ? "Not a bill to pay" : surplus > 0 ? "They owe us" : "We owe them (−)"}</p>
          <p className="text-xl font-semibold text-success">
            {isOpening ? "Value only" : formatCurrency(surplus > 0 ? surplus : due)}
          </p>
          {isOpening ? null : (
            <p className="text-xs text-muted-foreground">
              {billMoney.shipping > 0 ? `Payable ${formatCurrency(billMoney.payable)} · ` : ""}
              Paid {formatCurrency(money(purchase.paidAmount))}
              {billMoney.sentBack > 0 ? ` · sent back ${formatCurrency(billMoney.sentBack)}` : ""}
            </p>
          )}
        </div>
        <div className="surface-card min-w-0 p-3 sm:p-5">
          <p className="text-sm text-muted-foreground">Coming</p>
          <p className="text-2xl font-semibold">{trace.coming}</p>
        </div>
        <div className="surface-card min-w-0 p-3 sm:p-5">
          <p className="text-sm text-muted-foreground">Still on our shelf</p>
          <p className="text-2xl font-semibold">{trace.inShop}</p>
        </div>
        <div className="surface-card min-w-0 p-3 sm:p-5">
          <p className="text-sm text-muted-foreground">Sold</p>
          <p className="text-2xl font-semibold">{trace.sold}</p>
          <p className="text-sm text-muted-foreground">Sold today (Lagos day) {trace.soldToday}</p>
        </div>
        <div className="surface-card min-w-0 p-3 sm:p-5">
          <p className="text-sm text-muted-foreground">Other known places</p>
          <p className="text-2xl font-semibold">{trace.inTransit + trace.backToSupplier + trace.otherKnown}</p>
          <p className="text-sm text-muted-foreground">
            Shop to shop {trace.inTransit}
            {" · back to supplier "}
            {trace.backToSupplier}
            {" · return, repair, or other "}
            {trace.otherKnown}
          </p>
        </div>
      </div>
      {lines.length ? (
        <div id="bill-lines" className="surface-card scroll-mt-4 overflow-hidden">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-5 py-4">
            <div>
              <h3 className="font-semibold">What is on this bill</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {lines.length} item{lines.length === 1 ? "" : "s"} · {linesUnits} unit{linesUnits === 1 ? "" : "s"} · each line&apos;s cost
                and where its units are now
              </p>
            </div>
            <p className="text-sm">
              Invoice value <span className="font-semibold tabular-nums">{formatCurrency(billTotal)}</span>
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-5 py-3 font-medium">Item</th>
                  <th className="px-3 py-3 text-right font-medium">On the bill</th>
                  <th className="px-3 py-3 text-right font-medium">Unit cost</th>
                  <th className="px-3 py-3 text-right font-medium">Line total</th>
                  <th className="px-3 py-3 text-right font-medium">Scanned in</th>
                  <th className="px-3 py-3 text-right font-medium">In shop</th>
                  <th className="px-5 py-3 text-right font-medium">Sold</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id} className="border-t border-border">
                    <td className="px-5 py-3">
                      <p className="font-medium">{line.name}</p>
                      {productSpecLine(line) ? <p className="text-xs text-muted-foreground">{productSpecLine(line)}</p> : null}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">{line.quantity}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{formatCurrency(line.unitCost)}</td>
                    <td className="px-3 py-3 text-right font-semibold tabular-nums">{formatCurrency(line.lineTotal)}</td>
                    <td className={`px-3 py-3 text-right tabular-nums ${line.tracked && line.scanned < line.quantity ? "text-warning" : ""}`}>
                      {line.tracked ? line.scanned : line.receivedQty}
                      {!line.tracked ? <span className="block text-[11px] text-muted-foreground">pieces</span> : null}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">{line.tracked ? line.inShop : "—"}</td>
                    <td className="px-5 py-3 text-right tabular-nums">{line.tracked ? line.sold : "—"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border bg-muted/30 font-semibold">
                  <td className="px-5 py-3">Total</td>
                  <td className="px-3 py-3 text-right tabular-nums">{linesUnits}</td>
                  <td className="px-3 py-3" />
                  <td className="px-3 py-3 text-right tabular-nums">{formatCurrency(linesTotal)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{lines.reduce((sum, line) => sum + (line.tracked ? line.scanned : line.receivedQty), 0)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{lines.reduce((sum, line) => sum + line.inShop, 0)}</td>
                  <td className="px-5 py-3 text-right tabular-nums">{lines.reduce((sum, line) => sum + line.sold, 0)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {Math.abs(linesTotal - billTotal) > 0.5 ? (
            <p className="border-t border-border px-5 py-3 text-xs text-warning">
              The lines add up to {formatCurrency(linesTotal)}, but the bill says {formatCurrency(billTotal)}. Check this bill
              with the supplier&apos;s paper.
            </p>
          ) : null}
        </div>
      ) : null}
      {purchase.source === "UPLOAD_STOCK" && purchase.status !== "CANCELLED" && !isOpening && (await can(me.role, "action.upload")) ? (
        <div className="surface-card flex flex-wrap items-center justify-between gap-3 p-5">
          <div>
            <h3 className="font-semibold">More items on this paper invoice?</h3>
            <p className="text-sm text-muted-foreground">
              Add them to this same bill, as many times as it takes, so one bill on the system matches the invoice in your hand.
            </p>
          </div>
          <Link
            href={`/uploads?bill=${encodeURIComponent(purchase.invoiceNumber)}`}
            className="inline-flex h-10 items-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
          >
            Add more items to this bill
          </Link>
        </div>
      ) : null}
            {receivedOnGoodsOnTheWay ? (
        <div className="surface-card flex flex-wrap items-center justify-between gap-3 border-warning/30 p-5">
          <div>
            <h3 className="font-semibold">These goods are still on the way</h3>
            <p className="text-sm text-muted-foreground">
              {waitingLot?.status === "PENDING_APPROVAL"
                ? "They have been counted and are waiting for a second yes. Nothing on this bill can be sold until then."
                : `Nothing on this bill is on the shelf or can be sold yet. When the goods arrive, receive carton ${waitingLot?.lotNumber} and they go into the shop at once.`}
            </p>
          </div>
          <Link href="/incoming" className="text-sm font-medium text-primary hover:underline">
            Open Goods on the way
          </Link>
        </div>
      ) : purchase.status !== "RECEIVED" ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="surface-card p-5">
            <h3 className="mb-2 font-semibold">Book as coming</h3>
            <p className="mb-4 text-sm text-muted-foreground">Scan the waybill. Stock does not rise yet.</p>
            <ActionForm action={bookPurchaseAsComing} submit="Book as goods on the way" enterDoesNotSubmit className="space-y-3">
              <input type="hidden" name="id" value={purchase.id} />
              <ScanList name="imeis" kind={item?.product.tracking === "SERIAL" ? "SERIAL" : "IMEI"} required={item?.product.tracking !== "NONE"} />
            </ActionForm>
          </div>
          <div className="surface-card p-5">
            <h3 className="mb-2 font-semibold">Already in this shop</h3>
            <p className="mb-4 text-sm text-muted-foreground">Boxes on the counter now. This does not pay the supplier.</p>
            <ActionForm action={receivePurchaseImeis} submit={`Add ${remaining} unit(s) to shop`} enterDoesNotSubmit className="space-y-3">
              <input type="hidden" name="id" value={purchase.id} />
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">Unit cost on this carton (₦)</span>
                <Input
                  name="costPrice"
                  type="number"
                  min={0}
                  step="0.01"
                  defaultValue={item ? money(item.costPrice) : 0}
                  required
                />
                <span className="mt-1 block text-xs text-muted-foreground">
                  Price list now {item ? formatCurrency(money(item.product.costPrice)) : "—"}. If you change it, write why below.
                </span>
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">Note if the cost changed</span>
                <Input name="costNote" placeholder="Example: supplier invoice showed a new cost" />
              </label>
              <ScanList name="imeis" kind={item?.product.tracking === "SERIAL" ? "SERIAL" : "IMEI"} required={false} />
            </ActionForm>
          </div>
        </div>
      ) : (
        <div className="surface-card p-5 text-sm text-success">
          Goods received into {purchase.branch.name}.
        </div>
      )}
      {purchase.imeiRecords.length ? (
        <div className="surface-card overflow-hidden">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-5">
            <div>
              <h3 className="font-semibold">Every unit from this bill</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Each phone, its item and its cost on this bill. Sold rows have the invoice.
              </p>
            </div>
            <ExportCsv filename={`${purchase.invoiceNumber}-units.csv`} rows={csvRows} label="Download this bill as CSV" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="px-5 py-3 font-medium">Item</th>
                  <th className="px-5 py-3 font-medium">IMEI or serial</th>
                  <th className="px-5 py-3 text-right font-medium">Cost</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Shop</th>
                  <th className="px-5 py-3 font-medium">Invoice</th>
                  <th className="px-5 py-3 font-medium">Sold at</th>
                  <th className="px-5 py-3 font-medium">Customer</th>
                </tr>
              </thead>
              <tbody>
                {purchase.imeiRecords.map((row) => (
                  <tr key={row.id} className="border-t border-border">
                    <td className="px-5 py-3">
                      <p className="font-medium">{row.product.name}</p>
                      {productSpecLine(row.product) ? (
                        <p className="text-xs text-muted-foreground">{productSpecLine(row.product)}</p>
                      ) : null}
                    </td>
                    <td className="px-5 py-3">
                      <Link href={`/imei/${row.id}`} className="font-mono text-primary">
                        {row.imei1}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums">{formatCurrency(row.unitCost)}</td>
                    <td className="px-5 py-3">
                      <StatusBadge value={row.status} />
                      {backAfterSale(row) ? <p className="mt-1 text-[11px] text-muted-foreground">{backAfterSale(row)}</p> : null}
                    </td>
                    <td className="px-5 py-3">{row.branch.name}</td>
                    <td className="px-5 py-3">
                      {row.sale ? (
                        <Link href={`/sales/${row.sale.id}`} className="text-primary">
                          {row.sale.invoiceNumber}
                        </Link>
                      ) : (
                        "No invoice"
                      )}
                    </td>
                    <td className="px-5 py-3">
                      {row.sale?.saleDate ? formatDateTime(row.sale.saleDate) : "Not sold on the system"}
                    </td>
                    <td className="px-5 py-3">{row.customer?.name ?? "No named buyer"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="surface-card p-5 text-sm text-muted-foreground">
          No unique numbers on this bill yet. Book Coming IMEIs or confirm arrival.
        </div>
      )}
      {lines.length && !isOpening && purchase.status !== "CANCELLED" && canChangeCost(me.role) ? (
        <div className="surface-card p-5">
          <h3 className="mb-2 font-semibold">Correct a cost on this bill</h3>
          <p className="mb-4 text-sm text-muted-foreground">
            For a cost typed wrong. The bill total, the item&apos;s cost on the price list (when it holds the same wrong
            figure) and the profit on units already sold from this line all follow. Who did what keeps the old figure.
          </p>
          <CorrectLineCost
            lines={lines.map((line) => ({
              id: line.id,
              label: [line.name, line.storage, shopConditionLabel(line.condition)].filter(Boolean).join(" · "),
              quantity: line.quantity,
              unitCost: line.unitCost,
            }))}
          />
        </div>
      ) : null}
      {maySetShipping ? (
        <div className="surface-card p-5">
          <h3 className="mb-2 font-semibold">Shipping fee</h3>
          <p className="mb-4 text-sm text-muted-foreground">
            The part of the uploaded value that is shipping. It comes off what is payable to the supplier; the goods keep
            their value. Uploaded {formatCurrency(billMoney.billed)}, payable to the supplier{" "}
            {formatCurrency(billMoney.payable)}. Leave it empty for none.
          </p>
          <ActionForm
            action={setPurchaseShippingFee}
            submit="Save shipping fee"
            successMessage="Shipping fee saved. What is payable to the supplier has changed."
            variant="outline"
            className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end"
          >
            <input type="hidden" name="id" value={purchase.id} />
            <Input
              name="shippingFee"
              type="number"
              min={0}
              step="0.01"
              defaultValue={billMoney.shipping || ""}
              placeholder="0.00"
              aria-label="Shipping fee"
            />
          </ActionForm>
        </div>
      ) : null}
      {purchase.status === "CANCELLED" ? (
        <div className="rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
          <p className="font-semibold">This bill was cancelled. It is not owed and its goods are off the shelf.</p>
          {cancelNote ? <p className="mt-1">{cancelNote}</p> : null}
        </div>
      ) : isOpening ? null : due > 0 ? (
        <div className="surface-card p-5">
          <h3 className="mb-2 font-semibold">Pay supplier</h3>
          <p className="mb-4 text-sm text-muted-foreground">
            This records money leaving. Goods stay as received. Pay by transfer from one of our bank accounts, or in cash.
          </p>
          <PaySupplierForm purchaseId={purchase.id} due={due} banks={payingBanks} />
        </div>
      ) : surplus > 0 ? (
        <p className="text-sm text-muted-foreground">
          This house owes us {formatCurrency(surplus)} after send-backs. Do not pay more on this bill.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">This supplier bill is fully paid.</p>
      )}
      {!isOpening && isShopOwner(me.role) && money(purchase.paidAmount) > 0 ? (
        <div className="surface-card p-5">
          <h3 className="mb-2 font-semibold">Undo last supplier payment</h3>
          <p className="mb-3 text-sm text-muted-foreground">Stock and IMEIs stay. Who did what keeps this.</p>
          <ActionForm action={reverseSupplierPayment} submit="Reverse last payment" variant="outline">
            <input type="hidden" name="id" value={purchase.id} />
          </ActionForm>
        </div>
      ) : null}
      {!isOpening && isShopOwner(me.role) && purchase.status !== "CANCELLED" ? (
        <CancelRecordCard
          action={cancelSupplierBill}
          idName="id"
          id={purchase.id}
          title="Cancel this bill"
          description="For a bill booked by mistake: the wrong supplier, loaded twice, or goods that never came. Undo any payment on it first. Once cancelled, the right bill can load the same IMEIs again."
          submit="Cancel this bill"
          confirmTitle={`Cancel ${purchase.invoiceNumber}?`}
          impact={[
            "Everything this bill put on the shelf comes off; its IMEIs leave the system.",
            "Goods still marked coming on it stop coming.",
            `${purchase.supplier.name} is no longer owed for it.`,
            "Refused if any of its goods were sold, moved or sent back.",
          ]}
        />
      ) : null}
    </div>
  )
}
