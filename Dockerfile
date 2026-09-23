# Build the SPA (dist/ contains index.html + hashed assets + PWA files)
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime: Apache + PHP. The built SPA and server.php share /var/www/html —
# server.php serves dist's index.html for non-API routes, and bin/poll.php
# requires server.php by path.
FROM php:8.3-apache

# Stock Debian Apache aliases /icons/ to its own icon set — that would
# hijack the PWA icon path, so drop that conf (mod_rewrite does all routing).
RUN docker-php-ext-install pdo_mysql \
    && a2enmod rewrite headers expires \
    && rm -f /etc/apache2/mods-enabled/alias.conf

# Routing: real files/dirs served directly, everything else -> server.php;
# deny .env* and any .php other than server.php (defense in depth).
COPY docker/000-default.conf /etc/apache2/sites-available/000-default.conf

COPY server.php /var/www/html/server.php
COPY bin/ /var/www/html/bin/
COPY --from=build /app/dist/ /var/www/html/

# COPY preserves source modes — the host may keep server.php 0660, which
# www-data (Apache) can't read. Make the webroot world-readable, +X on dirs.
RUN chmod -R a+rX /var/www/html

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost/api/config || exit 1
