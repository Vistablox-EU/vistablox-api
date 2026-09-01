FROM golang:1.24.8-alpine3.22 AS build

ARG MINIO_RELEASE=RELEASE.2025-10-15T17-29-55Z
ARG MINIO_COMMIT=9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a
RUN apk add --no-cache git
RUN git clone --depth 1 --branch "${MINIO_RELEASE}" https://github.com/minio/minio.git /src/minio
WORKDIR /src/minio
RUN test "$(git rev-parse HEAD)" = "${MINIO_COMMIT}"
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    MINIO_LDFLAGS="$(go run buildscripts/gen-ldflags.go)" && \
    CGO_ENABLED=0 go build -tags kqueue -trimpath \
      --ldflags "${MINIO_LDFLAGS}" -o /minio

FROM alpine:3.22

RUN apk add --no-cache ca-certificates
COPY --from=build /minio /usr/local/bin/minio

EXPOSE 9000
VOLUME ["/data"]
ENTRYPOINT ["minio"]
CMD ["server", "/data"]
