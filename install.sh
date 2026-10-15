#!/bin/sh
# Trinity installer for the self-hosted (Docker Compose) path.
#
#   ./install.sh            create .env with random secrets, then print the next steps
#   ./install.sh --up       also run `docker compose up --build -d`
#
# Idempotent: if .env already exists it is NEVER modified, the script just reminds you what to do next.
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

UP=0
[ "${1:-}" = "--up" ] && UP=1

if [ -f .env ]; then
  echo ".env already exists, leaving it untouched."
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

  ADMIN_EMAIL="$(grep '^SEED_ADMIN_EMAIL=' .env | cut -d= -f2-)"
  echo "Created .env with freshly generated secrets (file mode 600)."
  echo
  echo "  First admin:  ${ADMIN_EMAIL:-admin@example.com}"
  echo "  Password:     $ADMIN_PASS   (also stored as SEED_ADMIN_PASSWORD in .env; change it after login)"
  echo "  Demo data:    $DEMO   (set SEED_DEMO_DATA=true in .env before the first start if you want sample contacts)"
  echo
fi

if [ "$UP" = 1 ]; then
  docker compose up --build -d
  echo
  echo "Trinity is starting. Open http://localhost:3000 in a minute or two."
else
  echo "Next: docker compose up --build -d    (or re-run ./install.sh --up)"
  echo "Then open http://localhost:3000"
fi
