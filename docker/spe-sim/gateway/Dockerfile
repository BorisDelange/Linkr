# The SPE's front door: TLS termination + one path prefix per environment
# (/docker-8743/ → container docker-8743). Its behaviour is set by environment
# variables at start (see 40-spe-gateway.sh), so one image covers the proxy
# variants met across SPEs.
FROM nginx:1.27-alpine

# Self-signed certificate for https://localhost, made once at build. The browser
# warns on first visit; accept it once.
RUN apk add --no-cache openssl \
    && mkdir -p /etc/nginx/certs \
    && openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
        -subj "/CN=localhost" \
        -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
        -keyout /etc/nginx/certs/gateway.key -out /etc/nginx/certs/gateway.crt \
    && apk del openssl

COPY 40-spe-gateway.sh /docker-entrypoint.d/40-spe-gateway.sh
RUN chmod +x /docker-entrypoint.d/40-spe-gateway.sh

EXPOSE 443
