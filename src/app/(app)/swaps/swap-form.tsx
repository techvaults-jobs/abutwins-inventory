"use client"

import { useMemo, useState, type ReactNode } from "react"
import { createSwap } from "@/app/actions/ops"
import { ActionForm } from "@/components/action-form"
import { DifferenceSettle } from "@/components/difference-settle"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { formatCurrency } from "@/lib/utils"
import { SHOP_CONDITION_OPTIONS, shopConditionLabel } from "@/lib/conditions"
import { STORAGE_OPTIONS } from "@/lib/item-specs"
import { UNIT_IDENTITY_OPTIONS, type UnitIdentityKind } from "@/lib/unit-identity"
import { SwapPaymentFields, type SwapBank } from "./swaps-list"

/** A product name already on the price list, with the brand and category it sits under. */
type ModelName = { name: string; brand: string; category: string }
type Customer = { id: string; name: string; phone: string; branchId: string }
type Branch = { id: string; name: string }

const SUGGESTED_CATEGORIES = ["Phones", "Tablets", "Laptops"]

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-3 rounded-xl border border-border p-3">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-foreground">{title}</legend>
      {children}
    </fieldset>
  )
}

export function SwapForm({
  customers,
  models,
  brands,
  categories,
  branches,
  banks,
  defaultBranchId,
  successHref,
}: {
  successHref?: string
  customers: Customer[]
  models: ModelName[]
  brands: string[]
  categories: string[]
  branches: Branch[]
  banks: SwapBank[]
  defaultBranchId?: string | null
}) {
  const [branchId, setBranchId] = useState(defaultBranchId || branches[0]?.id || "")
  const [customerId, setCustomerId] = useState("")
  const [tradeValue, setTradeValue] = useState("")
  const [givenValue, setGivenValue] = useState("")
  const [identityKind, setIdentityKind] = useState<UnitIdentityKind>("IMEI")
  const [modelName, setModelName] = useState("")
  const [brand, setBrand] = useState("")
  const [category, setCategory] = useState("Phones")
  const [storage, setStorage] = useState("")
  const [condition, setCondition] = useState("UK_USED")
  const [color, setColor] = useState("")

  const shopCustomers = customers.filter((row) => row.branchId === branchId)
  const pickedCustomer = shopCustomers.find((row) => row.id === customerId)
  const categoryChoices = [...new Set([...SUGGESTED_CATEGORIES, ...categories])]
  const swapAmount = Number(tradeValue || 0)
  const givenAmount = Number(givenValue || 0)
  const balance = givenAmount - swapAmount
  const balanceLabel = useMemo(() => {
    if (!Number.isFinite(balance) || (!tradeValue && !givenValue)) return null
    if (balance > 0) return { kind: "receivable" as const, amount: balance }
    if (balance < 0) return { kind: "payable" as const, amount: Math.abs(balance) }
    return { kind: "even" as const, amount: 0 }
  }, [balance, tradeValue, givenValue])

  const bookedAs = [brand, modelName, storage, shopConditionLabel(condition), color].filter(Boolean).join(" · ")

  // Picking a name already on the list fills its brand and category, so the
  // phone lands on the same item the shop already sells.
  function pickModel(value: string) {
    setModelName(value)
    const known = models.find((row) => row.name.toLowerCase() === value.trim().toLowerCase())
    if (known) {
      setBrand(known.brand)
      setCategory(known.category)
    }
  }

  return (
    <ActionForm
      action={createSwap}
      successHref={successHref}
      submit="Save Swap Deal"
      successMessage="Swap Deal done and invoiced."
      enterDoesNotSubmit
      confirmModal={{
        title: "Save this Swap Deal?",
        description:
          "It takes effect at once, with no approval. Check the phones and the values: the customer's phone goes onto the shelf and the shop phone leaves now.",
        confirmLabel: "Save Swap Deal",
        tone: "warning",
        impactItems: [
          bookedAs ? `Customer's phone in: ${bookedAs}, worth ${formatCurrency(swapAmount)}` : "Customer's phone details as typed",
          `Shop phone out, worth ${formatCurrency(givenAmount)}`,
          balance > 0
            ? `The customer owes ${formatCurrency(balance)}. Anything not paid now goes on their account.`
            : balance < 0
              ? `We owe the customer ${formatCurrency(-balance)}. Anything not paid back now stays on their account.`
              : "Even swap. No money either way.",
          "The invoice is written now",
        ],
      }}
      className="space-y-4"
    >
      <Section title="Shop and customer">
        <Field label="Shop">
          <Select
            name="branchId"
            value={branchId}
            onChange={(event) => {
              setBranchId(event.target.value)
              setCustomerId("")
            }}
            required
          >
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>{branch.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Customer">
          <Select name="customerId" value={customerId} onChange={(event) => setCustomerId(event.target.value)}>
            <option value="">New customer. Type the name and phone below.</option>
            {shopCustomers.map((customer) => (
              <option key={customer.id} value={customer.id}>{customer.name} · {customer.phone}</option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Customer name">
            <Input
              name="customerName"
              defaultValue={pickedCustomer?.name ?? ""}
              placeholder="Adebayo Musa"
              required
              key={`customer-name-${customerId}-${branchId}`}
            />
          </Field>
          <Field label="Customer phone">
            <Input
              name="customerPhone"
              defaultValue={pickedCustomer?.phone ?? ""}
              placeholder="0803 000 0000"
              required
              key={`customer-phone-${customerId}-${branchId}`}
            />
          </Field>
        </div>
      </Section>

      <Section title="Customer's phone coming in">
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">This phone is known by</p>
          <input type="hidden" name="oldIdentityKind" value={identityKind} />
          <div className="flex gap-1 rounded-xl border border-border bg-muted/60 p-1">
            {UNIT_IDENTITY_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setIdentityKind(option.value)}
                className={`flex-1 rounded-lg py-2 text-xs font-semibold transition-all ${
                  identityKind === option.value
                    ? "bg-primary text-primary-foreground shadow-xs"
                    : "text-muted-foreground hover:bg-card hover:text-foreground"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className={identityKind === "IMEI" ? "grid gap-3 sm:grid-cols-2" : ""}>
          <Field label={identityKind === "IMEI" ? "IMEI 1" : "Serial number"}>
            <Input
              name="oldDeviceId"
              required
              className="font-mono"
              placeholder={identityKind === "IMEI" ? "Scan or type IMEI 1" : "Scan or type the serial number"}
            />
          </Field>
          {identityKind === "IMEI" ? (
            <Field label="IMEI 2 (optional)">
              <Input name="oldImei2" className="font-mono" placeholder="For dual SIM phones" />
            </Field>
          ) : null}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Phone name (model)">
            <Input
              name="oldProductName"
              list="swap-model-names"
              value={modelName}
              onChange={(event) => pickModel(event.target.value)}
              placeholder="iPhone 12 Pro, Galaxy S21, Tab A9"
              required
            />
            <datalist id="swap-model-names">
              {models.map((row) => (
                <option key={row.name} value={row.name} />
              ))}
            </datalist>
          </Field>
          <Field label="Brand">
            <Input
              name="oldBrand"
              list="swap-brand-names"
              value={brand}
              onChange={(event) => setBrand(event.target.value)}
              placeholder="Apple, Samsung, Tecno"
              required
            />
            <datalist id="swap-brand-names">
              {brands.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Storage">
            <Select name="oldStorage" value={storage} onChange={(event) => setStorage(event.target.value)} required>
              <option value="">Pick storage</option>
              {STORAGE_OPTIONS.map((size) => (
                <option key={size} value={size}>{size}</option>
              ))}
            </Select>
          </Field>
          <Field label="Memory (RAM)">
            <Input name="oldRam" placeholder="6GB (optional)" />
          </Field>
          <Field label="Colour">
            <Input name="oldColor" value={color} onChange={(event) => setColor(event.target.value)} placeholder="Graphite (optional)" />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Condition (how the phone looks)">
            <Select name="oldDeviceCondition" value={condition} onChange={(event) => setCondition(event.target.value)} required>
              {SHOP_CONDITION_OPTIONS.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="Category">
            <Input
              name="oldCategory"
              list="swap-category-names"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              placeholder="Phones"
            />
            <datalist id="swap-category-names">
              {categoryChoices.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </Field>
        </div>
        <Field label="Anything else about its condition (optional)">
          <Input name="oldConditionNotes" placeholder="Small scratch on the back, battery 86%, Face ID works" />
        </Field>
        <Field label="Value of the customer's phone (₦)">
          <Input
            name="tradeValue"
            type="number"
            min={0}
            value={tradeValue}
            onChange={(event) => setTradeValue(event.target.value)}
            placeholder="What we give for it"
            required
          />
        </Field>
        {bookedAs ? (
          <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            Will be booked in as <span className="font-semibold text-foreground">{bookedAs}</span>. A name that is not on the
            price list yet is added at the swap value. Set its selling price on Phones & items.
          </p>
        ) : null}
      </Section>

      <Section title="Shop phone going out">
        <Field label="IMEI or serial number" hint="Scan or type the In shop phone or laptop the customer is taking.">
          <Input name="newDeviceId" className="font-mono" placeholder="Scan or type" required />
        </Field>
        <Field label="Value of the shop phone (₦)">
          <Input
            name="givenValue"
            type="number"
            min={0}
            value={givenValue}
            onChange={(event) => setGivenValue(event.target.value)}
            placeholder="What we give it out for"
            required
          />
        </Field>
      </Section>

      {balanceLabel ? (
        <p className="text-sm font-medium">
          {balanceLabel.kind === "receivable"
            ? `Receivable (customer pays us): ${formatCurrency(balanceLabel.amount)}`
            : balanceLabel.kind === "payable"
              ? `Payable (we pay the customer): ${formatCurrency(balanceLabel.amount)}`
              : "Balance: even. No money either way."}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Balance shows Receivable if the shop item is worth more, or Payable if the swap-in item is worth more.
        </p>
      )}

      {balanceLabel && balanceLabel.kind !== "even" ? (
        <Section title="The balance">
          <DifferenceSettle
            key={balance}
            balance={balance}
            moneyFields={
              <div className="grid gap-2 sm:grid-cols-2">
                <SwapPaymentFields banks={banks} branchId={branchId} payingOut={balance < 0} />
              </div>
            }
          />
        </Section>
      ) : null}
    </ActionForm>
  )
}
