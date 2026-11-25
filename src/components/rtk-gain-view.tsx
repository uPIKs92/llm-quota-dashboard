import { useCallback, useEffect, useMemo, useState } from "react"
import { ArrowDown, ArrowUp, CalendarBlank, Fire, Leaf, Terminal, Warning } from "@phosphor-icons/react"

import { GlassCard } from "@/components/ui/glass-card"
import { Progress } from "@/components/ui/progress"
import { StatTile } from "@/components/ui/stat-tile"
import { TrendChart, type TrendPoint, type TrendTick } from "@/components/trend-chart"
import { cn } from "@/lib/utils"

/* ------------------------------ API shapes ------------------------------ */

interface RtkMetrics {
  commands: number
  inputTokens: number
  outputTokens: number
  savedTokens: number
  savingsPct: number
}
interface RtkDaily extends RtkMetrics {
  date: string
}
interface RtkWeekly extends RtkMetrics {
  weekStart: string
  weekEnd: string | null
}
interface RtkMonthly extends RtkMetrics {
  month: string
}
interface RtkSummary {
  totalCommands: number
  totalInput: number
  totalOutput: number
  totalSaved: number
  avgSavingsPct: number
}
interface RtkData {
  host?: string
  empty?: boolean
  stale?: boolean
  fetchedAt?: string
  summary?: RtkSummary
  daily?: RtkDaily[]
  weekly?: RtkWeekly[]
  monthly?: RtkMonthly[]
}
interface RtkHost {
  id: string
  label: string
  source: "local" | "ssh"
  empty: boolean
  stale: boolean
  fetchedAt: string | null
}

type Status = "ok" | "error" | "loading"
type Mode = "daily" | "weekly" | "monthly"

const MODES: Mode[] = ["daily", "weekly", "monthly"]
const MODE_LABEL: Record<Mode, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" }
const DAILY_POINTS = 90
const TZ_JAKARTA = "Asia/Jakarta"

/* ------------------------------- formatting ------------------------------ */

function fmtTokens(n: number) {
  return n.toLocaleString("en-US")
}

function fmtShort(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K"
  return String(n)
}

/** "YYYY-MM-DD" or "YYYY-MM" as a UTC instant; Jakarta display keeps the same calendar day. */
function bucketDate(key: string) {
  return new Date(key.length === 7 ? `${key}-01T00:00:00Z` : `${key}T00:00:00Z`)
}

function fmtDayMonth(key: string) {
  return new Intl.DateTimeFormat("id-ID", { timeZone: TZ_JAKARTA, day: "numeric", month: "short" }).format(bucketDate(key))
}

function fmtDayMonthYear(key: string) {
  return new Intl.DateTimeFormat("id-ID", { timeZone: TZ_JAKARTA, dateStyle: "medium" }).format(bucketDate(key))
}

function fmtMonthYear(key: string) {
  return new Intl.DateTimeFormat("id-ID", { timeZone: TZ_JAKARTA, month: "short", year: "numeric" }).format(bucketDate(key))
}

function fmtMonthOnly(key: string) {
  return new Intl.DateTimeFormat("id-ID", { timeZone: TZ_JAKARTA, month: "short" }).format(bucketDate(key))
}

function fmtTime(iso: string) {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return "-"
  return new Intl.DateTimeFormat("id-ID", { timeZone: TZ_JAKARTA, hour: "2-digit", minute: "2-digit" }).format(d)
}

function bucketSub(b: RtkMetrics) {
  return `${fmtShort(b.savedTokens)} saved · ${Math.round(b.savingsPct)}% · ${fmtTokens(b.commands)} cmds`
}

function tickLabel(key: string, mode: Mode) {
  return mode === "monthly" ? fmtMonthOnly(key) : fmtDayMonth(key)
}

/* --------------------------------- view ---------------------------------- */

interface RtkGainViewProps {
  /** Bumped by the parent's Refresh button to trigger an immediate reload. */
  refreshKey: number
  onStatusChange: (status: Status) => void
}

export function RtkGainView({ refreshKey, onStatusChange }: RtkGainViewProps) {
  const [data, setData] = useState<RtkData | null>(null)
  const [status, setStatus] = useState<Status>("loading")
  const [error, setError] = useState("")
  const [mode, setMode] = useState<Mode>("daily")
  const [hosts, setHosts] = useState<RtkHost[]>([])
  const [hostId, setHostId] = useState<string | null>(null)

  const load = useCallback(async (host: string) => {
    setStatus("loading")
    setError("")
    try {
      const res = await fetch(`/api/rtk?host=${encodeURIComponent(host)}`)
      // Read as text first: a proxy or PHP failure can return a non-JSON body.
      const text = await res.text()
      let json: unknown = null
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
      if (!res.ok || json === null || typeof json !== "object") {
        const detail = text.trim().slice(0, 80)
        throw new Error(
          `API error (HTTP ${res.status})${detail && json === null ? `: ${detail}` : ""}`,
        )
      }
      setData(json as RtkData)
      setStatus("ok")
    } catch (err) {
      setStatus("error")
      setError(err instanceof Error ? err.message : "Failed to load RTK data")
    }
  }, [])

  // Host list: on mount, and again on Refresh (picks up new or stale hosts).
  const loadHosts = useCallback(async () => {
    try {
      const res = await fetch("/api/rtk/hosts")
      const json = await res.json()
      if (!res.ok || !Array.isArray(json.hosts)) throw new Error(json.error || `HTTP ${res.status}`)
      setHosts(json.hosts)
      setHostId(prev => prev ?? json.hosts[0]?.id ?? null)
    } catch (err) {
      setStatus("error")
      setError(err instanceof Error ? err.message : "Failed to load RTK hosts")
    }
  }, [])

  useEffect(() => {
    loadHosts()
  }, [loadHosts, refreshKey])

  // Data for the selected host: on selection, every 60s, and on Refresh.
  useEffect(() => {
    if (hostId === null) return
    load(hostId)
    const id = setInterval(() => load(hostId), 60000)
    return () => clearInterval(id)
  }, [hostId, load, refreshKey])

  /** Switch host; drop the previous host's numbers so they never show under the new name. */
  const selectHost = useCallback((id: string) => {
    if (id === hostId) return
    setData(null)
    setHostId(id)
  }, [hostId])

  const hostLabel = hosts.find(h => h.id === hostId)?.label ?? hostId ?? ""

  useEffect(() => {
    onStatusChange(status)
  }, [status, onStatusChange])

  const summary = data?.summary
  const latest = data?.daily?.at(-1)
  const savingsPct = summary?.avgSavingsPct ?? 0

  const savingsIndicator =
    savingsPct >= 60
      ? "bg-gradient-to-r from-emerald-400 to-emerald-600"
      : savingsPct >= 30
        ? "bg-gradient-to-r from-emerald-300 to-emerald-500"
        : "bg-gradient-to-r from-emerald-200 to-emerald-400"

  const series = useMemo<TrendPoint[]>(() => {
    if (!data || data.empty) return []
    if (mode === "daily") {
      return (data.daily ?? []).slice(-DAILY_POINTS).map(d => ({
        key: d.date,
        value: d.savedTokens,
        title: fmtDayMonthYear(d.date),
        sub: bucketSub(d),
      }))
    }
    if (mode === "weekly") {
      return (data.weekly ?? []).map(w => ({
        key: w.weekStart,
        value: w.savedTokens,
        title: w.weekEnd
          ? `${fmtDayMonth(w.weekStart)} – ${fmtDayMonthYear(w.weekEnd)}`
          : fmtDayMonthYear(w.weekStart),
        sub: bucketSub(w),
      }))
    }
    return (data.monthly ?? []).map(m => ({
      key: m.month,
      value: m.savedTokens,
      title: fmtMonthYear(m.month),
      sub: bucketSub(m),
    }))
  }, [data, mode])

  // ~6 evenly spread x labels, first and last always included (same rule as the quota chart).
  const xTicks = useMemo<TrendTick[]>(() => {
    const n = series.length
    if (n < 2) return []
    const idx = [...new Set(Array.from({ length: 6 }, (_, k) => Math.round((k * (n - 1)) / 5)))]
      .sort((a, b) => a - b)
    return idx.map((i, pos) => ({
      key: series[i].key,
      x: ((i + 0.5) / n) * 100,
      label: tickLabel(series[i].key, mode),
      edge: pos === 0 ? "left" : pos === idx.length - 1 ? "right" : "center",
    }))
  }, [series, mode])

  const emphasisKey = series.at(-1)?.key ?? null
  const stale = !!data?.stale
  const fetchedAt = data?.fetchedAt

  return (
    <>
      {hosts.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="RTK host">
          {hosts.map(h => (
            <button
              key={h.id}
              type="button"
              onClick={() => selectHost(h.id)}
              aria-pressed={hostId === h.id}
              className={cn(
                "spring eyebrow glass-pill inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 transition-colors",
                hostId === h.id
                  ? "text-card-foreground"
                  : "text-card-foreground/45 hover:text-card-foreground/80",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "size-1.5 rounded-full",
                  h.empty ? "bg-card-foreground/30" : h.stale ? "bg-amber-400" : "bg-emerald-400",
                )}
              />
              {h.label}
            </button>
          ))}
        </div>
      )}

      {/* Hero: all-time savings */}
      <GlassCard revealDelay={0} innerClassName="p-4 sm:p-6">
        {summary ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="eyebrow glass-pill inline-block rounded-full px-2.5 py-1 text-card-foreground/75">
                Savings · estimated tokens
              </span>
              {stale && (
                <span className="eyebrow glass-pill inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-1 text-amber-600 dark:text-amber-400">
                  <Warning size={12} weight="thin" />
                  Poller can't reach {hostLabel} — showing last data {fetchedAt ? fmtTime(fetchedAt) : ""}
                </span>
              )}
            </div>
            <p className="mt-3 text-4xl font-bold tracking-tight tabular-nums text-emerald-700 dark:text-emerald-300 sm:text-5xl">
              {fmtShort(summary.totalSaved)}
              <span className="text-2xl text-card-foreground/50 sm:text-3xl"> saved</span>
            </p>
            <div className="quota-bar relative mt-4">
              <Progress value={Math.min(savingsPct, 100)} indicatorClassName={savingsIndicator}>
                <span className="sr-only">Average savings: {savingsPct.toFixed(1)}%</span>
              </Progress>
            </div>
            <div className="mt-2 flex items-center justify-between gap-2 text-sm">
              <span className="text-card-foreground/70">
                <span className="font-semibold tabular-nums">{fmtShort(summary.totalSaved)}</span> of{" "}
                {fmtShort(summary.totalInput)} input tokens removed
              </span>
              <span className="font-medium tabular-nums text-card-foreground/70">{savingsPct.toFixed(1)}%</span>
            </div>
          </>
        ) : data?.empty ? (
          <div className="flex min-h-[120px] flex-col justify-center gap-2">
            <p className="text-sm text-card-foreground/70">No data yet for {hostLabel || "this host"} — the poller hasn't fetched it.</p>
          </div>
        ) : status === "error" ? (
          <div className="flex min-h-[120px] flex-col items-center justify-center gap-3">
            <p className="text-sm text-card-foreground/70">{error}</p>
            <button
              onClick={() => hostId !== null && load(hostId)}
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

      {summary && (
        <div className="grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-8 md:gap-4">
          <StatTile
            className="col-span-2 md:col-span-2"
            revealDelay={120}
            label="Commands"
            icon={<Terminal size={16} weight="thin" />}
            value={fmtTokens(summary.totalCommands)}
          />
          <StatTile
            className="col-span-1 md:col-span-2"
            revealDelay={160}
            label="Input est."
            icon={<ArrowDown size={16} weight="thin" />}
            value={fmtShort(summary.totalInput)}
          />
          <StatTile
            className="col-span-1 md:col-span-2"
            revealDelay={200}
            label="Output est."
            icon={<ArrowUp size={16} weight="thin" />}
            value={fmtShort(summary.totalOutput)}
          />
          <StatTile
            className="col-span-2 md:col-span-2"
            revealDelay={240}
            label="Today"
            icon={<CalendarBlank size={16} weight="thin" />}
            value={latest ? `${fmtShort(latest.savedTokens)} saved` : "-"}
            badge={
              latest ? (
                <span className="eyebrow glass-pill inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-emerald-700 dark:text-emerald-300">
                  <Leaf size={11} weight="thin" />
                  {Math.round(latest.savingsPct)}% saved
                </span>
              ) : null
            }
          />

          {data && !data.empty && (
        <GlassCard className="col-span-2 md:col-span-8" revealDelay={280} innerClassName="p-3 sm:p-6">
          <div className="flex items-center justify-between gap-2">
            <p className="eyebrow text-card-foreground/65">Tokens saved</p>
            <div className="flex items-center gap-1" role="group" aria-label="Chart range">
              {MODES.map(m => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  aria-pressed={mode === m}
                  className={cn(
                    "spring eyebrow glass-pill rounded-full px-2.5 py-1 transition-colors",
                    mode === m
                      ? "text-card-foreground"
                      : "text-card-foreground/45 hover:text-card-foreground/80",
                  )}
                >
                  {MODE_LABEL[m]}
                </button>
              ))}
            </div>
          </div>
          {/* Remount on range change so hover/pin state never survives the switch. */}
          <TrendChart key={mode} series={series} emphasisKey={emphasisKey} xTicks={xTicks} />
        </GlassCard>
          )}
        </div>
      )}

      {data && !data.empty && (
        <p className="px-1 text-[10px] text-card-foreground/55">
          Tokens estimated as bytes/4 · {hostLabel || "rtk"} via DB
          {fetchedAt ? ` · fetched ${fmtTime(fetchedAt)}` : ""}
        </p>
      )}
      {status === "error" && data && (
        <p className="flex items-center gap-1 px-1 text-[10px] text-tier-high">
          <Fire size={10} weight="thin" /> Refresh failed: {error}
        </p>
      )}
    </>
  )
}
