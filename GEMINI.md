# Project Gemini Instructions

This file contains instructions and context for Gemini CLI agents working on the `gitargo` project.

## Project Overview
`gitargo` is a web-based UI for managing Argo workflows, featuring a React-based frontend and a Python/Django backend (based on the presence of `static` and `zappa_settings.json` in `.gitignore`).

## Technology Stack
- **Frontend:** React (TypeScript), Tailwind CSS, yarn/npm.
- **Backend:** likely Django/Python (inferred from `.gitignore`).

## Development Standards
- Follow existing patterns in `services/ui/src/components`.
- Use TypeScript for all new frontend code.
- Adhere to ESLint and Prettier configurations.

## Configuration (Environment Variables)
### Backend (`services/api/.env`)
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
### Workflow Creation
Users can select a **Resource Profile** and enable **Ephemeral Volumes** (2Gi) during creation. These settings are automatically injected into the generated YAML templates.
