# syntax=docker/dockerfile:1
# The factory-worker image (ADR 0010). Build context: the repository root, filtered by the
# allowlist in Dockerfile.dockerignore. Run: factory-worker <state> --issue <n>.
#   docker build --platform linux/amd64 -f factory/worker/Dockerfile -t factory-worker .
# The default build is the worker. `--target boundary-check` builds the test-only check image
# on top of it (ADR 0010, amendment of 2026-11-06). `build-base` is what each target's build
# container, which runs the roles with Bash, starts from (ADR 0011; ADR 0010, amendments of
# 2026-11-09 and add-target-repositories).

# Moving the digest is a deliberate change (ADR 0010).
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

# The workspace with its production dependencies. Workspace packages stay in their own
# folders, not node_modules, because Node's type stripping refuses .ts under node_modules.
FROM ${NODE_IMAGE} AS install
ENV PNPM_HOME=/opt/pnpm CI=true
RUN npm install --global --ignore-scripts --prefix /opt/pnpm pnpm@12.15.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY factory/ factory/
RUN /opt/pnpm/bin/pnpm install --frozen-lockfile --prod --filter "@ceh/factory-worker..." --filter "ceh" \
 && rm -rf /root/.cache /root/.local/share/pnpm /root/.npm
COPY . .

FROM ${NODE_IMAGE} AS worker
# bubblewrap and socat: without them the SDK refuses to start any session, Bash or not, since
# the runner requires the sandbox (ADR 0007). With them, sessions start, and a Bash command
# fails because the sandbox cannot create its namespaces here (owner decision, 2026-11-06).
RUN apt-get update \
 && apt-get install --yes --no-install-recommends git ca-certificates bubblewrap socat \
 && rm -rf /var/lib/apt/lists/*
# TLS to Aurora; AWS rotates this bundle rarely, and a new one is a deliberate change too.
ADD --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b --chmod=644 \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
RUN useradd --uid 10001 --user-group --create-home --home-dir /home/factory --shell /usr/sbin/nologin factory
# Owned by root: the factory user cannot change its own code.
COPY --from=install /app /app
ENV NODE_ENV=production \
    HOME=/home/factory \
    TMPDIR=/tmp \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem \
    OPENSPEC_TELEMETRY=0
USER factory:factory
WORKDIR /home/factory
ENTRYPOINT ["node", "/app/factory/worker/src/main.ts"]

# Test only, never run by the state machine: the worker image with Vitest and the dev
# dependencies added, for the boundary tests in a container (container.live.test.ts) and on
# Fargate (boundaries.cloud.test.ts). It adds layers on top of the worker and changes none of
# its files: no COPY or ADD. The live setup loads .env.local only if it exists, so the token or
# key comes from the environment. Vitest keeps its caches in node_modules, made the one
# writable folder in /app.
FROM worker AS boundary-check
USER root
RUN npm install --global --ignore-scripts --prefix /opt/pnpm pnpm@12.15.0 \
 && cd /app && CI=true /opt/pnpm/bin/pnpm install --frozen-lockfile --filter "@ceh/factory-worker..." --filter "ceh" \
 && rm -rf /root/.cache /root/.local/share/pnpm /root/.npm /opt/pnpm \
 && chown factory:factory /app/node_modules
WORKDIR /app
USER factory:factory
ENTRYPOINT []

# The build base (ADR 0011; ADR 0010, amendment of add-target-repositories): what every target's
# build container starts from. The worker with pnpm and the factory's dev dependencies (Vitest,
# TypeScript, ESLint) from the frozen lockfile, as in boundary-check. It holds no target's
# toolchain and no dependency store: a target's `targets/<name>/build.Dockerfile` adds the
# toolchain `FROM build-base`, and factory-build installs the clone's dependencies online before
# each session. /app's own packages come from root's store and cache, removed again, so the
# factory user still cannot change the factory's code. Like the worker, it holds no secret: the
# model credential comes from the task's environment. It is not run on its own: the target's
# Dockerfile is assembled after this one (`pnpm image:build --target <name>`, and the stack).
FROM worker AS build-base
USER root
ENV PNPM_HOME=/opt/pnpm \
    PATH=/opt/pnpm/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN npm install --global --ignore-scripts --prefix /opt/pnpm pnpm@12.15.0 \
 && cd /app && CI=true NODE_ENV=development pnpm install --frozen-lockfile --filter "@ceh/factory-worker..." --filter "ceh" \
 && rm -rf /root/.cache /root/.local/share/pnpm /root/.npm /home/factory/.cache /home/factory/.local
USER factory:factory
ENV FACTORY_CONTAINER=build
WORKDIR /home/factory
ENTRYPOINT ["node", "/app/factory/worker/src/build-main.ts"]

# The default build: the worker, unchanged.
FROM worker
