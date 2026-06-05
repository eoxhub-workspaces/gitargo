# --- Stage 1: Build Frontend ---
FROM node:lts-bookworm-slim AS build-frontend
WORKDIR /app/ui
COPY services/ui/package*.json ./
RUN npm install --legacy-peer-deps
COPY services/ui/ ./
RUN npm run build

# --- Stage 2: Setup Backend ---
FROM node:lts-bookworm-slim AS production
WORKDIR /app
COPY services/api/package*.json ./
# Install all dependencies (including devDependencies like nodemon)
# so that hot-reloading works in dev environments via push.sh
RUN npm install --legacy-peer-deps
COPY services/api/ ./
# Copy built frontend assets to the backend's public directory
COPY --from=build-frontend /app/ui/build ./public

EXPOSE 3000
CMD ["node", "server.js"]
