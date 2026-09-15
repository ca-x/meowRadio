FROM node:24-bookworm-slim AS web
WORKDIR /app/web
COPY web/package*.json web/.npmrc ./
RUN npm ci --ignore-scripts
COPY web/ ./
RUN npm run build

FROM rust:1.94-bookworm AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY vendor ./vendor
COPY migrations ./migrations
COPY --from=web /app/web/dist ./web/dist
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* && useradd --uid 10001 --create-home meowradio && mkdir /data && chown meowradio:meowradio /data
COPY --from=builder /app/target/release/meowradio /usr/local/bin/meowradio
USER 10001:10001
ENV MEOW_DATABASE=/data/meowradio.db MEOW_LISTEN=0.0.0.0:3000
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1
ENTRYPOINT ["/usr/local/bin/meowradio"]
