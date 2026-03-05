#!/usr/bin/env bash
set -euo pipefail

echo "[entrypoint] Starting up..."

# --- Clean up any stale X lock files from previous runs ---
rm -f /tmp/.X99-lock /tmp/.x11-unix/X99

# --- 1. Start Xvfb ---
echo "[entrypoint] Starting Xvfb on ${DISPLAY}"
Xvfb "${DISPLAY}" \
    -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x${SCREEN_DEPTH}" \
    -ac \
    -nolisten tcp \
    +extension RANDR \
    &
XVFB_PID=$!

# --- Wait for Xvfb to be genuinely ready ---
echo "[entrypoint] Waiting for Xvfb to be ready..."
for i in $(seq 1 15); do
    if xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; then
        echo "[entrypoint] Xvfb is ready."
        break
    fi
    if [ "$i" -eq 15 ]; then
        echo "ERROR: Xvfb failed to start after 15 seconds. Aborting."
        exit 1
    fi
    sleep 1
done

# --- 2. Start x11vnc (no password) ---
echo "[entrypoint] Starting x11vnc on port ${VNC_PORT} (no password)"
x11vnc \
    -display "${DISPLAY}" \
    -rfbport "${VNC_PORT}" \
    -forever \
    -shared \
    -nopw \
    -noxdamage \
    -noxfixes \
    -quiet \
    &
X11VNC_PID=$!

# --- 3. Start noVNC ---
echo "[entrypoint] Starting noVNC on port ${NOVNC_PORT}"
/opt/novnc/utils/novnc_proxy \
    --vnc "localhost:${VNC_PORT}" \
    --listen "${NOVNC_PORT}" \
    &
NOVNC_PID=$!

echo "[entrypoint] All services up. Open http://<your-ip>:${NOVNC_PORT} in your browser."

# --- Graceful shutdown: clean up all child processes on exit ---
cleanup() {
    echo "[entrypoint] Shutting down all services..."
    kill "${NOVNC_PID}" "${X11VNC_PID}" "${XVFB_PID}" 2>/dev/null || true
    wait "${NOVNC_PID}" "${X11VNC_PID}" "${XVFB_PID}" 2>/dev/null || true
    echo "[entrypoint] Shutdown complete."
}
trap cleanup SIGTERM SIGINT EXIT

# --- 4. Run Playwright script ---
echo "[entrypoint] Starting Playwright script..."
node /app/playwright/script.js
echo "[entrypoint] Playwright script finished."
