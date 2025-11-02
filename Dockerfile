FROM node:24-alpine AS base
WORKDIR /app
RUN apk --no-cache add ca-certificates

FROM base AS builder
RUN apk --no-cache add python3-dev musl-dev make g++ git
COPY package.json .
COPY yarn.lock .
RUN yarn --frozen-lockfile --non-interactive
COPY . .
# Build app, trim node_modules dependencies, and remove tests
RUN yarn build && \
    mv yarnclean .yarnclean && yarn --frozen-lockfile --non-interactive --production && \
    find dist/ -name '*.spec.js*' -exec rm {} +

FROM base AS release
ENV NODE_ENV production
RUN mkdir runtime && echo '{}' > runtime/config.json && chown -R 1000:1000 .
COPY --from=builder --chown=1000:1000 /app/dist ./dist
COPY --from=builder --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=builder --chown=1000:1000 /app/chips ./chips
USER 1000:1000
CMD ["sh", "-c", "node node_modules/typeorm/cli migration:run -d dist/clients/database.js && node dist/index.js"]
