FROM node:20-bookworm-slim AS builder

RUN apt-get update && apt-get install -y python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY server ./server
COPY client ./client

RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim AS runner

# Fonts for sharp's SVG text rendering (Ralph bakes copy onto post images) and
# ffmpeg for rendering reel frames into real MP4 video. The slim image ships
# with neither; without fonts the baked text renders as empty boxes.
RUN apt-get update && apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/arlo.db

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/client ./client

EXPOSE 3000

CMD ["node", "server/dist/app.js"]
