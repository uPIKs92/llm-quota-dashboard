import { useEffect, useState, type CSSProperties } from "react"
import { useReveal } from "@/hooks/use-reveal"

function parseUTC(iso: string): number {
  // If the string has no timezone offset, treat it as UTC
  if (!/[zZ]$/.test(iso) && !/[+-]\d{2}:?\d{2}$/.test(iso)) {
    return new Date(iso + "Z").getTime()
  }
  return new Date(iso).getTime()
}

function countdown(ms: number): string {
  if (ms <= 0) return "00:00:00"
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return [h, m, s].map(n => String(n).padStart(2, "0")).join(":")
}

interface Props {
  windowStart: string
  windowEnd: string
  /** Quota exhausted this window — label the countdown as replenish time. */
  exhausted?: boolean
}

const shellStyle = { "--reveal-delay": "120ms" } as CSSProperties

/* ---- Smooth gradation across the whole window (0–100% elapsed) ----
   Frontier color interpolates green → gold → red in oklch so there is no
   hard step at the old 70% / 90% thresholds. Anchors mirror the dark-mode
   fill tokens (the reset track is always dark, both themes). */
const GREEN = { L: 0.68, C: 0.1, H: 150 }
const GOLD = { L: 0.72, C: 0.16, H: 70 }
const RED = { L: 0.62, C: 0.21, H: 32 }

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

/** Frontier color at a given elapsed percent (0–100). */
function frontierColor(p: number): string {
  const m = p <= 70
    ? { L: lerp(GREEN.L, GOLD.L, p / 70), C: lerp(GREEN.C, GOLD.C, p / 70), H: lerp(GREEN.H, GOLD.H, p / 70) }
    : { L: lerp(GOLD.L, RED.L, (p - 70) / 30), C: lerp(GOLD.C, RED.C, (p - 70) / 30), H: lerp(GOLD.H, RED.H, (p - 70) / 30) }
  return `oklch(${m.L.toFixed(3)} ${m.C.toFixed(3)} ${m.H.toFixed(1)})`
}

/** Flame opacity: nothing below 45%, eases to full by 100%. */
function burnOpacity(p: number): number {
  const t = Math.min(Math.max((p - 45) / 55, 0), 1)
  // easeInOutQuad
  const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
  return e * 0.92
}

/** Ambient glow on the track: ramps in from 75% to 100%. */
function glowShadow(p: number): string {
  const a = Math.min(Math.max((p - 75) / 25, 0), 1)
  return `0 0 16px 2px rgba(255,110,60,${(0.45 * a).toFixed(3)}), inset 0 0 12px rgba(232,52,28,${(0.22 * a).toFixed(3)})`
}

export function ResetWindowBar({ windowStart, windowEnd, exhausted }: Props) {
  // independent 1s tick so countdown stays live
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const reveal = useReveal<HTMLDivElement>()

  if (!windowStart || !windowEnd) {
    return (
      <div
        ref={reveal.ref}
        data-revealed={reveal.visible ? "true" : "false"}
        className="bezel-shell spring reveal"
        style={shellStyle}
      >
        <div className="bezel-core reset-track h-24 px-5 py-4 flex items-center justify-center overflow-hidden relative">
          <p className="text-xs uppercase tracking-wide text-white/60">
            Reset window unavailable
          </p>
        </div>
      </div>
    )
  }

  const start = parseUTC(windowStart)
  const end = parseUTC(windowEnd)
  const now = Date.now()
  const total = Math.max(end - start, 1)
  const p = Math.min(Math.max(((now - start) / total) * 100, 0), 100)
  const remaining = end - now
  const isOver = remaining <= 0
  const startColor = `oklch(${GREEN.L} ${GREEN.C} ${GREEN.H})`
  const burn = burnOpacity(p)
  const showEmbers = p >= 82

  return (
    <div
      ref={reveal.ref}
      data-revealed={reveal.visible ? "true" : "false"}
      className="bezel-shell spring reveal"
      style={shellStyle}
    >
      <div
        className="bezel-core reset-track h-[72px] px-3 py-2 sm:h-24 sm:px-5 sm:py-4 flex items-center overflow-hidden relative"
        style={{ boxShadow: glowShadow(p) }}
      >
        {/* elapsed fill — smooth green→gold→red gradation, frontier = now */}
        <div
          className="reset-fill"
          style={{
            width: `${p}%`,
            background: `linear-gradient(90deg, ${startColor}, ${frontierColor(p)})`,
          }}
        >
          {/* flame overlay hugs the leading edge of the fill */}
          <div className="reset-burn" style={{ opacity: burn }} />
          {/* rising embers at critical urgency */}
          {showEmbers && (
            <>
              <span className="reset-ember" style={{ left: "80%", animationDelay: "0s" }} />
              <span className="reset-ember" style={{ left: "88%", animationDelay: "0.6s" }} />
              <span className="reset-ember" style={{ left: "95%", animationDelay: "1.1s" }} />
            </>
          )}
        </div>

        {/* foreground text */}
        <div className="relative z-10 flex w-full items-center justify-between">
          <div>
            <p className="eyebrow glass-pill inline-block rounded-full px-2 py-0.5 text-white/70">
              {exhausted ? "Replenish in" : "Reset window"}
            </p>
            <p
              className="mt-1 text-lg sm:text-3xl font-bold tabular-nums tracking-tight text-white"
              style={{ textShadow: "0 1px 4px rgba(0,0,0,0.35)" }}
            >
              {isOver ? "Replenishing…" : countdown(remaining)}
            </p>
          </div>
          <div className="hidden text-right sm:block">
            <p className="eyebrow glass-pill inline-block rounded-full px-2 py-0.5 text-white/70">Elapsed</p>
            <p
              className="mt-1 text-lg font-semibold tabular-nums text-white/80"
              style={{ textShadow: "0 1px 3px rgba(0,0,0,0.3)" }}
            >
              {p.toFixed(0)}%
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
