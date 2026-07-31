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
import { useTheme } from "./theme"
import { Moon, Sun } from "lucide-react"

interface QuotaData {
  name: string
  model: string
  token_limit_per_5h: number
  expiry_date: string
  last_used: string
  total_requests: number
  is_expired: boolean
  current_usage: {
    tokens_used_in_current_window: number
    window_ends_at: string
    remaining_tokens: number
  }
}

type Status = "ok" | "error" | "loading"

function fmtTokens(n: number) {
  return n.toLocaleString("id-ID")
}

function countdown(iso: string) {
  const diff = new Date(iso).getTime() - Date.now()
  if (diff <= 0) return "00:00:00"
  const h = Math.floor(diff / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  const s = Math.floor((diff % 60000) / 1000)
  return [h, m, s].map(n => String(n).padStart(2, "0")).join(":")
}

export default function App() {
  const { theme, toggle } = useTheme()
  const [data, setData] = useState<QuotaData | null>(null)
  const [status, setStatus] = useState<Status>("loading")
  const [error, setError] = useState("")

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
      setError(err instanceof Error ? err.message : "Gagal memuat data")
    }
  }, [])

  useEffect(() => {
    checkQuota()
    const id = setInterval(checkQuota, 60000)
    return () => clearInterval(id)
  }, [checkQuota])

  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const pct = data
    ? (data.current_usage.tokens_used_in_current_window / data.token_limit_per_5h) * 100
    : 0
  const barColor = pct >= 90 ? "bg-red-500" : pct >= 60 ? "bg-amber-500" : "bg-emerald-500"
  const badgeVariant =
    status === "ok" ? "default" : status === "error" ? "destructive" : "secondary"

  return (
    <main className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="text-xl">GLM Quota</CardTitle>
            <CardDescription>
              {data
                ? `${data.name} · ${data.model}`
                : status === "error"
                  ? "Gagal memuat"
                  : "Memuat…"}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={badgeVariant}>
              {status === "loading" ? "Mengecek…" : status === "ok" ? "OK" : "Gagal"}
            </Badge>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={toggle}
              aria-label={theme === "dark" ? "Mode terang" : "Mode gelap"}
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          {data ? (
            <>
              <div className="flex flex-col gap-2">
                <Progress
                  value={Math.min(pct, 100)}
                  className="h-3.5"
                  indicatorClassName={barColor}
                >
                  <span className="sr-only">Sisa token: {pct.toFixed(0)}%</span>
                </Progress>
                <div className="flex justify-between text-sm text-muted-foreground">
                  <span>
                    {fmtTokens(data.current_usage.tokens_used_in_current_window)} /{" "}
                    {fmtTokens(data.token_limit_per_5h)} token terpakai
                  </span>
                  <span className="font-medium text-foreground">
                    {fmtTokens(data.current_usage.remaining_tokens)} sisa
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg bg-muted/50 p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Reset window
                  </p>
                  <p className="mt-1 font-semibold tabular-nums whitespace-nowrap">
                    {countdown(data.current_usage.window_ends_at)}
                  </p>
                </div>
                <div className="rounded-lg bg-muted/50 p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Expired
                  </p>
                  <p className="mt-1 font-semibold">
                    {data.is_expired
                      ? "Ya"
                      : new Date(data.expiry_date).toLocaleDateString("id-ID")}
                  </p>
                </div>
                <div className="rounded-lg bg-muted/50 p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Total requests
                  </p>
                  <p className="mt-1 font-semibold">{fmtTokens(data.total_requests)}</p>
                </div>
                <div className="rounded-lg bg-muted/50 p-3">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Last used
                  </p>
                  <p className="mt-1 font-semibold">
                    {new Date(data.last_used).toLocaleString("id-ID")}
                  </p>
                </div>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{error || "Mengambil data…"}</p>
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
