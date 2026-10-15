#!/bin/sh
# Writes the gateway's nginx config from the environment, before nginx starts
# (the official image runs /docker-entrypoint.d/*.sh first).
#
#   SPE_IDS               space-separated ids; each gets /docker-<id>/ → host docker-<id>
#   GATEWAY_WEBSOCKETS    on | off   off = forward no Upgrade header, like a proxy
#                                    nobody configured for WebSockets (browser sees 1006)
#   GATEWAY_STRIP_PREFIX  on | off   on = /docker-<id>/x reaches the container as /x
#   GATEWAY_IDLE_TIMEOUT  e.g. 60s   how long a silent connection stays open
#   GATEWAY_MAX_BODY      e.g. 1m    largest request body (uploads); nginx's own default is 1m
set -eu

ids="${SPE_IDS:-8743}"
websockets="${GATEWAY_WEBSOCKETS:-on}"
strip="${GATEWAY_STRIP_PREFIX:-on}"
idle="${GATEWAY_IDLE_TIMEOUT:-3600s}"
max_body="${GATEWAY_MAX_BODY:-512m}"

if [ "$websockets" = "on" ]; then
  ws_lines='proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;'
else
  ws_lines='proxy_http_version 1.0;'
fi

conf=/etc/nginx/conf.d/default.conf
links=""

cat > "$conf" <<EOF
map \$http_upgrade \$connection_upgrade {
    default upgrade;
    ''      '';
}

server {
    listen 443 ssl;
    server_name _;
    ssl_certificate     /etc/nginx/certs/gateway.crt;
    ssl_certificate_key /etc/nginx/certs/gateway.key;

    # Docker's embedded DNS, re-asked at request time: a stopped environment
    # answers 502 instead of keeping the whole gateway from starting.
    resolver 127.0.0.11 valid=10s ipv6=off;

    client_max_body_size $max_body;
    # Redirects keep the browser's host:port (8443), not the 443 nginx listens on.
    absolute_redirect off;
EOF

for id in $ids; do
  if [ "$strip" = "on" ]; then
    rewrite="rewrite ^/docker-$id/(.*)\$ /\$1 break;"
  else
    rewrite=""
  fi
  links="$links<li><a href=\"/docker-$id/\">docker-$id</a></li>"
  cat >> "$conf" <<EOF

    location = /docker-$id { return 301 /docker-$id/; }
    location /docker-$id/ {
        set \$upstream docker-$id;
        $rewrite
        proxy_pass http://\$upstream:80;
        $ws_lines
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Prefix /docker-$id;
        proxy_read_timeout $idle;
        proxy_send_timeout $idle;
    }
EOF
done

cat >> "$conf" <<EOF

    location = / {
        default_type text/html;
        return 200 '<!doctype html><meta charset="utf-8"><title>SPE gateway</title><body style="font-family:sans-serif"><h1>SPE gateway</h1><p>websockets=$websockets · strip_prefix=$strip · idle=$idle · max_body=$max_body</p><ul>$links</ul></body>';
    }
}
EOF

echo "spe-gateway: ids=[$ids] websockets=$websockets strip_prefix=$strip idle=$idle max_body=$max_body"
