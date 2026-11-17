const express = require('express');
const path = require('path');
const fs = require('fs');

function createWorkspaceRouter(ctx) {
  const router = express.Router();

  const {
    gitlabApi,
    GITLAB_PROJECT_ID,
    GITLAB_BRANCH,
    GITLAB_WORKFLOWS_PATH,
    GITLAB_PACKAGES_PATH,
    GITLAB_APPLICATIONS_PATH,
    ENABLE_WORKFLOWS,
    ENABLE_OGC_PACKAGES,
    ENABLE_APPLICATIONS,
    ALLOW_PUBLIC_INGRESS,
    MULTI_TENANT_MODE,
    JUPYTERHUB_PVC_NAME,
    JUPYTER_PVC_MOUNT_PATH,
    INGRESS_DEFAULTS,
    ingressClusterConfig,
    ARGO_PROFILES,
    EPHEMERAL_VOLUME_CONFIG,
    BASE_PATH,
    customObjectsApi,
    appsV1Api,
    coreV1Api,
    networkingV1Api,
    k8sApi,
    k8sCustomApi,
    k8sCoreApi,
    kc,
    getUsername,
    getCandidateUsernames,
    getGitLabPath,
    getGitLabPackagesPath,
    getVirtualPath,
    getCommitOptions,
    stripAnsiCodes,
    hasWorkspaceGroupAccess,
    requiresAuth,
    resolveSafeWorkspacePath,
    listWorkspaceDirectory,
    validateArgoWorkflow
  } = ctx;

router.get("/workspace/files", async (req, res, next) => {
  try {
    const reqPath = req.query.path || "";
    // Sanitize path against directory traversal
    const safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, "").replace(/^\/+/, "");

    // --- MULTI-TENANT MODE: Strict User PVC Isolation ---
    if (MULTI_TENANT_MODE) {
      const username = getUsername(req);
      if (!username) {
        return res.status(403).json({ message: "Access denied. User session required in multi-tenant mode." });
      }

      const candidateUsernames = [username];
      if (username.includes('@')) {
        candidateUsernames.push(username.split('@')[0]);
      }

      let targetPath = null;
      for (const uName of candidateUsernames) {
        const rootDir = path.resolve(JUPYTER_PVC_MOUNT_PATH, uName);
        const resolvedPath = path.resolve(rootDir, safePath);

        // Security Enforcement: Target path MUST stay strictly inside user's directory
        if (resolvedPath.startsWith(rootDir) && fs.existsSync(resolvedPath)) {
          targetPath = resolvedPath;
          break;
        }
      }

      if (!targetPath) {
        return res.json({ files: [], exists: false, currentPath: safePath });
      }

      const stat = fs.statSync(targetPath);
      if (stat.isFile()) {
        return res.sendFile(targetPath);
      }

      const entries = fs.readdirSync(targetPath, { withFileTypes: true });
      const pvcFiles = entries.map(entry => {
        const full = path.join(targetPath, entry.name);
        let size = 0;
        let mtime = null;
        try {
          const s = fs.statSync(full);
          size = s.size;
          mtime = s.mtime;
        } catch (e) {}

        return {
          name: entry.name,
          isDirectory: entry.isDirectory(),
          size: entry.isDirectory() ? 0 : size,
          mtime: mtime
        };
      });

      return res.json({ files: pvcFiles, exists: true, currentPath: safePath });
    }

    // --- SINGLE-TENANT MODE: Primary S3 Bucket Storage ---
    const bucket = process.env.S3_BUCKET || process.env.BUCKET_NAME || process.env.AWS_S3_BUCKET;
    const endpoint = process.env.S3_ENDPOINT || process.env.AWS_ENDPOINT_URL;
    const accessKey = process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY;
    const secretKey = process.env.AWS_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY;

    if (bucket && endpoint && accessKey && secretKey) {
      try {
        const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
        let endpointUrl = endpoint;
        if (!endpointUrl.startsWith('http://') && !endpointUrl.startsWith('https://')) {
          endpointUrl = 'https://' + endpointUrl;
        }

        const s3Client = new S3Client({
          region: process.env.AWS_REGION || "eu-nl",
          endpoint: endpointUrl,
          credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
          forcePathStyle: true
        });

        // Extract possible workflow name from safePath
        const pathParts = safePath.split('/').filter(Boolean);
        const execName = pathParts[pathParts.length - 1] || "";

        const candidatePrefixes = [];
        if (safePath) candidatePrefixes.push(safePath.replace(/\/$/, "") + "/");
        if (execName) {
          candidatePrefixes.push(execName + "/");
          candidatePrefixes.push(`application_packages_executions/${execName}/`);
          candidatePrefixes.push(`tmp/application_packages_executions/${execName}/`);
        }
        if (execName && process.env.ARGO_NAMESPACE) candidatePrefixes.push(`${process.env.ARGO_NAMESPACE}/${execName}/`);

        // Check if K8s Workflow status resolves an explicit S3 key
        if (execName) {
          try {
            const ns = process.env.ARGO_NAMESPACE || "default";
            const wfRes = await customObjectsApi.getNamespacedCustomObject({
              group: 'argoproj.io',
              version: 'v1alpha1',
              namespace: ns,
              plural: 'workflows',
              name: execName
            });
            const nodes = wfRes.body?.status?.nodes || wfRes.status?.nodes || {};
            Object.values(nodes).forEach(node => {
              const arts = node.outputs?.artifacts || [];
              arts.forEach(art => {
                if (art.s3?.key) {
                  candidatePrefixes.unshift(art.s3.key.replace(/\/$/, "") + "/");
                }
              });
            });
          } catch (wfErr) {
            // Ignore if workflow not found
          }
        }

        let bestFiles = [];

        for (const prefix of candidatePrefixes) {
          try {
            const command = new ListObjectsV2Command({
              Bucket: bucket,
              Prefix: prefix,
              Delimiter: '/'
            });

            const s3Res = await s3Client.send(command);
            const files = [];

            if (s3Res.CommonPrefixes) {
              s3Res.CommonPrefixes.forEach(p => {
                const folderName = p.Prefix.replace(prefix, "").replace(/\/$/, "");
                if (folderName) {
                  files.push({ name: folderName, isDirectory: true, size: 0, mtime: null });
                }
              });
            }

            if (s3Res.Contents) {
              s3Res.Contents.forEach(c => {
                const fileName = c.Key.replace(prefix, "");
                if (fileName && fileName !== "") {
                  files.push({
                    name: fileName,
                    isDirectory: false,
                    size: c.Size || 0,
                    mtime: c.LastModified || null
                  });
                }
              });
            }

            if (files.length > 0) {
              bestFiles = files;
              break;
            }
          } catch (pErr) {
            // Try next candidate prefix
          }
        }

        return res.json({ files: bestFiles, exists: bestFiles.length > 0, currentPath: safePath });
      } catch (s3Err) {
        console.error("[S3 STORAGE ERROR] Failed to list S3 workspace files:", s3Err.message);
        return res.status(500).json({ message: "Failed to list files from S3 bucket storage.", error: s3Err.message });
      }
    }

    // Fallback if S3 is not configured in single-tenant mode: use local PVC mount
    const rootDir = path.resolve(JUPYTER_PVC_MOUNT_PATH);
    const targetPath = path.resolve(rootDir, safePath);

    if (!targetPath.startsWith(rootDir)) {
      return res.status(403).json({ message: "Access denied." });
    }

    if (!fs.existsSync(rootDir) || !fs.existsSync(targetPath)) {
      return res.json({ files: [], exists: false, currentPath: safePath });
    }

    const stat = fs.statSync(targetPath);
    if (stat.isFile()) {
      return res.sendFile(targetPath);
    }

    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    const files = entries.map(entry => {
      const full = path.join(targetPath, entry.name);
      let size = 0;
      let mtime = null;
      try {
        const s = fs.statSync(full);
        size = s.size;
        mtime = s.mtime;
      } catch (e) {}

      return {
        name: entry.name,
        isDirectory: entry.isDirectory(),
        size: entry.isDirectory() ? 0 : size,
        mtime: mtime
      };
    });

    return res.json({ files, exists: true, currentPath: safePath });
  } catch (error) {
    console.error("Error listing workspace files:", error.message);
    next(error);
  }
});

/**
 * GET /api/workspace/files/download
 * Download or stream a file from S3 Bucket storage or local PVC
 */
router.get("/workspace/files/download", async (req, res, next) => {
  try {
    const reqPath = req.query.path || "";
    const safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, "").replace(/^\/+/, "");

    if (!safePath) {
      return res.status(400).json({ message: "path parameter is required." });
    }

    // --- MULTI-TENANT MODE: Strict User PVC File Download ---
    if (MULTI_TENANT_MODE) {
      const username = getUsername(req);
      if (!username) {
        return res.status(403).json({ message: "Access denied. User session required in multi-tenant mode." });
      }

      const candidateUsernames = [username];
      if (username.includes('@')) {
        candidateUsernames.push(username.split('@')[0]);
      }

      for (const uName of candidateUsernames) {
        const rootDir = path.resolve(JUPYTER_PVC_MOUNT_PATH, uName);
        const targetPath = path.resolve(rootDir, safePath);

        // Security Enforcement: Target path MUST stay strictly inside user's directory
        if (targetPath.startsWith(rootDir) && fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
          return res.download(targetPath, path.basename(targetPath));
        }
      }

      return res.status(404).json({ message: "File not found on user workspace PVC." });
    }

    // --- SINGLE-TENANT MODE: S3 Bucket File Download or Local PVC ---
    const bucket = process.env.S3_BUCKET || process.env.BUCKET_NAME || process.env.AWS_S3_BUCKET;
    const endpoint = process.env.S3_ENDPOINT || process.env.AWS_ENDPOINT_URL;
    const accessKey = process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY;
    const secretKey = process.env.AWS_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY;

    if (bucket && endpoint && accessKey && secretKey) {
      try {
        const { GetObjectCommand } = require('@aws-sdk/client-s3');
        let endpointUrl = endpoint;
        if (!endpointUrl.startsWith('http://') && !endpointUrl.startsWith('https://')) {
          endpointUrl = 'https://' + endpointUrl;
        }

        const s3Client = new S3Client({
          region: process.env.AWS_REGION || "eu-nl",
          endpoint: endpointUrl,
          credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
          forcePathStyle: true
        });

        // Try exact safePath first, then candidate S3 keys
        const candidateKeys = [
          safePath,
          `application_packages_executions/${safePath}`,
          `tmp/application_packages_executions/${safePath}`
        ];

        let s3Stream = null;
        let contentType = 'application/octet-stream';

        for (const s3Key of candidateKeys) {
          try {
            const command = new GetObjectCommand({
              Bucket: bucket,
              Key: s3Key
            });
            const s3Res = await s3Client.send(command);
            if (s3Res.Body) {
              s3Stream = s3Res.Body;
              if (s3Res.ContentType) contentType = s3Res.ContentType;
              break;
            }
          } catch (e) {
            // Try next candidate key
          }
        }

        if (s3Stream) {
          const filename = path.basename(safePath);
          res.setHeader('Content-Type', contentType);
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
          return s3Stream.pipe(res);
        }
      } catch (s3Err) {
        console.error("[S3 DOWNLOAD ERROR]", s3Err.message);
      }
    }

    // Fallback: Local PVC File Download in Single-Tenant Mode
    const rootDir = path.resolve(JUPYTER_PVC_MOUNT_PATH);
    const targetPath = path.resolve(rootDir, safePath);

    if (!targetPath.startsWith(rootDir)) {
      return res.status(403).json({ message: "Access denied." });
    }

    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
      return res.download(targetPath, path.basename(targetPath));
    }

    return res.status(404).json({ message: "File not found." });
  } catch (err) {
    next(err);
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

// --- Applications Deployment Feature ---

const requiresApplicationsEnabled = (req, res, next) => {
  if (!ENABLE_APPLICATIONS) {
    return res.status(403).json({ message: "Applications feature is disabled." });
  }
  next();
};

const validateAndSanitizeAppYaml = (appName, content, fileType) => {
  // Support multi-document YAML configurations (e.g., Middleware + Ingress) safely
  const documents = content.split("---").map(doc => doc.trim()).filter(Boolean);
  if (documents.length === 0) {
    throw new Error(`Empty YAML content for ${fileType}.yaml`);
  }

  const sanitizedDocs = documents.map(docStr => {
    // If the entire document is commented out (disabled), bypass validation and preserve it as-is
    const lines = docStr.split("\n").filter(l => l.trim().length > 0);
    const isDocDisabled = lines.length > 0 && lines.every(line => line.trim().startsWith("#"));
    if (isDocDisabled) {
      return docStr;
    }

    const parsed = YAML.parse(docStr);
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`Invalid YAML document format in ${fileType}.yaml`);
    }

    if (!parsed.metadata) parsed.metadata = {};

    // Strictly override and enforce namespace to match the configured administrative space
    const enforcedNamespace = process.env.ARGO_NAMESPACE || "default";
    parsed.metadata.namespace = enforcedNamespace;

    // Enforce labels
    if (!parsed.metadata.labels) parsed.metadata.labels = {};
    parsed.metadata.labels['app.kubernetes.io/service'] = appName;

    // Enforce selector matchLabels for deployment
    if (fileType === 'deployment' && parsed.kind === 'Deployment') {
      if (!parsed.spec) parsed.spec = {};
      if (!parsed.spec.selector) parsed.spec.selector = {};
      if (!parsed.spec.selector.matchLabels) parsed.spec.selector.matchLabels = {};
      parsed.spec.selector.matchLabels['app.kubernetes.io/service'] = appName;

      if (!parsed.spec.template) parsed.spec.template = {};
      if (!parsed.spec.template.metadata) parsed.spec.template.metadata = {};
      if (!parsed.spec.template.metadata.labels) parsed.spec.template.metadata.labels = {};
      parsed.spec.template.metadata.labels['app.kubernetes.io/service'] = appName;
    }

    // Enforce selector for service
    if (fileType === 'service' && parsed.kind === 'Service') {
      if (!parsed.spec) parsed.spec = {};
      if (!parsed.spec.selector) parsed.spec.selector = {};
      parsed.spec.selector['app.kubernetes.io/service'] = appName;
    }

    // Enforce ingress rules targeting the service
    if (fileType === 'ingress' && parsed.kind === 'Ingress') {
      if (!ALLOW_PUBLIC_INGRESS) {
        throw new Error("Ingress creation is disabled by administrator.");
      }
      if (parsed.spec?.rules) {
        for (const rule of parsed.spec.rules) {
          if (rule.http?.paths) {
            for (const p of rule.http.paths) {
              if (p.backend?.service?.name && p.backend.service.name !== appName) {
                p.backend.service.name = appName;
              }
            }
          }
        }
      }
    }

    return YAML.stringify(parsed);
  });

  return sanitizedDocs.join("\n---\n");
};

// Helper to parse filename into component name and resource type
function parseAppFilename(filename) {
  const match = filename.match(/^(?:(.*)[-._])?(deployment|service|ingress)\.ya?ml$/i);
  if (!match) return null;
  const comp = match[1] ? match[1].trim().toLowerCase() : "";
  const type = match[2].toLowerCase();
  return { comp, type };
}

// Helper to resolve an app name (e.g. "my-folder/web" or "my-app") into folder and prefix
function resolveAppLocation(appName) {
  if (!appName) return { folder: "", prefix: "" };
  const parts = appName.split('/');
  if (parts.length >= 2) {
    return {
      folder: parts[0],
      prefix: parts.slice(1).join('/')
    };
  }
  return {
    folder: appName,
    prefix: ""
  };
}

// Helper to construct filename for a given prefix and resource type (e.g. "web-deployment.yaml")
function getAppFilename(prefix, type) {
  if (!prefix) return `${type}.yaml`;
  return `${prefix}-${type}.yaml`;
}


  return router;
}

module.exports = { createWorkspaceRouter };
