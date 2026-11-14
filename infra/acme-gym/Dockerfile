# flagship-acme-gym: Let's Encrypt's Pebble test CA behind Caddy, the gym's private ACME CA (docs/gym-test-acme.md).
# Pebble's image is `scratch` + the binary + its test certificates; Caddy's Alpine image runs both.
FROM ghcr.io/letsencrypt/pebble:2.10.1@sha256:ddf230642b1a584f519f32e347de1b05a6e4c1f6c35c1863b33effeab5f78199 AS pebble

FROM caddy:2.11.6-alpine@sha256:d44355d3c2149dc580ce2cac735955d1c08d3d00882c30489c241aa51a5c10d9
COPY --from=pebble /app /usr/local/bin/pebble
COPY --from=pebble /test/certs /pebble/certs
COPY pebble-config.json /pebble/pebble-config.json
COPY Caddyfile /etc/caddy/Caddyfile
COPY start.sh /usr/local/bin/start.sh
RUN chmod 0755 /usr/local/bin/start.sh
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/start.sh"]
