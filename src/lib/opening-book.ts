import type { ProductCondition, ProductTracking } from "@prisma/client"
import { mapOpeningCondition, stockTabColumns } from "@/lib/opening-stock"
import { keyName } from "@/lib/table-file"

/**
 * The opening stock book: what a shop opened the software with, while it is
 * still being corrected against a physical count.
 *
 * The client's words: "pull out the stock uploaded on the system, use that to do
 * a stock count ... then a final clean-up of both the stock quantity, the stock
 * IMEI if they exist or they do not exist, then the cost price and the selling
 * price, both the lowest selling price and the standard selling price ... once
 * we've made it complete, it will no longer be adjustable."
 *
 * This file only reads and checks the count sheet. Nothing here touches the
 * database, so the same checks run for the Excel re-upload and for edits typed
 * on screen.
 */

export const ITEMS_SHEET = "ITEMS"
export const UNITS_SHEET = "IMEI & SERIAL"

export const ITEM_HEADERS = [
  "ITEM CODE",
  "PRODUCT NAME",
  "BRAND",
  "CATEGORY",
  "CONDITION",
  "SPECIFICATION",
  "TRACKING",
  "ON OPENING STOCK",
  "COUNTED QTY",
  "UNIT COST PRICE",
  "LOWEST SELLING PRICE",
  "STANDARD SELLING PRICE",
] as const

export const UNIT_HEADERS = ["ITEM CODE", "PRODUCT NAME", "IMEI / SERIAL", "ON SHELF (YES/NO)"] as const

export type BookLine = {
  productId: string
  sku: string
  name: string
  brand: string
  category: string
  condition: ProductCondition
  storage: string | null
  tracking: ProductTracking
  /** Units on the opening bill. This is the figure being corrected. */
  openingQty: number
  /** What the shop's shelf row says right now, which can include later bills. */
  shelfQty: number
  costPrice: number
  minimumPrice: number
  sellingPrice: number
  /** IMEIs or serials on the opening bill that are still In shop. */
  identities: string[]
}

export type OpeningChange = {
  sku: string
  /** Piece items only. Phones and laptops follow their IMEI / serial list. */
  quantity?: number
  costPrice?: number
  minimumPrice?: number
  sellingPrice?: number
  addIdentities?: string[]
  removeIdentities?: string[]
  /** Names-only lines start as pieces. Adding an IMEI or serial later switches tracking. */
  promoteTracking?: ProductTracking
}

export type NewOpeningItem = {
  name: string
  brand: string
  category: string
  condition: ProductCondition
  storage: string | null
  tracking: ProductTracking
  quantity: number
  costPrice: number
  minimumPrice: number
  sellingPrice: number
  identities: string[]
}

export type CorrectionPlan = {
  changes: OpeningChange[]
  newItems: NewOpeningItem[]
  problems: string[]
}

/** The two tabs of the count sheet, header row first. */
export function bookSheets(lines: BookLine[]) {
  const items: Array<Array<string | number>> = [
    [...ITEM_HEADERS],
    ...lines.map((line) => [
      line.sku,
      line.name,
      line.brand,
      line.category,
      line.condition.replaceAll("_", " "),
      line.storage ?? "",
      line.tracking === "NONE" ? "PIECES" : line.tracking,
      line.openingQty,
      line.openingQty,
      line.costPrice,
      line.minimumPrice,
      line.sellingPrice,
    ]),
  ]
  const units: Array<Array<string | number>> = [
    [...UNIT_HEADERS],
    ...lines.flatMap((line) => line.identities.map((identity) => [line.sku, line.name, identity, "YES"])),
  ]
  return [
    { name: ITEMS_SHEET, rows: items },
    { name: UNITS_SHEET, rows: units },
  ]
}

/** An IMEI keeps only its digits; a serial is kept as written. */
export function cleanIdentity(raw: string) {
  const value = raw.replace(/\s+/g, " ").trim()
  const digits = value.replace(/\D/g, "")
  if (digits.length >= 14 && /^[\d\s-]+$/.test(value)) return digits
  return value
}

/**
 * The IMEI & SERIAL tab of the count sheet, read on its own: one row per unit,
 * by product name. Shops copy the count sheet for a supplier bill too, with
 * the items on one tab and every IMEI on this one. A row marked NO on ON SHELF
 * or with no number gives no identity.
 */
export function readUnitListTabs(sheets: Array<{ sheet: string; grid: string[][] }>) {
  const units: Array<{ sheet: string; line: number; name: string; identity: string | null }> = []
  for (const tab of sheets) {
    const header = headerIndex(tab.grid, ["product_name"])
    if (!header || header.index.identity == null || header.index.cost != null) continue
    for (let r = header.at + 1; r < tab.grid.length; r += 1) {
      const row = tab.grid[r]
      const name = cellAt(row, header.index.name)
      if (!name) continue
      // A unit with no number, or one marked NO, keeps its place so the rows
      // still line up with the stock tab; it gives no IMEI.
      const identity = cleanIdentity(cellAt(row, header.index.identity))
      const gone = /^n/i.test(cellAt(row, header.index.onShelf))
      units.push({ sheet: tab.sheet, line: r + 1, name, identity: identity && !gone ? identity : null })
    }
  }
  return units
}

export function unitListName(raw: string) {
  return raw.trim().replace(/\s+/g, " ").toLowerCase()
}

/**
 * A bill sheet in the count sheet's layout: items on a stock tab, every IMEI
 * on an IMEI & SERIAL tab with no cost column. When the list's rows line up
 * with a stock tab's, name for name, each IMEI is written into its row's
 * QTY/IMEI cell (left alone when it already holds an IMEI or a count above 1).
 * A list that does not line up comes back in byName, for the caller to match
 * by item name.
 */
export function fillFromUnitList(
  stockTabs: Array<{ sheet: string; grid: string[][] }>,
  otherTabs: Array<{ sheet: string; grid: string[][] }>
) {
  const listTabs = otherTabs.filter((tab) => readUnitListTabs([tab]).some((unit) => unit.identity))
  const byName: ReturnType<typeof readUnitListTabs> = []
  for (const tab of listTabs) {
    const units = readUnitListTabs([tab])
    const match = stockTabs.findIndex((stock) => {
      const cols = stockTabColumns(stock.grid)
      if (!cols) return false
      const names = stock.grid.slice(cols.at + 1).map((row) => row[cols.name] ?? "").filter((name) => name.trim())
      return names.length === units.length && names.every((name, i) => unitListName(name) === unitListName(units[i].name))
    })
    if (match < 0) {
      byName.push(...units)
      continue
    }
    const cols = stockTabColumns(stockTabs[match].grid)!
    let i = 0
    const grid = stockTabs[match].grid.map((row, r) => {
      if (r <= cols.at || !(row[cols.name] ?? "").trim()) return row
      const unit = units[i++]
      const cell = (row[cols.identity] ?? "").trim()
      if (!unit.identity || (cell && cell !== "1")) return row
      const filled = [...row]
      filled[cols.identity] = unit.identity
      return filled
    })
    stockTabs[match] = { ...stockTabs[match], grid }
  }
  return { listTabs, byName }
}

function number(raw: string) {
  const text = raw.replace(/,/g, "").replace(/₦/g, "").trim()
  if (!text) return null
  const n = Number(text)
  return Number.isFinite(n) ? n : NaN
}

function findTab(sheets: Array<{ sheet: string; grid: string[][] }>, test: (key: string) => boolean) {
  return sheets.find((tab) => test(keyName(tab.sheet)))
}

function headerIndex(grid: string[][], must: string[]) {
  for (let i = 0; i < Math.min(grid.length, 8); i += 1) {
    const keys = grid[i].map((cell) => keyName(cell))
    if (must.every((name) => keys.some((key) => key.includes(name)))) {
      const index: Record<string, number> = {}
      keys.forEach((key, col) => {
        if (!key) return
        if (key.includes("item_code") || key === "code" || key === "sku") index.code = col
        else if (key.includes("product") && key.includes("name")) index.name = col
        else if (key === "brand") index.brand = col
        else if (key === "category") index.category = col
        else if (key === "condition") index.condition = col
        else if (key.includes("specification") || key.includes("storage")) index.spec = col
        else if (key === "tracking") index.tracking = col
        else if (key.includes("counted")) index.counted = col
        else if (key.includes("cost")) index.cost = col
        else if (key.includes("lowest") || (key.includes("min") && key.includes("sell"))) index.lowest = col
        else if (key.includes("standard") || (key.includes("selling") && key.includes("price"))) index.selling = col
        else if (key.includes("imei") || key.includes("serial")) index.identity = col
        else if (key.includes("shelf")) index.onShelf = col
      })
      return { at: i, index }
    }
  }
  return null
}

function cellAt(row: string[], col: number | undefined) {
  return col == null ? "" : String(row[col] ?? "").trim()
}

function readTracking(raw: string): ProductTracking | null {
  const key = keyName(raw)
  if (!key || key === "pieces" || key === "piece" || key === "none" || key === "qty") return "NONE"
  if (key === "imei") return "IMEI"
  if (key === "serial") return "SERIAL"
  return null
}

/**
 * Check edits typed on screen with the same rules as the count sheet, so the
 * two ways of correcting can never disagree about what is allowed.
 */
export function checkScreenChanges(raw: unknown, lines: BookLine[]): CorrectionPlan {
  const problems: string[] = []
  const bySku = new Map(lines.map((line) => [line.sku, line]))
  const out: OpeningChange[] = []
  if (!Array.isArray(raw)) return { changes: [], newItems: [], problems: ["Nothing was changed."] }
  if (raw.length > 500) return { changes: [], newItems: [], problems: ["Save up to 500 lines at a time."] }

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const row = entry as Record<string, unknown>
    const line = bySku.get(String(row.sku ?? ""))
    if (!line) {
      problems.push("One changed line is no longer on this opening stock. Refresh the page and try again.")
      continue
    }
    const next: OpeningChange = { sku: line.sku }
    const read = (key: string) => (row[key] === undefined || row[key] === "" || row[key] === null ? null : Number(row[key]))

    const quantity = read("quantity")
    if (quantity !== null) {
      if (line.tracking !== "NONE") {
        problems.push(`${line.name}: add or take off its IMEIs instead of typing a count.`)
        continue
      }
      if (!Number.isInteger(quantity) || quantity < 0) {
        problems.push(`${line.name}: the count must be a whole number, 0 or more.`)
        continue
      }
      if (quantity !== line.openingQty) next.quantity = quantity
    }
    const cost = read("costPrice")
    if (cost !== null) {
      if (!Number.isFinite(cost) || cost < 0) {
        problems.push(`${line.name}: cost price must be a number, 0 or more.`)
        continue
      }
      if (cost !== line.costPrice) next.costPrice = cost
    }
    const lowest = read("minimumPrice")
    if (lowest !== null && lowest !== line.minimumPrice) {
      if (!Number.isFinite(lowest) || lowest <= 0) {
        problems.push(`${line.name}: lowest selling price must be above 0.`)
        continue
      }
      next.minimumPrice = lowest
    }
    const selling = read("sellingPrice")
    if (selling !== null && selling !== line.sellingPrice) {
      if (!Number.isFinite(selling) || selling <= 0) {
        problems.push(`${line.name}: standard selling price must be above 0.`)
        continue
      }
      next.sellingPrice = selling
    }
    if ((next.sellingPrice ?? line.sellingPrice) < (next.minimumPrice ?? line.minimumPrice)) {
      problems.push(`${line.name}: the standard selling price cannot be below the lowest selling price.`)
      continue
    }

    const list = (key: string) =>
      Array.isArray(row[key]) ? [...new Set((row[key] as unknown[]).map((v) => cleanIdentity(String(v ?? ""))).filter(Boolean))] : []
    const add = list("addIdentities")
    const remove = list("removeIdentities")
    if ((add.length || remove.length) && line.tracking === "NONE") {
      if (line.openingQty > 0 || (quantity !== null && quantity > 0)) {
        problems.push(`${line.name} is counted in pieces, so it has no IMEI or serial.`)
        continue
      }
      const looksLikeImei = add.some((value) => value.replace(/\D/g, "").length >= 14)
      next.promoteTracking = looksLikeImei ? "IMEI" : "SERIAL"
    }
    const short = add.find((value) => value.length < 4)
    if (short) {
      problems.push(`${line.name}: ${short} is too short for an IMEI or serial.`)
      continue
    }
    const addable = add.filter((value) => !line.identities.includes(value))
    const removable = remove.filter((value) => line.identities.includes(value))
    if (addable.length) next.addIdentities = addable
    if (removable.length) next.removeIdentities = removable
    if (next.promoteTracking) delete next.quantity

    if (Object.keys(next).length > 1) out.push(next)
  }

  return { changes: out, newItems: [], problems }
}

/**
 * Read a filled-in count sheet against the book as it stands.
 *
 * Only what is written changes. A blank price keeps the price, a blank counted
 * quantity keeps the quantity, and an IMEI that is not on the sheet at all is
 * left alone: to take a phone off, write NO next to it. That way a sheet with
 * a few rows deleted by accident cannot quietly remove stock.
 */
export function planCorrection(
  sheets: Array<{ sheet: string; grid: string[][] }>,
  lines: BookLine[]
): CorrectionPlan {
  const problems: string[] = []
  const bySku = new Map(lines.map((line) => [line.sku.toUpperCase(), line]))
  const changes = new Map<string, OpeningChange & { counted?: number; line: BookLine }>()
  const newItems: Array<NewOpeningItem & { label: string }> = []

  const itemsTab = findTab(sheets, (key) => key.includes("item")) ?? sheets[0]
  const unitsTab = findTab(sheets, (key) => key.includes("imei") || key.includes("serial"))

  const change = (line: BookLine) => {
    const existing = changes.get(line.sku)
    if (existing) return existing
    const fresh: OpeningChange & { counted?: number; line: BookLine } = { sku: line.sku, line }
    changes.set(line.sku, fresh)
    return fresh
  }

  if (!itemsTab) return { changes: [], newItems: [], problems: ["We could not find the ITEMS tab in that file."] }
  const itemsHead = headerIndex(itemsTab.grid, ["product_name"])
  if (!itemsHead || itemsHead.index.code == null) {
    return {
      changes: [],
      newItems: [],
      problems: ["The ITEMS tab needs the ITEM CODE and PRODUCT NAME header. Download a fresh count sheet and fill that one."],
    }
  }

  const { index } = itemsHead
  for (let r = itemsHead.at + 1; r < itemsTab.grid.length; r += 1) {
    const row = itemsTab.grid[r]
    if (!row.some((cell) => String(cell ?? "").trim())) continue
    const label = `${itemsTab.sheet} line ${r + 1}`
    const code = cellAt(row, index.code).toUpperCase()
    const name = cellAt(row, index.name)

    const counted = number(cellAt(row, index.counted))
    const cost = number(cellAt(row, index.cost))
    const lowest = number(cellAt(row, index.lowest))
    const selling = number(cellAt(row, index.selling))

    if (counted !== null && (Number.isNaN(counted) || counted < 0 || !Number.isInteger(counted))) {
      problems.push(`${label}: COUNTED QTY must be a whole number, 0 or more.`)
      continue
    }
    if (cost !== null && (Number.isNaN(cost) || cost < 0)) {
      problems.push(`${label}: UNIT COST PRICE must be a number, 0 or more.`)
      continue
    }
    if (lowest !== null && (Number.isNaN(lowest) || lowest < 0)) {
      problems.push(`${label}: LOWEST SELLING PRICE must be a number above 0.`)
      continue
    }
    if (selling !== null && (Number.isNaN(selling) || selling < 0)) {
      problems.push(`${label}: STANDARD SELLING PRICE must be a number above 0.`)
      continue
    }

    if (!code) {
      if (!name) continue
      // A row with no item code is something found on the shelf that was never
      // loaded. It needs enough to create the item properly.
      const tracking = readTracking(cellAt(row, index.tracking))
      const condition = mapOpeningCondition(cellAt(row, index.condition))
      if (!tracking) {
        problems.push(`${label}: ${name}: TRACKING must be PIECES, IMEI or SERIAL.`)
        continue
      }
      if (!condition) {
        problems.push(`${label}: ${name}: condition "${cellAt(row, index.condition)}" is not one we know.`)
        continue
      }
      if (cost === null || lowest === null || selling === null || lowest <= 0 || selling <= 0) {
        problems.push(`${label}: ${name} is new, so it needs a cost price, and a lowest and a standard selling price above 0.`)
        continue
      }
      if (tracking === "NONE" && counted === null) {
        problems.push(`${label}: ${name} is new, so write how many were counted.`)
        continue
      }
      newItems.push({
        label,
        name,
        brand: cellAt(row, index.brand) || "Unbranded",
        category: cellAt(row, index.category) || "General",
        condition,
        storage: cellAt(row, index.spec) || null,
        tracking,
        quantity: tracking === "NONE" ? counted ?? 0 : 0,
        costPrice: cost,
        minimumPrice: lowest,
        sellingPrice: selling,
        identities: [],
      })
      continue
    }

    const line = bySku.get(code)
    if (!line) {
      problems.push(`${label}: item code ${code} is not on this shop's opening stock. Leave ITEM CODE blank for an item that was never loaded.`)
      continue
    }
    if (changes.get(line.sku)?.counted !== undefined && counted !== null) {
      problems.push(`${label}: ${line.name} (${line.sku}) is on the ITEMS tab twice. Keep one row.`)
      continue
    }

    // A zero price the sheet only repeats back is "not changed", so a freshly
    // downloaded sheet always goes back in clean. A price someone writes must be
    // above 0, and closing refuses any line still left at zero.
    if (lowest !== null && lowest !== line.minimumPrice && lowest <= 0) {
      problems.push(`${label}: LOWEST SELLING PRICE must be a number above 0.`)
      continue
    }
    if (selling !== null && selling !== line.sellingPrice && selling <= 0) {
      problems.push(`${label}: STANDARD SELLING PRICE must be a number above 0.`)
      continue
    }

    const next = change(line)
    if (counted !== null) next.counted = counted
    if (cost !== null && cost !== line.costPrice) next.costPrice = cost
    if (lowest !== null && lowest !== line.minimumPrice) next.minimumPrice = lowest
    if (selling !== null && selling !== line.sellingPrice) next.sellingPrice = selling
  }

  const seen = new Set<string>()
  if (unitsTab) {
    const unitsHead = headerIndex(unitsTab.grid, ["imei"])
    if (!unitsHead || unitsHead.index.identity == null) {
      problems.push(`The ${unitsTab.sheet} tab needs the IMEI / SERIAL header. Download a fresh count sheet and fill that one.`)
    } else {
      const { index: u } = unitsHead
      for (let r = unitsHead.at + 1; r < unitsTab.grid.length; r += 1) {
        const row = unitsTab.grid[r]
        if (!row.some((cell) => String(cell ?? "").trim())) continue
        const label = `${unitsTab.sheet} line ${r + 1}`
        const identity = cleanIdentity(cellAt(row, u.identity))
        if (!identity) continue
        if (identity.length < 4) {
          problems.push(`${label}: ${identity} is too short for an IMEI or serial.`)
          continue
        }
        if (seen.has(identity)) {
          problems.push(`${label}: ${identity} is on the sheet twice. Keep one row.`)
          continue
        }
        seen.add(identity)

        const shelfKey = keyName(cellAt(row, u.onShelf))
        const onShelf = !(shelfKey === "no" || shelfKey === "n" || shelfKey === "0" || shelfKey === "missing")
        const code = cellAt(row, u.code).toUpperCase()

        if (!code) {
          const name = cellAt(row, u.name).toLowerCase()
          const matches = newItems.filter((item) => item.name.toLowerCase() === name && item.tracking !== "NONE")
          if (matches.length !== 1) {
            problems.push(
              `${label}: ${identity} has no item code, so its PRODUCT NAME must match exactly one new phone or laptop row on the ITEMS tab.`
            )
            continue
          }
          if (onShelf) matches[0].identities.push(identity)
          continue
        }

        const line = bySku.get(code)
        if (!line) {
          problems.push(`${label}: item code ${code} is not on this shop's opening stock.`)
          continue
        }
        if (line.tracking === "NONE") {
          if (line.openingQty > 0) {
            problems.push(`${label}: ${line.name} is counted in pieces, so it has no IMEI or serial. Write its count on the ITEMS tab.`)
            continue
          }
          const next = change(line)
          next.addIdentities = [...(next.addIdentities ?? []), identity]
          const listed = next.addIdentities
          next.promoteTracking = listed.some((value) => value.replace(/\D/g, "").length >= 14) ? "IMEI" : "SERIAL"
          continue
        }
        const known = line.identities.includes(identity)
        if (onShelf && !known) {
          const next = change(line)
          next.addIdentities = [...(next.addIdentities ?? []), identity]
        } else if (!onShelf && known) {
          const next = change(line)
          next.removeIdentities = [...(next.removeIdentities ?? []), identity]
        }
      }
    }
  }

  for (const item of newItems) {
    if (item.tracking !== "NONE" && item.identities.length === 0) {
      problems.push(`${item.label}: ${item.name} is a new ${item.tracking === "IMEI" ? "phone" : "serial"} item, so list each unit on the ${UNITS_SHEET} tab.`)
    }
  }

  const out: OpeningChange[] = []
  for (const next of changes.values()) {
    const { line, counted, ...rest } = next
    if (line.tracking === "NONE") {
      if (counted !== undefined && counted !== line.openingQty) rest.quantity = counted
    } else if (counted !== undefined) {
      const after = line.identities.length + (rest.addIdentities?.length ?? 0) - (rest.removeIdentities?.length ?? 0)
      if (counted !== after) {
        problems.push(
          `${line.name} (${line.sku}): COUNTED QTY says ${counted}, but the ${UNITS_SHEET} tab leaves ${after}. Mark missing units NO and add found ones, so the two agree.`
        )
        continue
      }
    }
    const minimum = rest.minimumPrice ?? line.minimumPrice
    const selling = rest.sellingPrice ?? line.sellingPrice
    if ((rest.minimumPrice !== undefined || rest.sellingPrice !== undefined) && selling < minimum) {
      problems.push(`${line.name} (${line.sku}): the standard selling price cannot be below the lowest selling price.`)
      continue
    }
    if (Object.keys(rest).length > 1) out.push(rest)
  }

  return {
    changes: out,
    newItems: newItems.map(({ label: _label, ...item }) => item),
    problems,
  }
}
