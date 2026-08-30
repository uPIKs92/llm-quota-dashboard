import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  ArrowClockwise,
  CalendarBlank,
  Clock,
  Coins,
  Fire,
  Gauge,
  Hash,
  MoonStars,
  Sun,
  Warning,
} from "@phosphor-icons/react"
import { GlassCard } from "@/components/ui/glass-card"
import { Progress } from "@/components/ui/progress"
import { ResetWindowBar } from "@/components/reset-window-bar"
import { StatTile } from "@/components/ui/stat-tile"
import { cn } from "@/lib/utils"
import { useTheme } from "./theme"

interface HistoryDay {
  log_date: string
  tokens_used: number
  requests: number
}

interface QuotaData {
  name: string
  model: string
  limit: number
  used: number
  remaining: number
  windowStart: string
  windowEnd: string
  totalRequests: number
  totalLifetime: number
  isExpired: boolean
  expiryDate: string
  lastUsed: string
  tpm: number
  stale?: boolean
}

type Status = "ok" | "error" | "loading"

function fmtTokens(n: number) {
  return n.toLocaleString("en-US")
}

function fmtShort(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K"
  return String(n)
}

const TZ_JAKARTA = "Asia/Jakarta"

/** Date + time, Indonesian, GMT+7. e.g. "11 Agt 2026, 14.30" */
function fmtDateTime(iso: string) {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso || "-"
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: TZ_JAKARTA,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d)
}

/** Date only, indonesian, GMT+7. e.g. "11 Agt 2026" */
function fmtDate(iso: string) {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso || "-"
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: TZ_JAKARTA,
    dateStyle: "medium",
  }).format(d)
}

function parseUTCish(iso: string): number {
  if (!/[zZ]$/.test(iso) && !/[+-]\d{2}:?\d{2}$/.test(iso)) {
    return new Date(iso + "Z").getTime()
  }
  return new Date(iso).getTime()
}

function daysLeft(expiryIso: string): number {
  return Math.ceil((parseUTCish(expiryIso) - Date.now()) / 86_400_000)
}

/** Today's date anchor in Jakarta time (YYYY-MM-DD), not UTC. */
function todayJakarta() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ_JAKARTA,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
}

export default function App() {
  const { theme, toggle } = useTheme()
  const [appName, setAppName] = useState("LLM Quota")
  const [data, setData] = useState<QuotaData | null>(null)
  const [history, setHistory] = useState<HistoryDay[]>([])
  const [status, setStatus] = useState<Status>("loading")
  const [error, setError] = useState("")
  const [hoverDate, setHoverDate] = useState<string | null>(null)
  const [pinDate, setPinDate] = useState<string | null>(null)
  const chartRef = useRef<HTMLDivElement>(null)

  // Close pinned tooltip on outside tap/click (mouse + touch).
  useEffect(() => {
    if (!pinDate) return
    function onPointerDown(e: PointerEvent) {
      if (!chartRef.current?.contains(e.target as Node)) {
        setPinDate(null)
        setHoverDate(null)
      }
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [pinDate])

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/config")
      if (!res.ok) return
      const json = await res.json()
      if (json.appName) setAppName(json.appName)
    } catch {
      /* title is cosmetic; fall back to default */
    }
  }, [])

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/history")
      if (!res.ok) return
      setHistory(await res.json())
    } catch {
      /* chart is optional; don't fail the page on it */
    }
  }, [])

  const checkQuota = useCallback(async () => {
    setStatus("loading")
    setError("")
    try {
      const res = await fetch("/api/stats")
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setData(json)
      setStatus("ok")
    } catch (err) {
      setStatus("error")
      setError(err instanceof Error ? err.message : "Failed to load data")
    }
  }, [])

  useEffect(() => {
    loadConfig()
    checkQuota()
    loadHistory()
    const id = setInterval(() => {
      checkQuota()
      loadHistory()
    }, 60000)
    return () => clearInterval(id)
  }, [checkQuota, loadHistory, loadConfig])

  const pct = data && data.limit > 0 ? (data.used / data.limit) * 100 : 0
  const pctFixed = pct.toFixed(2)
  const pctInt = pctFixed.slice(0, -3)
  const pctDec = pctFixed.slice(-2)
  // Quota exhausted: no tokens left in this window — replenish at window end.
  const isExhausted = !!data && data.limit > 0 && data.remaining <= 0
  // Tier model mirrors ResetWindowBar: low (<70) / mid (70-89) / high (>=90).
  const tier = pct >= 90 ? "high" : pct >= 70 ? "mid" : "low"
  const quotaIndicatorClass =
    tier === "high"
      ? "quota-tier-high quota-tier-high-glow"
      : tier === "mid"
        ? "quota-tier-mid"
        : "quota-tier-low"
  const pctColor =
    tier === "high"
      ? "text-tier-high"
      : tier === "mid"
        ? "text-tier-mid"
        : "text-tier-low"

  const today = todayJakarta()
  const todayTokens = history.find(d => d.log_date === today)?.tokens_used ?? 0
  const max = Math.max(1, ...history.map(d => d.tokens_used))

  // Chart geometry in percent units. `y` is the SVG y (0 = top); `h` is the
  // height above baseline used by the HTML dot layer. x sits at hit-target
  // centers ((i + 0.5) / n) so dots align exactly with the button columns.
  const points = useMemo(
    () =>
      history.map((d, i) => {
        const h = Math.max((d.tokens_used / max) * 100, 1.5)
        return {
          log_date: d.log_date,
          x: ((i + 0.5) / history.length) * 100,
          y: 100 - h,
          h,
        }
      }),
    [history, max],
  )
  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ")
  const areaPath =
    points.length > 1
      ? `${linePath} L${points[points.length - 1].x} 100 L${points[0].x} 100 Z`
      : ""

  const statusDotColor: string =
    status === "ok"
      ? "bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.5)]"
      : status === "error"
        ? "bg-red-400 shadow-[0_0_4px_rgba(248,113,113,0.5)]"
        : "bg-amber-400 shadow-[0_0_4px_rgba(251,191,36,0.5)] animate-pulse"

  let subValue: ReactNode = "-"
  let subValueClass = ""
  let subBadge: ReactNode = null
  if (data) {
    if (data.isExpired) {
      subValue = "Expired"
      subValueClass = "text-tier-high"
    } else if (data.expiryDate) {
      const d = daysLeft(data.expiryDate)
      subValue = fmtDate(data.expiryDate)
      if (Number.isNaN(d)) {
        subBadge = null
      } else {
        if (d <= 3) subValueClass = "text-tier-high"
        const badgeText = d <= 0 ? "Ends today" : d === 1 ? "1 day left" : `${d} days left`
        const badgeClass =
          d <= 3
            ? "text-tier-high"
            : d <= 7
              ? "text-amber-600 dark:text-amber-400"
              : "text-card-foreground/75"
        subBadge = (
          <span
            className={cn(
              "eyebrow glass-pill inline-flex items-center gap-1 rounded-full px-2 py-0.5",
              badgeClass,
            )}
          >
            {badgeText}
          </span>
        )
      }
    }
  }

  return (
    <>
      <div className="mesh-orbs" aria-hidden />
      <div className="grain" aria-hidden />
      <main
        className="relative z-10 mx-auto flex min-h-[100dvh] w-full max-w-md flex-col gap-3 px-4 py-4 sm:max-w-2xl sm:gap-4"
        style={{
          paddingTop: "max(1rem, env(safe-area-inset-top))",
          paddingBottom: "max(1rem, env(safe-area-inset-bottom))",
        }}
      >
        {/* Floating glass pill nav */}
        <nav className="spring mx-auto flex w-full max-w-3xl items-center justify-between gap-3 rounded-full border border-black/10 bg-black/5 px-3 py-1.5 backdrop-blur-2xl dark:border-white/10 dark:bg-white/5 sm:px-4">
          <div className="flex min-w-0 items-center gap-2.5 pl-1">
            <span
              className={cn("relative inline-block size-2 shrink-0 rounded-full", statusDotColor)}
            />
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium tracking-tight text-foreground">{appName}</span>
              <span className="truncate text-[10px] text-muted-foreground">Auto-refresh 60s</span>
            </div>
            {data && (
              <span className="hidden truncate text-xs text-muted-foreground sm:inline">· {data.model}</span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={toggle}
              aria-label="Toggle theme"
              className="spring flex size-8 items-center justify-center rounded-full text-foreground/70 hover:bg-foreground/10 hover:text-foreground active:scale-[0.96]"
            >
              {theme === "dark" ? (
                <Sun size={18} weight="thin" />
              ) : (
                <MoonStars size={18} weight="thin" />
              )}
            </button>
            <button
              onClick={checkQuota}
              disabled={status === "loading"}
              className="group spring flex items-center gap-2 rounded-full bg-white py-2 pl-4 pr-1.5 text-sm font-medium text-black hover:bg-white/90 active:scale-[0.98] disabled:opacity-50"
            >
              <span>Refresh</span>
              <span className="flex size-6 items-center justify-center rounded-full bg-black/10 transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:scale-105">
                <ArrowClockwise
                  size={14}
                  weight="thin"
                  className={cn(status === "loading" && "animate-spin")}
                />
              </span>
            </button>
          </div>
        </nav>

        {/* Hero quota card */}
        <GlassCard revealDelay={0} innerClassName="p-4 sm:p-6">
          {data ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="eyebrow glass-pill inline-block rounded-full px-2.5 py-1 text-card-foreground/75">
                  Quota
                </span>
                {isExhausted && (
                  <span className="eyebrow glass-pill inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2.5 py-1 text-tier-high">
                    <Fire size={12} weight="thin" />
                    Exhausted
                  </span>
                )}
                {data.stale && (
                  <span className="eyebrow glass-pill inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-1 text-amber-600 dark:text-amber-400">
                    <Warning size={12} weight="thin" />
                    Upstream down, using cache
                  </span>
                )}
              </div>
              <p
                className={cn(
                  "mt-3 text-4xl font-bold tracking-tight tabular-nums text-card-foreground sm:text-5xl",
                  pctColor,
                )}
              >
                {pctInt}
                <span className="text-2xl text-card-foreground/50 sm:text-3xl">
                  .{pctDec}%
                </span>
              </p>

              <div className="quota-bar relative mt-4">
                <Progress value={Math.min(pct, 100)} indicatorClassName={quotaIndicatorClass}>
                  <span className="sr-only">Tokens used: {pctFixed}%</span>
                </Progress>
              </div>
              <div className="mt-2 flex items-center justify-between text-sm">
                <span className="text-card-foreground/70">
                  Used{" "}
                  <span className="font-semibold tabular-nums">{fmtTokens(data.used)}</span> /{" "}
                  {fmtTokens(data.limit)}
                </span>
                <span className="font-medium tabular-nums text-card-foreground/70">
                  {fmtTokens(data.remaining)} remaining
                </span>
              </div>
            </>
          ) : error ? (
            <div className="flex min-h-[120px] flex-col items-center justify-center gap-3">
              <p className="text-sm text-card-foreground/70">{error}</p>
              <button
                onClick={checkQuota}
                className="spring rounded-full px-4 py-1.5 text-sm font-medium text-foreground/70 hover:bg-foreground/10 hover:text-foreground active:scale-[0.96]"
              >
                Retry
              </button>
            </div>
          ) : (
            <div className="flex min-h-[120px] flex-col justify-center gap-3">
              <span className="skeleton h-5 w-16 rounded-full" />
              <span className="skeleton h-9 w-24 rounded-md" />
              <span className="skeleton h-5 w-full rounded" />
              <span className="sr-only">Loading</span>
            </div>
          )}
        </GlassCard>

        {/* Bento grid */}
        {data && (
          <div className="grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-8 md:gap-4">
            {/* Subscription — expiry with urgency states */}
            <StatTile
              className="col-span-2 md:col-span-3"
              revealDelay={120}
              label="Subscription"
              icon={<CalendarBlank size={16} weight="thin" />}
              value={subValue}
              valueClassName={subValueClass || undefined}
              badge={subBadge}
            />

            {/* Reset window — beside subscription */}
            <div className="col-span-2 md:col-span-5">
              <ResetWindowBar windowStart={data.windowStart} windowEnd={data.windowEnd} exhausted={isExhausted} />
            </div>

            {/* Last used — wide, with Today sub-badge */}
            <StatTile
              className="col-span-2 md:col-span-4"
              revealDelay={160}
              label="Last used"
              icon={<Clock size={16} weight="thin" />}
              value={data.lastUsed ? fmtDateTime(data.lastUsed) : "-"}
              badge={
                <span className="eyebrow glass-pill inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-card-foreground/75">
                  <Coins size={11} weight="thin" />
                  {fmtTokens(todayTokens)} today
                </span>
              }
            />

            {/* Tokens/min — wide, with Requests sub-badge */}
            <StatTile
              className="col-span-2 md:col-span-4"
              revealDelay={200}
              label="Tokens/min"
              icon={<Gauge size={16} weight="thin" />}
              value={fmtShort(data.tpm)}
              badge={
                <span className="eyebrow glass-pill inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-card-foreground/75">
                  <Hash size={11} weight="thin" />
                  {fmtTokens(data.totalRequests)} req
                </span>
              }
            />

            {/* 30-day chart */}
            <GlassCard className="col-span-2 md:col-span-8" revealDelay={240} innerClassName="p-3 sm:p-6">
              <div className="flex items-baseline justify-between">
                <p className="eyebrow text-card-foreground/65">Daily usage</p>
                <p className="text-xs text-card-foreground/70 sm:text-sm">30 days</p>
              </div>
              <div
                ref={chartRef}
                className="relative mt-3 h-20 sm:mt-4 sm:h-28"
                onMouseLeave={() => setHoverDate(null)}
              >
                {history.length === 0 ? (
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
                        const isOpen = hoverDate === p.log_date || pinDate === p.log_date
                        return (
                          <span key={p.log_date}>
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
                                  : p.log_date === today
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
                      {history.map((d, i) => {
                        const isOpen = hoverDate === d.log_date || pinDate === d.log_date
                        return (
                          <button
                            key={d.log_date}
                            type="button"
                            className="relative h-full flex-1 cursor-pointer outline-none"
                            onMouseEnter={() => setHoverDate(d.log_date)}
                            onMouseLeave={() => setHoverDate(null)}
                            onFocus={() => setHoverDate(d.log_date)}
                            onBlur={() => setHoverDate(null)}
                            onClick={() => setPinDate(p => (p === d.log_date ? null : d.log_date))}
                            aria-label={`${fmtDate(d.log_date)}, ${fmtShort(d.tokens_used)} tokens, ${fmtTokens(d.requests)} requests`}
                          >
                            <span
                              role="tooltip"
                              className={cn(
                                "pointer-events-none absolute bottom-full z-50 mb-1.5 whitespace-nowrap rounded-lg bg-popover px-2 py-1 text-xs font-medium text-popover-foreground shadow-lg ring-1 ring-card-foreground/10 backdrop-blur transition-opacity duration-100",
                                isOpen ? "opacity-100" : "opacity-0",
                                i === 0
                                  ? "left-0"
                                  : i === history.length - 1
                                    ? "right-0"
                                    : "left-1/2 -translate-x-1/2",
                              )}
                            >
                              <span className="block">{fmtDate(d.log_date)}</span>
                              <span className="block">
                                {fmtShort(d.tokens_used)} tokens · {fmtTokens(d.requests)} req
                              </span>
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </>
                )}
              </div>
            </GlassCard>
          </div>
        )}
      </main>
    </>
  )
}
