#!/bin/sh
# Trinity installer for the self-hosted (Docker Compose) path.
#
#   ./install.sh            create .env with random secrets, then print the next steps
#   ./install.sh --up       also run `docker compose up --build -d --wait`
#   ./install.sh --trusted-proxy=VALUE
#                           how Trinity learns the visitor's IP (docs/deployment.md, "Client IP"): none | cloudflare |
#                           cloudflare-tunnel | cidr:<list> | cloudflare-behind:<list>. Without the flag, the script asks
#                           which deployment you use, but ONLY when it runs on a terminal (default: none).
#
# Idempotent: if .env already exists it is NEVER modified: the script only prints the values it would suggest.
set -eu

cd "$(dirname "$0")"

rand_hex() { # $1 = bytes
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

rand_b64_32() { # 32 random bytes, base64 (the format INTEGRATIONS_SECRET_KEY requires)
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32
  else
    head -c 32 /dev/urandom | base64 | tr -d '\n'
  fi
}

# Replace `KEY=...` (also a commented `# KEY=...` line) in .env, or append it. Only used on a .env this run just created.
set_kv() { # $1 = key, $2 = value
  tmp_kv=".env.tmp.kv.$$"
  awk -v k="$1" -v v="$2" '
    BEGIN { done = 0 }
    !done && ($0 ~ "^" k "=" || $0 ~ "^# ?" k "=") { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' .env > "$tmp_kv"
  mv "$tmp_kv" .env
  chmod 600 .env
}

valid_trusted_proxy() {
  case "$1" in
    none | cloudflare | cloudflare-tunnel | cidr:?* | cloudflare-behind:?*) return 0 ;;
    *) return 1 ;;
  esac
}

# Ask which deployment this is; prints the TRUSTED_PROXY value on stdout (menu goes to stderr).
ask_trusted_proxy() {
  {
    echo "How will visitors reach Trinity?"
    echo "  1) Directly on this machine's port (default)             -> none"
    echo "  2) Behind Caddy/nginx installed on this host             -> cidr:docker-gateway"
    echo "  3) Cloudflare connects straight to this machine's port   -> cloudflare"
    echo "  4) Cloudflare Tunnel (cloudflared in Docker Compose)     -> cloudflare-tunnel"
    echo "  5) Type another value (see docs/deployment.md)"
    printf "Choose [1-5, Enter = 1]: "
  } >&2
  read -r choice || choice=""
  case "$choice" in
    2) echo "cidr:docker-gateway" ;;
    3) echo "cloudflare" ;;
    4) echo "cloudflare-tunnel" ;;
    5)
      printf "TRUSTED_PROXY value: " >&2
      read -r custom || custom=""
      echo "$custom"
      ;;
    *) echo "none" ;;
  esac
}

UP=0
TP=""
for arg in "$@"; do
  case "$arg" in
    --up) UP=1 ;;
    --trusted-proxy=*) TP="${arg#--trusted-proxy=}" ;;
    *) echo "error: unknown option $arg" >&2; exit 2 ;;
  esac
done

if [ -z "$TP" ]; then
  if [ -t 0 ] && [ -t 1 ]; then
    TP="$(ask_trusted_proxy)"
  else
    TP="none"
  fi
fi
valid_trusted_proxy "$TP" || { echo "error: invalid TRUSTED_PROXY \"$TP\" (none | cloudflare | cloudflare-tunnel | cidr:<list> | cloudflare-behind:<list>)" >&2; exit 2; }

# Companion settings that go with the chosen value.
WEB_BIND_SUGGEST=""
COMPOSE_FILE_SUGGEST=""
case "$TP" in
  cidr:docker-gateway | cloudflare-behind:docker-gateway) WEB_BIND_SUGGEST="127.0.0.1" ;;
  cloudflare-tunnel) COMPOSE_FILE_SUGGEST="docker-compose.yml:docker-compose.tunnel.yml" ;;
esac

print_proxy_values() {
  echo "  TRUSTED_PROXY=$TP"
  [ -n "$WEB_BIND_SUGGEST" ] && echo "  WEB_BIND=$WEB_BIND_SUGGEST"
  if [ -n "$COMPOSE_FILE_SUGGEST" ]; then
    echo "  COMPOSE_FILE=$COMPOSE_FILE_SUGGEST     (needs Docker Compose >= 2.24)"
    echo "  CLOUDFLARED_TUNNEL_ID=<tunnel uuid>"
    echo "  CLOUDFLARED_CREDENTIALS_FILE=<path to the tunnel credentials json>"
    echo "  and: cp deploy/cloudflared/config.example.yml deploy/cloudflared/config.yml   (edit the hostname)"
  fi
  return 0
}

if [ -f .env ]; then
  echo ".env already exists, leaving it untouched."
  echo "Suggested client-IP settings for your choice (add them yourself, or run scripts/migrate-env.sh):"
  print_proxy_values
  echo
else
  [ -f .env.example ] || { echo "error: .env.example not found, run this from the repository root" >&2; exit 1; }

  PG_PASS="$(rand_hex 16)"
  JWT="$(rand_hex 32)"
  SVC="$(rand_hex 32)"
  INT_KEY="$(rand_b64_32)"
  ADMIN_PASS="$(rand_hex 9)"
  # Demo contacts are off by default; run `SEED_DEMO_DATA=true ./install.sh` to include them.
  DEMO="${SEED_DEMO_DATA:-false}"

  umask 077
  tmp=".env.tmp.$$"
  # Replace the value of every key we generate; every other line is copied as-is.
  awk -v pg="$PG_PASS" -v jwt="$JWT" -v svc="$SVC" -v ik="$INT_KEY" -v ap="$ADMIN_PASS" -v demo="$DEMO" '
    BEGIN { FS = OFS = "=" }
    /^POSTGRES_PASSWORD=/          { print "POSTGRES_PASSWORD=" pg; next }
    /^DATABASE_URL=/               { print "DATABASE_URL=postgresql://trinity:" pg "@localhost:5432/trinity"; next }
    /^JWT_SECRET=/                 { print "JWT_SECRET=" jwt; next }
    /^SERVICE_SECRET=/             { print "SERVICE_SECRET=" svc; next }
    /^INTERNAL_SERVICE_SECRET=/    { print "INTERNAL_SERVICE_SECRET=" svc; next }
    /^INTEGRATIONS_SECRET_KEY=/    { print "INTEGRATIONS_SECRET_KEY=" ik; next }
    /^SEED_ADMIN_PASSWORD=/        { print "SEED_ADMIN_PASSWORD=" ap; next }
    /^SEED_DEMO_DATA=/             { print "SEED_DEMO_DATA=" demo; next }
    { print }
  ' .env.example > "$tmp"
  mv "$tmp" .env
  chmod 600 .env

  set_kv TRUSTED_PROXY "$TP"
  [ -n "$WEB_BIND_SUGGEST" ] && set_kv WEB_BIND "$WEB_BIND_SUGGEST"
  [ -n "$COMPOSE_FILE_SUGGEST" ] && set_kv COMPOSE_FILE "$COMPOSE_FILE_SUGGEST"

  ADMIN_EMAIL="$(grep '^SEED_ADMIN_EMAIL=' .env | cut -d= -f2-)"
  echo "Created .env with freshly generated secrets (file mode 600)."
  echo
  echo "  First admin:  ${ADMIN_EMAIL:-admin@example.com}"
  echo "  Password:     $ADMIN_PASS   (also stored as SEED_ADMIN_PASSWORD in .env; change it after login)"
  echo "  Demo data:    $DEMO   (set SEED_DEMO_DATA=true in .env before the first start if you want sample contacts)"
  echo "  Client IP:    TRUSTED_PROXY=$TP"
  if [ -n "$COMPOSE_FILE_SUGGEST" ]; then
    echo "  Tunnel:       fill CLOUDFLARED_TUNNEL_ID and CLOUDFLARED_CREDENTIALS_FILE in .env and create"
    echo "                deploy/cloudflared/config.yml from deploy/cloudflared/config.example.yml before starting."
  fi
  echo
fi

if [ "$UP" = 1 ]; then
  if grep -q '^TRUSTED_PROXY=cloudflare-tunnel' .env; then
    for key in CLOUDFLARED_TUNNEL_ID CLOUDFLARED_CREDENTIALS_FILE; do
      grep -q "^$key=." .env || { echo "error: TRUSTED_PROXY=cloudflare-tunnel needs $key in .env (see docker-compose.tunnel.yml)" >&2; exit 1; }
    done
    grep -q '^COMPOSE_FILE=.*docker-compose.tunnel.yml' .env || { echo "error: TRUSTED_PROXY=cloudflare-tunnel needs COMPOSE_FILE=docker-compose.yml:docker-compose.tunnel.yml in .env" >&2; exit 1; }
    [ -f deploy/cloudflared/config.yml ] || { echo "error: deploy/cloudflared/config.yml is missing (copy deploy/cloudflared/config.example.yml)" >&2; exit 1; }
  fi
  # --wait: fails when a service is unhealthy, including the trinity health check (`trinity healthcheck`, GET /api/v1/health).
  docker compose up --build -d --wait --wait-timeout 300 || {
    echo "error: the stack did not become healthy; see: docker compose ps && docker compose logs trinity postgres" >&2
    exit 1
  }
  echo
  echo "Trinity is starting. Open http://localhost:3000 in a minute or two."
else
  echo "Next: docker compose up --build -d --wait    (or re-run ./install.sh --up)"
  echo "Then open http://localhost:3000"
fi
