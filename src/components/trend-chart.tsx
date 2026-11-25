import { useEffect, useMemo, useRef, useState } from "react"

import { cn } from "@/lib/utils"

export interface TrendPoint {
  /** Stable id; drives hover/pin state and the emphasis dot. */
  key: string
  value: number
  /** Tooltip first line. */
  title: string
  /** Tooltip second line. */
  sub: string
}

export interface TrendTick {
  key: string
  /** Percent position of the bucket column center. */
  x: number
  label: string
  edge: "left" | "center" | "right"
}

interface TrendChartProps {
  series: TrendPoint[]
  /** Key of the bucket that gets the emphasis dot (e.g. today / latest). */
  emphasisKey: string | null
  /** Optional x-axis labels rendered in a row beneath the plot. */
  xTicks?: TrendTick[]
}

/**
 * Line + area trend with hover/pin tooltips. Plot area, dots and hit targets
 * are one shared layer so dots align exactly with the button columns. Hover and
 * pin state live here: remount (via `key`) to reset them, e.g. on range change.
 */
export function TrendChart({ series, emphasisKey, xTicks = [] }: TrendChartProps) {
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  const [pinKey, setPinKey] = useState<string | null>(null)
  const chartRef = useRef<HTMLDivElement>(null)

  // Close pinned tooltip on outside tap/click (mouse + touch).
  useEffect(() => {
    if (!pinKey) return
    function onPointerDown(e: PointerEvent) {
      if (!chartRef.current?.contains(e.target as Node)) {
        setPinKey(null)
        setHoverKey(null)
      }
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [pinKey])

  const max = Math.max(1, ...series.map(d => d.value))

  // Chart geometry in percent units. `y` is the SVG y (0 = top); `h` is the
  // height above baseline used by the HTML dot layer. x sits at hit-target
  // centers ((i + 0.5) / n) so dots align exactly with the button columns.
  const points = useMemo(
    () =>
      series.map((d, i) => {
        const h = Math.max((d.value / max) * 100, 1.5)
        return {
          ...d,
          x: ((i + 0.5) / series.length) * 100,
          y: 100 - h,
          h,
        }
      }),
    [series, max],
  )
  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ")
  const areaPath =
    points.length > 1
      ? `${linePath} L${points[points.length - 1].x} 100 L${points[0].x} 100 Z`
      : ""

  return (
    <>
      <div
        ref={chartRef}
        className="relative mt-3 h-20 sm:mt-4 sm:h-28"
        onMouseLeave={() => setHoverKey(null)}
      >
        {series.length === 0 ? (
          <div className="flex h-full items-end">
            <span className="text-sm text-card-foreground/60">No data yet</span>
          </div>
        ) : (
          <>
            {/* Line + area (SVG, non-scaling stroke) */}
            {points.length > 1 && (
              <div className="pointer-events-none absolute inset-0 text-card-foreground/40">
                <svg
                  aria-hidden
                  className="h-full w-full"
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                >
                  <defs>
                    <linearGradient id="chart-area-fade" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="currentColor" stopOpacity="0.15" />
                      <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  <path d={areaPath} fill="url(#chart-area-fade)" />
                  <path
                    d={linePath}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              </div>
            )}
            {/* Dots + hairline (HTML layer, no pointer events) */}
            <div className="pointer-events-none absolute inset-0">
              {points.map(p => {
                const isOpen = hoverKey === p.key || pinKey === p.key
                return (
                  <span key={p.key}>
                    {isOpen && (
                      <span
                        className="absolute bottom-0 w-px bg-card-foreground/20"
                        style={{ left: `${p.x}%`, height: `${p.h}%` }}
                      />
                    )}
                    <span
                      className={cn(
                        "spring absolute block rounded-full",
                        isOpen
                          ? "size-2 bg-card-foreground ring-2 ring-card-foreground/20"
                          : p.key === emphasisKey
                            ? "size-1 bg-card-foreground"
                            : "size-1 bg-card-foreground/35",
                      )}
                      style={{
                        left: `${p.x}%`,
                        bottom: `${p.h}%`,
                        transform: "translate(-50%, 50%)",
                      }}
                    />
                  </span>
                )
              })}
            </div>
            {/* Hit targets */}
            <div className="flex h-full">
              {series.map((d, i) => {
                const isOpen = hoverKey === d.key || pinKey === d.key
                return (
                  <button
                    key={d.key}
                    type="button"
                    className="relative h-full flex-1 cursor-pointer outline-none"
                    onMouseEnter={() => setHoverKey(d.key)}
                    onMouseLeave={() => setHoverKey(null)}
                    onFocus={() => setHoverKey(d.key)}
                    onBlur={() => setHoverKey(null)}
                    onClick={() => setPinKey(p => (p === d.key ? null : d.key))}
                    aria-label={`${d.title}, ${d.sub}`}
                  >
                    <span
                      role="tooltip"
                      className={cn(
                        "pointer-events-none absolute bottom-full z-50 mb-1.5 whitespace-nowrap rounded-lg bg-popover px-2 py-1 text-xs font-medium text-popover-foreground shadow-lg ring-1 ring-card-foreground/10 backdrop-blur transition-opacity duration-100",
                        isOpen ? "opacity-100" : "opacity-0",
                        i === 0
                          ? "left-0"
                          : i === series.length - 1
                            ? "right-0"
                            : "left-1/2 -translate-x-1/2",
                      )}
                    >
                      <span className="block">{d.title}</span>
                      <span className="block">{d.sub}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          </>
        )}
      </div>
      {xTicks.length > 0 && (
        <div className="pointer-events-none relative mt-1.5 h-4 text-[10px] tabular-nums text-card-foreground/45">
          {xTicks.map(t => (
            <span
              key={t.key}
              className="absolute top-0 whitespace-nowrap"
              style={
                t.edge === "left"
                  ? { left: `${t.x}%` }
                  : t.edge === "right"
                    ? { right: `${100 - t.x}%` }
                    : { left: `${t.x}%`, transform: "translateX(-50%)" }
              }
            >
              {t.label}
            </span>
          ))}
        </div>
      )}
    </>
  )
}
