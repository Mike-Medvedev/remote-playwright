#!/usr/bin/env bash
set -euo pipefail

# --- Validate required env vars up front ---
if [ -z "${VNC_PASSWORD:-}" ]; then
    echo "ERROR: VNC_PASSWORD environment variable is not set. Refusing to start."
    exit 1
fi

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

# --- Wait for Xvfb to be genuinely ready (no sleep guessing) ---
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

# --- 2. Store VNC password and start x11vnc ---
x11vnc -storepasswd "${VNC_PASSWORD}" /tmp/vncpasswd
chmod 600 /tmp/vncpasswd

echo "[entrypoint] Starting x11vnc on port ${VNC_PORT}"
x11vnc \
    -display "${DISPLAY}" \
    -rfbauth /tmp/vncpasswd \
    -rfbport "${VNC_PORT}" \
    -forever \
    -shared \
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
sleep 10
node /app/playwright/script.js
echo "[entrypoint] Playwright script finished."
