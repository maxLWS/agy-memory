# syntax=docker/dockerfile:1
# Minimal non-root image for Glama / MCP inspection (zero runtime dependencies).
FROM node:22-alpine

LABEL org.opencontainers.image.title="agy-memory MCP Server" \
      org.opencontainers.image.description="Per-project Markdown blackboard and local session archive MCP plugin for Google Antigravity." \
      org.opencontainers.image.source="https://github.com/maxLWS/agy-memory" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

COPY --chown=node:node package.json README.md LICENSE ./
COPY --chown=node:node dist/mcp-server.mjs ./dist/mcp-server.mjs

ENV NODE_ENV=production

USER node

ENTRYPOINT ["node", "/app/dist/mcp-server.mjs"]
