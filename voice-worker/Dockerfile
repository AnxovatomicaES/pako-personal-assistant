# Image for LiveKit Cloud's agent hosting (lk agent create). Render builds the worker from source and does not use this file.
# LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are injected by LiveKit Cloud at run time: nothing secret is baked in.
FROM node:22-slim

# Slim images lack the CA bundle, and without it Room.connect() fails with "failed to retrieve region info".
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
# Builds the TypeScript and drops LiveKit's local end-of-turn model (Gemini Live decides turns itself), then keeps runtime packages only.
RUN npm run build && npm prune --omit=dev

RUN useradd --create-home agent && chown -R agent:agent /app
USER agent
ENV NODE_ENV=production

CMD ["node", "dist/agent.js", "start"]
