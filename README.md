# LLM Quota Dashboard

Realtime quota/usage dashboard for **any LLM API**. Point it at a JSON endpoint,
configure the field map, and get a live dashboard with daily token-usage history,
Telegram alerts (reset-soon, reset-done, usage milestones), and a Telegram bot
for on-demand checks.

Built with Vite + React + TypeScript (shadcn/ui) on the frontend and a single
PHP file on the backend. No Node runtime needed in production — `server.php`
serves the pre-built SPA.

## Features

- **Provider-agnostic** — works with any upstream returning JSON via a config-driven field map.
- **Installable PWA** — offline app shell + last-known API data via service worker caching; auto-updates.
- **One-command Docker deploy** — web + MariaDB + every-minute poller via `docker compose up -d --build`.
- **Live dashboard** — usage progress, reset countdown, usage chart with Daily / 5h-windows toggle.
- **Daily history** — token deltas logged to MySQL, anchored per day.
- **5h-window history** — tokens consumed per quota window, chartable for the last 34 windows (~7 days).
- **Telegram alerts** — usage milestones (25/50/75/90%), reset-soon, reset-done.
- **Telegram bot** — `/quota`, `/reset`, `/help` (prefix configurable).
- **Dark/light theme** with anti-FOUC persistence.

## Requirements

- PHP 8.0+ with `curl` and `pdo_mysql` extensions
- MySQL 5.7+ / MariaDB 10.3+
- Node.js 18+ and npm (build only)

## Quick start

```sh
git clone https://github.com/uPIKs92/llm-quota-dashboard.git
cd llm-quota-dashboard
npm install
npm run build          # outputs dist/
cp .env.example .env   # then edit .env
```

Create the database and tables:

```sh
mysql -u quota_user -p quota_dash < sql/schema.sql
```

Point your web server at the project root so `server.php` handles requests
(see deployment below). Then visit the site in your browser.

## Configuration

All config lives in `.env`. Copy `.env.example` and fill it in.

### Core

| Variable | Description | Default |
|---|---|---|
| `UPSTREAM_URL` | The quota/usage endpoint to monitor | _(required)_ |
| `API_KEY` | Bearer token sent to upstream | — |
| `APP_NAME` | Dashboard title + alert label | `LLM Quota` |
| `BOT_COMMAND_PREFIX` | Bot command prefix (empty = `/quota`) | _(empty)_ |
| `TZ` | Timezone for alert formatting | `Asia/Jakarta` |

> `GLM_API_KEY` is still read as a legacy fallback for `API_KEY`.

### Database

| Variable | Description |
|---|---|
| `DB_HOST` | MySQL host (default `127.0.0.1`) |
| `DB_DATABASE` | Database name (default `quota_dash`) |
| `DB_USERNAME` | MySQL user (default `quota_user`) |
| `DB_PASSWORD` | MySQL password |

### Telegram

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_CHAT_ID` | Chat/channel ID to receive alerts |
| `ALERT_WINDOW_MINUTES` | Minutes before reset to alert (default `30`) |
| `WEBHOOK_URL` | Public HTTPS base for webhook (optional) |
| `TELEGRAM_WEBHOOK_SECRET` | Secret token for webhook verification (optional) |

### Replenish ping

| Variable | Description | Default |
|---|---|---|
| `REPLENISH_PING_URL` | Completions endpoint for the boundary ping | derived: `UPSTREAM_URL` minus `/stats` + `/v1/chat/completions` |

At every 5h window boundary the cron poller fires ONE tiny completion
(`"hi"`, `max_tokens: 1`) so the upstream materializes the new quota window
immediately — with no request since the last boundary, the usage endpoint
keeps reporting a sliding zero window instead of the fresh one. The ping
consumes ~1-2 tokens per boundary. Set `REPLENISH_PING_URL=off` (or `0`) to
disable it.

### Field map (point at your provider)

The dashboard reads a **canonical shape** from the upstream response. By default
it expects the original proxy contract. If your API uses different field names,
override the dotted JSON paths:

| Canonical | Default path | Override var |
|---|---|---|
| name | `name` | `FIELD_NAME` |
| model | `model` | `FIELD_MODEL` |
| limit | `token_limit_per_5h` | `FIELD_LIMIT` |
| used | `current_usage.tokens_used_in_current_window` | `FIELD_USED` |
| remaining | `current_usage.remaining_tokens` | `FIELD_REMAINING` |
| window start | `current_usage.window_started_at` | `FIELD_WINDOW_START` |
| window end | `current_usage.window_ends_at` | `FIELD_WINDOW_END` |
| total requests | `total_requests` | `FIELD_TOTAL_REQUESTS` |
| total lifetime | `total_lifetime_tokens` | `FIELD_TOTAL_LIFETIME` |
| is expired | `is_expired` | `FIELD_IS_EXPIRED` |
| expiry date | `expiry_date` | `FIELD_EXPIRY_DATE` |
| last used | `last_used` | `FIELD_LAST_USED` |

**Example** — if your API returns `{ "usage": { "spent": 1200, "cap": 50000 } }`,
set:

```env
FIELD_USED=usage.spent
FIELD_LIMIT=usage.cap
```

No code changes needed.

## Deployment

### Docker (one command)

The repo ships a `compose.yaml` with three services: `web` (Apache + PHP serving
the SPA and API), `db` (MariaDB, schema auto-imported on first start), and
`poller` (the every-minute cron loop — no host crontab needed).

**From source:**

```sh
cp .env.example .env   # fill in UPSTREAM_URL, DB_PASSWORD, etc.
docker compose up -d --build
```

**Prebuilt image** (no Node/PHP toolchain needed): the published image is
`ghcr.io/upiks92/llm-quota-dashboard`. If you forked, change the `image:` lines
in `compose.yaml` to your registry path, then:

```sh
cp .env.example .env   # fill in UPSTREAM_URL, DB_PASSWORD, etc.
docker compose up -d
```

Then open `http://localhost:8080`. The dashboard listens on port `8080` by
default — change the `ports:` mapping in `compose.yaml` if needed.

Notes:

- Config comes from `.env` (same file as bare-metal). Compose passes it to the
  containers as environment variables; only `DB_HOST` is overridden to `db`.
- The MariaDB container initializes the schema from `sql/schema.sql` on first
  volume creation. Later schema changes: re-import manually
  (`docker compose exec -T db mariadb -u quota_user -p... quota_dash < sql/schema.sql`)
  or reset the volume (`docker compose down -v` — deletes history).
- **PWA installability requires HTTPS or `localhost`** — `localhost:8080`
  qualifies; a LAN IP needs a reverse proxy with TLS in front of the container.
- The Telegram webhook needs a public HTTPS URL: put a reverse proxy (Caddy,
  nginx + certbot, Cloudflare tunnel, …) in front of `:8080`, set
  `WEBHOOK_URL=https://your-domain` + `TELEGRAM_WEBHOOK_SECRET` in `.env`, then
  register it: `docker compose exec web php /var/www/html/bin/set-webhook.php`.
- CLI helpers run inside the container:
  `docker compose exec web php /var/www/html/bin/repair-daily.php`.

Images are published automatically by GitHub Actions: `main` pushes a rolling
`latest` (+ `edge-<sha>`); pushing a `vX.Y.Z` tag publishes `X.Y.Z`, `X.Y`, and
`latest` for `linux/amd64` + `linux/arm64`.

### nginx + PHP-FPM

Point the root at the project and route non-file requests to `server.php`:

```nginx
server {
    listen 80;
    server_name quota.example.com;
    root /var/www/llm-quota-dashboard;
    index server.php;

    location / {
        try_files $uri $uri/ /server.php?$query_string;
    }

    location ~ \.(js|css|svg|woff2?|png|jpg|ico)$ {
        expires 30d;
        try_files $uri =404;
    }

    location ~ \.(php|env)$ {
        deny all;               # never serve PHP source or .env
    }

    location ~ server\.php$ {
        include fastcgi_params;
        fastcgi_pass unix:/run/php/php8.x-fpm.sock;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    }
}
```

### Apache + .htaccess

Create `.htaccess` in the project root:

```apache
RewriteEngine On

# Serve real files directly
RewriteCond %{REQUEST_FILENAME} -f [OR]
RewriteCond %{REQUEST_FILENAME} -d
RewriteRule ^ - [L]

# Everything else -> server.php
RewriteRule ^ server.php [QSA,L]

# Block secrets
<FilesMatch "^\.env">
    Require all denied
</FilesMatch>
```

Make sure `mod_rewrite` is enabled and `AllowOverride All` is set for the dir.

### Shared hosting (cPanel)

1. Upload the built files (`dist/` + `server.php` + `sql/` + `bin/`) via FTP.
2. Create a MySQL database + user, import `sql/schema.sql` via phpMyAdmin.
3. Edit `.env` with your DB + upstream details.
4. Set the document root to the project folder.
5. Most shared hosts route `.php` automatically — `server.php` handles SPA fallback.

## Cron (alerts + daily logging)

The dashboard polls upstream automatically when you load the page, but Telegram
alerts and daily logging need a job running every minute. With Docker, the
`poller` service already does this — nothing to set up.

Bare-metal, add a cron job:

```cron
* * * * * php /var/www/llm-quota-dashboard/bin/poll.php >> /tmp/quota-poll.log 2>&1
```

## Telegram bot

1. Create a bot via [@BotFather](https://t.me/BotFather), get the token.
2. Add the bot to your chat/channel, set `TELEGRAM_CHAT_ID`.
3. Set up the webhook so commands reach `server.php`:
   ```sh
   # in .env set WEBHOOK_URL=https://quota.example.com and TELEGRAM_WEBHOOK_SECRET
   php bin/set-webhook.php
   ```

| Command (prefix=empty) | Action |
|---|---|
| `/quota` | Current usage + progress bar |
| `/reset` | Reset-window countdown |
| `/help` | List commands |

## CLI scripts

| Script | Purpose |
|---|---|
| `bin/poll.php` | Cron entry — poll, log, alert |
| `bin/repair-daily.php` | One-time fix for cumulative-vs-daily token deltas |
| `bin/set-webhook.php` | Register the Telegram webhook |

## Development

```sh
npm run dev       # Vite dev server with HMR
npm run build     # tsc + production build to dist/
npm run lint      # oxlint
```

During development, run `server.php` with PHP's built-in server for the API
while the Vite dev server serves the frontend:

```sh
php -S localhost:8000   # API at :8000
npm run dev             # frontend at :5173
```

## API endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/stats` | GET | Normalized quota (proxied + mapped from upstream) |
| `/api/history` | GET | Daily token log (last 30 days) |
| `/api/window-history` | GET | Token usage per 5h quota window (`?n=`, 1–200, default 34) |
| `/api/config` | GET | `{ "appName": "..." }` |
| `/api/tg/webhook` | POST | Telegram webhook receiver |

## Security notes

- **Never commit `.env`.** It's gitignored by default. If it was ever committed,
  rotate all secrets (API key, bot token, DB password).
- The Telegram webhook verifies `X-Telegram-Bot-Api-Secret-Token` when
  `TELEGRAM_WEBHOOK_SECRET` is set.
- Bot commands only respond to `TELEGRAM_CHAT_ID` (authorized chat).
- Block `.env` and PHP source at the web server level (see deployment configs).

## License

[MIT](LICENSE)
