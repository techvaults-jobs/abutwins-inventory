"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { createCustomer } from "@/app/actions/parties"
import { createBankAccount } from "@/app/actions/finance"
import { checkoutSale, findInStockImei, searchTillStock } from "@/app/actions/sales"
import { cancelPriceRequest, getMyPriceRequest, requestPriceApproval } from "@/app/actions/price-requests"
import { TillLookup } from "@/components/till-lookup"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select } from "@/components/ui/select"
import { pushSaleQueue } from "@/lib/offline-sales"
import { requestParkedFlush } from "@/lib/flush-parked"
import { applyParkedToTillSnapshot, readTillSnapshot, saveTillSnapshot, type TillBankAccount, type TillBranch, type TillCustomer, type TillImei, type TillProduct, type TillSnapshot } from "@/lib/till-catalog"
import { formatCurrency, money } from "@/lib/utils"
import { belowCost, lineMargin, needsReason, openingPrice, resellerPrice, sellFloor } from "@/lib/pricing"
import { formatCondition } from "@/lib/status"
import { phoneLookLabel } from "@/lib/phone-look"
import { BellRing, ChevronDown, Loader2, PlusCircle, RotateCcw, ScanLine, Trash2 } from "lucide-react"
import { useDecision } from "@/hooks/use-decision"
import { AnimatedNumber } from "@/components/animated-number"

/** One stable key per sale line: a phone by its IMEI, pieces by their item (they merge). */
function lineKey(line: { imeiId?: string | null; productId: string }) {
  return line.imeiId ?? `piece-${line.productId}`
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-sans text-[10px] font-semibold text-muted-foreground">
      {children}
    </kbd>
  )
}

function lookLabel(item: TillImei) {
  return phoneLookLabel(item.cosmeticGrade) || formatCondition(item.product.condition)
}

/**
 * Everything about what a line may be charged comes from one place, shared with
 * the shop system, so the till never promises a price the sale then refuses.
 */
type PriceSource = {
  sellingPrice: number
  minimumPrice: number
  costPrice: number
  resellerMarkup: number
  /** Worked out on the server when this till may not see cost. */
  resellerQuote?: number
}

function priceBasis(source: PriceSource) {
  return {
    costPrice: money(source.costPrice),
    minimumPrice: money(source.minimumPrice),
    sellingPrice: money(source.sellingPrice),
    resellerMarkup: money(source.resellerMarkup),
    ...(source.resellerQuote !== undefined ? { resellerQuote: money(source.resellerQuote) } : {}),
  }
}

function detailParts(storage?: string | null, condition?: string | null, color?: string | null, category?: string | null) {
  const look = formatCondition(condition) || phoneLookLabel(condition)
  return [storage, look, color, category].filter(Boolean) as string[]
}

function matchesTillQuery(
  q: string,
  fields: Array<string | null | undefined>
) {
  const hay = fields.filter(Boolean).join(" ").toLowerCase()
  return hay.includes(q)
}

export function PosClient({
  products: serverProducts,
  customers: serverCustomers,
  imeis: serverImeis,
  branches: serverBranches,
  bankAccounts: serverBankAccounts = [],
  defaultBranchId,
  canOverrideFloor: serverCanOverrideFloor,
  canSeeCost: serverCanSeeCost,
}: {
  products: TillProduct[]
  customers: TillCustomer[]
  imeis: TillImei[]
  branches: TillBranch[]
  bankAccounts?: TillBankAccount[]
  defaultBranchId?: string | null
  canOverrideFloor?: boolean
  canSeeCost?: boolean
}) {
  const router = useRouter()
  // The till reads the shop system while the line is up, and the last list
  // saved on this phone when it is down. Only the phone's own list is held in
  // state. The shop system's figures are read straight from props.
  //
  // They used to be copied into state on first load, which meant nothing sent
  // from the shop system afterwards ever arrived: a customer added at the till
  // a moment earlier was missing from the list, so the credit limit was checked
  // against nothing and the name looked unselected.
  const [deviceList, setDeviceList] = useState<TillSnapshot | null>(null)
  const [lineDown, setLineDown] = useState(false)

  const usingDeviceList = deviceList !== null
  const products = deviceList?.products ?? serverProducts
  const customers = deviceList?.customers ?? serverCustomers
  const imeis = deviceList?.imeis ?? serverImeis
  const branches = deviceList?.branches ?? serverBranches
  const bankAccounts = deviceList?.bankAccounts ?? serverBankAccounts
  const canOverrideFloor = deviceList ? Boolean(deviceList.canOverrideFloor) : Boolean(serverCanOverrideFloor)
  const canSeeCost = deviceList ? Boolean(deviceList.canSeeCost) : Boolean(serverCanSeeCost)
  const [query, setQuery] = useState("")
  const [customerId, setCustomerId] = useState("")
  const [branchId, setBranchId] = useState(defaultBranchId || serverBranches[0]?.id || "")
  const [method, setMethod] = useState<"CASH" | "BANK" | "SPLIT" | "CREDIT">("CASH")
  // Use the buyer's credit note on this sale. On by default whenever the
  // picked buyer has one; the cashier can turn it off.
  const [useCreditNote, setUseCreditNote] = useState(true)
  // Money taken now, split between the till and the bank. Both a Split sale and
  // a Credit sale use these: the difference is whether anything is left owing.
  const [payCash, setPayCash] = useState(0)
  const [payBank, setPayBank] = useState(0)
  const [bankAccountId, setBankAccountId] = useState("")
  const [paymentRef, setPaymentRef] = useState("")
  const [paid, setPaid] = useState(0)
  const [notes, setNotes] = useState("")
  const [wholesale, setWholesale] = useState(false)
  const [newName, setNewName] = useState("")
  const [newPhone, setNewPhone] = useState("")
  const [savingCustomer, setSavingCustomer] = useState(false)
  const [newBankName, setNewBankName] = useState("")
  const [newBankNumber, setNewBankNumber] = useState("")
  const [savingBank, setSavingBank] = useState(false)
  const [cart, setCart] = useState<
    Array<{
      productId: string
      imeiId?: string
      name: string
      imei?: string
      unitPrice: number
      /** The standard price, for showing what a discount actually gave away. */
      listPrice: number
      /** The lowest staff may charge. Under it needs the CEO and a reason. */
      minPrice: number
      /** What this unit cost us, so margin can be shown as the price is typed. */
      costPrice: number
      resellerMarkup: number
      resellerQuote?: number
      sellingPrice: number
      minimumPrice: number
      /** Why this line left the standard price. Only asked for under the floor. */
      priceReason?: string
      quantity: number
      onHand?: number
      warrantyDays?: number
      storage?: string | null
      condition?: string | null
      color?: string | null
      category?: string | null
    }>
  >([])
  const [orderDiscount, setOrderDiscount] = useState(0)
  const [discountReason, setDiscountReason] = useState("")
  const [busy, setBusy] = useState(false)
  // The CEO or Super Admin's sign-off for a price this seller may not give
  // alone. It belongs to the deal it was given for: change a price, a quantity
  // or the discount and it no longer applies.
  const [approval, setApproval] = useState<{ token: string; name: string; key: string; requestId: string } | null>(null)
  const [approvalOpen, setApprovalOpen] = useState(false)
  // The ask sent to the CEO and main admin for this deal, while it is open.
  const [priceAsk, setPriceAsk] = useState<{
    id: string
    number: string
    key: string
    sentTo: string[]
    sentAt: number
    status: "PENDING" | "DECLINED" | "EXPIRED" | "CANCELLED"
    note?: string | null
    decidedBy?: string | null
  } | null>(null)
  const [approving, setApproving] = useState(false)
  const [waitSeconds, setWaitSeconds] = useState(0)
  const [remoteImeis, setRemoteImeis] = useState<TillImei[]>([])
  const [remoteAccessories, setRemoteAccessories] = useState<TillProduct[]>([])
  const [searchingRemote, setSearchingRemote] = useState(false)
  const { confirm } = useDecision()

  function resetSale() {
    setCart([])
    setPaid(0)
    setPayCash(0)
    setPayBank(0)
    setCustomerId("")
    setNotes("")
    setPaymentRef("")
    setWholesale(false)
    setOrderDiscount(0)
    setDiscountReason("")
    setQuery("")
    setApproval(null)
    setPriceAsk(null)
  }

  const handleClearCart = async () => {
    if (cart.length === 0) {
      resetSale()
      toast.info("Sale cleared. Ready for the next buyer.")
      return
    }
    const ok = await confirm({
      title: "Start a new sale?",
      description: `This sale has ${cart.length} item${cart.length === 1 ? "" : "s"} scanned. Starting a new sale clears them so another till can sell those phones.`,
      tone: "danger",
      confirmLabel: "Yes, start a new sale",
      cancelLabel: "Keep this sale",
      impactItems: [
        `${cart.length} item${cart.length === 1 ? "" : "s"} will leave this sale`,
        "Those IMEIs can be sold again",
      ],
    })
    if (ok) {
      resetSale()
      toast.info("Sale cleared. Ready for the next buyer.")
    }
  }

  const handleBranchChange = async (newBranchId: string) => {
    if (newBranchId === branchId) return
    if (cart.length > 0) {
      const ok = await confirm({
        title: "Switch Branch Location?",
        description: "Switching branches clears all items currently scanned in this cart because inventory records are branch-isolated.",
        tone: "warning",
        confirmLabel: "Yes, Switch & Clear",
        cancelLabel: "Cancel",
        impactItems: [
          `Active cart of ${cart.length} item(s) will be cleared`,
          "Items cannot be sold across different branch inventories simultaneously",
        ],
      })
      if (!ok) return
    }
    setBranchId(newBranchId)
    setCart([])
    setPaid(0)
    setCustomerId("")
  }

  useEffect(() => {
    const onLine = () => {
      const down = !navigator.onLine
      setLineDown(down)
      // When the line comes back, go back to the shop system's list and ask the
      // server for a fresh one. The till used to stay on the phone's saved list
      // for the rest of the shift, so a phone sold at the other till kept
      // showing as In shop here long after the line returned.
      if (!down) {
        setDeviceList((current) => {
          if (current) router.refresh()
          return null
        })
      }
    }
    onLine()
    window.addEventListener("online", onLine)
    window.addEventListener("offline", onLine)
    return () => {
      window.removeEventListener("online", onLine)
      window.removeEventListener("offline", onLine)
    }
  }, [router])

  useEffect(() => {
    let cancelled = false
    const snapshot = {
      products: serverProducts,
      customers: serverCustomers,
      imeis: serverImeis,
      branches: serverBranches,
      bankAccounts: serverBankAccounts,
      defaultBranchId,
      canOverrideFloor: serverCanOverrideFloor,
      canSeeCost: serverCanSeeCost,
    }
    void (async () => {
      const online = navigator.onLine
      if (online && (serverImeis.length || serverCustomers.length || serverProducts.length)) {
        await saveTillSnapshot(snapshot)
        // Fresh figures have arrived, so the phone's older copy is no longer
        // what should be on screen.
        if (!cancelled) setDeviceList(null)
        return
      }
      const stored = await readTillSnapshot()
      if (cancelled) return
      if (stored) {
        setDeviceList(stored)
        if (stored.defaultBranchId && !branchId) setBranchId(stored.defaultBranchId)
        return
      }
      if (!online && (serverImeis.length || serverCustomers.length)) {
        await saveTillSnapshot(snapshot)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [serverProducts, serverCustomers, serverImeis, serverBranches, serverBankAccounts, defaultBranchId, serverCanOverrideFloor, serverCanSeeCost])

  // What is In shop here and not already on this sale. Worked out once per
  // change rather than on every keystroke: this walks every phone in the shop
  // and, for each, the whole cart, so on a big shop it was enough work between
  // keypresses to make the search box feel stuck.
  const cartImeiIds = useMemo(
    () => new Set(cart.map((line) => line.imeiId).filter(Boolean) as string[]),
    [cart]
  )
  const branchImeis = useMemo(
    () => imeis.filter((item) => item.branchId === branchId && !cartImeiIds.has(item.id)),
    [imeis, branchId, cartImeiIds]
  )

  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => {
    const local = q
      ? branchImeis.filter((item) =>
          matchesTillQuery(q, [
            item.imei1,
            item.serialNumber,
            item.product.name,
            item.product.storage,
            item.product.color,
            item.product.brand,
            item.product.category,
            lookLabel(item),
            item.cosmeticGrade,
          ])
        )
      : []
    const localIds = new Set(local.map((row) => row.id))
    const extra = remoteImeis.filter(
      (item) => item.branchId === branchId && !cartImeiIds.has(item.id) && !localIds.has(item.id)
    )
    return [...local, ...extra]
  }, [q, branchImeis, remoteImeis, branchId, cartImeiIds])
  const accessoryHits = useMemo(() => {
    const local = q
      ? products.filter((product) => {
          if (product.serialized) return false
          const onHand = product.stock.find((row) => row.branchId === branchId)?.quantity ?? 0
          return (
            onHand > 0 &&
            matchesTillQuery(q, [
              product.name,
              product.sku,
              product.brand.name,
              product.category?.name,
              product.storage,
              product.color,
              formatCondition(product.condition),
            ])
          )
        })
      : []
    const localIds = new Set(local.map((row) => row.id))
    const extra = remoteAccessories.filter((product) => {
      if (product.serialized) return false
      if (localIds.has(product.id)) return false
      const onHand = product.stock.find((row) => row.branchId === branchId)?.quantity ?? 0
      return onHand > 0
    })
    return [...local, ...extra]
  }, [q, products, branchId, remoteAccessories])

  useEffect(() => {
    if (!q || q.length < 2) {
      setRemoteImeis([])
      setRemoteAccessories([])
      return
    }
    if (typeof navigator !== "undefined" && !navigator.onLine) return
    let cancelled = false
    const timer = window.setTimeout(async () => {
      setSearchingRemote(true)
      const result = await searchTillStock(query.trim(), branchId)
      if (cancelled) return
      setSearchingRemote(false)
      if ("error" in result && result.error) {
        setRemoteImeis([])
        setRemoteAccessories([])
        return
      }
      setRemoteImeis(result.imeis ?? [])
      setRemoteAccessories((result.accessories ?? []) as TillProduct[])
    }, 280)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [q, query, branchId])

  const grossTotal = useMemo(
    () =>
      cart.reduce((sum, line) => {
        const price = Number.isFinite(line.unitPrice) ? line.unitPrice : 0
        const qty = Number.isFinite(line.quantity) ? line.quantity : 0
        return sum + price * qty
      }, 0),
    [cart]
  )
  // The lowest this basket may go for, and what it cost us. Both are checked
  // again by the shop system; these are here so the cashier sees it while typing.
  const floorTotal = useMemo(
    () => cart.reduce((sum, line) => sum + line.minPrice * (line.quantity || 1), 0),
    [cart]
  )
  const costTotal = useMemo(
    () => cart.reduce((sum, line) => sum + line.costPrice * (line.quantity || 1), 0),
    [cart]
  )
  const maxDiscount = Math.max(0, grossTotal)
  const appliedDiscount = Math.min(Math.max(0, orderDiscount), maxDiscount)
  const total = Math.max(0, grossTotal - appliedDiscount)
  const discountGuard = Math.max(floorTotal, costTotal)
  const discountBreaksFloor = appliedDiscount > 0 && total < discountGuard
  const deal = useMemo(
    () => ({
      wholesale,
      orderDiscount: appliedDiscount,
      items: cart.map((line) => ({
        productId: line.productId,
        imeiId: line.imeiId,
        quantity: line.quantity,
        unitPrice: Number.isFinite(line.unitPrice) ? line.unitPrice : 0,
      })),
    }),
    [cart, wholesale, appliedDiscount]
  )
  const dealKey = useMemo(() => JSON.stringify(deal), [deal])
  const activeApproval = approval && approval.key === dealKey ? approval : null
  const askForThisDeal = priceAsk && priceAsk.key === dealKey ? priceAsk : null
  const waitingForApproval = askForThisDeal?.status === "PENDING"

  // While an ask is open, look for the answer every few seconds. The approver
  // answers from their own screen; the till picks it up here by itself.
  useEffect(() => {
    if (!priceAsk || priceAsk.status !== "PENDING") return
    let stopped = false
    const look = async () => {
      try {
        const result = await getMyPriceRequest(priceAsk.id)
        if (stopped || "error" in result) return
        if (result.status === "APPROVED" && result.approval) {
          setApproval({ token: result.approval, name: result.decidedBy ?? "the CEO", key: priceAsk.key, requestId: priceAsk.id })
          setPriceAsk(null)
          setApprovalOpen(false)
          toast.success(`Approved by ${result.decidedBy ?? "the CEO"}. Tap Complete sale to finish.`, { duration: 8000 })
        } else if (result.status === "DECLINED" || result.status === "EXPIRED" || result.status === "CANCELLED") {
          setPriceAsk((current) =>
            current && current.id === priceAsk.id
              ? { ...current, status: result.status as "DECLINED" | "EXPIRED" | "CANCELLED", note: result.note, decidedBy: result.decidedBy }
              : current
          )
          if (result.status === "DECLINED") {
            setApprovalOpen(true)
            toast.error(`${result.decidedBy ?? "The approver"} declined this price${result.note ? `: ${result.note}` : "."}`)
          }
        }
      } catch {
        // The line dropped; the next look tries again.
      }
    }
    const timer = window.setInterval(look, 3000)
    void look()
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [priceAsk])

  // A changed sale no longer matches what was asked. Withdraw the ask so the
  // approver is not asked about a deal the till is no longer making.
  useEffect(() => {
    if (priceAsk && priceAsk.status === "PENDING" && priceAsk.key !== dealKey) {
      void cancelPriceRequest(priceAsk.id)
      setPriceAsk(null)
      toast.message("The sale changed, so the approval request was withdrawn. Ask again when the prices are set.")
    }
  }, [dealKey, priceAsk])

  useEffect(() => {
    if (!waitingForApproval || !askForThisDeal) return
    const tick = () => setWaitSeconds(Math.floor((Date.now() - askForThisDeal.sentAt) / 1000))
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [waitingForApproval, askForThisDeal])

  async function sendPriceAsk() {
    setApproving(true)
    try {
      const result = await requestPriceApproval({
        branchId,
        deal,
        reasons: cart.map((line) => String(line.priceReason || "").trim()),
        discountReason: discountReason.trim() || undefined,
        customerName: customers.find((row) => row.id === customerId)?.name,
      })
      if ("error" in result && result.error) {
        toast.error(result.error)
        return
      }
      if ("request" in result && result.request) {
        setPriceAsk({
          id: result.request.id,
          number: result.request.requestNumber,
          key: dealKey,
          sentTo: result.request.sentTo,
          sentAt: Date.now(),
          status: "PENDING",
        })
        toast.success(`Sent to ${result.request.sentTo.join(" and ")}. You will see the answer here.`)
      }
    } catch {
      toast.error("The shop system did not answer. Check the network and try again.")
    } finally {
      setApproving(false)
    }
  }

  async function withdrawPriceAsk() {
    if (!priceAsk) return
    await cancelPriceRequest(priceAsk.id).catch(() => undefined)
    setPriceAsk(null)
    setApprovalOpen(false)
  }
  /** May this sale go under the floor or under cost, with a reason? */
  const mayGoUnder = canOverrideFloor || Boolean(activeApproval)
  const marginTotal = total - costTotal
  const customer = customers.find((row) => row.id === customerId)
  const shopBanks = useMemo(
    () => bankAccounts.filter((row) => row.branchId === branchId),
    [bankAccounts, branchId]
  )
  // Cash and Bank always pay the full sale total. Credit sales keep cash and/or bank
  // received now. That stops Amount paid from lagging behind a raised price.
  /** Money we owe the picked buyer (a balance below zero), usable as payment. */
  const creditAvailable = customer && customer.currentBalance < 0 ? -customer.currentBalance : 0
  const creditUse = useCreditNote ? Math.min(creditAvailable, total) : 0
  /** What is left to pay in cash, bank or credit once the credit note is used. */
  const toPay = Math.max(0, total - creditUse)
  /** Cash and bank typed in by hand, for a Split or a Credit sale. */
  const handReceived = Math.max(0, payCash) + Math.max(0, payBank)
  const splitsTyped = method === "SPLIT" || method === "CREDIT"
  const effectivePaid = splitsTyped ? Math.min(handReceived, toPay) : toPay
  /** A Split sale is paid in full, so the two boxes have to reach the total. */
  const splitShortfall = method === "SPLIT" ? Math.max(0, toPay - handReceived) : 0
  const due = Math.max(0, toPay - effectivePaid)
  const nextDebt = (customer?.currentBalance ?? 0) + creditUse + due
  const wantsBank =
    toPay > 0 && (method === "BANK" || (splitsTyped && Math.max(0, payBank) > 0))

  useEffect(() => {
    if (!shopBanks.length) {
      if (bankAccountId) setBankAccountId("")
      return
    }
    if (!shopBanks.some((row) => row.id === bankAccountId)) {
      setBankAccountId(shopBanks[0].id)
    }
  }, [shopBanks, bankAccountId])

  useEffect(() => {
    if (!splitsTyped) setPaid(toPay)
  }, [method, toPay, splitsTyped])

  // A price edited after the split was typed would leave the two boxes short or
  // over. The bank side absorbs the change, since the cash side is what someone
  // physically counted out.
  useEffect(() => {
    if (method !== "SPLIT") return
    const cash = Math.min(payCash, toPay)
    const bank = Math.max(0, toPay - cash)
    if (cash !== payCash) setPayCash(cash)
    if (bank !== payBank) setPayBank(bank)
  }, [method, toPay])

  // A new buyer starts with their credit note in use, if they have one.
  useEffect(() => {
    setUseCreditNote(true)
  }, [customerId])

  // Ticking Reseller re-quotes the basket off cost, and unticking puts the
  // standard prices back. A price typed by hand is replaced too — the tick is a
  // deliberate act, so the cashier is told what happened rather than left with a
  // mix of retail and reseller lines on one invoice.
  const resellerRef = useRef(wholesale)
  useEffect(() => {
    if (resellerRef.current === wholesale) return
    resellerRef.current = wholesale
    setCart((current) => {
      if (current.length === 0) return current
      let requoted = 0
      const next = current.map((line) => {
        const basis = priceBasis(line)
        const opening = openingPrice(basis, { reseller: wholesale })
        const floor = sellFloor(basis, { reseller: wholesale })
        if (opening !== line.unitPrice) requoted += 1
        return { ...line, unitPrice: opening, minPrice: floor, priceReason: "" }
      })
      if (requoted > 0) {
        toast.message(
          wholesale
            ? `${requoted} line${requoted === 1 ? "" : "s"} re-quoted at the reseller price.`
            : `${requoted} line${requoted === 1 ? "" : "s"} back at the standard price.`
        )
      }
      syncPaid(next)
      return next
    })
  }, [wholesale])

  // Keep cash + bank from exceeding the sale total while staff type.
  useEffect(() => {
    if (!splitsTyped || !(total > 0)) return
    if (payCash + payBank <= total) return
    const overflow = payCash + payBank - total
    if (payBank >= overflow) setPayBank(Math.max(0, payBank - overflow))
    else {
      const rest = overflow - payBank
      setPayBank(0)
      setPayCash(Math.max(0, payCash - rest))
    }
  }, [method, total, payCash, payBank])

  function setPaidTo(nextTotal: number) {
    if (!splitsTyped) setPaid(nextTotal)
  }

  /**
   * Add a shop bank account without leaving the till. Bank money has to land in
   * a named account, and a cashier who finds the list empty mid-sale used to be
   * sent to another screen and told to come back. Who may do this is unchanged:
   * the shop system refuses anyone the money screens would refuse.
   */
  async function saveBankAccount() {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      toast.error("You can only add a bank account when the network is good.")
      return
    }
    if (!newBankName.trim() || !newBankNumber.trim()) {
      toast.error("Type the bank name and the account number.")
      return
    }
    setSavingBank(true)
    const formData = new FormData()
    formData.set("branchId", branchId)
    formData.set("bankName", newBankName.trim())
    formData.set("accountNumber", newBankNumber.trim())
    // The money screens own opening balances. A bank added here starts at zero
    // and is topped up there, so the till cannot quietly declare money.
    formData.set("openingBalance", "0")
    const result = await createBankAccount(formData)
    setSavingBank(false)
    if ("error" in result && result.error) {
      toast.error(result.error)
      return
    }
    toast.success("Bank account saved for this shop.")
    if ("id" in result && result.id) setBankAccountId(result.id)
    setNewBankName("")
    setNewBankNumber("")
    router.refresh()
  }

  async function saveCustomer() {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      toast.error("You can only add a new name when the network is good. Use a customer already saved on this phone.")
      return
    }
    if (!newName.trim() || !newPhone.trim()) {
      toast.error("A new customer needs a name and a phone number.")
      return
    }
    setSavingCustomer(true)
    const formData = new FormData()
    formData.set("name", newName.trim())
    formData.set("phone", newPhone.trim())
    formData.set("branchId", branchId)
    const result = await createCustomer(formData)
    setSavingCustomer(false)
    if (result.error) {
      toast.error(result.error)
      return
    }
    toast.success("Customer saved for this shop.")
    if (result.id) setCustomerId(result.id)
    setNewName("")
    setNewPhone("")
    router.refresh()
  }

  async function takeScan(code: string) {
    const cleaned = code.replace(/[\s-]/g, "").trim()
    const exact = branchImeis.find(
      (item) =>
        item.imei1 === cleaned ||
        item.serialNumber === cleaned ||
        item.imei1 === code.trim() ||
        item.serialNumber === code.trim() ||
        item.imei1.endsWith(cleaned)
    )
    if (exact) {
      addImei(exact)
      toast.success("Added to this sale")
      return
    }
    if (typeof navigator !== "undefined" && navigator.onLine) {
      const found = await findInStockImei(cleaned || code.trim(), branchId)
      if (found.imei) {
        addImei(found.imei)
        toast.success("Added to this sale")
        return
      }
      toast.error(found.error || "Nothing in this shop matches that scan. Check Goods on the way, or check the shop.")
      return
    }
    setQuery(code)
    toast.error("That number is not in the list saved on this phone. Scan from the last In shop list, or wait for the network.")
  }

  async function takeLookupCommit(raw: string) {
    const typed = raw.trim()
    if (!typed) return
    const cleaned = typed.replace(/[\s-]/g, "")
    const exactLocal = branchImeis.find(
      (item) =>
        item.imei1 === cleaned ||
        item.serialNumber === cleaned ||
        item.imei1 === typed ||
        item.serialNumber === typed ||
        (cleaned.length >= 8 && item.imei1.endsWith(cleaned))
    )
    if (exactLocal) {
      addImei(exactLocal)
      toast.success("Added to this sale")
      return
    }
    if (filtered[0]) {
      addImei(filtered[0])
      toast.success("Added to this sale")
      return
    }
    if (accessoryHits[0]) {
      addAccessory(accessoryHits[0])
      return
    }
    await takeScan(typed)
  }

  function addImei(item: TillImei) {
    const basis = priceBasis(item.product)
    const opening = openingPrice(basis, { reseller: wholesale })
    setCart((current) => {
      const next = [
        ...current,
        {
          productId: item.productId,
          imeiId: item.id,
          name: item.product.name,
          imei: item.imei1,
          unitPrice: opening,
          listPrice: money(item.product.sellingPrice),
          minPrice: sellFloor(basis, { reseller: wholesale }),
          costPrice: basis.costPrice,
          resellerMarkup: basis.resellerMarkup,
          resellerQuote: basis.resellerQuote,
          sellingPrice: basis.sellingPrice,
          minimumPrice: basis.minimumPrice,
          quantity: 1,
          warrantyDays: 0,
          storage: item.product.storage,
          condition: item.cosmeticGrade || item.product.condition,
          color: item.product.color,
          category: item.product.category ?? null,
        },
      ]
      syncPaid(next)
      return next
    })
    setQuery("")
    setRemoteImeis([])
    setRemoteAccessories([])
  }

  function syncPaid(nextCart: typeof cart, discount = appliedDiscount) {
    const gross = nextCart.reduce((sum, row) => sum + row.unitPrice * row.quantity, 0)
    setPaidTo(Math.max(0, gross - Math.min(Math.max(0, discount), Math.max(0, gross))))
  }

  function setLineQuantity(index: number, raw: number) {
    setCart((current) => {
      const next = current.map((row, i) => {
        if (i !== index) return row
        if (row.imeiId) return { ...row, quantity: 1 }
        // Any whole number from 1 up. Stock on hand is checked when the sale is completed.
        const quantity = Math.max(1, Math.floor(Number.isFinite(raw) ? raw : 1) || 1)
        return { ...row, quantity }
      })
      syncPaid(next)
      return next
    })
  }

  function addAccessory(product: TillProduct, pieces = 1) {
    const onHand = product.stock.find((row) => row.branchId === branchId)?.quantity ?? 0
    if (onHand < 1) {
      toast.error(`${product.name} has no pieces left in this shop.`)
      return
    }
    const basis = priceBasis(product)
    const opening = openingPrice(basis, { reseller: wholesale })
    const addQty = Math.max(1, Math.min(onHand, Math.floor(pieces) || 1))
    setCart((current) => {
      const existing = current.find((line) => !line.imeiId && line.productId === product.id)
      let next
      if (existing) {
        const quantity = Math.min(onHand, existing.quantity + addQty)
        if (quantity === existing.quantity) {
          toast.error(`Only ${onHand} piece${onHand === 1 ? "" : "s"} of ${product.name} left in this shop.`)
          return current
        }
        next = current.map((line) =>
          line === existing ? { ...line, quantity, onHand } : line
        )
        toast.success(`Pieces on this sale: ${quantity}`)
      } else {
        next = [
          ...current,
          {
            productId: product.id,
            name: product.name,
            unitPrice: opening,
            listPrice: money(product.sellingPrice),
            minPrice: sellFloor(basis, { reseller: wholesale }),
            costPrice: basis.costPrice,
            resellerMarkup: basis.resellerMarkup,
            resellerQuote: basis.resellerQuote,
            sellingPrice: basis.sellingPrice,
            minimumPrice: basis.minimumPrice,
            quantity: addQty,
            onHand,
            warrantyDays: 0,
            storage: product.storage,
            condition: product.condition,
            color: product.color,
            category: product.category?.name ?? null,
          },
        ]
        toast.success(
          addQty === 1
            ? "Added to this sale. Change Pieces if you need more."
            : `Added ${addQty} pieces to this sale.`
        )
      }
      syncPaid(next)
      return next
    })
    setQuery("")
    setRemoteImeis([])
    setRemoteAccessories([])
  }

  async function checkout() {
    if (method === "CREDIT" && !customerId) {
      toast.error("A credit sale needs a buyer name.")
      return
    }
    if (creditUse > 0 && typeof navigator !== "undefined" && !navigator.onLine) {
      toast.error("Using a credit note needs the network, so the same credit cannot be spent twice. Wait for it, or turn the credit note off.")
      return
    }
    if (due > 0 && !customerId) {
      toast.error("A part payment needs a buyer name. A walk-in must pay everything now.")
      return
    }
    if (due > 0 && customerId) {
      const cust = customers.find((c) => c.id === customerId)
      const ok = await confirm({
        title: "This buyer will still owe us",
        description: `${formatCurrency(due)} will stay owed by ${cust?.name || "this buyer"} after this sale.`,
        tone: "warning",
        confirmLabel: "Yes, they still owe us",
        cancelLabel: "Change the amount received",
        impactItems: [
          `Money received now: ${formatCurrency(effectivePaid)}`,
          `Still owed: ${formatCurrency(due)}`,
          `Buyer: ${cust?.name || "this buyer"}`,
        ],
      })
      if (!ok) return
    }
    if (method === "SPLIT" && splitShortfall > 0) {
      toast.error(
        `Cash and bank together come to ${formatCurrency(handReceived)}, ${formatCurrency(splitShortfall)} short of ${formatCurrency(toPay)}. Add the rest, or use Credit sales if they are not paying it all today.`
      )
      return
    }
    if (method === "SPLIT" && handReceived > 0 && (payCash <= 0 || payBank <= 0)) {
      toast.error("A split needs money in both boxes. Use Cash or Bank on its own otherwise.")
      return
    }
    if (wantsBank && !bankAccountId) {
      toast.error("Pick which bank account received this money. Add banks under Money in and out if the list is empty.")
      return
    }
    if (wantsBank && !paymentRef.trim()) {
      toast.error("Type the transfer or POS reference number so the payment can be checked against the terminal.")
      return
    }
    const underFloor = cart.filter((line) => line.unitPrice < line.minPrice)
    const underCost = cart.filter((line) => belowCost(line.unitPrice, line.costPrice))
    const missingReason = cart.find(
      (line) =>
        needsReason({ unitPrice: line.unitPrice, floor: line.minPrice, costPrice: line.costPrice }) &&
        !String(line.priceReason || "").trim()
    )
    if (missingReason) {
      toast.error(`Say why ${missingReason.name} is going below the lowest allowed price.`)
      return
    }
    if (discountBreaksFloor && !discountReason.trim()) {
      toast.error("Say why this order is going below what the stock may be sold for.")
      return
    }
    // Any price is allowed, but going under the floor or under cost needs the
    // CEO or Super Admin. When the seller cannot do it alone, the CEO approves
    // this deal on this till with their own password.
    if ((underFloor.length > 0 || underCost.length > 0 || discountBreaksFloor) && !mayGoUnder) {
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        toast.error("Asking for approval needs the network. Wait for it to come back, or raise the price.")
        return
      }
      setApprovalOpen(true)
      return
    }
    // A price below cost is the one the shop feels straight away, so it is
    // confirmed out loud even when the person is allowed to do it.
    if (underCost.length > 0) {
      const ok = await confirm({
        title: "This sale loses money",
        description: `${underCost.length} line${underCost.length === 1 ? "" : "s"} on this sale go for less than we paid.`,
        tone: "danger",
        confirmLabel: "Yes, sell at a loss",
        cancelLabel: "Go back and change the price",
        impactItems: underCost.map(
          (line) =>
            `${line.name}: ${formatCurrency(line.unitPrice)} against ${formatCurrency(line.costPrice)} cost`
        ),
      })
      if (!ok) return
    }
    if (cart.some((line) => !Number.isFinite(line.unitPrice) || line.unitPrice < 0)) {
      toast.error("Every line needs a valid sell price before you complete the sale.")
      return
    }
    if (!(total > 0) && cart.length > 0) {
      toast.error("Sale total cannot be zero. Check the prices on this sale.")
      return
    }
    for (const line of cart) {
      if (line.imeiId) continue
      const product = products.find((row) => row.id === line.productId)
      const onHand =
        line.onHand ??
        product?.stock.find((row) => row.branchId === branchId)?.quantity ??
        0
      if (line.quantity > onHand) {
        toast.error(
          `${line.name}: only ${onHand} piece${onHand === 1 ? "" : "s"} left in this shop. Lower Pieces on this sale.`
        )
        return
      }
    }

    const depositChannel: "CASH" | "TRANSFER" =
      method === "CASH" ? "CASH" : "TRANSFER"

    // Both a Split and a Credit sale can take cash and bank together, so the
    // tenders are built the same way. They differ in what the sale is called:
    // Credit stays Credit while anything is owed, Split is paid in full.
    const tenders: Array<{ method: "CASH" | "TRANSFER"; amount: number }> = []
    if (splitsTyped) {
      if (payCash > 0) tenders.push({ method: "CASH", amount: Math.max(0, payCash) })
      if (payBank > 0) tenders.push({ method: "TRANSFER", amount: Math.max(0, payBank) })
    }

    const checkoutMethod: "CASH" | "TRANSFER" | "CREDIT" | "SPLIT_PAYMENT" =
      method === "CREDIT"
        ? "CREDIT"
        : method === "SPLIT"
          ? tenders.length > 1
            ? "SPLIT_PAYMENT"
            : // One box left empty is not a split, it is that one channel.
              tenders[0]?.method ?? "CASH"
          : depositChannel

    const payload = {
      customerId: customerId || undefined,
      branchId,
      paymentMethod: checkoutMethod,
      paidAmount: effectivePaid,
      creditNoteAmount: creditUse > 0 ? creditUse : undefined,
      depositMethod:
        method === "CREDIT" && tenders.length === 1 ? tenders[0].method : undefined,
      splitTenders: tenders.length > 1 ? tenders : undefined,
      bankAccountId: wantsBank ? bankAccountId : undefined,
      paymentReference: wantsBank ? paymentRef.trim() : undefined,
      notes,
      wholesale,
      orderDiscount: appliedDiscount,
      discountReason: discountReason.trim() || undefined,
      priceApproval: activeApproval?.token,
      priceRequestId: activeApproval?.requestId,
      items: cart.map((line) => ({
        productId: line.productId,
        imeiId: line.imeiId,
        quantity: line.quantity,
        unitPrice: Number.isFinite(line.unitPrice) ? line.unitPrice : 0,
        warrantyDays: line.warrantyDays ?? 0,
        priceReason: String(line.priceReason || "").trim() || undefined,
      })),
    }
    setBusy(true)
    async function keepOnDevice() {
      await pushSaleQueue(payload)
      await requestParkedFlush()
      const next = await applyParkedToTillSnapshot(payload)
      if (next) setDeviceList(next)
      setBusy(false)
      setCart([])
      setPaid(0)
    }
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      await keepOnDevice()
      toast.message("Saved on this phone. Send it when the network comes back.")
      return
    }
    let result: Awaited<ReturnType<typeof checkoutSale>>
    try {
      result = await checkoutSale(payload)
    } catch {
      await keepOnDevice()
      toast.message("The shop system did not answer. This sale is waiting on this phone.")
      return
    }
    setBusy(false)
    if (result.error) {
      toast.error(result.error)
      return
    }
    toast.success("Sale saved. Nobody can change this invoice.")
    resetSale()
    // Straight to the receipt, printing itself, so the customer is handed it
    // before they leave the counter.
    router.push(`/sales/${result.saleId}?receipt=1`)
    router.refresh()
  }

  // Keys a busy counter lives on: "/" or F2 jumps to the scan box from
  // anywhere, Ctrl or Cmd + Enter finishes the sale. The ref keeps the newest
  // checkout, since it closes over this render's cart.
  const checkoutRef = useRef(checkout)
  checkoutRef.current = checkout
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const typing = Boolean(target?.closest("input, textarea, select, [contenteditable=true]"))
      if ((event.key === "/" && !typing) || event.key === "F2") {
        const box = document.getElementById("till-lookup") as HTMLInputElement | null
        if (box) {
          event.preventDefault()
          box.focus()
          box.select()
        }
        return
      }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        void checkoutRef.current()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const [addingBuyer, setAddingBuyer] = useState(false)
  const [extrasOpen, setExtrasOpen] = useState(false)
  // Discount, reseller and notes fold away until someone needs them, and stay
  // open while any of them is in use so nothing is hidden that changes money.
  const extrasInUse = wholesale || appliedDiscount > 0 || Boolean(notes.trim())
  const showExtras = extrasOpen || extrasInUse
  const itemCount = cart.reduce((sum, line) => sum + (line.quantity || 1), 0)
  const shopCustomers = customers.filter(
    (row) => row.branchId === branchId && !row.name.toLowerCase().includes("walk-in")
  )

  function chooseMethod(next: typeof method) {
    setMethod(next)
    setPaymentRef("")
    if (next === "CREDIT") {
      setPaid(0)
      setPayCash(0)
      setPayBank(0)
    } else if (next === "SPLIT") {
      // Start the split at the whole sale in cash, so the cashier moves one
      // figure across rather than typing both.
      setPayCash(toPay)
      setPayBank(0)
      setPaid(toPay)
    } else {
      setPayCash(0)
      setPayBank(0)
      setPaid(toPay)
    }
  }

  function updateLine(index: number, patch: Partial<(typeof cart)[number]>, resync = false) {
    setCart((current) => {
      const next = current.map((row, i) => (i === index ? { ...row, ...patch } : row))
      if (resync) syncPaid(next)
      return next
    })
  }

  // A removed line slides out first, then leaves the sale. Found again by its
  // key when the slide ends, in case other lines moved meanwhile.
  const [leaving, setLeaving] = useState<Set<string>>(() => new Set())
  function removeLineAnimated(key: string) {
    setLeaving((current) => new Set(current).add(key))
    window.setTimeout(() => {
      setLeaving((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
      setCart((current) => {
        const next = current.filter((line) => lineKey(line) !== key)
        syncPaid(next)
        return next
      })
    }, 190)
  }

  const methodHint =
    method === "CREDIT"
      ? "Type what they pay now in cash, bank, or both. The rest stays on Credit sales until it is paid."
      : method === "SPLIT"
        ? `Part in the till, part into a shop bank. Both must reach ${formatCurrency(toPay)}. Not paying it all today? Use Credit.`
        : method === "BANK"
          ? "The full amount landed in one shop bank account. Transfer, POS terminal and USSD all count as Bank."
          : "The full amount is in the till."

  const payLabel = busy
    ? "Saving this sale"
    : cart.length
      ? `Complete sale · ${formatCurrency(toPay)}${creditUse > 0 ? " after credit note" : ""}`
      : "Complete sale"

  return (
    <div className="till-page pb-6 lg:pb-0">
      {usingDeviceList || lineDown ? (
        <div className="mb-4 rounded-xl bg-warning-soft px-4 py-3 text-sm text-warning">
          You are selling from the last shop list saved on this phone. You can only use names already on this phone. Phones still on the way are not here. The real invoice is created when the network comes back.
        </div>
      ) : null}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_380px] xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-w-0 space-y-4">
          <section className="surface-card p-4 sm:p-5">
            <TillLookup
              value={query}
              onChange={setQuery}
              onCommit={takeLookupCommit}
              searching={searchingRemote}
            />
            {query ? (
              <div className="mt-3 overflow-hidden rounded-xl border border-border">
                <p className="border-b border-border bg-muted/40 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {searchingRemote ? "Looking across this shop's stock" : "In this shop · tap to add"}
                </p>
                <div className="max-h-[22rem] divide-y divide-border overflow-y-auto">
                  {filtered.slice(0, 8).map((item) => {
                    const parts = detailParts(
                      item.product.storage,
                      item.cosmeticGrade || item.product.condition,
                      item.product.color,
                      item.product.category
                    )
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => addImei(item)}
                        className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left transition-colors hover:bg-primary-soft focus-visible:bg-primary-soft focus-visible:outline-none"
                      >
                        <div className="min-w-0">
                          <span className="block truncate text-sm font-semibold">{item.product.name}</span>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
                            <span className="font-mono text-foreground">{item.imei1}</span>
                            {item.serialNumber ? <span>· {item.serialNumber}</span> : null}
                            <span>· {parts.length ? parts.join(" · ") : "Details not set on this phone"}</span>
                          </div>
                        </div>
                        <span className="shrink-0 text-sm font-semibold tabular-nums">
                          {formatCurrency(money(item.product.sellingPrice))}
                        </span>
                      </button>
                    )
                  })}
                  {accessoryHits.slice(0, 6).map((product) => {
                    const parts = detailParts(product.storage, product.condition, product.color, product.category?.name)
                    const onHand = product.stock.find((row) => row.branchId === branchId)?.quantity ?? 0
                    return (
                      <button
                        key={product.id}
                        type="button"
                        onClick={() => addAccessory(product)}
                        className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left transition-colors hover:bg-primary-soft focus-visible:bg-primary-soft focus-visible:outline-none"
                      >
                        <div className="min-w-0">
                          <span className="block truncate text-sm font-semibold">{product.name}</span>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
                            <span className={onHand > 0 ? "text-foreground" : "text-danger"}>{onHand} on hand</span>
                            {product.brand?.name ? <span>· {product.brand.name}</span> : null}
                            {parts.length ? <span>· {parts.join(" · ")}</span> : null}
                          </div>
                        </div>
                        <span className="shrink-0 text-sm font-semibold tabular-nums">
                          {formatCurrency(money(product.sellingPrice))}
                        </span>
                      </button>
                    )
                  })}
                  {filtered.length === 0 && accessoryHits.length === 0 && !searchingRemote ? (
                    <p className="px-3 py-5 text-sm text-muted-foreground">
                      Nothing in this shop matches that. Check the spelling, or scan the IMEI or serial.
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </section>

          <section className="surface-card overflow-hidden" aria-label="This sale">
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
              <h2 className="text-sm font-semibold">
                This sale
                <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground tabular-nums">
                  {itemCount} {itemCount === 1 ? "item" : "items"}
                </span>
              </h2>
              <button
                type="button"
                onClick={handleClearCart}
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {cart.length ? <RotateCcw className="h-3.5 w-3.5" /> : <PlusCircle className="h-3.5 w-3.5" />}
                {cart.length ? "Clear" : "New sale"}
              </button>
            </div>

            {cart.length === 0 ? (
              <div className="flex flex-col items-center px-6 py-12 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-soft text-primary">
                  <ScanLine className="h-6 w-6" />
                </span>
                <p className="mt-3 font-medium">Scan a phone or type a name to start</p>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  IMEI, serial, phone name, brand, pouch or charger cord all work in the same box.
                </p>
                <p className="mt-4 hidden gap-3 text-xs text-muted-foreground sm:flex">
                  <span><Kbd>/</Kbd> scan box</span>
                  <span><Kbd>Ctrl</Kbd> + <Kbd>Enter</Kbd> complete sale</span>
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {cart.map((line, index) => {
                  const parts = detailParts(line.storage, line.condition, line.color, line.category)
                  const isPieceLine = !line.imeiId
                  const margin = lineMargin(line.unitPrice, line.costPrice, line.quantity)
                  const isUnderCost = belowCost(line.unitPrice, line.costPrice)
                  const underFloor = line.unitPrice < line.minPrice
                  const quote = resellerPrice(priceBasis(line))
                  const wantsReason = needsReason({ unitPrice: line.unitPrice, floor: line.minPrice, costPrice: line.costPrice })
                  const onHand =
                    line.onHand ??
                    products.find((row) => row.id === line.productId)?.stock.find((row) => row.branchId === branchId)?.quantity ??
                    0
                  const lineTotal = (Number.isFinite(line.unitPrice) ? line.unitPrice : 0) * line.quantity
                  return (
                    <li
                      key={lineKey(line)}
                      className={`px-4 py-4 sm:px-5 ${leaving.has(lineKey(line)) ? "motion-line-out" : "motion-line-in"}`}
                    >
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold leading-snug">{line.name}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                            {line.imei ? (
                              <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-foreground">{line.imei}</span>
                            ) : (
                              <span className="rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground">
                                Piece item{onHand > 0 ? ` · ${onHand} on hand` : ""}
                              </span>
                            )}
                            {parts.length ? (
                              <span className="text-muted-foreground">{parts.join(" · ")}</span>
                            ) : !isPieceLine ? (
                              <span className="text-danger">Storage and look missing. Fix on Phones and items.</span>
                            ) : null}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-base font-semibold tabular-nums">{formatCurrency(lineTotal)}</p>
                          {canSeeCost && margin.hasCost ? (
                            <p className={`text-xs tabular-nums ${isUnderCost ? "font-medium text-danger" : "text-success"}`}>
                              {isUnderCost ? "Loss " : "Keep "}
                              {formatCurrency(Math.abs(margin.amount))} · {margin.percent}%
                            </p>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          onClick={() => removeLineAnimated(lineKey(line))}
                          className="-mr-1 -mt-1 rounded-md p-2 text-muted-foreground transition-colors duration-press ease-standard hover:bg-danger-soft hover:text-danger active:scale-90"
                          aria-label={`Remove ${line.name}`}
                          title="Remove from this sale"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>

                      <div className={`mt-3 grid gap-3 ${isPieceLine ? "grid-cols-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]" : "grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]"}`}>
                        <label className={`block ${isPieceLine ? "col-span-2 sm:col-span-1" : ""}`}>
                          <span className="mb-1 block text-xs font-medium text-muted-foreground">
                            Price{isPieceLine ? " each" : ""}
                          </span>
                          <div className="relative">
                            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">₦</span>
                            <Input
                              type="number"
                              inputMode="decimal"
                              className={`h-10 pl-7 font-semibold tabular-nums ${underFloor || isUnderCost ? "border-danger focus-visible:ring-danger/30" : ""}`}
                              value={Number.isFinite(line.unitPrice) ? line.unitPrice : ""}
                              onChange={(event) => {
                                const raw = event.target.value
                                const unitPrice = raw === "" ? 0 : Number(raw)
                                if (!Number.isFinite(unitPrice) || unitPrice < 0) return
                                updateLine(index, { unitPrice }, true)
                              }}
                              onFocus={(event) => event.currentTarget.select()}
                              aria-label={`Sell price for ${line.name}`}
                            />
                          </div>
                        </label>
                        {isPieceLine ? (
                          <div>
                            <span className="mb-1 block text-xs font-medium text-muted-foreground">Pieces</span>
                            <div className="flex h-10 items-stretch overflow-hidden rounded-lg border border-input bg-card">
                              <button
                                type="button"
                                className="w-9 shrink-0 text-lg text-muted-foreground hover:bg-muted disabled:opacity-40"
                                onClick={() => setLineQuantity(index, line.quantity - 1)}
                                disabled={line.quantity <= 1}
                                aria-label={`One less ${line.name}`}
                              >
                                −
                              </button>
                              <input
                                type="number"
                                min={1}
                                step={1}
                                inputMode="numeric"
                                className="min-w-0 flex-1 bg-transparent text-center text-sm font-semibold tabular-nums outline-none"
                                value={String(line.quantity)}
                                onChange={(event) => setLineQuantity(index, Number(event.target.value))}
                                aria-label={`Pieces of ${line.name}`}
                              />
                              <button
                                type="button"
                                className="w-9 shrink-0 text-lg text-muted-foreground hover:bg-muted"
                                onClick={() => setLineQuantity(index, line.quantity + 1)}
                                aria-label={`One more ${line.name}`}
                              >
                                +
                              </button>
                            </div>
                          </div>
                        ) : null}
                        <label className="block">
                          <span className="mb-1 block text-xs font-medium text-muted-foreground">Warranty days</span>
                          <Input
                            type="number"
                            min={0}
                            step={1}
                            inputMode="numeric"
                            className="h-10 tabular-nums"
                            value={String(line.warrantyDays ?? 0)}
                            onChange={(event) =>
                              updateLine(index, { warrantyDays: Math.max(0, Number(event.target.value) || 0) })
                            }
                            onFocus={(event) => event.currentTarget.select()}
                            aria-label={`Warranty days for ${line.name}`}
                          />
                        </label>
                      </div>

                      <p className="mt-2 text-xs text-muted-foreground tabular-nums">
                        Standard {formatCurrency(line.listPrice)} · lowest {formatCurrency(line.minPrice)}
                        {quote > 0 ? ` · reseller ${formatCurrency(quote)}` : ""}
                        {canSeeCost && margin.hasCost ? ` · cost ${formatCurrency(line.costPrice)}` : ""}
                      </p>

                      {underFloor || isUnderCost || line.unitPrice !== line.listPrice || (onHand > 0 && line.quantity > onHand) ? (
                        <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                          {underFloor ? (
                            <span className="rounded-full bg-danger-soft px-2 py-0.5 font-medium text-danger">
                              Under the lowest price
                              {canOverrideFloor
                                ? ""
                                : activeApproval
                                  ? ` · approved by ${activeApproval.name}`
                                  : waitingForApproval
                                    ? " · waiting for approval"
                                    : " · needs approval"}
                            </span>
                          ) : null}
                          {isUnderCost ? (
                            <span className="rounded-full bg-danger-soft px-2 py-0.5 font-medium text-danger">
                              Loses {formatCurrency(Math.abs(margin.amount))}
                            </span>
                          ) : null}
                          {line.unitPrice < line.listPrice && !underFloor ? (
                            <span className="rounded-full bg-info-soft px-2 py-0.5 font-medium text-info">
                              {formatCurrency(line.listPrice - line.unitPrice)} off
                              {wholesale && quote > 0 ? " · reseller" : ""}
                            </span>
                          ) : null}
                          {line.unitPrice > line.listPrice ? (
                            <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">
                              Raised above standard
                            </span>
                          ) : null}
                          {onHand > 0 && line.quantity > onHand ? (
                            <span className="rounded-full bg-warning-soft px-2 py-0.5 font-medium text-warning">
                              Only {onHand} on hand
                            </span>
                          ) : null}
                        </div>
                      ) : null}

                      {wantsReason ? (
                        <label className="mt-2 block">
                          <span className="mb-1 block text-xs font-medium text-warning">
                            Special price: a reason is required
                          </span>
                          <Input
                            className={`h-9 text-sm ${String(line.priceReason ?? "").trim() ? "" : "border-warning"}`}
                            value={line.priceReason ?? ""}
                            onChange={(event) => updateLine(index, { priceReason: event.target.value })}
                            placeholder="Why this price? e.g. old stock, loyal customer. Sent with the approval request"
                            aria-label={`Reason for the price on ${line.name}`}
                          />
                        </label>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </div>

        <aside id="finish-sale" className="surface-card overflow-hidden lg:sticky lg:top-20">
          <div className="border-b border-border bg-muted/40 px-5 py-4">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Sale total</p>
            <p className="mt-0.5 text-3xl font-semibold tabular-nums tracking-tight">
              <AnimatedNumber value={total} />
            </p>
            <div className="mt-1 space-y-0.5 text-sm tabular-nums text-muted-foreground">
              {appliedDiscount > 0 ? (
                <p>{formatCurrency(grossTotal)} less {formatCurrency(appliedDiscount)} discount</p>
              ) : null}
              {canSeeCost && costTotal > 0 ? (
                <p className={marginTotal < 0 ? "font-medium text-danger" : "text-success"}>
                  {marginTotal < 0 ? "Loss on this sale " : "We keep "}
                  {formatCurrency(Math.abs(marginTotal))}
                  {total > 0 ? ` (${Math.round((marginTotal / total) * 1000) / 10}%)` : ""}
                </p>
              ) : null}
            </div>
          </div>

          <div className="space-y-5 p-5">
            {branches.length > 1 ? (
              <label className="block text-sm">
                <span className="mb-1.5 block font-medium">Shop</span>
                <Select value={branchId} onChange={(event) => void handleBranchChange(event.target.value)}>
                  {branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}

            <div className="text-sm">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="font-medium">Buyer</span>
                {!lineDown && !customer ? (
                  <button
                    type="button"
                    onClick={() => setAddingBuyer((value) => !value)}
                    className="text-xs font-semibold text-primary hover:underline"
                  >
                    {addingBuyer ? "Cancel" : "+ New buyer"}
                  </button>
                ) : null}
              </div>
              <Select value={customerId} onChange={(event) => setCustomerId(event.target.value)} aria-label="Buyer">
                <option value="">Walk-in (pays everything now)</option>
                {shopCustomers.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name} · {row.phone}
                  </option>
                ))}
              </Select>
              {customer ? (
                <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">
                  {customer.currentBalance < 0
                    ? `We owe them ${formatCurrency(-customer.currentBalance)} (credit note)`
                    : `Owes ${formatCurrency(customer.currentBalance)}`}
                  {customer.creditLimit > 0 ? ` · limit ${formatCurrency(customer.creditLimit)}` : ""}
                </p>
              ) : lineDown ? (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  New buyers cannot be saved while the network is down. Pick a name already on this phone.
                </p>
              ) : addingBuyer ? (
                <div className="mt-2 grid grid-cols-2 gap-2 rounded-lg border border-border p-2.5">
                  <Input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Name" aria-label="New buyer name" />
                  <Input value={newPhone} onChange={(event) => setNewPhone(event.target.value)} placeholder="Phone" inputMode="tel" aria-label="New buyer phone" />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="col-span-2"
                    disabled={savingCustomer}
                    onClick={async () => {
                      await saveCustomer()
                      setAddingBuyer(false)
                    }}
                  >
                    {savingCustomer ? "Saving this buyer" : "Save buyer for this shop"}
                  </Button>
                </div>
              ) : null}
            </div>

            {creditAvailable > 0 ? (
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-success/30 bg-success-soft p-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]"
                  checked={useCreditNote}
                  onChange={(event) => setUseCreditNote(event.target.checked)}
                />
                <span className="min-w-0">
                  <span className="block font-semibold text-foreground">Pay with their credit note</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground tabular-nums">
                    {customer?.name} has {formatCurrency(creditAvailable)} of credit from a return.
                    {useCreditNote && cart.length
                      ? toPay > 0
                        ? ` ${formatCurrency(creditUse)} comes off this sale; ${formatCurrency(toPay)} is left to pay below.`
                        : ` It covers this whole sale. ${formatCurrency(creditAvailable - creditUse)} of credit stays for next time.`
                      : ""}
                  </span>
                </span>
              </label>
            ) : null}

            {creditUse > 0 && toPay <= 0 ? (
              <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                Nothing more to pay. The credit note settles this sale, so no cash or bank is taken.
              </p>
            ) : (
            <div className="text-sm">
              <span className="mb-1.5 block font-medium">How they pay</span>
              {/* One highlight slides to the chosen way of paying. */}
              <div role="radiogroup" aria-label="How they pay" className="relative grid grid-cols-4 rounded-lg bg-muted p-1">
                <span
                  aria-hidden
                  className="absolute bottom-1 left-1 top-1 w-[calc((100%-0.5rem)/4)] rounded-md bg-card shadow-sm ring-1 ring-border transition-transform duration-panel ease-decelerate"
                  style={{ transform: `translateX(${["CASH", "BANK", "SPLIT", "CREDIT"].indexOf(method) * 100}%)` }}
                />
                {(
                  [
                    ["CASH", "Cash"],
                    ["BANK", "Bank"],
                    ["SPLIT", "Split"],
                    ["CREDIT", "Credit"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={method === value}
                    onClick={() => chooseMethod(value)}
                    className={`relative z-10 rounded-md px-2 py-2 text-sm font-semibold transition-colors duration-small ease-standard ${
                      method === value ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">{methodHint}</p>
            </div>
            )}

            {splitsTyped && toPay > 0 ? (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <label className="block text-sm">
                    <span className="mb-1 block text-xs font-medium text-muted-foreground">
                      {method === "SPLIT" ? "Cash part" : "Cash now"}
                    </span>
                    <Input
                      type="number"
                      min={0}
                      inputMode="decimal"
                      max={toPay || undefined}
                      value={payCash || ""}
                      placeholder="0"
                      className="tabular-nums"
                      onChange={(event) => {
                        const next = Math.max(0, Number(event.target.value) || 0)
                        if (method === "SPLIT") {
                          // The bill is settled in full, so whatever is not cash is bank.
                          const cash = Math.min(next, toPay)
                          setPayCash(cash)
                          setPayBank(Math.max(0, toPay - cash))
                          return
                        }
                        setPayCash(Math.min(next, Math.max(0, toPay - payBank)))
                      }}
                    />
                  </label>
                  <label className="block text-sm">
                    <span className="mb-1 block text-xs font-medium text-muted-foreground">
                      {method === "SPLIT" ? "Bank part" : "Bank now"}
                    </span>
                    <Input
                      type="number"
                      min={0}
                      inputMode="decimal"
                      max={toPay || undefined}
                      value={payBank || ""}
                      placeholder="0"
                      className="tabular-nums"
                      onChange={(event) => {
                        const next = Math.max(0, Number(event.target.value) || 0)
                        if (method === "SPLIT") {
                          const bank = Math.min(next, toPay)
                          setPayBank(bank)
                          setPayCash(Math.max(0, toPay - bank))
                          return
                        }
                        setPayBank(Math.min(next, Math.max(0, toPay - payCash)))
                      }}
                    />
                  </label>
                </div>
                {method === "SPLIT" ? (
                  <p className={`text-xs tabular-nums ${splitShortfall > 0 ? "font-medium text-warning" : "text-success"}`}>
                    {splitShortfall > 0
                      ? `${formatCurrency(splitShortfall)} still to place in a box.`
                      : `${formatCurrency(payCash)} cash + ${formatCurrency(payBank)} bank. Paid in full.`}
                  </p>
                ) : (
                  <p className="text-xs tabular-nums text-muted-foreground">
                    Received now {formatCurrency(effectivePaid)}
                    {due > 0 ? ` · still owed ${formatCurrency(due)}` : " · paid in full today"}
                  </p>
                )}
              </div>
            ) : null}

            {wantsBank ? (
              <>
              <label className="block text-sm">
                <span className="mb-1.5 block font-medium">Bank account that received it</span>
                {shopBanks.length ? (
                  <Select value={bankAccountId} onChange={(event) => setBankAccountId(event.target.value)}>
                    {shopBanks.map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.bankName} · {row.accountNumber}
                        {row.accountName ? ` · ${row.accountName}` : ""}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <div className="space-y-2 rounded-lg border border-warning/40 bg-warning-soft p-3">
                    <p className="text-xs text-foreground">
                      No bank account for this shop yet. Add the one the money landed in and it will be here for every sale after this.
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      <Input value={newBankName} onChange={(event) => setNewBankName(event.target.value)} placeholder="Bank name" aria-label="Bank name" />
                      <Input
                        value={newBankNumber}
                        onChange={(event) => setNewBankNumber(event.target.value)}
                        placeholder="Account number"
                        aria-label="Bank account number"
                        inputMode="numeric"
                      />
                    </div>
                    <Button type="button" variant="outline" size="sm" className="w-full" disabled={savingBank} onClick={saveBankAccount}>
                      {savingBank ? "Saving this bank account" : "Save bank account for this shop"}
                    </Button>
                  </div>
                )}
              </label>
              <label className="block text-sm">
                <span className="mb-1.5 block font-medium">
                  Payment reference
                  <span className="ml-1.5 rounded-full bg-danger-soft px-1.5 py-0.5 text-[10px] font-semibold text-danger">Required</span>
                </span>
                <Input
                  value={paymentRef}
                  onChange={(event) => setPaymentRef(event.target.value)}
                  placeholder="Transfer description, POS approval code, or last 4 digits"
                  aria-label="Payment reference number"
                  autoComplete="off"
                  className="font-mono"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  This is how the admin checks the cashier record against the bank or POS terminal. It will appear on the invoice.
                </p>
              </label>
              </>
            ) : null}

            <div className="rounded-lg border border-border">
              <button
                type="button"
                onClick={() => setExtrasOpen((value) => !value)}
                disabled={extrasInUse}
                aria-expanded={showExtras}
                className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm font-medium disabled:cursor-default"
              >
                <span>Discount, reseller and notes</span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {appliedDiscount > 0 ? <span className="rounded-full bg-info-soft px-2 py-0.5 text-info">−{formatCurrency(appliedDiscount)}</span> : null}
                  {wholesale ? <span className="rounded-full bg-info-soft px-2 py-0.5 text-info">Reseller</span> : null}
                  <ChevronDown className={`h-4 w-4 transition-transform ${showExtras ? "rotate-180" : ""}`} />
                </span>
              </button>
              {showExtras ? (
                <div className="space-y-4 border-t border-border p-3">
                  <div className="space-y-2">
                    <label className="block text-sm">
                      <span className="mb-1 block text-xs font-medium text-muted-foreground">Discount on the whole order</span>
                      <div className="relative">
                        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">₦</span>
                        <Input
                          type="number"
                          min={0}
                          step={1}
                          inputMode="decimal"
                          className="pl-7 tabular-nums"
                          value={orderDiscount ? String(orderDiscount) : ""}
                          onChange={(event) => {
                            const raw = Number(event.target.value)
                            const next = Number.isFinite(raw) && raw > 0 ? Math.min(raw, maxDiscount) : 0
                            setOrderDiscount(next)
                            syncPaid(cart, next)
                          }}
                          placeholder="0"
                          aria-label="Discount on the whole order"
                        />
                      </div>
                    </label>
                    <div className="flex flex-wrap gap-1.5">
                      {[2.5, 5, 10].map((percent) => (
                        <button
                          key={percent}
                          type="button"
                          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                          onClick={() => {
                            const next = Math.round((grossTotal * percent) / 100)
                            setOrderDiscount(next)
                            syncPaid(cart, next)
                          }}
                          disabled={!(grossTotal > 0)}
                        >
                          {percent}%
                        </button>
                      ))}
                      {appliedDiscount > 0 ? (
                        <button
                          type="button"
                          className="rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                          onClick={() => {
                            setOrderDiscount(0)
                            setDiscountReason("")
                            syncPaid(cart, 0)
                          }}
                        >
                          Clear
                        </button>
                      ) : null}
                    </div>
                    {discountBreaksFloor ? (
                      <>
                        <p className="text-xs text-danger">
                          This takes the sale under the {formatCurrency(discountGuard)} this stock may go for.
                          {mayGoUnder ? " Say why." : " Say why. The CEO or Super Admin approves it when you complete the sale."}
                        </p>
                        <Input
                          className="h-9 text-sm"
                          value={discountReason}
                          onChange={(event) => setDiscountReason(event.target.value)}
                          placeholder="Why this discount?"
                          aria-label="Reason for this discount"
                        />
                      </>
                    ) : null}
                  </div>
                  <label className="flex items-start gap-2.5 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]"
                      checked={wholesale}
                      onChange={(event) => setWholesale(event.target.checked)}
                    />
                    <span>
                      <span className="font-medium">Reseller or dealer sale</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        Re-prices every line from cost with the category markup.
                      </span>
                    </span>
                  </label>
                  <Input placeholder="Notes for the invoice" value={notes} onChange={(event) => setNotes(event.target.value)} aria-label="Notes" />
                </div>
              ) : null}
            </div>

            {customer && (method === "CREDIT" || due > 0) ? (
              <p className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning tabular-nums">
                {customer.name} would owe {formatCurrency(nextDebt)} after this sale.
              </p>
            ) : null}
            {activeApproval ? (
              <p className="rounded-lg bg-success-soft px-3 py-2 text-xs text-success">
                Price approved by {activeApproval.name}. Change a price and it will need approving again.
              </p>
            ) : waitingForApproval ? (
              <button
                type="button"
                onClick={() => setApprovalOpen(true)}
                className="flex w-full items-center gap-2 rounded-lg bg-primary-soft px-3 py-2 text-left text-xs text-primary"
              >
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                <span>
                  Waiting for {askForThisDeal?.sentTo.join(" or ")} to approve this price… {formatWait(waitSeconds)}
                </span>
              </button>
            ) : null}

            <div className="space-y-2">
              <Button className="min-h-12 w-full text-base" disabled={!cart.length || busy} onClick={checkout}>
                {payLabel}
              </Button>
              <p className="text-center text-xs text-muted-foreground tabular-nums">
                {cart.length
                  ? `${creditUse > 0 ? `Credit note ${formatCurrency(creditUse)} · ` : ""}Paid ${formatCurrency(effectivePaid)}${due > 0 ? ` · owed ${formatCurrency(due)}` : " · in full"}`
                  : "Add something to this sale first"}
                <span className="hidden lg:inline"> · <Kbd>Ctrl</Kbd> + <Kbd>Enter</Kbd></span>
              </p>
            </div>
          </div>
        </aside>
      </div>

      {/* On a phone the total and the pay button stay under the thumb. */}
      <div className="till-bar fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-xl lg:hidden">
        <div className="mx-auto flex max-w-xl items-center gap-3">
          <button
            type="button"
            className="min-w-0 flex-1 text-left"
            onClick={() => document.getElementById("finish-sale")?.scrollIntoView({ behavior: "smooth", block: "start" })}
          >
            <span className="block text-xs text-muted-foreground">
              {itemCount} {itemCount === 1 ? "item" : "items"} · {method === "BANK" ? "Bank" : method === "SPLIT" ? "Split" : method === "CREDIT" ? "Credit" : "Cash"}
            </span>
            <span className="block truncate text-xl font-semibold tabular-nums">
              <AnimatedNumber value={total} />
            </span>
          </button>
          <Button className="min-h-12 shrink-0 px-6 text-base" disabled={!cart.length || busy} onClick={checkout}>
            {busy ? "Saving" : "Complete sale"}
          </Button>
        </div>
      </div>
      <Dialog open={approvalOpen} onOpenChange={(open) => !approving && setApprovalOpen(open)}>
        <DialogContent className="max-w-md">
          <DialogHeader className="pr-8">
            <DialogTitle>
              {waitingForApproval
                ? "Waiting for approval"
                : askForThisDeal?.status === "DECLINED"
                  ? "Price declined"
                  : "Ask for approval on this price"}
            </DialogTitle>
            <DialogDescription>
              {waitingForApproval
                ? `Sent to ${askForThisDeal?.sentTo.join(" and ")} (${askForThisDeal?.number}). The first to answer decides. You can close this and keep working; the till tells you when they answer.`
                : askForThisDeal?.status === "DECLINED"
                  ? `${askForThisDeal.decidedBy ?? "The approver"} declined${askForThisDeal.note ? `: "${askForThisDeal.note}"` : "."} Raise the price, or change the deal and ask again.`
                  : askForThisDeal?.status === "EXPIRED"
                    ? "Nobody answered in 30 minutes, so the request lapsed. Send it again."
                    : "This sale goes under the lowest allowed price or under what we paid. The CEO and the main admin get it on their screens straight away, with the prices and your reasons. Their name is kept on the invoice and on Price changes."}
            </DialogDescription>
          </DialogHeader>
          <ul className="space-y-1 rounded-lg bg-muted p-3 text-xs">
            {cart
              .filter((line) => line.unitPrice < line.minPrice || belowCost(line.unitPrice, line.costPrice))
              .map((line, index) => (
                <li key={`${line.imeiId ?? line.productId}-${index}`}>
                  {line.name}: {formatCurrency(line.unitPrice)}
                  {line.listPrice > 0 ? ` (standard ${formatCurrency(line.listPrice)})` : ""}
                  {belowCost(line.unitPrice, line.costPrice) ? " · under cost" : ""}
                  {line.priceReason ? ` · “${line.priceReason}”` : ""}
                </li>
              ))}
            {discountBreaksFloor ? (
              <li>Order discount {formatCurrency(appliedDiscount)}, sale total {formatCurrency(total)}</li>
            ) : null}
          </ul>
          {waitingForApproval ? (
            <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-3 text-sm">
              <Loader2 className="h-5 w-5 shrink-0 animate-spin text-primary" />
              <div className="min-w-0 flex-1">
                <p className="font-medium">Waiting for an answer</p>
                <p className="text-xs text-muted-foreground tabular-nums">Sent {formatWait(waitSeconds)} ago · lapses after 30 minutes</p>
              </div>
            </div>
          ) : null}
          <DialogFooter className="gap-2">
            {waitingForApproval ? (
              <>
                <Button type="button" variant="outline" onClick={() => void withdrawPriceAsk()}>
                  Withdraw request
                </Button>
                <Button type="button" onClick={() => setApprovalOpen(false)}>
                  Keep working
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="outline" disabled={approving} onClick={() => setApprovalOpen(false)}>
                  Cancel
                </Button>
                <Button type="button" disabled={approving} onClick={() => void sendPriceAsk()}>
                  <BellRing className="mr-1.5 h-4 w-4" />
                  {approving ? "Sending" : askForThisDeal ? "Ask again" : "Send for approval"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** "45s", "3m 10s": how long a price ask has been waiting. */
function formatWait(seconds: number) {
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
}
