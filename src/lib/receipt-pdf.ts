import { jsPDF } from "jspdf"
import { letterheadFromSettings } from "@/lib/letterhead"
import { drawPdfLetterhead, drawPdfPaperFooter, loadLogoDataUrl } from "@/lib/pdf-letterhead"

/**
 * Building a receipt a customer can be handed or sent.
 *
 * Kept apart from the screen so one sale and a whole day's sales are printed by
 * the same code: a receipt exported in a batch looks exactly like the one given
 * over the counter.
 */

const INK: [number, number, number] = [15, 23, 42]
const MUTED: [number, number, number] = [100, 116, 139]
const LINE: [number, number, number] = [226, 232, 240]

export type ReceiptLine = {
  name: string
  imei?: string | null
  quantity: number
  amount: number
  warranty?: string | null
  storage?: string | null
  condition?: string | null
  color?: string | null
}

export type ReceiptData = {
  company: string
  tagline?: string
  logoSrc?: string
  footer?: string
  invoiceNumber: string
  branch: string
  address?: string | null
  shopPhone?: string | null
  email?: string | null
  cashier?: string | null
  customer?: string | null
  customerPhone?: string | null
  soldAt: string
  items: ReceiptLine[]
  total: number
  paid: number
  /** Part of what was paid that came off the buyer's credit note. */
  creditNoteUsed?: number
  method: string
  /** Transfer description or POS approval code for bank payments. */
  paymentReference?: string | null
  notes?: string | null
}

function naira(value: number) {
  return `NGN ${Math.round(value).toLocaleString("en-NG")}`
}

/**
 * Draws one receipt onto the page and hands back the height used, so a batch
 * can decide whether the next one fits.
 */
export function drawReceipt(doc: jsPDF, data: ReceiptData, mark?: string) {
  const brand = letterheadFromSettings({
    companyName: data.company,
    productName: data.tagline,
    companyAddress: data.address || undefined,
    companyPhone: data.shopPhone || undefined,
    companyEmail: data.email || undefined,
    companyLogo: data.logoSrc,
    companyFooter: data.footer,
  })
  const pageW = doc.internal.pageSize.getWidth()
  const left = 14
  const right = pageW - 14
  let y = drawPdfLetterhead(doc, brand, {
    title: "Sales invoice",
    subtitle: data.invoiceNumber,
    meta: [data.branch, data.soldAt, data.cashier ? `Served by ${data.cashier}` : ""].filter(Boolean),
    logo: mark,
    full: true,
  })

  doc.setFont("helvetica", "bold")
  doc.setFontSize(8)
  doc.setTextColor(...MUTED)
  doc.text("BILL TO", left, y)
  doc.setTextColor(...INK)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(10)
  y += 5
  doc.text(data.customer || "Walk-in", left, y)
  if (data.customerPhone) {
    doc.setFont("helvetica", "normal")
    doc.setFontSize(8)
    doc.setTextColor(...MUTED)
    y += 4
    doc.text(data.customerPhone, left, y)
  }
  y += 6

  doc.setDrawColor(...LINE)
  doc.setLineWidth(0.3)
  doc.line(left, y, right, y)
  y += 5

  doc.setTextColor(...INK)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(8)
  doc.text("Item", left, y)
  doc.text("Qty", right - 46, y, { align: "right" })
  doc.text("Amount", right, y, { align: "right" })
  y += 3
  doc.setDrawColor(...LINE)
  doc.line(left, y, right, y)
  y += 5

  doc.setFont("helvetica", "normal")
  for (const item of data.items) {
    doc.setTextColor(...INK)
    doc.setFontSize(9)
    doc.text(doc.splitTextToSize(item.name, right - left - 52)[0], left, y)
    doc.text(String(item.quantity), right - 46, y, { align: "right" })
    doc.text(naira(item.amount), right, y, { align: "right" })
    y += 4
    const spec = [item.storage, item.condition, item.color].filter(Boolean).join(" · ")
    const under = [
      spec,
      item.imei ? `IMEI: ${item.imei}` : "",
      item.warranty ? `Warranty: ${item.warranty}` : "",
    ]
      .filter(Boolean)
      .join("  |  ")
    if (under) {
      doc.setTextColor(...MUTED)
      doc.setFontSize(7)
      doc.text(under, left, y)
      y += 4
    }
    y += 1
  }

  y += 2
  doc.setDrawColor(...LINE)
  doc.line(left, y, right, y)
  y += 6

  const due = Math.max(0, data.total - data.paid)
  const rows: Array<[string, string, boolean]> = [
    ["Total", naira(data.total), true],
    ...((data.creditNoteUsed ?? 0) > 0
      ? ([
          ["From credit note", naira(data.creditNoteUsed ?? 0), false],
          [`Paid in money (${data.method})`, naira(data.paid - (data.creditNoteUsed ?? 0)), false],
        ] as Array<[string, string, boolean]>)
      : ([[`Paid (${data.method})`, naira(data.paid), false]] as Array<[string, string, boolean]>)),
  ]
  if (due > 0) rows.push(["Still owing", naira(due), true])

  for (const [label, value, bold] of rows) {
    doc.setFont("helvetica", bold ? "bold" : "normal")
    doc.setFontSize(bold ? 10 : 9)
    doc.setTextColor(...INK)
    doc.text(label, right - 50, y, { align: "right" })
    doc.text(value, right, y, { align: "right" })
    y += 5
  }

  if (data.paymentReference) {
    y += 2
    doc.setFont("helvetica", "bold")
    doc.setFontSize(7)
    doc.setTextColor(...MUTED)
    doc.text(`Ref: ${data.paymentReference}`, left, y)
    y += 3.5
    doc.setFont("helvetica", "normal")
  }

  if (data.notes) {
    y += 2
    doc.setFont("helvetica", "normal")
    doc.setFontSize(7)
    doc.setTextColor(...MUTED)
    for (const line of doc.splitTextToSize(data.notes, right - left) as string[]) {
      doc.text(line, left, y)
      y += 3.5
    }
  }

  y += 4
  doc.setFontSize(7)
  doc.setTextColor(...MUTED)
  doc.text(
    "This receipt shows a sale that is finished. Money paid later is written down on its own and does not change this paper.",
    left,
    y
  )
  y += 6
  drawPdfPaperFooter(doc, brand, 1, data.invoiceNumber)

  return y
}

export async function loadMark(logoSrc?: string) {
  return loadLogoDataUrl(logoSrc || letterheadFromSettings({}).logoSrc)
}

export function receiptFileName(invoiceNumber: string) {
  return `Receipt-${invoiceNumber.replace(/[^A-Za-z0-9-]/g, "")}.pdf`
}
