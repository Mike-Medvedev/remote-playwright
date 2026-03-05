# Facebook Session Capture (Playwright + noVNC)

Automated container that captures authenticated Facebook Marketplace sessions using Playwright with a persistent browser profile. Runs headless with noVNC for human-in-the-loop login when needed.

## How it works

1. **Launch** -- Container starts Xvfb, x11vnc (no password), noVNC, and the Playwright script
2. **Persistent context** -- Playwright uses `/data/browser-profile` (Azure File Share) so cookies and browser state survive between runs
3. **Login detection** -- Navigates to Facebook Marketplace and checks if the user is already logged in
4. **If not logged in** -- POSTs to `{WEBHOOK_URL}/webhook/needs-login` with the noVNC URL, then waits for a human to log in via noVNC
5. **Session capture** -- Intercepts a Marketplace GraphQL request and extracts headers, cookies, and POST body
6. **POST session** -- Sends the captured session to `{WEBHOOK_URL}/webhook/refresh` and exits

## Local run

```bash
# Build
docker build -t playwright-novnc .

# Run (mount a local dir as the persistent profile)
docker run -p 6080:6080 \
  -e WEBHOOK_URL=https://your-backend.example.com \
  -v $(pwd)/browser-profile:/data/browser-profile \
  playwright-novnc
```

Open **http://localhost:6080** -- no password needed.

## GitHub secrets and variables

### Required secrets

| Secret | Description |
|--------|-------------|
| **DOCKERHUB_USERNAME** | Docker Hub username |
| **DOCKERHUB_TOKEN** | Docker Hub access token |
| **AZURE_CREDENTIALS** | Service principal JSON for ACI deployment |
| **WEBHOOK_URL** | Backend base URL (e.g. `https://api.example.com`). The script POSTs to `/webhook/needs-login` and `/webhook/refresh` |
| **AZURE_STORAGE_ACCOUNT** | Azure Storage account name for the file share |
| **AZURE_STORAGE_KEY** | Azure Storage account key |

### Required variables

| Variable | Description |
|----------|-------------|
| **AZURE_RESOURCE_GROUP** | Resource group for ACI |
| **AZURE_LOCATION** | Azure region (e.g. `eastus`) |
| **AZURE_FILE_SHARE_NAME** | Name of the Azure File Share mounted at `/data/browser-profile` |

## Webhook payloads

### `POST /webhook/needs-login`

Sent when the container detects that human login is required.

```json
{
  "novncUrl": "http://<container-ip>:6080"
}
```

### `POST /webhook/refresh`

Sent after successfully capturing an authenticated session.

```json
{
  "headers": {
    "cookie": "datr=...; sb=...; c_user=...; xs=...",
    "x-fb-lsd": "abc123",
    "x-asbd-id": "129477",
    "...": "..."
  },
  "body": "av=100012345&__user=100012345&__a=1&...",
  "capturedAt": "2026-03-05T10:30:00.000Z"
}
```
