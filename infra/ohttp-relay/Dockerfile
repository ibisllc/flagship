# Flagship's interim OHTTP relay (infra/ohttp-relay/README.md). No dependencies.
FROM node:22-alpine
WORKDIR /app
COPY relay.mjs ./
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "relay.mjs"]
