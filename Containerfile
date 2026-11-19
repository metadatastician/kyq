# SPDX-License-Identifier: MPL-2.0
# Wolfi build/runtime stages; build with Podman.
FROM cgr.dev/chainguard/wolfi-base@sha256:d833404331d631805e1536ec3633393504232549c1347a4b7fd008535d4874bf AS build
RUN apk add --no-cache rust build-base pkgconf openssl-dev git ca-certificates
WORKDIR /src
COPY . .
RUN cargo build --locked --release --bin kyq

FROM cgr.dev/chainguard/wolfi-base@sha256:d833404331d631805e1536ec3633393504232549c1347a4b7fd008535d4874bf
RUN apk add --no-cache libstdc++ ca-certificates
COPY --from=build /src/target/release/kyq /usr/local/bin/kyq
USER 65532:65532
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/kyq"]
CMD ["--help"]
