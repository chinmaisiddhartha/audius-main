# Uses separate stage for nodejs deps despite caching to avoid installing build tools
FROM node:14.16 AS builder
RUN apt-get install make
WORKDIR /app
COPY package*.json ./
RUN target=/root/.npm npm ci

FROM alpine:3.14 AS base

WORKDIR /usr/src/app

VOLUME "/file_storage"
ENV storagePath=/file_storage

# Add the wait script to the image
# Script originally from https://github.com/ufoscout/docker-compose-wait/releases/download/2.4.0/wait /usr/bin/wait
COPY scripts/wait /usr/bin/wait

RUN echo 'http://dl-cdn.alpinelinux.org/alpine/v3.10/main' >> /etc/apk/repositories && \
    apk update && \
    apk add \
        bash=5.1.16-r0 \
        curl \
        docker=20.10.11-r1 \
        libpq=11.12-r0 \
        nodejs=14.20.1-r0 \
        npm \
        postgresql-client=11.12-r0 \
        postgresql-contrib=11.12-r0 \
        postgresql-libs=11.12-r0 \
        postgresql=11.12-r0 \
        py3-pip \
        python3 \
        python3-dev \
        redis=6.2.7-r0 \
        rsyslog=8.2012.0-r3 \
        sudo=1.9.5p2-r0

# Install openresty with public key
RUN echo 'http://mirror.leaseweb.com/alpine/v3.13/community' >> /etc/apk/repositories && \
    apk add wget && \
    wget 'http://openresty.org/package/admin@openresty.com-5ea678a6.rsa.pub' && \
    mv 'admin@openresty.com-5ea678a6.rsa.pub' /etc/apk/keys/ && \
    source /etc/os-release && \
    MAJOR_VER=`echo $VERSION_ID | sed 's/\.[0-9]\+$//'` && \
    echo "http://openresty.org/package/alpine/v$MAJOR_VER/main" | tee -a /etc/apk/repositories && \
    apk update && \
    apk add openresty=1.21.4.1-r0 && \
    mkdir /usr/local/openresty/conf && \
    mkdir /usr/local/openresty/logs && \
    mkdir /usr/local/openresty/cache

COPY nginx_conf /usr/local/openresty/conf/

# Create a db user if postgres in case it will be run inside this container
COPY scripts/init-db.sh scripts/init-db.sh
RUN bash scripts/init-db.sh

COPY --from=builder /app/node_modules node_modules

COPY . .

# Compile js code to typescript based on tsconfig.build.json
RUN npx tsc --project tsconfig.build.json

# ARGs can be optionally defined with --build-arg while doing docker build eg in CI and then set to env vars
ARG git_sha
ARG audius_loggly_disable
ARG audius_loggly_token
ARG audius_loggly_tags

ENV GIT_SHA=$git_sha
ENV logglyDisable=$audius_loggly_disable
ENV logglyToken=$audius_loggly_token
ENV logglyTags=$audius_loggly_tags
ENV port=4000
ENV contentCacheLayerEnabled=true

EXPOSE 4000

HEALTHCHECK --interval=5s --timeout=5s --start-period=15m --retries=12 \
    CMD curl -f http://localhost:${port}/health_check || exit 1

CMD ["bash", "scripts/start.sh"]
