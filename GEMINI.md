# Project Gemini Instructions

This file contains instructions and context for Gemini CLI agents working on the `gitargo` project.

## Project Overview
`gitargo` is a web-based UI for managing Argo workflows, featuring a React-based frontend and a Python/Django backend (based on the presence of `static` and `zappa_settings.json` in `.gitignore`).

## Technology Stack
- **Frontend:** React (TypeScript), Tailwind CSS, Vite.
- **Backend:** Node.js (Express), `@kubernetes/client-node`.

## Development Standards
- Follow existing patterns in `services/ui/src/components`.
- Use TypeScript for all new frontend code.
- Adhere to ESLint and Prettier configurations.

## Configuration (Environment Variables)
### Backend (`services/api/.env`)
- `MULTI_TENANT_MODE`: Set to `true` to isolate GitLab workflow storage under user folders (`workflows/<username>/`) and restrict execution visibility to the creating user.
- `GITLAB_PACKAGES_PATH`: Subfolder in GitLab for saving CWL Application Packages (default `packages`).
- `JUPYTERHUB_PVC_NAME`: Name of the shared PersistentVolumeClaim (default `jupyterhub-home`) mounted into executions with `subPath: <username>`.
- `JUPYTER_PVC_MOUNT_PATH`: Mount point on the Gitargo API pod for workspace file browsing (default `/shared-workspace`).
- `ARGO_PROFILES`: JSON string defining resource profiles.
  ```json
  {
    "gpu": {
      "label": "GPU Profile",
      "resources": { "limits": { "nvidia.com/gpu": "1" } },
      "tolerations": [ { "key": "gpu", "operator": "Exists", "effect": "NoSchedule" } ]
    }
  }
  ```
- `ARGO_NAMESPACE`: Default namespace for workflows.
- `ARGO_SERVICE_ACCOUNT`: Default service account.

## Features
### OGC Application Packages (CWL)
Users can load remote CWL application package definitions (e.g. from GitHub), configure input parameters, and execute them on Kubernetes using `cwltool`. Executions automatically output results into their isolated `/workspace/results` folder on the `jupyterhub-home` PVC.

### Workspace File Browser
Users can browse, preview, and download result files directly from their mounted workspace PVC via the Gitargo UI without opening JupyterLab.
