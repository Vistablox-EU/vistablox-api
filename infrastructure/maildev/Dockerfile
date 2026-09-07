FROM node:22-alpine AS build

ARG MAILDEV_RELEASE=v2.2.1
ARG MAILDEV_COMMIT=1f2c75be259eaf3c2bf9e04f8193f5924cb324ff
RUN apk add --no-cache git
RUN git clone --depth 1 --branch "${MAILDEV_RELEASE}" https://github.com/maildev/maildev.git /src/maildev
WORKDIR /src/maildev
RUN test "$(git rev-parse HEAD)" = "${MAILDEV_COMMIT}"
RUN npm install \
  && npm prune \
  && npm cache clean --force

FROM node:22-alpine

RUN apk add --no-cache tzdata
ENV NODE_ENV=production
ENV TZ=UTC
USER node
WORKDIR /home/node
COPY --chown=node:node --from=build /src/maildev /home/node

EXPOSE 1080 1025
ENV MAILDEV_WEB_PORT=1080
ENV MAILDEV_SMTP_PORT=1025
ENTRYPOINT ["bin/maildev"]
HEALTHCHECK --interval=10s --timeout=1s \
  CMD wget -O - http://localhost:${MAILDEV_WEB_PORT}${MAILDEV_BASE_PATHNAME}/healthz || exit 1
