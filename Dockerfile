FROM node:22-slim
RUN npm install -g solc@0.8.14 \
 && apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY runner-server.js /runner/runner-server.js
ENV RUNNER_AUTH_TOKEN=""
EXPOSE 8080
CMD ["node", "/runner/runner-server.js"]
