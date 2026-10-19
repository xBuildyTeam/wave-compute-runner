FROM node:22-bookworm-slim
# solc: solc@0.8.14's npm package is broken (missing common/helpers.js). We install a working
# solc npm (0.8.36) purely as the loadRemoteVersion loader; it runs the REAL v0.8.14+commit.80d49f37
# compiler at runtime, so output stays solc 0.8.14 / evmVersion istanbul per Theta mainnet rules.
# v2 adds: Chromium (headless browser jobs), Ganache + ethers (local EVM gas tests).
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl chromium fonts-liberation procps \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g solc@0.8.36 ganache@7.9.2 ethers@6.13.4 \
 && npm cache clean --force
ENV CHROME_PATH=/usr/bin/chromium \
    RUNNER_DATA_DIR=/workspace \
    RUNNER_AUTH_TOKEN="" \
    RUNNER_MAX_CONCURRENT=2 \
    NODE_PATH=/usr/local/lib/node_modules
WORKDIR /workspace
COPY runner-server.js /runner/runner-server.js
COPY tools /runner/tools
COPY bench /runner/bench
COPY suites /runner/suites
EXPOSE 8080
CMD ["node", "/runner/runner-server.js"]
