# Spec: Compact iPhone Layout + Glass Gradient Badges

## Objective

Rework the existing iOS liquid-glass dashboard so the entire UI fits within one
viewport on a first-generation iPhone logical resolution (390 × 844 CSS px,
Safari + PWA), with **no vertical scroll**. Preserve the liquid-glass aesthetic
(bezel-shell / bezel-core, mesh orbs, film grain, reveal animations). Keep the
theme switcher fully functional. Add gradient backgrounds + inset highlight rings
to badge/pill labels so they read as real frosted glass instead of flat tints.

**User:** operator monitoring LLM API quota from a phone.
**Success:** at 390 × 844 dvh, all primary content visible without scrolling;
theme toggle still works in both directions; badges show layered glass.

## Tech Stack

- React 19 + TypeScript
- Vite 8
- Tailwind CSS v4 (no `tailwind.config.js` — theme tokens live in `src/index.css`
  under `@theme inline` and `:root` / `.dark`)
- Base UI (`@base-ui/react`) — `useRender`, `mergeProps`
- Phosphor Icons
- No new dependencies this change.

## Commands

```
Build:  npm run build       # tsc -b && vite build
Dev:    npm run dev          # vite
Lint:   npm run lint         # oxlint
Preview npm run preview      # vite preview
```

No test framework present in this repo. Verification = build + manual browser
screenshot at 390 × 844 (dark + light).

## Project Structure

```
index.html                              → viewport meta (already viewport-fit=cover)
src/
  App.tsx                               → page composition, hero, bento grid
  theme.tsx                             → ThemeProvider + useTheme (untouched)
  index.css                             → tokens, bezel system, glass utilities
  components/
    reset-window-bar.tsx                → countdown hero bar
    ui/
      glass-card.tsx                    → double-bezel wrapper
      stat-tile.tsx                     → label/value/icon tile
      badge.tsx                         → (shadcn Badge, currently unused on page)
  hooks/
    use-reveal.ts                       → IntersectionObserver reveal
```

## Current Layout Budget vs Target (390 × 844, ~760 usable px)

| Section               | Now (px) | Target (px) |
|-----------------------|---------:|------------:|
| main padding          | 64       | 32          |
| nav pill              | 52       | 48          |
| hero quota card       | ~280     | ~150        |
| reset bar             | 96       | 72 (row 1L) |
| remaining dial        | 180      | 72 (row 1R) |
| 5 stat tiles stacked  | 450      | 2×64 = 128  |
| 30-day chart          | 180      | 90          |
| footer line           | 16       | 0 (folded)  |
| gaps (8 × ~12)        | 96       | 56          |
| **Total**             | **~1414**| **~648**    |

Target ≤ 760. Margin ≈ 110 px for notch safe-area.

## Code Style

- Functional components, named exports.
- `cn()` from `@/lib/utils` for class merging.
- Density via Tailwind responsive prefixes (`sm:`, `md:`), not JS branching.
- Reusable visual classes live in `src/index.css` (e.g. `.bezel-shell`,
  `.eyebrow`). New pattern → new CSS class, not inline duplication.
- No inline `style` objects for static looks (only dynamic values like
  `--reveal-delay`, bar widths).
- Keep `data-*` hooks (`data-revealed`, `data-slot`) intact — observability
  + animation triggers depend on them.

## Changes

### 1. Container density — `src/App.tsx:141`

```diff
- <main className="... max-w-5xl ... gap-6 px-4 py-8 sm:gap-8 sm:px-6 sm:py-12">
+ <main
+   className="... max-w-md sm:max-w-2xl ... gap-3 px-4 py-4 sm:gap-4"
+   style={{ paddingTop: "max(1rem, env(safe-area-inset-top))",
+            paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
+ >
```

Drop the footer `<p>Auto-refreshes…</p>` (line 338); fold hint into nav title
tooltip or remove entirely.

### 2. Nav pill — keep theme switcher

`theme.tsx` untouched. Nav button (lines 154-164) stays verbatim. Only size
tweak: `size-9` → `size-8`. Verify toggle works both directions post-build.

### 3. Hero quota card compact — `src/App.tsx:183-227`

- Padding `p-6 sm:p-8` → `p-4 sm:p-6`.
- Big percentage `text-6xl sm:text-7xl` → `text-4xl sm:text-5xl`.
- Remove center progress overlay text (lines 206-208, the
  `mix-blend-difference` span). Keep `Progress` bar only.
- Keep bottom row "Used X% / N remaining".
- Min-height fallback `min-h-[200px]` → `min-h-[120px]`.

### 4. Bento row 1 — side-by-side on mobile — `src/App.tsx:231-257`

- Grid wrapper `grid-cols-1 ... md:grid-cols-8` →
  `grid-cols-2 sm:grid-cols-2 md:grid-cols-8`.
- ResetWindowBar: `md:col-span-5` stays; becomes left half on mobile.
- Remaining dial card: `md:col-span-3` stays; becomes right half on mobile.

**ResetWindowBar (`src/components/reset-window-bar.tsx`):**
- Track `h-24 px-5 py-4` → `h-[72px] px-3 py-2 sm:px-4`.
- Countdown `text-2xl sm:text-3xl` → `text-lg sm:text-2xl`.
- Hide Elapsed block on mobile: wrap right `<div>` in `hidden sm:block`.
- Eyebrow font fine; keep `text-white/55`.

**Remaining dial (`src/App.tsx:238-257`):**
- `size-28` → `size-16 sm:size-20`.
- `px-6 py-8` → `px-3 py-3`.
- `{remainingPct}%` `text-2xl` → `text-base sm:text-lg`.
- Drop `{fmtTokens(data.remaining)} tokens left` line on mobile
  (`hidden sm:block`), or remove entirely (info already in hero bottom row).

### 5. Stat tiles — 3-col grid on mobile — `src/App.tsx:260-297`

- Wrapper inside the bento grid: current 5 tiles use `md:col-span-N`. Restructure
  so on mobile they form a 3-col × 2-row block.
- Since parent grid is `md:grid-cols-8`, stat tiles need explicit mobile spans.
  Simpler: wrap the 5 StatTiles in their own sub-grid:
  `<div className="col-span-2 md:col-span-8 grid grid-cols-3 gap-2 md:grid-cols-5 md:gap-4">`.
- Keep all 5 tiles (Expires, Total requests, Used today, Tokens/min, Last used).
  On mobile 3+2; on md use the original 8-col layout spans.

**StatTile default density (`src/components/ui/stat-tile.tsx:29,34`):**
- `px-5 py-4 sm:px-6 sm:py-5` → `px-3 py-2.5 sm:px-4 sm:py-3`.
- Value `text-xl ... sm:text-2xl` → `text-sm sm:text-lg`.
- Icon wrapper `p-2 size-18px icon` → `p-1.5`, icon `size={16}` (was 18).
- Label eyebrow stays; reduce `text-white/40` ok.

### 6. 30-day chart compact — `src/App.tsx:300-334`

- `md:col-span-8 p-6 h-32` → `col-span-2 md:col-span-8 p-3 h-16 sm:h-24`.
- Bar container `gap-1 sm:gap-1.5` stays.
- Hide weekday labels on mobile: `<span className="hidden sm:inline ...">`.
### 7. Glass gradient badge utility — `src/index.css` (new class)

Add after `.eyebrow`:

```css
.glass-pill {
  background: linear-gradient(
    to bottom,
    rgba(255,255,255,0.22) 0%,
    rgba(255,255,255,0.06) 100%
  );
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.28),
    inset 0 0 0 1px rgba(255,255,255,0.12);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
}
:root:not(.dark) .glass-pill {
  background: linear-gradient(
    to bottom,
    rgba(255,255,255,0.55) 0%,
    rgba(255,255,255,0.25) 100%
  );
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.7),
    inset 0 0 0 1px rgba(255,255,255,0.4);
}
```

Apply `.glass-pill` via `cn(...)` to:
- `src/App.tsx:186` — "Quota" eyebrow pill (replace `bg-white/10`).
- `src/components/reset-window-bar.tsx:109` — "Reset window" eyebrow.
- `src/components/reset-window-bar.tsx:118` — "Elapsed" eyebrow.
- StatTile label: keep as text (no bg) — adding pill here crowds the compact
  tile. Leave unchanged.

### 8. Mobile bezel shrink — `src/index.css`

Add under squircle block:

```css
@media (max-width: 640px) {
  :root { --bezel-pad: 0.25rem; --radius-squircle: 1.25rem; }
}
```

## Testing Strategy

No unit-test framework in repo. Verification is build + manual browser:

1. `npm run build` — must pass (TS strict + Vite).
2. Browser at viewport 390 × 844:
   - Dark mode: screenshot, confirm no vertical scroll, all sections visible.
   - Light mode: same.
   - Theme toggle button: click dark→light→dark, confirm class flips on `<html>`
     and localStorage persists.
3. 320 × 568 (iPhone SE): graceful — scroll acceptable, no horizontal overflow.
4. Desktop 1280 wide: layout still uses `md:` grid, looks correct.

## Boundaries

- **Always:** `npm run build` before declaring done. Preserve `data-revealed`,
  `data-slot`, `--reveal-delay` hooks. Keep all `QuotaData`/`HistoryDay` logic
  intact — no data changes.
- **Ask first:** new dependencies, removing any of the 5 stat tiles, changing
  API response shape.
- **Never:** touch `theme.tsx`, `server.php`, `sql/`, edit `node_modules`.

## Success Criteria

- [ ] `npm run build` exits 0.
- [ ] At 390 × 844 in dark mode: page height ≤ 844 (no scroll), all 6 sections
      (nav, hero, reset bar, dial, stats, chart) visible.
- [ ] Same in light mode.
- [ ] Theme toggle flips `<html class="dark">` both directions and persists.
- [ ] Badges ("Quota", "Reset window", "Elapsed") show vertical gradient +
      inset top highlight (frosted glass, not flat tint).
- [ ] No horizontal overflow at 320 px wide.
- [ ] Desktop layout (`md:` grid) unchanged visually.

## Open Questions

1. Drop "Last used" tile entirely to free mobile space? Default: keep, accept
   3+2 split.
2. Remove the `mix-blend-difference` center progress text, or move the `%`
   into the bar fill? Default: remove (redundant with big number above).
3. Footer "Auto-refreshes every 60s" — remove or shrink into nav? Default:
   remove (timer behavior unchanged).
