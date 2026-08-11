import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"

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
}

export function ResetWindowBar({ windowStart, windowEnd }: Props) {
  // independent 1s tick so countdown stays live
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  if (!windowStart || !windowEnd) {
    return (
      <div className="reset-track h-20 px-4 flex items-center">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          Reset window unavailable
        </p>
      </div>
    )
  }

  const start = parseUTC(windowStart)
  const end = parseUTC(windowEnd)
  const now = Date.now()
  const total = Math.max(end - start, 1)
  const elapsedPct = Math.min(Math.max(((now - start) / total) * 100, 0), 100)
  const remaining = end - now
  const isOver = remaining <= 0
  const tier = elapsedPct >= 90 ? "high" : elapsedPct >= 70 ? "mid" : "low"

  return (
    <div
      className={cn(
        "reset-track h-20 px-4 flex items-center",
        tier === "high" && "reset-glow-high"
      )}
    >
      {/* elapsed fill */}
      <div
        className={cn(
          "reset-fill",
          tier === "mid" && "reset-fill-mid",
          tier === "high" && "reset-fill-high"
        )}
        style={{ width: `${elapsedPct}%` }}
      >
        {/* flame overlay hugs the leading edge of the fill */}
        {tier !== "low" && (
          <div
            className={cn(
              "reset-burn",
              tier === "mid" && "reset-burn-mid",
              tier === "high" && "reset-burn-high"
            )}
          />
        )}
        {/* rising embers at critical urgency */}
        {tier === "high" && (
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
          <p
            className="text-xs uppercase tracking-wide text-muted-foreground"
            style={{ textShadow: "0 1px 2px rgba(255,255,255,0.4)" }}
          >
            Reset window
          </p>
          <p
            className="mt-0.5 text-2xl font-bold tabular-nums tracking-tight"
            style={{ textShadow: "0 1px 4px rgba(0,0,0,0.35)" }}
          >
            {isOver ? "Resetting…" : countdown(remaining)}
          </p>
        </div>
        <div className="text-right">
          <p
            className="text-xs uppercase tracking-wide text-muted-foreground"
            style={{ textShadow: "0 1px 2px rgba(255,255,255,0.4)" }}
          >
            Elapsed
          </p>
          <p
            className="mt-0.5 text-lg font-semibold tabular-nums"
            style={{ textShadow: "0 1px 3px rgba(0,0,0,0.3)" }}
          >
            {elapsedPct.toFixed(0)}%
          </p>
        </div>
      </div>
    </div>
  )
}
