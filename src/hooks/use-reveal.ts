import { useEffect, useRef, useState } from "react"

interface RevealOptions {
  threshold?: number
  rootMargin?: string
  once?: boolean
}

export function useReveal<T extends HTMLElement = HTMLDivElement>(opts: RevealOptions = {}) {
  const ref = useRef<T>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true)
          if (opts.once !== false) observer.disconnect()
        }
      },
      { threshold: opts.threshold ?? 0.15, rootMargin: opts.rootMargin ?? "0px 0px -10% 0px" }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [opts.threshold, opts.rootMargin, opts.once])
  return { ref, visible }
}

export function useRevealAttr<T extends HTMLElement = HTMLDivElement>(opts: RevealOptions = {}) {
  const { ref, visible } = useReveal<T>(opts)
  return {
    ref,
    "data-revealed": visible ? "true" : "false",
    className: "reveal",
  }
}
