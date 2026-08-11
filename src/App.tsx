import { useCallback, useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { ResetWindowBar } from "@/components/reset-window-bar"
import { cn } from "@/lib/utils"
import { useTheme } from "./theme"
import { Moon, Sun } from "lucide-react"

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

  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

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
  const badgeVariant =
    status === "ok" ? "default" : status === "error" ? "destructive" : "secondary"

  const today = new Date().toISOString().slice(0, 10)
  const todayTokens =
    history.find(d => d.log_date === today)?.tokens_used ?? 0
  const max = Math.max(1, ...history.map(d => d.tokens_used))

  return (
    <main className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="text-xl">{appName}</CardTitle>
            <CardDescription>
              {data
                ? `${data.name} · ${data.model}`
                : status === "error"
                  ? "Failed to load"
                  : "Loading…"}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={badgeVariant}>
              {status === "loading" ? "Checking…" : status === "ok" ? "OK" : "Failed"}
            </Badge>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={toggle}
              aria-label={theme === "dark" ? "Light mode" : "Dark mode"}
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          {data ? (
            <>
              <div className="flex flex-col gap-2">
                <div className="quota-bar relative">
                  <Progress
                    value={Math.min(pct, 100)}
                    indicatorClassName={quotaIndicatorClass}
                  >
                    <span className="sr-only">Tokens used: {pct.toFixed(0)}%</span>
                  </Progress>
                  <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs font-bold tabular-nums text-white mix-blend-difference">
                    {pct.toFixed(0)}% used
                  </span>
                </div>
                <div className="flex justify-between text-sm text-muted-foreground">
                  <span>
                    {fmtTokens(data.used)} /{" "}
                    {fmtTokens(data.limit)} tokens ·{" "}
                    <span className={cn("font-semibold tabular-nums", pctColor)}>
                      {pct.toFixed(0)}%
                    </span>
                  </span>
                  <span className="font-medium text-foreground">
                    {fmtTokens(data.remaining)} left
                  </span>
                </div>
              </div>

              <ResetWindowBar
                windowStart={data.windowStart}
                windowEnd={data.windowEnd}
              />

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg bg-muted/50 p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Expires
                  </p>
                  <p className="mt-1 font-semibold">
                    {data.isExpired
                      ? "Yes"
                      : data.expiryDate
                        ? new Date(data.expiryDate).toLocaleDateString("en-US")
                        : "—"}
                  </p>
                </div>
                <div className="rounded-lg bg-muted/50 p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Total requests
                  </p>
                  <p className="mt-1 font-semibold">{fmtTokens(data.totalRequests)}</p>
                </div>
                <div className="rounded-lg bg-muted/50 p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Used today
                  </p>
                  <p className="mt-1 font-semibold tabular-nums">
                    {fmtTokens(todayTokens)} tokens
                  </p>
                </div>
                <div className="rounded-lg bg-muted/50 p-3" title="last 60s">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Tokens/min
                  </p>
                  <p className="mt-1 font-semibold tabular-nums">
                    {fmtShort(data.tpm)} tokens
                  </p>
                </div>
                <div className="rounded-lg bg-muted/50 p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Last used
                  </p>
                  <p className="mt-1 font-semibold">
                    {data.lastUsed ? new Date(data.lastUsed).toLocaleString("en-US") : "—"}
                  </p>
                </div>
              </div>

              <div className="rounded-lg bg-muted/50 p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Daily usage (30 days)
                </p>
                <div className="mt-3 flex h-28 items-end gap-0.5">
                  {history.length === 0 ? (
                    <span className="text-xs text-muted-foreground">
                      No data yet
                    </span>
                  ) : (
                    history.map(d => (
                      <div key={d.log_date} className="flex h-full flex-1 flex-col items-center gap-1">
                        <div className="flex w-full flex-1 items-end">
                          <div
                            className={`w-full rounded-t ${d.log_date === today ? "bg-primary" : "bg-muted-foreground/40"} `}
                            style={{ height: `${Math.max((d.tokens_used / max) * 100, 4)}%` }}
                            title={`${new Date(d.log_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · ${fmtShort(d.tokens_used)} tokens · ${fmtTokens(d.requests)} req`}
                          />
                        </div>
                        <span className="text-[10px] text-muted-foreground">
                          {new Date(d.log_date).toLocaleDateString("en-US", { weekday: "short" })}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{error || "Fetching data…"}</p>
          )}
        </CardContent>

        <CardFooter>
          <Button
            variant="outline"
            className="w-full"
            onClick={checkQuota}
            disabled={status === "loading"}
          >
            Refresh
          </Button>
        </CardFooter>
      </Card>
    </main>
  )
}
