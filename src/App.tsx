import { useCallback, useEffect, useState } from "react"
import {
  ArrowClockwise,
  CalendarBlank,
  Clock,
  Coins,
  Gauge,
  Hash,
  MoonStars,
  Sun,
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
  if (isNaN(d.getTime())) return iso || "—"
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: TZ_JAKARTA,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d)
}

/** Date only, indonesian, GMT+7. e.g. "11 Agt 2026" */
function fmtDate(iso: string) {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso || "—"
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: TZ_JAKARTA,
    dateStyle: "medium",
  }).format(d)
}

/** Short weekday, indonesian. e.g. "Sen" */
function fmtWeekday(iso: string) {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ""
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: TZ_JAKARTA,
    weekday: "short",
  }).format(d)
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

  const statusDotColor: string =
    status === "ok"
      ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]"
      : status === "error"
        ? "bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.8)]"
        : "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.8)] animate-pulse"

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
                <span className="eyebrow glass-pill inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-card-foreground/75">
                  <CalendarBlank size={12} weight="thin" />
                  {data.isExpired ? "Expired" : fmtDate(data.expiryDate)}
                </span>
              </div>
              <p
                className={cn(
                  "mt-3 text-4xl font-bold tracking-tight tabular-nums text-card-foreground sm:text-5xl",
                  pctColor,
                )}
              >
                {pct.toFixed(0)}
                <span className="text-2xl text-card-foreground/50 sm:text-3xl">%</span>
              </p>
              <p className="mt-1.5 text-sm text-card-foreground/60">
                {fmtTokens(data.used)} / {fmtTokens(data.limit)} tokens
              </p>

              <div className="quota-bar relative mt-4">
                <Progress value={Math.min(pct, 100)} indicatorClassName={quotaIndicatorClass}>
                  <span className="sr-only">Tokens used: {pct.toFixed(0)}%</span>
                </Progress>
              </div>
              <div className="mt-2 flex items-center justify-between text-sm">
                <span className="text-card-foreground/65">
                  Used{" "}
                  <span className={cn("font-semibold tabular-nums", pctColor)}>
                    {pct.toFixed(0)}%
                  </span>
                </span>
                <span className="font-medium tabular-nums text-card-foreground/65">
                  {fmtTokens(data.remaining)} remaining
                </span>
              </div>
            </>
          ) : (
            <div className="flex min-h-[120px] items-center justify-center">
              <p className="text-sm text-card-foreground/50">{error || "Fetching data…"}</p>
            </div>
          )}
        </GlassCard>

        {/* Bento grid */}
        {data && (
          <div className="grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-8 md:gap-4">
            {/* Reset window — full width */}
            <div className="col-span-2 md:col-span-8">
              <ResetWindowBar windowStart={data.windowStart} windowEnd={data.windowEnd} />
            </div>

            {/* Last used — wide, with Today sub-badge */}
            <StatTile
              className="col-span-2 md:col-span-8"
              revealDelay={160}
              label="Last used"
              icon={<Clock size={16} weight="thin" />}
              value={data.lastUsed ? fmtDateTime(data.lastUsed) : "—"}
              badge={
                <span className="eyebrow glass-pill inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-card-foreground/75">
                  <Coins size={11} weight="thin" />
                  {fmtTokens(todayTokens)} today
                </span>
              }
            />

            {/* Tokens/min — wide, with Requests sub-badge */}
            <StatTile
              className="col-span-2 md:col-span-8"
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
                <p className="eyebrow text-card-foreground/55">Daily usage</p>
                <p className="text-xs text-card-foreground/60 sm:text-sm">30 days</p>
              </div>
              <div className="mt-3 flex h-16 items-end gap-1 sm:mt-4 sm:h-24 sm:gap-1.5">
                {history.length === 0 ? (
                  <span className="text-sm text-card-foreground/50">No data yet</span>
                ) : (
                  history.map(d => (
                    <div key={d.log_date} className="flex h-full flex-1 flex-col items-center gap-1">
                      <div className="flex w-full flex-1 items-end">
                        <div
                          className={cn(
                            "w-full rounded-full",
                            d.log_date === today ? "bg-card-foreground" : "bg-card-foreground/25",
                          )}
                          style={{
                            height: `${Math.max((d.tokens_used / max) * 100, 4)}%`,
                          }}
                          title={`${fmtDate(d.log_date)} · ${fmtShort(d.tokens_used)} tokens · ${fmtTokens(d.requests)} req`}
                        />
                      </div>
                      <span className="hidden text-[10px] text-card-foreground/50 sm:inline">
                        {fmtWeekday(d.log_date)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </GlassCard>
          </div>
        )}
      </main>
    </>
  )
}
