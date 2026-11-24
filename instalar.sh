#!/bin/sh
set -eu

REPO="${ORQ_REPO:-allopze/omg}"
REF="${ORQ_REF:-main}"
URL="https://github.com/${REPO}/archive/${REF}.tar.gz"

command -v node >/dev/null 2>&1 || { echo "✘ Se requiere Node.js >= 20 en el PATH." >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "✘ Se requiere tar." >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL" -o "$TMP/repo.tar.gz"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP/repo.tar.gz" "$URL"
else
  echo "✘ Se requiere curl o wget." >&2
  exit 1
fi

tar -xzf "$TMP/repo.tar.gz" --strip-components=1 -C "$TMP"
exec node "$TMP/instalar.mjs" "$@"
