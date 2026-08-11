import * as React from "react"

import { cn } from "@/lib/utils"
import { GlassCard } from "@/components/ui/glass-card"

interface StatTileProps {
  label: string
  value: React.ReactNode
  hint?: string
  badge?: React.ReactNode
  icon?: React.ReactNode
  className?: string
  valueClassName?: string
  size?: "default" | "sm"
  revealDelay?: number
}

export function StatTile({
  label,
  value,
  hint,
  badge,
  icon,
  className,
  valueClassName,
  size = "default",
  revealDelay,
}: StatTileProps) {
  return (
    <GlassCard size={size} className={className} revealDelay={revealDelay} title={hint}>
      <div className="flex items-center justify-between gap-2 px-3 py-2.5 sm:px-4 sm:py-3">
        <div className="min-w-0">
          <p className="eyebrow text-card-foreground/55">{label}</p>
          <p
            className={cn(
              "mt-1.5 break-words text-sm font-semibold tracking-tight text-card-foreground tabular-nums sm:text-lg",
              valueClassName
            )}
          >
            {value}
          </p>
          {badge ? <div className="mt-1.5">{badge}</div> : null}
        </div>
        {icon ? (
          <span className="shrink-0 rounded-full bg-card-foreground/10 p-1.5 text-card-foreground/70 ring-1 ring-card-foreground/10">
            {icon}
          </span>
        ) : null}
      </div>
    </GlassCard>
  )
}
