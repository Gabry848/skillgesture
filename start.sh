#!/usr/bin/env bash
# Start the cloud server with a persistent, loopback-only development database.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${1:-}" == "--help" ]]; then
  cat <<'HELP'
Usage: ./start.sh
Starts Docker/Postgres and runs SkillGesture at http://127.0.0.1:8080/mcp.
Requires Node.js 24+, npm, and Docker (Docker Desktop on macOS).
On macOS, the database password is saved in Keychain. Elsewhere set PGPASSWORD.
Ctrl+C stops SkillGesture; the database and its data remain available.
HELP
  exit 0
fi
[[ $# == 0 ]] || { echo 'Usa ./start.sh oppure ./start.sh --help.' >&2; exit 1; }

fail() { echo "Errore: $*" >&2; exit 1; }
for command in node npm docker; do
  command -v "$command" >/dev/null || fail "Installa $command e riprova."
done
[[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 24 ]] || fail 'Serve Node.js 24 o successivo.'

container=skillgesture-postgres
volume=skillgesture-postgres-data
keychain_service=skillgesture-local-postgres
keychain_account=skillgesture
is_macos=false
[[ "$(uname -s)" != Darwin ]] || is_macos=true

if ! docker info >/dev/null 2>&1; then
  if "$is_macos"; then
    echo 'Avvio Docker Desktop...'
    open -a Docker || fail 'Installa e avvia Docker Desktop.'
  else
    fail 'Avvia Docker e riprova.'
  fi
  ready=false
  for ((attempt = 0; attempt < 60; attempt++)); do
    if docker info >/dev/null 2>&1; then ready=true; break; fi
    sleep 2
  done
  "$ready" || fail 'Docker non è pronto dopo 120 secondi. Avvialo e riprova.'
fi

existing=false
if docker container inspect "$container" >/dev/null 2>&1; then existing=true; fi

# Prefer an explicit credential, then Keychain; adopt a previously created
# container's password without printing its environment or resetting its data.
if [[ -z "${PGPASSWORD:-}" ]] && "$is_macos"; then
  PGPASSWORD=$(security find-generic-password -a "$keychain_account" -s "$keychain_service" -w 2>/dev/null) || PGPASSWORD=
fi
if [[ -z "${PGPASSWORD:-}" ]] && "$existing"; then
  PGPASSWORD=$(docker container inspect "$container" | node -e '
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const env = JSON.parse(input)[0].Config.Env ?? [];
      process.stdout.write((env.find(v => v.startsWith("POSTGRES_PASSWORD=")) ?? "").slice(18));
    });
  ')
fi
if [[ -z "${PGPASSWORD:-}" ]]; then
  "$existing" && fail 'Imposta PGPASSWORD con la password del database esistente.'
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    fail 'Il volume dati esiste già: imposta PGPASSWORD con la sua password. I dati sono conservati.'
  fi
  "$is_macos" || fail 'Imposta PGPASSWORD per il database locale e riprova.'
  PGPASSWORD=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
fi
export PGPASSWORD
save_password() {
  if "$is_macos"; then
    security add-generic-password -U -a "$keychain_account" -s "$keychain_service" -w "$PGPASSWORD" >/dev/null 2>&1 \
      || fail 'Non riesco a salvare la password nel Portachiavi. Sbloccalo e riprova.'
  fi
}

if "$existing"; then
  # Use the actual mapped port, including a container from the manual setup.
  PGPORT=$(docker container inspect "$container" | node -e '
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const c = JSON.parse(input)[0];
      const env = c.Config.Env ?? [];
      const ports = c.HostConfig.PortBindings?.["5432/tcp"] ?? [];
      const port = ports[0];
      if (!env.includes("POSTGRES_USER=skillgesture") || !env.includes("POSTGRES_DB=skillgesture") ||
          ports.length !== 1 || port.HostIp !== "127.0.0.1" || !/^[0-9]+$/.test(port.HostPort)) process.exit(1);
      process.stdout.write(port.HostPort);
    });
  ') || fail "Il container $container non corrisponde alla configurazione locale prevista. Nessun dato modificato."
  docker start "$container" >/dev/null
else
  PGPORT=5433
  save_password
  POSTGRES_PASSWORD="$PGPASSWORD" docker run -d \
    --name "$container" --restart unless-stopped \
    -p "127.0.0.1:$PGPORT:5432" \
    -e POSTGRES_USER=skillgesture -e POSTGRES_DB=skillgesture -e POSTGRES_PASSWORD \
    -v "$volume:/var/lib/postgresql" postgres:18-alpine >/dev/null
fi

echo 'Attendo Postgres...'
ready=false
for ((attempt = 0; attempt < 60; attempt++)); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U skillgesture -d skillgesture >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
"$ready" || fail "Postgres non è pronto. Controlla: docker logs $container"

# Test the credential over TCP, rather than the container's trusted Unix socket.
docker exec -e PGPASSWORD "$container" psql -h 127.0.0.1 -U skillgesture -d skillgesture -c 'SELECT 1' >/dev/null 2>&1 \
  || fail 'Password Postgres non valida. Imposta PGPASSWORD con la password corretta e riprova.'
if "$existing"; then save_password; fi

if ! node --input-type=module -e "await import('./src/index.js')" >/dev/null 2>&1; then
  echo 'Installo le dipendenze...'
  npm ci
fi

# This launcher always targets its local database, even in a production shell.
unset DATABASE_URL DATABASE_PASSWORD_FILE TLS_CERT TLS_KEY
export PGHOST=127.0.0.1 PGPORT PGUSER=skillgesture PGDATABASE=skillgesture
export HOST=127.0.0.1 PORT=8080 PUBLIC_URL=http://127.0.0.1:8080/mcp
export ALLOW_INSECURE_LOCALHOST=1 TRUST_PROXY=0
echo "Avvio SkillGesture: $PUBLIC_URL"
echo 'Ctrl+C ferma SkillGesture; Postgres conserva i dati e resta acceso.'
exec node src/index.js
