require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const YAML = require('yaml');
const k8s = require('@kubernetes/client-node');

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables
const GITLAB_URL = process.env.GITLAB_URL || 'https://gitlab.com';
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
const GITLAB_PROJECT_ID = process.env.GITLAB_PROJECT_ID;
const GITLAB_BRANCH = process.env.GITLAB_BRANCH || 'main';
const GITLAB_WORKFLOWS_PATH = process.env.GITLAB_WORKFLOWS_PATH || '.';

if (!GITLAB_TOKEN || !GITLAB_PROJECT_ID) {
  console.error('ERROR: GITLAB_TOKEN and GITLAB_PROJECT_ID are required environment variables.');
  process.exit(1);
}

// GitLab API client
const gitlabApi = axios.create({
  baseURL: `${GITLAB_URL}/api/v4`,
  headers: {
    'PRIVATE-TOKEN': GITLAB_TOKEN,
  },
});

// CORS configuration to support authenticated requests (withCredentials: true)
const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS 
  ? process.env.CORS_ALLOWED_ORIGINS.split(',') 
  : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:8000', 'http://localhost:8080'];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV !== 'production') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Helper to decode JWT payload without verification (for logging claims only)
function decodeJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64').toString();
    return JSON.parse(payload);
  } catch (e) {
    return null;
  }
}

// Simple Authentication Middleware (Checks session token/header)
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.headers.cookie) {
    const cookies = req.headers.cookie.split(';').reduce((acc, cookie) => {
      const [key, value] = cookie.trim().split('=');
      acc[key] = value;
      return acc;
    }, {});
    token = cookies['access_token'] || cookies['id_token'] || cookies['appSession'];
  }

  if (token) {
    req.token = token;
    req.user = decodeJwt(token);
  }
  next();
});

const requiresAuth = (req, res, next) => {
  if (req.user || process.env.NODE_ENV === 'development') {
    return next();
  }
  res.status(401).json({ 
    message: 'Authentication Required',
    loginUrl: `${BASE_PATH}/login` 
  });
};

const BASE_PATH = process.env.BASE_PATH || "";
console.log(`Application BASE_PATH is set to: "${BASE_PATH}"`);

// Helper to serve index.html with injected BASE_PATH config
const serveIndex = (req, res) => {
  const indexPath = path.join(__dirname, "public", "index.html");

  fs.readFile(indexPath, "utf8", (err, data) => {
    if (err) {
      return res.status(500).send("Error loading index.html");
    }
    // Inject the BASE_PATH into the head so the SPA can read it
    const injectedData = data.replace(
      "<head>",
      `<head><script>window.BASE_PATH = "${BASE_PATH}";</script>`
    );
    res.send(injectedData);
  });
};

// 1. Serve static files from the public directory
if (BASE_PATH !== "") {
  app.use(
    `${BASE_PATH}/static`,
    express.static(path.join(__dirname, "public", "static"))
  );
}
app.use("/static", express.static(path.join(__dirname, "public", "static")));
app.use(express.static(path.join(__dirname, "public")));

// --- Validation Middleware ---
const allowedArgoKinds = [
  "Workflow",
  "CronWorkflow",
  "WorkflowTemplate"
];

const validateArgoWorkflow = (req, res, next) => {
  const { content } = req.body;
  if (!content) {
    return res.status(400).json({ message: "Content is required." });
  }

  try {
    const parsed = YAML.parse(content);
    if (!parsed || typeof parsed !== "object") {
      return res.status(400).json({ message: "Invalid YAML format." });
    }

    if (!parsed.kind) {
      return res.status(400).json({ message: "Missing 'kind' field in YAML." });
    }

    if (!allowedArgoKinds.includes(parsed.kind)) {
      return res.status(400).json({
        message: `Invalid 'kind'. Only Argo Workflow definitions are allowed. Received: '${parsed.kind}'. Allowed kinds: ${allowedArgoKinds.join(", ")}.`
      });
    }

    next();
  } catch (error) {
    return res
      .status(400)
      .json({ message: `YAML Parsing Error: ${error.message}` });
  }
};

// --- Configuration & Profiles ---
const DEFAULT_PROFILES = {
  "cpu-standard": {
    label: "Standard CPU (2 CPU, 4Gi RAM)",
    resources: {
      limits: { cpu: "2", memory: "4Gi" },
      requests: { cpu: "500m", memory: "1Gi" }
    }
  },
  "cpu-performance": {
    label: "Performance CPU (10 CPU, 48Gi RAM)",
    resources: {
      limits: { cpu: "10", memory: "48Gi" },
      requests: { cpu: "5", memory: "24Gi" }
    }
  },
  "gpu-nvidia": {
    label: "NVIDIA GPU (1 GPU, 4 CPU, 16Gi RAM)",
    resources: {
      limits: { "nvidia.com/gpu": "1", cpu: "4", memory: "16Gi" },
      requests: { "nvidia.com/gpu": "1", cpu: "2", memory: "8Gi" }
    },
    tolerations: [
      { key: "nvidia.com/gpu", operator: "Exists", effect: "NoSchedule" }
    ]
  }
};

let ARGO_PROFILES = DEFAULT_PROFILES;
if (process.env.ARGO_PROFILES) {
  try {
    ARGO_PROFILES = JSON.parse(process.env.ARGO_PROFILES);
  } catch (e) {
    console.error("Failed to parse ARGO_PROFILES from environment, using defaults.", e);
  }
}

const EPHEMERAL_VOLUME_CONFIG = {
  name: "ephemeral-workdir",
  storage: "2Gi",
  storageClassName: "csi-disk",
  mountPath: "/workdir"
};

// Helper to get GitLab commit author options from session user
function getCommitOptions(req) {
  const options = {};
  if (req.user) {
    options.author_name = req.user.name || req.user.nickname || req.user.preferred_username || req.user.sub;
    options.author_email = req.user.email;
  }
  return options;
}

// --- 2. API ROUTES ---

const apiRouter = express.Router();

/**
 * GET /api/diag/token
 * Diagnostic endpoint to view the current session token claims.
 */
apiRouter.get("/diag/token", (req, res) => {
  if (!req.user) {
    return res.status(401).json({ message: "No session found." });
  }

  res.json({
    user: req.user,
    token: req.token ? "present" : "missing"
  });
});

// Protect all /api routes
apiRouter.use((req, res, next) => {
  // Skip protection for diagnostic endpoint
  if (req.path === "/diag/token") return next();
  requiresAuth(req, res, next);
});

/**
 * GET /api/config
 * Expose relevant configuration and profiles to the frontend.
 */
apiRouter.get("/config", (req, res) => {
  res.json({
    profiles: ARGO_PROFILES,
    ephemeralVolume: EPHEMERAL_VOLUME_CONFIG,
    allowPublishing: process.env.ALLOW_PUBLISHING === "true",
    experimentalCanvas: process.env.EXPERIMENTAL_CANVAS === "true",
    logViewerUrl: process.env.LOG_VIEWER_URL || `https://hub-test.eox.at/services/eoxhub-gateway/cif/log-viewer/search`,
    defaults: {
      namespace: process.env.ARGO_NAMESPACE || "default",
      serviceAccount: process.env.ARGO_SERVICE_ACCOUNT || "default"
    }
  });
});

// Helper to convert a frontend virtual path to a physical GitLab path
function getGitLabPath(virtualPath) {
  const cleanVirtualPath = virtualPath.replace(/^\//, "");
  if (!GITLAB_WORKFLOWS_PATH || GITLAB_WORKFLOWS_PATH === ".") {
    return cleanVirtualPath;
  }
  const basePath = GITLAB_WORKFLOWS_PATH.replace(/\/$/, "").replace(/^\//, "");
  return `${basePath}/${cleanVirtualPath}`;
}

/**
 * GET /api/published-workflows
 * Get the list of published workflow IDs from pygeoapi/hr-pygeoapi.yaml.
 */
apiRouter.get("/published-workflows", async (req, res, next) => {
  try {
    const filePath = "pygeoapi/hr-pygeoapi.yaml";
    try {
      const response = await gitlabApi.get(
        `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(filePath)}/raw`,
        { params: { ref: GITLAB_BRANCH } }
      );
      const parsed = YAML.parse(response.data);
      const published = parsed?.spec?.values?.argoWorkflows || [];
      res.json(published.map(p => p.id));
    } catch (error) {
      if (error.response && error.response.status === 404) {
        return res.json([]);
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/workflows/.../publish
 * Publish a workflow template to pygeoapi/hr-pygeoapi.yaml.
 */
apiRouter.post("/workflows/*/publish", async (req, res, next) => {
  try {
    const virtualPath = req.params[0];
    const filename = virtualPath.split('/').pop();
    const logicalName = filename.replace(/\.ya?ml$/i, "");
    const filePath = "pygeoapi/hr-pygeoapi.yaml";

    let content = "";
    let action = "update";

    try {
      const response = await gitlabApi.get(
        `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(filePath)}/raw`,
        { params: { ref: GITLAB_BRANCH } }
      );
      content = response.data;
    } catch (error) {
      if (error.response && error.response.status === 404) {
        action = "create";
        content = "spec:\n  values:\n    argoWorkflow: []";
      } else {
        throw error;
      }
    }

    const parsed = YAML.parse(content) || {};
    if (!parsed.spec) parsed.spec = {};
    if (!parsed.spec.values) parsed.spec.values = {};
    if (!parsed.spec.values.argoWorkflows) parsed.spec.values.argoWorkflows = [];

    const exists = parsed.spec.values.argoWorkflows.some(w => w.id === logicalName);
    if (!exists) {
      parsed.spec.values.argoWorkflows.push({
        id: logicalName,
        workflowTemplate: logicalName
      });

      await gitlabApi.post(
        `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
        {
          branch: GITLAB_BRANCH,
          commit_message: `Publish ${logicalName} to pygeoapi`,
          actions: [
            {
              action: action,
              file_path: filePath,
              content: YAML.stringify(parsed)
            }
          ]
        }
      );
    }

    res.json({ message: `Workflow ${logicalName} published successfully.` });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/workflows/.../publish
 * Unpublish a workflow template from pygeoapi/hr-pygeoapi.yaml.
 */
apiRouter.delete("/workflows/*/publish", async (req, res, next) => {
  try {
    const virtualPath = req.params[0];
    const filename = virtualPath.split('/').pop();
    const logicalName = filename.replace(/\.ya?ml$/i, "");
    const filePath = "pygeoapi/hr-pygeoapi.yaml";

    try {
      const response = await gitlabApi.get(
        `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(filePath)}/raw`,
        { params: { ref: GITLAB_BRANCH } }
      );
      
      const parsed = YAML.parse(response.data);
      if (parsed?.spec?.values?.argoWorkflows) {
        const initialLength = parsed.spec.values.argoWorkflows.length;
        parsed.spec.values.argoWorkflows = parsed.spec.values.argoWorkflows.filter(
          w => w.id !== logicalName
        );

        if (parsed.spec.values.argoWorkflows.length < initialLength) {
          await gitlabApi.post(
            `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
            {
              branch: GITLAB_BRANCH,
              commit_message: `Unpublish ${logicalName} from pygeoapi`,
              actions: [
                {
                  action: "update",
                  file_path: filePath,
                  content: YAML.stringify(parsed)
                }
              ]
            }
          );
        }
      }
      res.json({ message: `Workflow ${logicalName} unpublished successfully.` });
    } catch (error) {
      if (error.response && error.response.status === 404) {
        return res.json({ message: "File not found, nothing to unpublish." });
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/workflows
 * List files ending in .yaml, .yml, or .deleted in the GITLAB_WORKFLOWS_PATH.
 */
apiRouter.get("/workflows", async (req, res, next) => {
  try {
    const response = await gitlabApi.get(
      `/projects/${GITLAB_PROJECT_ID}/repository/tree`,
      {
        params: {
          path: GITLAB_WORKFLOWS_PATH === "." ? "" : GITLAB_WORKFLOWS_PATH,
          ref: GITLAB_BRANCH,
          recursive: true
        }
      }
    );

    const prefix = GITLAB_WORKFLOWS_PATH && GITLAB_WORKFLOWS_PATH !== "." 
      ? `${GITLAB_WORKFLOWS_PATH.replace(/\/$/, "")}/` 
      : "";

    const workflows = response.data
      .filter(
        (file) =>
          file.type === "blob" &&
          (file.name.endsWith(".yaml") || file.name.endsWith(".yml") || file.name.endsWith(".deleted"))
      )
      .map((file) => {
        let relativePath = file.path;
        if (prefix && relativePath.startsWith(prefix)) {
          relativePath = relativePath.slice(prefix.length);
        }
        return { ...file, path: relativePath };
      });

    res.json(workflows);
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return res.json([]);
    }
    next(error);
  }
});

/**
 * GET /api/workflows/.../history
 * Get the commit history for a file.
 */
apiRouter.get("/workflows/*/history", async (req, res, next) => {
  try {
    const virtualPath = req.params[0];
    const filePath = getGitLabPath(virtualPath);
    const response = await gitlabApi.get(
      `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
      {
        params: {
          path: filePath,
          ref_name: GITLAB_BRANCH
        }
      }
    );

    res.json(response.data);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/workflows/<path>
 * Get the raw content of a file.
 */
apiRouter.get("/workflows/*", async (req, res, next) => {
  // If the wildcard matches nothing, req.params[0] might be undefined.
  if (req.path === '/workflows/' || req.path === '/workflows') return next();

  try {
    const virtualPath = req.params[0];
    const filePath = getGitLabPath(virtualPath);
    const ref = req.query.ref || GITLAB_BRANCH;

    const response = await gitlabApi.get(
      `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(filePath)}/raw`,
      {
        params: {
          ref: ref
        }
      }
    );

    res.send(response.data);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/workflows/<path>/restore
 * Restore a soft-deleted workflow.
 */
apiRouter.post("/workflows/*/restore", async (req, res, next) => {
  try {
    const virtualPath = req.params[0];
    const filePath = getGitLabPath(virtualPath);
    const originalPath = filePath.replace(/\.deleted$/, "");

    const response = await gitlabApi.post(
      `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
      {
        branch: GITLAB_BRANCH,
        commit_message: `Restore ${originalPath}`,
        actions: [
          {
            action: "move",
            previous_path: filePath,
            file_path: originalPath
          }
        ]
      }
    );

    res.json(response.data);
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/workflows/*
 * Soft-delete a workflow by renaming it with a .deleted extension.
 */
apiRouter.delete("/workflows/*", async (req, res, next) => {
  try {
    const virtualPath = req.params[0];
    const filePath = getGitLabPath(virtualPath);
    
    const response = await gitlabApi.post(
      `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
      {
        branch: GITLAB_BRANCH,
        commit_message: `Delete ${filePath}`,
        actions: [
          {
            action: "move",
            previous_path: filePath,
            file_path: `${filePath}.deleted`
          }
        ]
      }
    );

    res.json(response.data);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/workflows/*
 * Create a new file.
 */
apiRouter.post(
  "/workflows/*",
  validateArgoWorkflow,
  async (req, res, next) => {
    try {
      const virtualPath = req.params[0];
      const filePath = getGitLabPath(virtualPath);
      const { content, commit_message, applyDefaults } = req.body;

      // Inject defaults if requested
      const injectedContent = applyDefaults 
        ? injectDefaults(content, virtualPath)
        : content;

      const response = await gitlabApi.post(
        `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
        {
          branch: GITLAB_BRANCH,
          commit_message: commit_message || `Create ${filePath}`,
          ...getCommitOptions(req),
          actions: [
            {
              action: "create",
              file_path: filePath,
              content: injectedContent
            }
          ]
        }
      );

      res.status(201).json(response.data);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PUT /api/workflows/*
 * Update an existing file.
 */
apiRouter.put(
  "/workflows/*",
  validateArgoWorkflow,
  async (req, res, next) => {
    try {
      const virtualPath = req.params[0];
      const filePath = getGitLabPath(virtualPath);
      const { content, commit_message, applyDefaults } = req.body;

      // Inject defaults if requested
      const injectedContent = applyDefaults 
        ? injectDefaults(content, virtualPath)
        : content;

      try {
        const response = await gitlabApi.post(
          `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
          {
            branch: GITLAB_BRANCH,
            commit_message: commit_message || `Update ${filePath}`,
            ...getCommitOptions(req),
            actions: [
              {
                action: "update",
                file_path: filePath,
                content: injectedContent
              }
            ]
          }
        );
        res.json(response.data);
      } catch (putError) {
        // If the file doesn't exist yet, GitLab PUT returns 400. 
        // We gracefully fallback to POST (create) action.
        if (
          putError.response &&
          putError.response.status === 400 &&
          putError.response.data &&
          putError.response.data.message &&
          putError.response.data.message.includes("A file with this name doesn't exist")
        ) {
          const postResponse = await gitlabApi.post(
            `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
            {
              branch: GITLAB_BRANCH,
              commit_message: commit_message || `Create ${filePath}`,
              actions: [
                {
                  action: "create",
                  file_path: filePath,
                  content: injectedContent
                }
              ]
            }
          );
          return res.status(201).json(postResponse.data);
        }
        // Otherwise re-throw the original error
        throw putError;
      }
    } catch (error) {
      next(error);
    }
  }
);

// --- Helper for injecting defaults ---
function injectDefaults(content, virtualPath) {
  const ARGO_NAMESPACE = process.env.ARGO_NAMESPACE;
  const ARGO_SERVICE_ACCOUNT = process.env.ARGO_SERVICE_ACCOUNT;
  const ARGO_TOLERATIONS = process.env.ARGO_TOLERATIONS;
  const ARGO_NODE_SELECTOR = process.env.ARGO_NODE_SELECTOR;
  const ARGO_AFFINITY = process.env.ARGO_AFFINITY;

  try {
    const parsed = YAML.parse(content);
    if (!parsed || typeof parsed !== "object") return content;

    if (!parsed.metadata) parsed.metadata = {};
    
    // Extract logical name from the path (e.g. workspaces/paquito.yaml -> paquito)
    let logicalName = "workflow-default";
    if (virtualPath) {
      const parts = virtualPath.split('/');
      const filename = parts[parts.length - 1];
      logicalName = filename.replace(/\.ya?ml$/i, "");
    }

    // Ensure metadata.name or generateName is present
    if (!parsed.metadata.name && !parsed.metadata.generateName) {
      parsed.metadata.name = logicalName;
      parsed.metadata.generateName = `${logicalName}-`;
    } else if (parsed.metadata.name && !parsed.metadata.generateName) {
      // If name is present but generateName is not, add generateName
      parsed.metadata.generateName = `${parsed.metadata.name}-`;
    }

    if (ARGO_NAMESPACE && !parsed.metadata.namespace) {
      parsed.metadata.namespace = ARGO_NAMESPACE;
    }

    if (!parsed.spec) parsed.spec = {};
    const isCron = parsed.kind === "CronWorkflow";
    if (isCron && !parsed.spec.workflowSpec) parsed.spec.workflowSpec = {};
    const spec = isCron ? parsed.spec.workflowSpec : parsed.spec;

    if (spec) {
      if (ARGO_SERVICE_ACCOUNT && !spec.serviceAccountName) {
        spec.serviceAccountName = ARGO_SERVICE_ACCOUNT;
      }

      if (ARGO_TOLERATIONS && (!spec.tolerations || spec.tolerations.length === 0)) {
        try {
          spec.tolerations = JSON.parse(ARGO_TOLERATIONS);
        } catch (e) {
          console.error("Failed to parse ARGO_TOLERATIONS", e);
        }
      }

      if (ARGO_NODE_SELECTOR && (!spec.nodeSelector || Object.keys(spec.nodeSelector).length === 0)) {
        try {
          spec.nodeSelector = JSON.parse(ARGO_NODE_SELECTOR);
        } catch (e) {
          console.error("Failed to parse ARGO_NODE_SELECTOR", e);
        }
      }

      if (ARGO_AFFINITY && (!spec.affinity || Object.keys(spec.affinity).length === 0)) {
        try {
          spec.affinity = JSON.parse(ARGO_AFFINITY);
        } catch (e) {
          console.error("Failed to parse ARGO_AFFINITY", e);
        }
      }
    }

    return YAML.stringify(parsed);
  } catch (error) {
    console.error("Error injecting defaults:", error);
    return content;
  }
}


// --- Kubernetes Client Initialization ---
const kc = new k8s.KubeConfig();
const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';

try {
  if (fs.existsSync(SA_TOKEN_PATH)) {
    console.log(`Found ServiceAccount token at ${SA_TOKEN_PATH}`);
    kc.loadFromCluster();
  } else {
    console.warn(`ServiceAccount token NOT FOUND at ${SA_TOKEN_PATH}. Falling back to default config.`);
    kc.loadFromDefault();
  }
  
  // Explicitly check for KUBERNETES_SERVICE_HOST to handle environments where DNS for .default.svc is flaky
  const cluster = kc.getCurrentCluster();
  if (cluster && process.env.KUBERNETES_SERVICE_HOST) {
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT || '443';
    cluster.server = `https://${host}:${port}`;
    cluster.skipTLSVerify = true; // Skip verification when using IP address
    console.log(`Using KUBERNETES_SERVICE_HOST for API connection: ${cluster.server} (TLS verify skipped)`);
  }

  // Allow manual token override from environment
  if (process.env.ARGO_AUTH_TOKEN) {
    console.log("Applying ARGO_AUTH_TOKEN override from environment.");
    const user = kc.getCurrentUser();
    if (user) {
      user.token = process.env.ARGO_AUTH_TOKEN;
    } else {
      kc.addUser({
        name: 'default-user',
        token: process.env.ARGO_AUTH_TOKEN
      });
      const context = kc.getContextObject('default');
      if (context) {
        context.user = 'default-user';
      }
    }
  }
  
  const user = kc.getCurrentUser();
  if (user && user.token) {
    console.log("Kubernetes client initialized with a token.");
  } else {
    console.warn("Kubernetes client initialized but NO TOKEN was found.");
  }
} catch (e) {
  console.error("Failed to initialize Kubernetes client:", e.message);
}

const customObjectsApi = kc.makeApiClient(k8s.CustomObjectsApi);

/**
 * GET /api/executions
 * List Argo Workflows directly via Kubernetes API using the official client
 */
apiRouter.get("/executions", async (req, res, next) => {
  try {
    const namespace = process.env.ARGO_NAMESPACE || "default";
    console.log(`Fetching workflows from K8s API (namespace: ${namespace})`);
    
    const response = await customObjectsApi.listNamespacedCustomObject(
      'argoproj.io',
      'v1alpha1',
      namespace,
      'workflows'
    );
    
    // The K8s client wraps the response in { response, body }
    const items = response.body.items || [];
    res.json(Array.isArray(items) ? items : []);
  } catch (error) {
    console.error("Error fetching workflows from K8s API:", error.message);
    if (error.body) {
       console.error("K8s API Error Body:", error.body);
    }
    next(error);
  }
});

/**
 * GET /api/executions/:name
 * Get details of a specific Argo Workflow directly via Kubernetes API
 */
apiRouter.get("/executions/:name", async (req, res, next) => {
  try {
    const namespace = process.env.ARGO_NAMESPACE || "default";
    const { name } = req.params;
    
    console.log(`Fetching workflow details from K8s API (namespace: ${namespace}, name: ${name})`);
    const response = await customObjectsApi.getNamespacedCustomObject(
      'argoproj.io',
      'v1alpha1',
      namespace,
      'workflows',
      name
    );
    
    res.json(response.body);
  } catch (error) {
    console.error(`Error fetching workflow ${req.params.name} from K8s API:`, error.message);
    next(error);
  }
});

/**
 * DELETE /api/executions/:name
 * Delete a specific Argo Workflow directly via Kubernetes API
 */
apiRouter.delete("/executions/:name", async (req, res, next) => {
  try {
    const namespace = process.env.ARGO_NAMESPACE || "default";
    const { name } = req.params;
    
    console.log(`Deleting workflow from K8s API (namespace: ${namespace}, name: ${name})`);
    
    const response = await customObjectsApi.deleteNamespacedCustomObject(
      'argoproj.io',
      'v1alpha1',
      namespace,
      'workflows',
      name
    );
    
    res.json({ message: `Workflow ${name} deleted successfully.` });
  } catch (error) {
    console.error(`Error deleting workflow ${req.params.name} from K8s API:`, error.message);
    if (error.body) {
      console.error(`K8s API Error Body:`, error.body);
      return res.status(error.statusCode || 500).json(error.body);
    }
    next(error);
  }
});

/**
 * POST /api/executions
 * Submit a new Argo Workflow directly via Kubernetes API
 */
apiRouter.post("/executions", async (req, res, next) => {
  try {
    const namespace = process.env.ARGO_NAMESPACE || "default";
    const workflow = req.body;
    
    if (!workflow || typeof workflow !== "object") {
      return res.status(400).json({ message: "Invalid workflow definition." });
    }

    if (!workflow.metadata) workflow.metadata = {};
    workflow.metadata.namespace = namespace;
    workflow.kind = "Workflow";
    workflow.apiVersion = "argoproj.io/v1alpha1";
    
    delete workflow.metadata.resourceVersion;
    delete workflow.metadata.uid;
    
    // To allow multiple executions of the same template, we must use generateName
    // and remove the exact name, so Kubernetes appends a unique ID.
    if (workflow.metadata.name) {
      workflow.metadata.generateName = workflow.metadata.name;
      if (!workflow.metadata.generateName.endsWith('-')) {
         workflow.metadata.generateName += '-';
      }
      delete workflow.metadata.name;
    } else if (!workflow.metadata.generateName) {
      workflow.metadata.generateName = 'workflow-';
    }

    console.log(`Submitting workflow to K8s API (namespace: ${namespace})`);
    
    const response = await customObjectsApi.createNamespacedCustomObject(
      'argoproj.io',
      'v1alpha1',
      namespace,
      'workflows',
      workflow
    );
    
    res.status(201).json(response.body);
  } catch (error) {
    console.error("Error submitting workflow to K8s API:", error.message);
    if (error.body) {
      console.error(`K8s API Error Body:`, error.body);
      return res.status(error.statusCode || 500).json(error.body);
    }
    next(error);
  }
});

// Helper for Loki requests
function getLokiConfig(req, targetUrl) {
  const headers = {};
  if (req.token) {
    const tokenValue = req.token.startsWith('Bearer ') ? req.token : `Bearer ${req.token}`;
    headers['Authorization'] = tokenValue;
    headers['Cookie'] = `authorization=${tokenValue}`;
  }
  
  const https = require('https');
  const isHttps = targetUrl.startsWith('https://');
  const config = { headers };
  
  if (isHttps) {
    config.httpsAgent = new https.Agent({ rejectUnauthorized: false });
  }
  return config;
}

/**
 * GET /api/logs/:id
 * Proxy logs from Loki log viewer.
 */
apiRouter.get("/logs/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { type, start_time, end_time } = req.query;
    const lokiUrl = process.env.LOG_VIEWER_URL || `https://hub-test.eox.at/services/eoxhub-gateway/cif/log-viewer/search`;
    const label = type === 'workflow' ? 'workflows_argoproj_io_workflow' : 'pod';

    const config = getLokiConfig(req, lokiUrl);
    config.params = {
      sel_label: label,
      sel_value: id,
      start_time: start_time || new Date(Date.now() - 3600000 * 24).toISOString().slice(0, 16),
      end_time: end_time || new Date().toISOString().slice(0, 16),
      query: ''
    };
    
    console.log(`Proxying logs from Loki: ${lokiUrl} (Label: ${label}, Value: ${id})`);
    const response = await axios.get(lokiUrl, config);
    res.send(response.data);
  } catch (error) {
    console.error(`Error fetching logs for ${req.params.id}:`, error.message);
    next(error);
  }
});


// --- Resilient API Mounting ---
if (BASE_PATH !== "") {
  // Ensure the base path does not have a trailing slash, but the mount point expects a slash before 'api'
  const cleanBasePath = BASE_PATH.replace(/\/$/, "");
  app.use(`${cleanBasePath}/api`, apiRouter);
}

// Always mount on /api as a fallback
app.use('/api', apiRouter);

// --- 3. CATCH-ALL ROUTE ---

// Catch-all route to serve index.html for React Router
if (BASE_PATH !== "") {
  app.get(`${BASE_PATH}/*`, (req, res) => {
    serveIndex(req, res);
  });
}

app.get("*", (req, res) => {
  serveIndex(req, res);
});

// Also handle the root if BASE_PATH is empty or for initial entry
if (BASE_PATH !== "") {
  app.get("/", (req, res) => {
    res.redirect(BASE_PATH);
  });
}


// --- 4. ERROR HANDLING ---

// Basic error handler
app.use((err, req, res, next) => {
  // If this is an auth error from requiresAuth and we're on an API route
  if (err.status === 401 || err.statusCode === 401) {
    return res.status(401).json({ 
      message: 'Authentication Required',
      loginUrl: `${BASE_PATH}/login` 
    });
  }

  console.error(err.stack);
  const status = err.response ? err.response.status : 500;
  const message = err.response ? err.response.data : { message: err.message };
  res.status(status).json(message);
});


// --- 5. SERVER START ---

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});