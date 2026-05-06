# Pod-resident Chromium container. Headful (Xvfb) so anti-bot sites
# fingerprinting `navigator.webdriver` and headless markers are happier;
# accepted tradeoff: a few hundred MB of image + a small RAM cost.
#
# CDP is exposed on :9222. The compose port mapping pins this to
# 127.0.0.1 only — the daemon's BrowserManager (running on the host
# as the only legitimate client) is the sole consumer.
#
# Profile (cookies, logins, localStorage) lives at /home/flagship/profile,
# bind-mounted to /var/flagship/data/chromium/profile on the host so it
# survives container rebuilds and sits inside the LUKS-encrypted root.

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        xvfb \
        dumb-init \
        fonts-liberation \
        ca-certificates \
        curl \
        socat \
    && rm -rf /var/lib/apt/lists/*

# Match host UID 1000 — same convention as forgejo. Profile files
# written by the container land owned by UID 1000 on the host, so a
# sysadmin can read them with the dev user without sudo.
RUN useradd -u 1000 -m -s /bin/bash flagship
USER flagship
WORKDIR /home/flagship

COPY --chown=flagship:flagship start.sh /home/flagship/start.sh
RUN chmod +x /home/flagship/start.sh

EXPOSE 9222
ENTRYPOINT ["dumb-init", "--", "/home/flagship/start.sh"]
