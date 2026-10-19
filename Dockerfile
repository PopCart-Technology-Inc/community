# PopCart Community: one small image. Node 24 runs the TypeScript directly (decision 0006).
# Runs as the unprivileged `node` user with a read-only app directory; media goes to /data/media.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY app ./app
RUN mkdir -p /data/media && chown -R node:node /data
USER node
ENV MEDIA_DIR=/data/media PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "app/main.ts"]
