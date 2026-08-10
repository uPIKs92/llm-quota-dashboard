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
- **Live dashboard** — usage progress, reset countdown, daily 7-day chart.
- **Daily history** — token deltas logged to MySQL, anchored per day.
- **Telegram alerts** — usage milestones (25/50/75/90%), reset-soon, reset-done.
- **Telegram bot** — `/quota`, `/reset`, `/help` (prefix configurable).
- **Dark/light theme** with anti-FOUC persistence.

## Requirements

- PHP 8.0+ with `curl` and `pdo_mysql` extensions
- MySQL 5.7+ / MariaDB 10.3+
- Node.js 18+ and npm (build only)

## Quick start

```sh
git clone https://github.com/yourname/llm-quota-dashboard.git
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
alerts and daily logging need a cron job running every minute:

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
| `/api/history` | GET | Daily token log (last 14 days) |
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
