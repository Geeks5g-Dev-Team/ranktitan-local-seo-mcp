# Two stages so the published image carries no compiler, no sources and no dev
# dependencies. This is the one service of ours that strangers reach from the
# public internet, so everything it does not need is attack surface it should
# not have.

FROM node:22-alpine AS build
WORKDIR /app

# Dependencies first: this layer is cached while only source changes.
COPY package.json package-lock.json ./
# `npm ci` would run the postinstall icloud-guard, which exists for a Mac under
# ~/Documents and has no business inside a container.
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop to production dependencies for the stage we copy out of.
RUN npm ci --omit=dev --ignore-scripts

FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3070

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Never root. `node` already exists in this image.
USER node

EXPOSE 3070

# Hits the health route rather than the MCP endpoint, which needs credentials.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3070/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
