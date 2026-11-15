# vocab's toolchain on top of ceh's build base (ADR 0010). It holds no project dependencies:
# factory-build installs them in the clone before each session. It is never built on its own
# path: `pnpm image:build --target vocab` and the stack assemble it after the worker Dockerfile,
# whose `build-base` stage this FROM names.
FROM build-base AS target-build
ENV FACTORY_TARGET=vocab
