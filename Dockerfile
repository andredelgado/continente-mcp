ARG PLAYWRIGHT_VERSION=1.65.0

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.tools.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS runtime
ENV NODE_ENV=production \
    CONTINENTE_DATA_DIR=/data
LABEL io.modelcontextprotocol.server.name="io.github.andredelgado/continente-mcp"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown pwuser:pwuser /data
USER pwuser
VOLUME ["/data"]
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]
