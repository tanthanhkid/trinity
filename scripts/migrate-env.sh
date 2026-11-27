#!/bin/sh
# Bring the .env of a running install up to date with the client-IP settings (G16b, docs/deployment.md "Client IP").
#
#   scripts/migrate-env.sh                          print what would change in ./.env (writes nothing)
#   scripts/migrate-env.sh --trusted-proxy=VALUE    propose VALUE instead of the default `none`
#   scripts/migrate-env.sh --env /path/to/.env      another file
#   scripts/migrate-env.sh --write                  apply the changes (a .env.bak.<time> copy is made first)
#
# VALUE: none | cloudflare | cloudflare-tunnel | cidr:<list> | cloudflare-behind:<list>
# It never prints secret values, never touches a key that is already set, and does not restart anything.
set -eu

ENV_FILE=".env"
TP=""
WRITE=0
for arg in "$@"; do
  case "$arg" in
    --write) WRITE=1 ;;
    --env=*) ENV_FILE="${arg#--env=}" ;;
    --trusted-proxy=*) TP="${arg#--trusted-proxy=}" ;;
    -h | --help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "error: unknown option $arg" >&2; exit 2 ;;
  esac
done

[ -f "$ENV_FILE" ] || { echo "error: $ENV_FILE not found (run from the repository root or pass --env=FILE)" >&2; exit 1; }

get_kv() { # last uncommented assignment of $1, quotes stripped
  grep "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//" || true
}
has_key() { grep -q "^$1=" "$ENV_FILE"; }

ADD="" # lines to append, one per line
DROP="" # exact lines to comment out
WARN="" # warnings, one per line

add() { ADD="$ADD$1
"; }
warn() { WARN="$WARN$1
"; }

cur_tp="$(get_kv TRUSTED_PROXY)"
if [ -z "$TP" ]; then TP="${cur_tp:-none}"; fi
case "$TP" in
  none | cloudflare | cloudflare-tunnel | cidr:?* | cloudflare-behind:?*) ;;
  *) echo "error: invalid TRUSTED_PROXY \"$TP\"" >&2; exit 2 ;;
esac

# 1. TRUSTED_PROXY itself.
if has_key TRUSTED_PROXY; then
  [ "$cur_tp" = "$TP" ] || warn "TRUSTED_PROXY is already set to \"$cur_tp\"; left alone (edit it by hand if you want \"$TP\")."
  TP="$cur_tp"
else
  add "TRUSTED_PROXY=$TP"
fi

# 2. Settings that go with the value.
case "$TP" in
  cidr:docker-gateway | cloudflare-behind:docker-gateway)
    has_key WEB_BIND || add "WEB_BIND=127.0.0.1"
    ;;
  cloudflare-tunnel)
    cf="$(get_kv COMPOSE_FILE)"
    case "$cf" in
      *docker-compose.tunnel.yml*) ;;
      *) has_key COMPOSE_FILE && warn "COMPOSE_FILE is set without docker-compose.tunnel.yml; add it (docker-compose.yml:docker-compose.tunnel.yml)." \
           || add "COMPOSE_FILE=docker-compose.yml:docker-compose.tunnel.yml" ;;
    esac
    [ -n "$(get_kv CLOUDFLARED_TUNNEL_ID)" ] || warn "Set CLOUDFLARED_TUNNEL_ID in $ENV_FILE (tunnel uuid)."
    [ -n "$(get_kv CLOUDFLARED_CREDENTIALS_FILE)" ] || warn "Set CLOUDFLARED_CREDENTIALS_FILE in $ENV_FILE (path to the tunnel credentials json)."
    warn "Create deploy/cloudflared/config.yml from deploy/cloudflared/config.example.yml; Docker Compose >= 2.24 is required."
    ;;
esac

# 3. Old trust flags: the API refuses to start when one is still "true" without TRUSTED_PROXY.
for line in $(grep -E '^[A-Z_]*_TRUST_(CF_IP|PROXY_HEADERS)=' "$ENV_FILE" | tr ' ' '#'); do
  line="$(echo "$line" | tr '#' ' ')"
  DROP="$DROP$line
"
  warn "Old flag ${line%%=*} is gone; it will be commented out. Its job is now done by TRUSTED_PROXY."
done

# 4. Internal secret: Rust signs the client IP for the API with it; both need the same value.
iss="$(get_kv INTERNAL_SERVICE_SECRET)"
svc="$(get_kv SERVICE_SECRET)"
sec="${iss:-$svc}"
if [ -z "$sec" ]; then
  warn "Neither INTERNAL_SERVICE_SECRET nor SERVICE_SECRET is set: Rust sends \"untrusted\" and client-IP checks never match."
else
  case "$sec" in
    *change-me*) warn "The internal secret is still the sample value; Rust and API refuse to start with it in production." ;;
    *) [ "${#sec}" -ge 32 ] || warn "The internal secret is shorter than 32 characters; generate one with: openssl rand -hex 32" ;;
  esac
fi

# 5. PORT=4000 from the Node era.
if has_key PORT; then
  warn "PORT is set: the Rust server ignores it (use TRINITY_HTTP_PORT); harmless on the Node stack."
fi

echo "== $ENV_FILE: changes =="
if [ -z "$ADD" ] && [ -z "$DROP" ]; then
  echo "(none)"
else
  printf '%s' "$DROP" | while IFS= read -r l; do [ -n "$l" ] && echo "-$l"; done
  printf '%s' "$ADD" | while IFS= read -r l; do [ -n "$l" ] && echo "+$l"; done
fi
if [ -n "$WARN" ]; then
  echo
  echo "== Notes =="
  printf '%s' "$WARN" | while IFS= read -r l; do [ -n "$l" ] && echo "- $l"; done
fi

if [ "$WRITE" = 1 ]; then
  if [ -z "$ADD" ] && [ -z "$DROP" ]; then
    echo; echo "Nothing to write."; exit 0
  fi
  bak="$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
  umask 077
  cp -p "$ENV_FILE" "$bak"
  tmp="$ENV_FILE.tmp.$$"
  DROP_LINES="$DROP" awk '
    BEGIN { n = split(ENVIRON["DROP_LINES"], a, "\n"); for (i = 1; i <= n; i++) if (a[i] != "") d[a[i]] = 1 }
    ($0 in d) { print "# (migrate-env) " $0; next }
    { print }
  ' "$ENV_FILE" > "$tmp"
  if [ -n "$ADD" ]; then
    { echo; echo "# Added by scripts/migrate-env.sh"; printf '%s' "$ADD"; } >> "$tmp"
  fi
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo
  echo "Written. Backup: $bak. Restart to apply: docker compose up -d --build --wait"
else
  echo
  echo "Dry run: nothing was written. Re-run with --write to apply."
fi
