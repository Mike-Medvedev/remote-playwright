# Playwright + noVNC in Docker

Run Playwright automation in a container with a virtual display and connect from your phone (or any browser) via noVNC. The stack includes Ubuntu, Xvfb, x11vnc, noVNC, Node.js, and Playwright with Chromium.

## Local run

```bash
# Build
docker build -t playwright-novnc .

# Run (noVNC on 6080; set VNC and Facebook env vars)
docker run -p 6080:6080 \
  -e VNC_PASSWORD=your-vnc-password \
  -e FACEBOOK_EMAIL=your@email.com \
  -e FACEBOOK_PASSWORD=yourpassword \
  playwright-novnc
```

Open **http://localhost:6080**, enter the VNC password, and you’ll see the headed Chromium session.

## CI/CD (GitHub Actions → Docker Hub → Azure Container Instances)

On **push to `main`**, the workflow:

1. Builds the Docker image  
2. Pushes it to Docker Hub  
3. Deploys to Azure Container Instances with a public IP  
4. Prints the noVNC URL and IP in the run log  

Connect from your phone at **http://&lt;public-ip&gt;:6080** and sign in with your VNC password.

---

## GitHub secrets and variables

Configure these in **Settings → Secrets and variables → Actions** before the first run.

### Required secrets

| Secret | Description |
|--------|-------------|
| **DOCKERHUB_USERNAME** | Your Docker Hub username (used to push the image). |
| **DOCKERHUB_TOKEN** | Docker Hub access token (or password). Create at [Docker Hub → Account Settings → Security → New Access Token](https://hub.docker.com/settings/security). Use “Read, Write, Delete” for push. |
| **AZURE_CREDENTIALS** | JSON for an Azure service principal used to deploy to ACI. See below. |
| **VNC_PASSWORD** | Password required to connect to noVNC. Passed into the container and used by x11vnc. Choose a strong value. |

### Optional variables (with defaults)

| Variable | Default | Description |
|----------|---------|-------------|
| **AZURE_RESOURCE_GROUP** | `playwright-novnc-rg` | Resource group for the ACI container group. |
| **AZURE_LOCATION** | `eastus` | Azure region (e.g. `eastus`, `westeurope`). |

---

## Setting up AZURE_CREDENTIALS

1. **Create a service principal** (Azure CLI):

   ```bash
   az login
   az account set --subscription "<subscription-id-or-name>"

   az ad sp create-for-rbac \
     --name "github-actions-playwright-aci" \
     --role contributor \
     --scopes /subscriptions/<subscription-id>/resourceGroups/<resource-group-name> \
     --sdk-auth
   ```

   Replace `<subscription-id>`, `<subscription-id-or-name>`, and `<resource-group-name>` as needed. Use the resource group you’ll use for ACI (e.g. `playwright-novnc-rg`); create it first with `az group create --name playwright-novnc-rg --location eastus` if you want a dedicated group.

2. **Copy the whole JSON output** (starts with `{"clientId":...}`).

3. In GitHub: **Settings → Secrets and variables → Actions → New repository secret**. Name it **AZURE_CREDENTIALS** and paste the JSON as the value.

### Minimal Azure permissions

The principal needs **Contributor** (or a custom role that can create/delete container groups and read resource groups) on the resource group used for ACI. The `--scopes` above limits it to that resource group.

---

## DOCKERHUB_USERNAME and DOCKERHUB_TOKEN

1. **DOCKERHUB_USERNAME**: Your Docker Hub login (e.g. `myuser`).  
2. **DOCKERHUB_TOKEN**: Create at [Docker Hub → Account Settings → Security → New Access Token](https://hub.docker.com/settings/security). Give it “Read, Write, Delete” so the workflow can push the image.  
3. Add both as repository secrets in GitHub.

---

## VNC_PASSWORD

- Choose a strong password and add it as a repository secret **VNC_PASSWORD**.  
- The workflow passes it into the ACI container; x11vnc uses it to protect the VNC session.  
- When you open **http://&lt;public-ip&gt;:6080**, noVNC will prompt for this password.

---

## Summary checklist

- [ ] **DOCKERHUB_USERNAME** – Docker Hub username  
- [ ] **DOCKERHUB_TOKEN** – Docker Hub access token  
- [ ] **AZURE_CREDENTIALS** – Service principal JSON (`az ad sp create-for-rbac ... --sdk-auth`)  
- [ ] **VNC_PASSWORD** – Password for noVNC  
- [ ] (Optional) **AZURE_RESOURCE_GROUP** and **AZURE_LOCATION** – If you don’t want the defaults  

After these are set, push to `main` and use the public IP printed in the workflow log to open noVNC in your phone’s browser.
