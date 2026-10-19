#!/usr/bin/env bash
# Mostra le ultime righe di un log come annotazione di errore (visibile anche senza scaricare i log).
f="${1:-ci.log}"; n="${2:-80}"
[ -f "$f" ] || exit 0
msg=$(tail -n "$n" "$f" | sed -e 's/\x1b\[[0-9;]*m//g' | sed -e 's/%/%25/g' | awk 'BEGIN{ORS="%0A"}{print}')
echo "::error title=$(basename "$f")::$msg"
