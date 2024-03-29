# syntax=docker/dockerfile:1

FROM golang:latest

RUN apt update && apt install -y ffmpeg 

# install in-container tools: dbmate, nats cli
RUN cd /tmp && \
  curl -fsSL -o /usr/local/bin/dbmate https://github.com/amacneil/dbmate/releases/latest/download/dbmate-linux-amd64 && \
  chmod +x /usr/local/bin/dbmate && \
  curl -fsSL -o nats.deb https://github.com/nats-io/natscli/releases/download/v0.0.35/nats-0.0.35-amd64.deb &&\
  apt install ./nats.deb

WORKDIR /app

COPY go.mod ./
COPY go.sum ./
RUN go mod download
COPY . ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /comms-linux

# COPY build/comms-linux-amd64 /comms-linux
# COPY db/migrations ./db/migrations

EXPOSE 8925

VOLUME ["/tmp/nats"]

CMD [ "/comms-linux" ]
