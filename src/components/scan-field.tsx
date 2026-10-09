"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Camera, Check, Plus } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

function cleanCode(raw: string) {
  return raw.replace(/[\s-]/g, "").trim()
}

/** Several numbers pasted at once: one per line, or split by commas or spaces. */
function splitCodes(raw: string) {
  return raw
    .split(/[\n,;\t ]+/)
    .map(cleanCode)
    .filter(Boolean)
}

/**
 * USB and Bluetooth scanners type the number and then press Enter.
 * Enter in a box must not save the form. Staff still have other fields to fill.
 */
export function preventEnterFromSubmitting(event: React.KeyboardEvent) {
  if (event.key !== "Enter") return
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  if (target.tagName === "TEXTAREA") return
  if (target instanceof HTMLButtonElement && target.type === "submit") return
  event.preventDefault()
}

export function ScanField({
  onScan,
  kind = "IMEI",
  placeholder,
  hint,
  value: controlledValue,
  onValueChange,
  autoFocus,
}: {
  onScan: (value: string) => void
  kind?: "IMEI" | "SERIAL" | "ANY"
  placeholder?: string
  hint?: string
  /**
   * What is typed in the box and not yet added. Pass it (with onValueChange)
   * when the form must also send a number someone typed and never pressed
   * Add or Enter for, which staff often do before pressing save.
   */
  value?: string
  onValueChange?: (value: string) => void
  /** Put the cursor in the box on load, for screens that are all about scanning. */
  autoFocus?: boolean
}) {
  const [ownValue, setOwnValue] = useState("")
  const value = controlledValue ?? ownValue
  const setValue = (next: string) => {
    if (onValueChange) onValueChange(next)
    if (controlledValue === undefined) setOwnValue(next)
  }
  const [scanning, setScanning] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<number | null>(null)

  function check(code: string) {
    if (kind === "IMEI" && code.length < 14) {
      toast.error("That IMEI is too short. Scan the box again, or type every digit.")
      return false
    }
    if (kind !== "IMEI" && code.length < 4) {
      toast.error(kind === "SERIAL" ? "That serial number is too short." : "That number is too short.")
      return false
    }
    return true
  }

  function commit(raw: string) {
    const code = cleanCode(raw)
    if (!code || !check(code)) return
    onScan(code)
    setValue("")
  }

  /** A pasted list adds every number on it, not one long string. */
  function onPaste(event: React.ClipboardEvent<HTMLInputElement>) {
    const codes = splitCodes(event.clipboardData.getData("text"))
    if (codes.length < 2) return
    event.preventDefault()
    const good = codes.filter(check)
    for (const code of good) onScan(code)
    if (good.length) toast.success(`${good.length} numbers added from what you pasted.`)
    setValue("")
  }

  async function startCamera() {
    const Detector = (window as Window & { BarcodeDetector?: new (opts: { formats: string[] }) => { detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue: string }>> } }).BarcodeDetector
    if (!Detector) {
      toast.error("This phone cannot open the camera scanner. Use a USB scanner, or type the number by hand.")
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } })
      streamRef.current = stream
      setScanning(true)
      requestAnimationFrame(() => {
        if (videoRef.current) videoRef.current.srcObject = stream
      })
      const detector = new Detector({ formats: ["code_128", "code_39", "ean_13", "ean_8", "qr_code", "data_matrix"] })
      const tick = async () => {
        const video = videoRef.current
        if (!video || video.readyState < 2) {
          timerRef.current = window.setTimeout(tick, 200)
          return
        }
        try {
          const codes = await detector.detect(video)
          const hit = codes[0]?.rawValue
          if (hit) {
            stopCamera()
            commit(hit)
            toast.success("Scanned")
            return
          }
        } catch {
          // keep looking
        }
        timerRef.current = window.setTimeout(tick, 250)
      }
      timerRef.current = window.setTimeout(tick, 300)
    } catch {
      toast.error("The camera was blocked. Allow the camera, or use a USB scanner.")
    }
  }

  function stopCamera() {
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setScanning(false)
  }

  useEffect(() => () => stopCamera(), [])

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onPaste={onPaste}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              event.stopPropagation()
              commit(value)
            }
          }}
          placeholder={
            placeholder ??
            (kind === "IMEI"
              ? "Type, paste or scan the IMEI"
              : kind === "SERIAL"
                ? "Type, paste or scan the serial number"
                : "Type, paste or scan an IMEI or serial number")
          }
          autoComplete="off"
          autoFocus={autoFocus}
          // Serial numbers carry letters, so only a pure IMEI box opens the number pad.
          inputMode={kind === "IMEI" ? "numeric" : "text"}
          autoCapitalize="characters"
          className="min-h-12 min-w-0 flex-1"
        />
        <Button type="button" className="min-h-12 shrink-0" disabled={!cleanCode(value)} onClick={() => commit(value)}>
          <Plus className="h-4 w-4 sm:mr-1.5" />
          <span className="hidden sm:inline">Add</span>
          <span className="sr-only sm:hidden">Add this number</span>
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-12 shrink-0"
          onClick={scanning ? stopCamera : startCamera}
          aria-label={scanning ? "Stop the camera" : "Scan with the camera"}
        >
          <Camera className="h-4 w-4 sm:mr-1.5" />
          <span className="hidden sm:inline">{scanning ? "Stop" : "Camera"}</span>
        </Button>
      </div>
      {scanning ? (
        <video ref={videoRef} className="h-48 w-full rounded-xl bg-black object-cover" autoPlay muted playsInline />
      ) : (
        <p className="text-xs text-muted-foreground">
          {hint ??
            "Type the number and press Add (or Enter), paste a whole list, or use a scanner or the camera. Adding a number does not save the form."}
        </p>
      )}
    </div>
  )
}

export function ScanList({
  name,
  kind = "IMEI",
  required = true,
}: {
  name: string
  kind?: "IMEI" | "SERIAL" | "ANY"
  required?: boolean
}) {
  const [items, setItems] = useState<string[]>([])
  // A number typed in the box but never added (no Add, no Enter) still goes
  // with the form: the hidden list is read-only, so the browser cannot stop
  // the save, and the number would otherwise be lost.
  const [typed, setTyped] = useState("")
  const pending = splitCodes(typed).filter(
    (code) => !items.includes(code) && code.length >= (kind === "IMEI" ? 14 : 4)
  )
  const payload = [...items, ...pending]

  function add(code: string) {
    setItems((current) => {
      if (current.includes(code)) {
        toast.error("That number is already on the list.")
        return current
      }
      return [...current, code]
    })
  }

  return (
    <div className="space-y-2">
      <ScanField kind={kind} onScan={add} value={typed} onValueChange={setTyped} />
      <textarea name={name} value={payload.join("\n")} readOnly required={required && payload.length === 0} className="sr-only" />
      {pending.length ? (
        <p className="text-xs text-muted-foreground">
          {pending.length === 1 ? `${pending[0]} goes` : `${pending.length} typed numbers go`} with the form when you save,
          even without pressing Add.
        </p>
      ) : null}
      {items.length ? (
        <ul className="space-y-1 text-sm">
          {items.map((item) => (
            <li key={item} className="flex items-center justify-between rounded-lg bg-muted px-3 py-2 font-mono text-xs">
              <span>{item}</span>
              <button type="button" className="text-danger" onClick={() => setItems((current) => current.filter((row) => row !== item))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">No number yet. Type, paste or scan the first one.</p>
      )}
    </div>
  )
}

export type ChecklistUnit = {
  /** The number the server keeps for this unit (its first IMEI). */
  key: string
  title: string
  /** Every number the unit can be found by: IMEI 1, IMEI 2, serial. */
  codes: string[]
  /** Why it cannot be ticked, when it cannot (sold at the sending shop, say). */
  unavailable?: string
}

/**
 * A known list of units to confirm, such as the phones on a transfer. Tick
 * each one by hand, tick them all, or type, paste or scan any of a unit's
 * numbers to tick it. No scanner is needed, and nothing has to be typed from
 * memory. The ticked units go to the form under `name`, one per line.
 */
export function UnitChecklist({ name, units, noun = "phone" }: { name: string; units: ChecklistUnit[]; noun?: string }) {
  const [ticked, setTicked] = useState<Set<string>>(() => new Set())
  const byCode = useMemo(() => {
    const map = new Map<string, ChecklistUnit>()
    for (const unit of units) for (const code of [unit.key, ...unit.codes]) if (code) map.set(code.toUpperCase(), unit)
    return map
  }, [units])
  const available = units.filter((unit) => !unit.unavailable)

  function setOne(unit: ChecklistUnit, on: boolean) {
    setTicked((current) => {
      const next = new Set(current)
      if (on) next.add(unit.key)
      else next.delete(unit.key)
      return next
    })
  }

  function find(code: string) {
    const unit = byCode.get(code.toUpperCase())
    if (!unit) {
      toast.error(`${code} is not on this list.`)
      return
    }
    if (unit.unavailable) {
      toast.error(`${unit.title} (${unit.key}): ${unit.unavailable}`)
      return
    }
    if (ticked.has(unit.key)) {
      toast.message(`${unit.title} is already ticked.`)
      return
    }
    setOne(unit, true)
    toast.success(`Ticked ${unit.title}`)
  }

  return (
    <div className="space-y-3">
      <ScanField
        kind="ANY"
        onScan={find}
        placeholder={`Type, paste or scan a ${noun}'s IMEI or serial to tick it`}
        hint={`Or tick each ${noun} below by hand. Anything left unticked stays at the sending shop.`}
      />
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium tabular-nums">
          {ticked.size} of {available.length} {noun}
          {available.length === 1 ? "" : "s"} ticked as arrived
        </span>
        <span className="flex gap-3">
          <button
            type="button"
            className="font-medium text-primary hover:underline disabled:opacity-40"
            disabled={ticked.size === available.length}
            onClick={() => setTicked(new Set(available.map((unit) => unit.key)))}
          >
            Tick all
          </button>
          <button
            type="button"
            className="font-medium text-muted-foreground hover:underline disabled:opacity-40"
            disabled={ticked.size === 0}
            onClick={() => setTicked(new Set())}
          >
            Clear
          </button>
        </span>
      </div>
      <ul className="max-h-72 divide-y divide-border overflow-auto rounded-xl border border-border">
        {units.map((unit) => {
          const on = ticked.has(unit.key)
          return (
            <li key={unit.key}>
              <label
                className={`flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm ${unit.unavailable ? "cursor-not-allowed opacity-55" : on ? "bg-success-soft/60" : "hover:bg-muted/60"}`}
              >
                <input
                  type="checkbox"
                  className="h-5 w-5 shrink-0 accent-[hsl(var(--success))]"
                  checked={on}
                  disabled={Boolean(unit.unavailable)}
                  onChange={(event) => setOne(unit, event.target.checked)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{unit.title}</span>
                  <span className="block break-all font-mono text-xs text-muted-foreground">
                    {[unit.key, ...unit.codes.filter((code) => code && code !== unit.key)].join(" · ")}
                  </span>
                  {unit.unavailable ? <span className="block text-xs text-warning">{unit.unavailable}</span> : null}
                </span>
                {on ? <Check className="h-4 w-4 shrink-0 text-success" aria-hidden /> : null}
              </label>
            </li>
          )
        })}
      </ul>
      <textarea name={name} value={[...ticked].join("\n")} readOnly className="sr-only" tabIndex={-1} aria-hidden />
    </div>
  )
}
