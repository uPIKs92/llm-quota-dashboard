import * as React from "react"

import { cn } from "@/lib/utils"
import { useReveal } from "@/hooks/use-reveal"

interface GlassCardProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: "default" | "sm"
  innerClassName?: string
  revealDelay?: number
  as?: "div" | "section" | "article"
}

export function GlassCard({
  as = "div",
  size = "default",
  innerClassName,
  revealDelay,
  className,
  style,
  children,
  ...props
}: GlassCardProps) {
  const reveal = useReveal<HTMLDivElement>()
  // Widen to ElementType so a union of intrinsic tags resolves to lenient props
  // (avoids invariant ref typing across tag kinds).
  const Tag: React.ElementType = as

  const revealStyle =
    revealDelay !== undefined
      ? ({ "--reveal-delay": `${revealDelay}ms`, ...style } as React.CSSProperties)
      : style

  return (
    <Tag
      ref={reveal.ref}
      data-slot="glass-card"
      data-revealed={revealDelay !== undefined ? (reveal.visible ? "true" : "false") : undefined}
      className={cn(
        "bezel-shell spring",
        size === "sm" && "bezel-shell-sm",
        revealDelay !== undefined && "reveal",
        className
      )}
      style={revealStyle}
      {...props}
    >
      <div className={cn("bezel-core", size === "sm" && "bezel-core-sm", innerClassName)}>
        {children}
      </div>
    </Tag>
  )
}
