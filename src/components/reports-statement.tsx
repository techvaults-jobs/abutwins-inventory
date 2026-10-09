import type { ReportsPack } from "@/lib/reports-pack"
import { reportsKpis } from "@/lib/reports-pack"
import { formatLagosStamp } from "@/lib/lagos-day"
import { letterheadFromCompany } from "@/lib/letterhead"
import { formatCurrency } from "@/lib/utils"
import { DocumentLetterhead, DocumentPaperFooter } from "@/components/document-letterhead"
import { groupOwedHouses } from "@/lib/purchase-money"

export function ReportsStatement({ data }: { data: ReportsPack }) {
  const kpis = reportsKpis(data)
  const brand = letterheadFromCompany(data.company)

  return (
    <section className="reports-statement mx-auto hidden w-full max-w-[210mm] overflow-hidden bg-white text-slate-900 print:block">
      <DocumentLetterhead
        brand={brand}
        documentKind="Executive summary"
        documentTitle="Sales by shop"
        meta={[data.statementRef, data.periodLabel, `Lagos time ${formatLagosStamp(new Date(data.preparedAt))}`]}
      >
        <div className="mt-4 grid gap-3 border-t border-white/15 pt-3 text-[12px] sm:grid-cols-3">
          <div>
            <p className="text-[10px] uppercase tracking-[0.16em] text-white/55">Branch Scope</p>
            <p className="font-semibold">{data.scope}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-[0.16em] text-white/55">Prepared By</p>
            <p className="font-semibold">{data.preparedBy}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-[0.16em] text-white/55">Report Scope</p>
            <p className="font-semibold">{data.periodLabel}</p>
          </div>
        </div>
      </DocumentLetterhead>

      <div className="grid grid-cols-2 sm:grid-cols-4 print:grid-cols-4 sm:divide-x print:divide-x divide-slate-200 border-b border-slate-200">
        {kpis.map((row) => (
          <div key={row.label} className="px-3 py-2.5">
            <p className="text-[9px] uppercase tracking-[0.14em] text-slate-500">{row.label}</p>
            <p className="mt-0.5 text-sm font-semibold tabular-nums">
              {row.money ? formatCurrency(row.value) : String(row.value)}
            </p>
          </div>
        ))}
      </div>

      <div className="px-6 py-4">
        <h3 className="text-sm font-semibold">Sales by shop</h3>
        <table className="mt-2 w-full text-[11px]">
          <thead>
            <tr className="border-y border-slate-200 bg-slate-50 text-left text-[10px] uppercase tracking-wider text-slate-500">
              <th className="py-1.5 pr-2">Branch</th>
              <th className="py-1.5 pr-2 text-right">Sales Volume</th>
              <th className="py-1.5 pr-2 text-right">Total Sales</th>
              {data.stockBasis === "cost" ? <th className="py-1.5 pr-2 text-right">Total Cost</th> : null}
              <th className="py-1.5 text-right">Payments Received</th>
            </tr>
          </thead>
          <tbody>
            {data.byShop.map((row) => (
              <tr key={row.name} className="border-b border-slate-100">
                <td className="py-1.5 pr-2 font-medium">{row.name}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{row.tickets}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{formatCurrency(row.revenue)}</td>
                {data.stockBasis === "cost" ? (
                  <td className="py-1.5 pr-2 text-right tabular-nums">{formatCurrency(row.cost)}</td>
                ) : null}
                <td className="py-1.5 text-right tabular-nums">{formatCurrency(row.collected)}</td>
              </tr>
            ))}
            {data.byShop.length === 0 ? (
              <tr><td colSpan={data.stockBasis === "cost" ? 5 : 4} className="py-3 text-slate-500">No completed sales in this scope.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="grid border-t border-slate-200 md:grid-cols-2">
        <div className="border-b border-slate-200 px-6 py-4 md:border-b-0 md:border-r">
          <h3 className="text-sm font-semibold">Customers who still owe us</h3>
          <table className="mt-2 w-full text-[11px]">
            <tbody>
              {data.debtors.map((row) => (
                <tr key={row.id} className="border-b border-slate-100">
                  <td className="py-1 pr-2">{row.name} · {row.shop}</td>
                  <td className="py-1 text-right tabular-nums font-medium">{formatCurrency(row.amount)}</td>
                </tr>
              ))}
              {data.debtors.length === 0 ? (
                <tr><td colSpan={2} className="py-3 text-slate-500">Nobody owes us money right now.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="px-6 py-4">
          <h3 className="text-sm font-semibold">Still owed to suppliers</h3>
          <table className="mt-2 w-full text-[11px]">
            <tbody>
              {groupOwedHouses(data.creditors).map((house) => (
                <tr key={house.key} className="border-b border-slate-100">
                  <td className="py-1 pr-2">
                    <span className="font-medium">{house.name}</span>
                    {house.bills.map((row) => (
                      <span key={row.id} className="block text-slate-500">{row.invoice} · {row.shop}</span>
                    ))}
                  </td>
                  <td className="py-1 text-right tabular-nums font-medium">{formatCurrency(house.owed)}</td>
                </tr>
              ))}
              {data.creditors.length === 0 ? (
                <tr><td colSpan={2} className="py-3 text-slate-500">All vendor accounts settled.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="px-6 py-4">
          <h3 className="text-sm font-semibold">Suppliers who owe us</h3>
          <table className="mt-2 w-full text-[11px]">
            <tbody>
              {groupOwedHouses(data.supplierCredits ?? []).map((house) => (
                <tr key={house.key} className="border-b border-slate-100">
                  <td className="py-1 pr-2">
                    <span className="font-medium">{house.name}</span>
                    {house.bills.map((row) => (
                      <span key={row.id} className="block text-slate-500">{row.invoice} · {row.shop}</span>
                    ))}
                  </td>
                  <td className="py-1 text-right tabular-nums font-medium">{formatCurrency(house.owed)}</td>
                </tr>
              ))}
              {(data.supplierCredits ?? []).length === 0 ? (
                <tr><td colSpan={2} className="py-3 text-slate-500">No supplier owes us after send-backs.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="border-t border-slate-200 px-6 py-4">
        <h3 className="text-sm font-semibold">Inventory Threshold Alerts</h3>
        <table className="mt-2 w-full text-[11px]">
          <thead>
            <tr className="border-y border-slate-200 bg-slate-50 text-left text-[10px] uppercase tracking-wider text-slate-500">
              <th className="py-1.5 pr-2">Item</th>
              <th className="py-1.5 pr-2">Shop</th>
              <th className="py-1.5 text-right">On shelf / lowest allowed</th>
            </tr>
          </thead>
          <tbody>
            {data.lowStock.map((row) => (
              <tr key={row.id} className="border-b border-slate-100">
                <td className="py-1.5 pr-2">{row.product}</td>
                <td className="py-1.5 pr-2">{row.shop}</td>
                <td className="py-1.5 text-right tabular-nums">{row.quantity} / {row.min}</td>
              </tr>
            ))}
            {data.lowStock.length === 0 ? (
              <tr><td colSpan={3} className="py-3 text-slate-500">No item is running low.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <DocumentPaperFooter brand={brand} extra="Software by Techvaults Limited · This paper does not change any sale." />
    </section>
  )
}
