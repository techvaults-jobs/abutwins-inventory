"use client"

import { useMemo, useState } from "react"
import { intakeImei } from "@/app/actions/imei"
import { ActionForm } from "@/components/action-form"
import { PhotoField } from "@/components/photo-field"
import { ScanField } from "@/components/scan-field"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { PHONE_LOOK_OPTIONS } from "@/lib/phone-look"
import { listedSupplierClash } from "@/lib/party-key"
import { defaultIdentityFor, UNIT_IDENTITY_OPTIONS, type UnitIdentityKind } from "@/lib/unit-identity"

export type IntakeProduct = {
  id: string
  name: string
  tracking: string
  costPrice: number
  minimumPrice: number
  sellingPrice: number
  stockByBranch: Array<{ branchId: string; quantity: number }>
}

type Branch = { id: string; name: string }
type Supplier = { id: string; name: string; phone?: string | null }

export function ImeiIntakeForm({
  products,
  branches,
  suppliers,
  canPrice = false,
}: {
  products: IntakeProduct[]
  branches: Branch[]
  suppliers: Supplier[]
  /** Type cost, lowest and selling price as the phone comes in. The price setters only (canChangeCost). */
  canPrice?: boolean
}) {
  const [imei1, setImei1] = useState("")
  const [supplierChoice, setSupplierChoice] = useState("")
  const [productId, setProductId] = useState(products[0]?.id ?? "")
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "")
  const [costPrice, setCostPrice] = useState(String(products[0]?.costPrice ?? 0))
  const [minimumPrice, setMinimumPrice] = useState(String(products[0]?.minimumPrice ?? 0))
  const [sellingPrice, setSellingPrice] = useState(String(products[0]?.sellingPrice ?? 0))
  const [identityKind, setIdentityKind] = useState<UnitIdentityKind>(
    defaultIdentityFor(products[0]?.tracking ?? "IMEI")
  )

  const selected = useMemo(
    () => products.find((product) => product.id === productId) ?? null,
    [products, productId]
  )
  const tracked = selected ? selected.tracking !== "NONE" : true
  const onShelfNow =
    selected?.stockByBranch.find((row) => row.branchId === branchId)?.quantity ?? 0

  function applyProduct(nextId: string) {
    setProductId(nextId)
    const product = products.find((row) => row.id === nextId)
    if (!product) return
    setCostPrice(String(product.costPrice))
    setMinimumPrice(String(product.minimumPrice))
    setSellingPrice(String(product.sellingPrice))
    setIdentityKind(defaultIdentityFor(product.tracking))
    setImei1("")
  }

  const addingNewSupplier = supplierChoice === "__new__"

  return (
    <ActionForm
      action={async (formData) => {
        if (addingNewSupplier) {
          const clash = listedSupplierClash(
            suppliers,
            String(formData.get("newSupplierName") || ""),
            String(formData.get("newSupplierPhone") || ""),
          )
          if (clash) return { error: clash }
        }
        const result = await intakeImei(formData)
        if (result && "success" in result && result.success) {
          setImei1("")
        }
        return result
      }}
      submit={tracked ? "Add unit to shop" : "Add pieces to shop"}
      successMessage="Added to the shop"
      enterDoesNotSubmit
      className="space-y-3"
    >
      {tracked ? (
        <>
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">This unit is known by</p>
            <input type="hidden" name="identityKind" value={identityKind} />
            <div className="flex gap-1 rounded-xl border border-border bg-muted/60 p-1">
              {UNIT_IDENTITY_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    setIdentityKind(option.value)
                    setImei1("")
                  }}
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
            <p className="mt-1 text-xs text-muted-foreground">
              Tablets, laptops and some phones have no IMEI. Pick Serial number for those.
            </p>
          </div>
          <ScanField
            key={identityKind}
            kind={identityKind}
            onScan={setImei1}
            placeholder={identityKind === "SERIAL" ? "Scan the serial number, then Enter" : "Scan IMEI 1, then Enter"}
          />
          <input type="hidden" name="imei1" value={imei1} />
          {imei1 ? <p className="font-mono text-xs">{imei1}</p> : null}
          {identityKind === "IMEI" ? (
            <>
              <Input name="imei2" placeholder="IMEI 2 (optional)" />
              <Input name="serialNumber" placeholder="Serial (optional)" />
            </>
          ) : null}
        </>
      ) : (
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          This item has no IMEI. Type how many pieces you are putting on the shelf.
        </p>
      )}

      <Select
        name="productId"
        required
        value={productId}
        onChange={(event) => applyProduct(event.target.value)}
        emptyLabel="No item is on the list yet. Add them on Phones and items first."
      >
        {products.map((product) => (
          <option key={product.id} value={product.id}>{product.name}</option>
        ))}
      </Select>

      <Select
        name="branchId"
        required
        value={branchId}
        onChange={(event) => setBranchId(event.target.value)}
      >
        {branches.map((branch) => (
          <option key={branch.id} value={branch.id}>{branch.name}</option>
        ))}
      </Select>

      <div className={`grid grid-cols-2 gap-3 ${canPrice ? "sm:grid-cols-4" : ""}`}>
        {/* Prices are the price setters'. Anyone else receives at the price list's own prices. */}
        {canPrice ? (
          <>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Cost</label>
          <Input
            name="costPrice"
            type="number"
            min={0}
            step="0.01"
            required
            value={costPrice}
            onChange={(event) => setCostPrice(event.target.value)}
            className="mt-1"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Lowest sell</label>
          <Input
            name="minimumPrice"
            type="number"
            min={0}
            step="0.01"
            required
            value={minimumPrice}
            onChange={(event) => setMinimumPrice(event.target.value)}
            className="mt-1"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Selling price</label>
          <Input
            name="sellingPrice"
            type="number"
            min={0}
            step="0.01"
            required
            value={sellingPrice}
            onChange={(event) => setSellingPrice(event.target.value)}
            className="mt-1"
          />
        </div>
          </>
        ) : null}
        <div>
          <label className="text-xs font-medium text-muted-foreground">
            {tracked ? "Quantity" : "Pieces to add"}
          </label>
          {tracked ? (
            <>
              <input type="hidden" name="quantity" value="1" />
              <Input value="1" readOnly className="mt-1 bg-muted/50" aria-label="Quantity is one phone" />
            </>
          ) : (
            <Input
              name="quantity"
              type="number"
              min={1}
              step={1}
              defaultValue={1}
              required
              className="mt-1"
              placeholder="How many pieces"
            />
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        On the shelf now at this shop: {onShelfNow}. Cost, lowest sell, and selling price update this item on the price list. This screen is still not a supplier bill.
      </p>

      <Select
        name="supplierId"
        value={supplierChoice}
        onChange={(event) => setSupplierChoice(event.target.value)}
      >
        <option value="">Supplier</option>
        {suppliers.map((supplier) => (
          <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
        ))}
        <option value="__new__">Add new supplier</option>
      </Select>
      {addingNewSupplier ? (
        <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3">
          <p className="text-xs font-semibold text-foreground">New supplier</p>
          <Input name="newSupplierName" required placeholder="Supplier name" />
          <Input name="newSupplierPhone" required placeholder="Supplier phone number" />
          <Input name="newSupplierCity" placeholder="City (optional)" />
        </div>
      ) : null}
      <Select name="cosmeticGrade" defaultValue="">
        <option value="">How the phone looks</option>
        {PHONE_LOOK_OPTIONS.map((row) => (
          <option key={row.value} value={row.value}>{row.label}</option>
        ))}
      </Select>
      <Input name="conditionNotes" placeholder="Anything else about its condition" />
      <PhotoField />
      <Input name="notes" placeholder="Notes" />
    </ActionForm>
  )
}
