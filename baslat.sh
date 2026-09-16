#!/usr/bin/env bash
# 6TiSCH 868 MHz Izleme ve Konfigurasyon Paneli baslaticisi
# Kullanim: ./baslat.sh            (varsayilan port 8680)
#           PORT=9000 ./baslat.sh
set -e
cd "$(dirname "$0")"

PORT="${PORT:-8680}"

if [ ! -d .venv ]; then
  echo "[*] Sanal ortam yok, olusturuluyor..."
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi

# Taze 24 saatlik veriyle baslamak isterseniz:
#   rm -f data/dashboard.db*

echo "[*] Panel hazirlaniyor: http://127.0.0.1:$PORT"
exec .venv/bin/uvicorn backend.main:app --host 0.0.0.0 --port "$PORT"
