# --- Stage 1: Build Frontend ---
FROM node:20-alpine AS build-frontend
WORKDIR /app/ui
COPY services/ui/package*.json ./
RUN npm install
COPY services/ui/ ./
RUN npm run build

# --- Stage 2: Development Stage ---
# Keeps npm, npx, and dev tools fully intact for rapid development workflows
FROM node:20-alpine AS development
RUN apk update && apk upgrade --no-cache
WORKDIR /app
COPY services/api/package*.json ./
RUN npm install
COPY services/api/ ./
COPY --from=build-frontend /app/ui/dist ./public
EXPOSE 3000
CMD ["npm", "run", "dev"]

# --- Stage 3: Hardened Production Stage ---
# Defaults to strict, non-root, zero-vulnerability security by purging npm/npx
FROM node:20-alpine AS production

# Update Alpine repositories and upgrade all OS-level packages 
# to pull in critical security patches (like libcrypto3 & libssl3)
RUN apk update && apk upgrade --no-cache

# Create a secure, explicit non-root system user and group
RUN addgroup -g 10001 -S gitargo && adduser -u 10001 -S gitargo -G gitargo

WORKDIR /app

# Copy the complete installed application context from the development stage
COPY --chown=gitargo:gitargo --from=development /app /app

# Harden container: Permanently remove global npm, npx, and corepack 
# to eliminate their internal dependencies from filesystem scans.
USER root
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/corepack

EXPOSE 3000

# Switch context to the non-root gitargo user
USER gitargo

CMD ["node", "server.js"]
