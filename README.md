# GLM Quota Dashboard

Realtime dashboard for a GLM API quota proxy, with daily token-usage history,
Telegram alerts (reset-soon, reset-done, usage milestones), and a Telegram bot
for on-demand quota checks.

- **Frontend:** Vite + React + TypeScript, shadcn/ui (Base UI), Tailwind. Dark/light theme.
- **Backend:** single `server.php` — proxies `/api/stats`, serves `/api/history`,
  handles the Telegram webhook `/api/tg/webhook`, and serves the built SPA.
- **Cron:** `bin/poll.php` polls upstream every minute, logs daily stats, fires alerts.

## Setup

1. **Build the frontend**
   ```sh
   npm install
   npm run build      # outputs dist/, served by server.php
   ```

2. **Configure secrets** — copy and fill `.env` (see `.env.example`):
   ```sh
   cp .env.example .env
   ```
   Needs `GLM_API_KEY`, `DB_*`, and `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`.

3. **Create the database + tables**
   ```sh
   mysql -u quota_user -p quota_dash < sql/schema.sql
   ```

4. **Point the web server** at the project root so `server.php` runs for all
   non-file requests (e.g. PHP-FPM + nginx `try_files`). `server.php` serves
   `index.html` (the built SPA) for browser routes.

5. **Cron** — poll upstream every minute:
   ```cron
   * * * * * php /var/www/html/glm-quota-dashboard/bin/poll.php >> /tmp/glm-poll.log 2>&1
   ```

6. **(Optional) Telegram webhook** for bot commands — set `WEBHOOK_URL` and
   `TELEGRAM_WEBHOOK_SECRET` in `.env`, then:
   ```sh
   php bin/set-webhook.php
   ```

## Bot commands

| Command            | Action                          |
|--------------------|---------------------------------|
| `/glmquota`, `/glm`| Current quota + progress bar    |
| `/glmreset`        | Reset-window countdown          |
| `/glmhelp`         | List commands                   |

## Scripts

- `bin/poll.php` — cron entry; calls `pollQuota()` (log + alert).
- `bin/repair-daily.php` — one-time fix for cumulative-vs-daily `tokens_used`.
- `bin/set-webhook.php` — register the Telegram webhook.

## Dev

```sh
npm run dev      # Vite dev server (HMR)
npm run build    # type-check + production build to dist/
```
