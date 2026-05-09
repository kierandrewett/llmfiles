FROM node:22-bookworm-slim

ARG OPENCODE_VERSION=""

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl git tar \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && mkdir -p /app /state /home/node \
    && chown -R node:node /app /state /home/node

USER node

ENV HOME="/home/node"
ENV PATH="/home/node/.opencode/bin:${PATH}"
ENV XDG_STATE_HOME="/state"
ENV OPENCODE_BRIDGE_MANAGE_OPENCODE="1"
ENV OPENCODE_BRIDGE_OPENCODE_HOST="127.0.0.1"
ENV OPENCODE_BRIDGE_OPENCODE_PORT="4096"

RUN set -eux; \
    curl -fsSL https://opencode.ai/install -o /tmp/opencode-install.sh; \
    if [ -n "${OPENCODE_VERSION}" ]; then \
        bash /tmp/opencode-install.sh --no-modify-path --version "${OPENCODE_VERSION}"; \
    else \
        bash /tmp/opencode-install.sh --no-modify-path; \
    fi; \
    rm /tmp/opencode-install.sh

WORKDIR /app

COPY --chown=node:node package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable

COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node src ./src
RUN yarn typecheck

VOLUME ["/state"]

CMD ["yarn", "start", "telegram"]
