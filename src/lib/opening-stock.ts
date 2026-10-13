import { keyName } from "@/lib/table-file"
import { parseShopCondition, shopConditionHelp } from "@/lib/conditions"
import type { ProductCondition, ProductTracking } from "@prisma/client"

/**
 * Abu Twins opening stock workbook.
 *
 * One Excel file per shop. Tabs they already use: PHONES, ACCESSORIES, SCREEN,
 * LAPTOPS. Same columns on every tab. The middle column is either an IMEI, a
 * serial, or a piece count, depending on the tab and what is written there.
 *
 * Opening load can take a tab with only PRODUCT NAME. Missing IMEI, serial, or
 * piece count is filled later on Correct and close opening stock.
 */

export type OpeningIdentity =
  | { kind: "imei"; value: string }
  | { kind: "serial"; value: string }
  | { kind: "qty"; value: number }

export type OpeningProductDraft = {
  sku: string
  name: string
  brand: string
  category: string
  tracking: ProductTracking
  condition: ProductCondition
  storage: string | null
  costPrice: number
  minimumPrice: number
  sellingPrice: number
}

export type OpeningUnitLine = {
  sheet: string
  line: number
  productKey: string
  identity: Extract<OpeningIdentity, { kind: "imei" | "serial" }>
}

export type OpeningQtyLine = {
  sheet: string
  line: number
  productKey: string
  quantity: number
}

export type OpeningPlan = {
  products: OpeningProductDraft[]
  units: OpeningUnitLine[]
  quantities: OpeningQtyLine[]
  problems: string[]
  /** Rows left out in lenient mode, each saying why. Empty when strict. */
  skipped: string[]
}


const HEADER_MARKERS = ["product_name", "s_n", "sn", "brand", "qty_imei_serial_no"]

function clean(value: string) {
  return value.replace(/\s+/g, " ").trim()
}

function slugPart(value: string) {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
}

export function makeOpeningSku(parts: { brand: string; name: string; storage: string; condition: ProductCondition }) {
  const joined = [parts.brand, parts.name, parts.storage, parts.condition.replaceAll("_", "-")]
    .map(slugPart)
    .filter(Boolean)
    .join("-")
  return (joined || "ITEM").slice(0, 60)
}

function findHeaderRow(grid: string[][]) {
  for (let i = 0; i < Math.min(grid.length, 12); i += 1) {
    const keys = grid[i].map((cell) => keyName(cell))
    if (keys.some((key) => key.includes("product") && key.includes("name"))) return i
    const hits = keys.filter((key) => HEADER_MARKERS.includes(key) || key.includes("imei") || key.includes("qty")).length
    if (hits >= 3) return i
  }
  return -1
}

function mapHeaders(cells: string[]) {
  const index: Record<string, number> = {}
  cells.forEach((cell, i) => {
    const key = keyName(cell)
    if (!key) return
    if (key.includes("product") && key.includes("name")) index.name = i
    else if (key === "name" && index.name == null) index.name = i
    else if (key === "brand") index.brand = i
    else if (key === "category") index.category = i
    else if (key === "tracking" || key === "how_we_count" || key === "how_we_count_it") index.tracking = i
    else if (key.includes("qty") || key.includes("imei") || key.includes("serial")) index.identity = i
    else if (key === "condition") index.condition = i
    else if (key.includes("specification") || key.includes("storage") || key === "spec") index.spec = i
    else if (key.includes("unit_cost") || (key.includes("cost") && key.includes("price"))) index.cost = i
    else if (key.includes("min") && key.includes("sell")) index.minSell = i
    else if (key.includes("selling") && key.includes("price")) index.selling = i
    else if (key === "s_n" || key === "sn" || key === "s_no") index.sn = i
  })
  return index
}

function at(row: string[], index: number | undefined) {
  if (index == null) return ""
  return clean(row[index] ?? "")
}

function money(raw: string) {
  if (!raw) return NaN
  const n = Number(String(raw).replace(/,/g, "").replace(/₦/g, "").trim())
  return Number.isFinite(n) ? n : NaN
}

function mapCondition(raw: string): ProductCondition | null {
  return parseShopCondition(raw)
}

/** The same reading of a hand-written condition, for the opening stock count sheet. */
export const mapOpeningCondition = mapCondition

function sheetHint(sheet: string): "phone" | "laptop" | "pieces" {
  const key = keyName(sheet)
  if (key.includes("phone") || key.includes("tablet")) return "phone"
  if (key.includes("laptop") || key.includes("computer") || key.includes("macbook")) return "laptop"
  return "pieces"
}

/** Empty, N/A, or a placeholder the shop wrote until they have the real number. */
export function isBlankOpeningIdentity(raw: string) {
  const value = clean(raw)
  if (!value) return true
  const key = keyName(value)
  if (!key) return true
  return (
    key === "na" ||
    key === "n_a" ||
    key === "nil" ||
    key === "none" ||
    key === "tbd" ||
    key === "pending" ||
    key === "later" ||
    key === "not_yet" ||
    key === "-" ||
    key === "--"
  )
}

/**
 * When the IMEI / serial / qty cell is empty, pick tracking from the tab so
 * staff can add the missing numbers later without inventing them now.
 */
export function defaultTrackingForSheet(sheet: string): ProductTracking {
  const hint = sheetHint(sheet)
  if (hint === "laptop") return "SERIAL"
  if (hint === "phone") return "IMEI"
  const key = keyName(sheet)
  if (key.includes("accessor") || key.includes("screen")) return "NONE"
  return "IMEI"
}

/** Read IMEI, SERIAL, or NONE from a TRACKING cell or from the upload form. */
export function parseOpeningTracking(raw: string): ProductTracking | null {
  const key = keyName(raw)
  if (!key) return null
  if (key === "imei" || key === "phone" || key === "phones") return "IMEI"
  if (key === "serial" || key === "laptop" || key === "laptops") return "SERIAL"
  if (
    key === "none" ||
    key === "pieces" ||
    key === "piece" ||
    key === "qty" ||
    key === "no_number" ||
    key === "no_imei" ||
    key === "all_pieces"
  ) {
    return "NONE"
  }
  return null
}

function classifyAsSheet(tracking: ProductTracking | undefined, sheet: string) {
  if (tracking === "IMEI") return "PHONES"
  if (tracking === "SERIAL") return "LAPTOPS"
  if (tracking === "NONE") return "ACCESSORIES"
  return sheet
}

function defaultCategory(sheet: string, written: string) {
  if (written) return written
  const key = keyName(sheet)
  if (key.includes("phone")) return "Phones"
  if (key.includes("laptop")) return "Laptops"
  if (key.includes("screen")) return "Screens"
  if (key.includes("accessor")) return "Accessories"
  return sheet.trim() || "General"
}

/**
 * Read the QTY / IMEI / SERIAL cell the way the shop fills it.
 * Phones tab → IMEI. Laptops tab → serial. Accessories / screens → piece count,
 * unless the cell is clearly an IMEI or a serial.
 */
export function classifyOpeningIdentity(sheet: string, raw: string): OpeningIdentity | { kind: "bad"; reason: string } {
  const value = clean(raw)
  if (!value) return { kind: "bad", reason: "put the IMEI, the serial, or how many pieces" }

  const digits = value.replace(/\D/g, "")
  const hint = sheetHint(sheet)
  const asNumber = Number(value.replace(/,/g, ""))
  const wholeNumber = Number.isFinite(asNumber) && Number.isInteger(asNumber) && String(asNumber) === value.replace(/,/g, "")

  if (digits.length >= 14 && (/^\d[\d\s-]*$/.test(value) || digits === value.replace(/\s/g, ""))) {
    return { kind: "imei", value: digits }
  }

  if (hint === "phone") {
    if (digits.length >= 14) return { kind: "imei", value: digits }
    if (wholeNumber && asNumber > 0 && asNumber < 10_000) {
      return { kind: "bad", reason: "a phone needs its own IMEI on this tab, not a piece count" }
    }
    if (value.length >= 4) return { kind: "serial", value }
    return { kind: "bad", reason: "IMEI is too short. Copy all the digits from the box" }
  }

  if (hint === "laptop") {
    if (wholeNumber && asNumber > 0 && asNumber < 100) {
      return { kind: "bad", reason: "a laptop needs its serial on this tab, not a piece count" }
    }
    return { kind: "serial", value }
  }

  // Accessories / screens: small whole numbers are piece counts.
  //
  // The ceiling matters. A tablet's 13-digit serial written on the accessories
  // tab used to read as a stock quantity of seven trillion, which nobody would
  // ever catch on a shelf count. A piece count in a phone shop is a handful to a
  // few thousand; anything longer is a serial that landed on the wrong tab.
  const PLAUSIBLE_PIECE_COUNT = 99_999
  if (wholeNumber && asNumber >= 0 && asNumber <= PLAUSIBLE_PIECE_COUNT) {
    return { kind: "qty", value: asNumber }
  }
  if (wholeNumber && asNumber > PLAUSIBLE_PIECE_COUNT) return { kind: "serial", value }
  if (value.length >= 4) return { kind: "serial", value }
  return { kind: "bad", reason: "put how many pieces, or a serial if this unit has one" }
}

/** How a workbook row names its item: units and counts point at products by this. */
export function openingProductKey(draft: OpeningProductDraft) {
  return productKey(draft)
}

function productKey(draft: OpeningProductDraft) {
  return [
    draft.name.toLowerCase(),
    draft.brand.toLowerCase(),
    draft.condition,
    (draft.storage || "").toLowerCase(),
    draft.tracking,
  ].join("|")
}

export type OpeningOptions = {
  /**
   * Treat a blank cost or selling price as zero instead of rejecting the row.
   *
   * Off for the Upload stock screen, where refusing a priced-wrong carton is the
   * right answer. On only for the one-off opening load, where a shop's existing
   * accessories often have no cost written down and holding back the whole shelf
   * would be worse than loading it with the price left to fill in.
   *
   * The same flag also lets a row load with only PRODUCT NAME. IMEI, serial, and
   * piece count can be added later on Correct and close opening stock.
   */
  allowMissingPrices?: boolean
  /**
   * When set, every row in the file uses this tracking unless the row has its
   * own TRACKING cell. Leave unset for All types: phones, laptops, and pieces
   * follow the tab names.
   */
  tracking?: ProductTracking
}

export function planOpeningStock(
  sheets: Array<{ sheet: string; grid: string[][] }>,
  options: OpeningOptions = {}
): OpeningPlan {
  const products = new Map<string, OpeningProductDraft>()
  const units: OpeningUnitLine[] = []
  const quantities: OpeningQtyLine[] = []
  const problems: string[] = []
  const skipped: string[] = []
  const seenCodes = new Set<string>()
  // In lenient mode a row we cannot read is set aside by name instead of the
  // whole workbook being refused. Strict mode keeps refusing, which is right for
  // a daily carton where a wrong number should stop the upload.
  const setAside = options.allowMissingPrices ? skipped : problems
  const qtyByKey = new Map<string, OpeningQtyLine>()

  for (const { sheet, grid } of sheets) {
    if (!grid.length) continue
    const headerAt = findHeaderRow(grid)
    if (headerAt < 0) {
      // Empty or title-only tabs are fine; ignore them.
      const hasData = grid.some((row) => row.some((cell) => cell))
      if (hasData) problems.push(`Tab ${sheet}: could not find the header row with PRODUCT NAME.`)
      continue
    }
    const headers = mapHeaders(grid[headerAt])
    if (headers.name == null) {
      problems.push(`Tab ${sheet}: the header must include PRODUCT NAME.`)
      continue
    }
    if (headers.identity == null && !options.allowMissingPrices) {
      problems.push(`Tab ${sheet}: the header must include PRODUCT NAME and QTY/IMEI/SERIAL NO.`)
      continue
    }

    const putDraft = (draft: OpeningProductDraft, label: string, itemName: string): string | null => {
      const key = productKey(draft)
      const existing = products.get(key)
      if (existing) {
        if (existing.tracking !== draft.tracking) {
          problems.push(`${label}: ${itemName} was already listed with a different tracking type. Keep one model consistent.`)
          return null
        }
        return key
      }
      let sku = draft.sku
      let n = 2
      while ([...products.values()].some((p) => p.sku === sku && productKey(p) !== key)) {
        sku = `${draft.sku}-${n}`.slice(0, 60)
        n += 1
      }
      draft.sku = sku
      products.set(key, draft)
      return key
    }

    for (let r = headerAt + 1; r < grid.length; r += 1) {
      const row = grid[r]
      const line = r + 1
      const name = at(row, headers.name)
      const brand = at(row, headers.brand)
      const identityRaw = at(row, headers.identity)
      const costRaw = at(row, headers.cost)
      const minSellRaw = at(row, headers.minSell) || at(row, headers.selling)
      if (!name && !brand && !identityRaw && !costRaw && !minSellRaw) continue

      const label = `${sheet} line ${line}`
      if (!name) {
        problems.push(`${label}: product name is missing.`)
        continue
      }
      // An accessory often has no brand on the box. That is not an error; it is
      // filed under a generic brand so the shop can still count and sell it.
      const brandName = brand || "Unbranded"

      const condition = mapCondition(at(row, headers.condition))
      if (!condition) {
        problems.push(`${label}: condition "${at(row, headers.condition)}" is not one we know. Use ${shopConditionHelp()}.`)
        continue
      }

      const rawCost = money(costRaw)
      const rawMinSell = money(minSellRaw)
      const costOk = Number.isFinite(rawCost) && rawCost >= 0
      const sellOk = Number.isFinite(rawMinSell) && rawMinSell > 0

      if (!costOk && !options.allowMissingPrices) {
        problems.push(`${label}: ${name} needs a unit cost price.`)
        continue
      }
      if (!sellOk && !options.allowMissingPrices) {
        problems.push(`${label}: ${name} needs a minimum selling price above 0.`)
        continue
      }

      const costPrice = costOk ? rawCost : 0
      const minSell = sellOk ? rawMinSell : 0
      const storage = at(row, headers.spec) || null
      const makeDraft = (tracking: ProductTracking): OpeningProductDraft => ({
        sku: makeOpeningSku({ brand: brandName, name, storage: storage || "", condition }),
        name,
        brand: brandName,
        category: defaultCategory(sheet, at(row, headers.category)),
        tracking,
        condition,
        storage,
        costPrice,
        minimumPrice: minSell,
        sellingPrice: minSell,
      })

      const fromRow = parseOpeningTracking(at(row, headers.tracking))
      const chosenTracking = fromRow || options.tracking
      const namesOnly = options.allowMissingPrices && isBlankOpeningIdentity(identityRaw)
      if (namesOnly) {
        const tracking = chosenTracking || defaultTrackingForSheet(sheet)
        const key = putDraft(makeDraft(tracking), label, name)
        if (!key) continue
        continue
      }

      const identity = classifyOpeningIdentity(classifyAsSheet(chosenTracking, sheet), identityRaw)
      if (identity.kind === "bad") {
        if (options.allowMissingPrices && chosenTracking && chosenTracking !== "NONE") {
          const key = putDraft(makeDraft(chosenTracking), label, name)
          if (!key) continue
          continue
        }
        setAside.push(`${label}: ${name}: ${identity.reason}.`)
        continue
      }

      const tracking: ProductTracking =
        chosenTracking || (identity.kind === "qty" ? "NONE" : identity.kind === "imei" ? "IMEI" : "SERIAL")
      const key = putDraft(makeDraft(tracking), label, name)
      if (!key) continue

      if (tracking === "NONE" && identity.kind !== "qty") {
        continue
      }
      if (tracking !== "NONE" && identity.kind === "qty") {
        continue
      }

      if (identity.kind === "qty") {
        const prev = qtyByKey.get(key)
        if (prev) {
          prev.quantity += identity.value
        } else {
          const lineQty = { sheet, line, productKey: key, quantity: identity.value }
          qtyByKey.set(key, lineQty)
          quantities.push(lineQty)
        }
        continue
      }

      if (seenCodes.has(identity.value)) {
        setAside.push(
          `${label}: ${identity.value} is on this workbook twice, so it is counted once. Staff can correct the shelf later on Correct and close opening stock or Phones and items.`
        )
        continue
      }
      seenCodes.add(identity.value)
      units.push({
        sheet,
        line,
        productKey: key,
        identity:
          tracking === "SERIAL"
            ? { kind: "serial", value: identity.value }
            : { kind: "imei", value: identity.value },
      })
    }
  }

  return {
    products: [...products.values()],
    units,
    quantities,
    problems,
    skipped,
  }
}
