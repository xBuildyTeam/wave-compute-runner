FROM node:22-slim
# NOTE: solc@0.8.14's published npm package is missing files (common/helpers.js) and throws
# "Cannot find module './common/helpers'" on any require() — not just the CLI. We install a
# recent, working solc npm version to use purely as the loadRemoteVersion loader/wrapper; it
# fetches and runs the REAL v0.8.14+commit.80d49f37 compiler binary at runtime, so compiled
# output is still genuine solc 0.8.14 / evmVersion istanbul per Theta mainnet rules.
RUN npm install -g solc@0.8.36 \
 && apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY runner-server.js /runner/runner-server.js
ENV RUNNER_AUTH_TOKEN=""
EXPOSE 8080
CMD ["node", "/runner/runner-server.js"]
