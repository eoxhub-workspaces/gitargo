const express = require('express');
const axios = require('axios');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const k8s = require('@kubernetes/client-node');

function createLogRouter(ctx) {
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
    parseAppFilename,
    resolveAppLocation,
    getAppFilename,
    getCommitOptions,
    stripAnsiCodes,
    hasWorkspaceGroupAccess,
    requiresAuth,
    requiresApplicationsEnabled,
    resolveSafeWorkspacePath,
    listWorkspaceDirectory,
    validateArgoWorkflow
  } = ctx;

  const coreV1Api = ctx.coreV1Api || k8sCoreApi || (kc ? kc.makeApiClient(k8s.CoreV1Api) : null);
  const NAMESPACE = process.env.ARGO_NAMESPACE || "default";
  const LOKI_CANDIDATES = [
    process.env.LOKI_URL,
    "http://mon-loki-gateway.core.svc:80",
    "http://mon-loki.core.svc:3100",
    "http://loki-headless.core.svc:3100",
    "http://mon-loki-gateway.core:80",
    "http://loki-gateway.monitoring.svc:80",
    "http://loki.monitoring.svc:3100"
  ].filter(Boolean);

  let cachedWorkingLokiUrl = null;

  async function getLokiUrl() {
    if (cachedWorkingLokiUrl) return cachedWorkingLokiUrl;
    if (process.env.LOKI_URL) return process.env.LOKI_URL;

    for (const url of LOKI_CANDIDATES) {
      try {
        const res = await axios.get(`${url}/loki/api/v1/labels`, {
          timeout: 1500
        });
        if (res.status === 200) {
          console.log(`[API LOGS] Auto-discovered working Loki service at: ${url}`);
          cachedWorkingLokiUrl = url;
          return url;
        }
      } catch (e) {
        // try next candidate
      }
    }

    return LOKI_CANDIDATES[0] || "http://mon-loki-gateway.core.svc:80";
  }

  const LOKI_LABELS = ["pod", "container", "namespace", "workflow", "cronworkflow"];
  const NAMESPACE_LABEL = process.env.LOKI_NAMESPACE_LABEL || "namespace";
  const ARGO_WORKFLOW_LABEL = process.env.LOKI_WORKFLOW_LABEL || "workflows_argoproj_io_workflow";

  function toLokiTimestamp(isoString) {
    if (!isoString) return `${Date.now() * 1000000}`;
    const ms = new Date(isoString).getTime();
    return isNaN(ms) ? `${Date.now() * 1000000}` : `${ms * 1000000}`;
  }

  function getLokiConfig(req) {
    const config = { headers: {} };
    if (process.env.LOKI_BEARER_TOKEN) {
      config.headers['Authorization'] = `Bearer ${process.env.LOKI_BEARER_TOKEN}`;
    }
    if (req && req.headers && req.headers['authorization']) {
      config.headers['Authorization'] = req.headers['authorization'];
    }
    return config;
  }

router.get("/logs/labels", async (req, res, next) => {
  try {
    const { start_time } = req.query;
    const startNs = toLokiTimestamp(start_time || new Date(Date.now() - 3600000).toISOString());
    const lokiUrl = await getLokiUrl();
    
    const config = getLokiConfig(req);
    config.params = {
      query: `{${NAMESPACE_LABEL}="${NAMESPACE}"}`,
      start: startNs
    };

    const resp = await axios.get(`${lokiUrl}/loki/api/v1/labels`, config);
    const labels = resp.data.data || [];
    console.log(`[API LOGS] All available Loki labels in namespace:`, labels);
    const filtered = labels.filter(l => !l.startsWith("__") && LOKI_LABELS.includes(l)).sort();
    res.json(filtered.length > 0 ? filtered : LOKI_LABELS);
  } catch (error) {
    console.error("Error fetching Loki labels:", error.message);
    res.json(LOKI_LABELS);
  }
});

/**
 * GET /api/logs/values/:label
 * Fetch all values for a specific label key.
 */
router.get("/logs/values/:label", async (req, res, next) => {
  try {
    const { label } = req.params;
    const { start_time, end_time } = req.query;
    
    if (!LOKI_LABELS.includes(label)) {
      return res.status(400).json({ message: `Label ${label} not allowed.` });
    }

    const startNs = toLokiTimestamp(start_time || new Date(Date.now() - 3600000).toISOString());
    const endNs = end_time ? toLokiTimestamp(end_time) : null;
    const lokiUrl = await getLokiUrl();

    const config = getLokiConfig(req);
    config.params = {
      query: `{${NAMESPACE_LABEL}="${NAMESPACE}"}`,
      start: startNs
    };
    if (endNs) config.params.end = endNs;

    const resp = await axios.get(`${lokiUrl}/loki/api/v1/label/${label}/values`, config);
    res.json((resp.data.data || []).sort());
  } catch (error) {
    console.error(`Error fetching Loki values for ${req.params.label}:`, error.message);
    res.json([]);
  }
});

/**
 * GET /api/logs/:id
 * Fetch raw logs for a specific workflow or pod from Loki.
 */
router.get("/logs/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { type, start_time, end_time, query, namespace, workflow } = req.query;

    console.log(`[API LOGS] Request received for ID: "${id}" | Type: "${type}" | Start: "${start_time || 'default'}" | End: "${end_time || 'none'}"`);

    // Sanitize user inputs to prevent LogQL injection
    const safeId = id.replace(/"/g, '');
    const safeQuery = query ? query.toString().replace(/"/g, '\\"') : undefined;

    // Enforce strict namespace isolation
    const ns = NAMESPACE;

    // Use 4 hours as a default temporal subset window instead of 24 hours for faster indexing
    const startNs = toLokiTimestamp(start_time || new Date(Date.now() - 3600000 * 4).toISOString());
    const endNs = end_time ? toLokiTimestamp(end_time) : null;

    console.log(`[API LOGS] Computed Loki bounds: startNs="${startNs}" | endNs="${endNs || 'none'}"`);

    let podName = safeId; // Default to the requested ID

    // Resolve the actual pod name from K8s status if a workflow name is provided and we are querying a pod
    if (type !== 'workflow' && workflow) {
      try {
        const wfResponse = await customObjectsApi.getNamespacedCustomObject({
          group: 'argoproj.io',
          version: 'v1alpha1',
          namespace: ns,
          plural: 'workflows',
          name: workflow.toString()
        });

        const wfNode = wfResponse.status?.nodes?.[safeId] || wfResponse.body?.status?.nodes?.[safeId];
        if (wfNode) {
          const resolvedPodName = wfNode.podName || wfNode.id;
          if (resolvedPodName) {
            podName = resolvedPodName;
          }
        }
      } catch (err) {
        console.debug(`Failed to fetch workflow details from K8s for log podName resolution:`, err.message);
      }
    }

    let logql = "";
    if (type === 'workflow') {
      logql = `{${NAMESPACE_LABEL}="${ns}", ${ARGO_WORKFLOW_LABEL}="${safeId}"}`;
    } else {
      // For pods, some Loki setups use 'k8s_pod_name' instead of 'pod'.
      logql = `{${NAMESPACE_LABEL}="${ns}", pod="${podName}"}`;
    }

    if (safeQuery) {
      logql += ` |= "${safeQuery}"`;
    }
    
    const lokiUrl = await getLokiUrl();

    // Helper function to fetch and parse logs. Instantiates a fresh config object per-request to avoid race conditions.
    const fetchAndParse = async (queryStr) => {
      const queryConfig = getLokiConfig(req);
      queryConfig.params = { query: queryStr, limit: 1000, start: startNs };
      if (endNs) queryConfig.params.end = endNs;
      
      console.log(`Fetching logs from Loki: ${lokiUrl}/loki/api/v1/query_range?query=${queryStr}`);
      let resp;
      try {
        resp = await axios.get(`${lokiUrl}/loki/api/v1/query_range`, queryConfig);
        if (resp.data) {
          const resultsCount = resp.data.data?.result?.length || 0;
          console.log(`[API LOGS] Loki response: status=${resp.status} | resultsCount=${resultsCount}`);
        }
      } catch (err) {
        console.error("Loki query failed:", err.message);
        return [];
      }
      
      let parsedLogs = [];
      let totalLines = 0;
      let filteredLines = 0;

      if (resp.data.data && resp.data.data.result && resp.data.data.result.length > 0) {
        for (const stream of resp.data.data.result) {
          for (const val of stream.values) {
            totalLines++;
            let line = val[1];
            console.debug(`[DEBUG] Raw Loki line: ${line}`);
            
            // 1. Extract inner message from CRI-O format
            const criMatch = line.match(/logtag="[A-Z]"\s+message="(.*)"/);
            if (criMatch) {
              line = criMatch[1];
              line = line.replace(/\\"/g, '"');
              console.debug(`[DEBUG] After CRI-O unwrap: ${line}`);
            }

            // 2. Filter out Argo internal logs.
            // Be careful: only filter if it looks like SYSTEM argo noise
            const lineLower = line.toLowerCase();
            const isArgoSystemLog = 
              lineLower.includes('level=info') && lineLower.includes('argo=true') && 
              (lineLower.includes('msg="alloc=') || lineLower.includes('msg="starting progress monitor') || 
               lineLower.includes('msg="starting deadline monitor') || lineLower.includes('msg="executor initialized') ||
               lineLower.includes('msg="main container completed') || lineLower.includes('msg="no output artifacts') ||
               lineLower.includes('msg="copying file') || lineLower.includes('msg="copying from container') ||
               lineLower.includes('msg="staging artifact') || lineLower.includes('msg="saving output artifacts') ||
               lineLower.includes('msg="no output parameters') || lineLower.includes('msg="no script output reference') ||
               lineLower.includes('msg="deadline monitor stopped') || lineLower.includes('msg="no artifact sidecars to kill') ||
               lineLower.includes('msg="successfully saved file') || lineLower.includes('msg="not deleting local artifact') ||
               lineLower.includes('msg="save artifact') || lineLower.includes('msg="saving file to s3') ||
               lineLower.includes('msg="creating minio client') || lineLower.includes('msg="s3 save') ||
               lineLower.includes('msg="saving artifact') || lineLower.includes('msg="using executor retry strategy') ||
               lineLower.includes('msg="part size not configured'));

            if (isArgoSystemLog) {
              console.debug(`[DEBUG] Filtering as Argo noise: ${line}`);
              filteredLines++;
              continue;
            }

            // 3. Try to extract payload from generic logrus format if it's our own log
            // Example: time="..." level=info msg="User Message"
            const msgMatch = line.match(/msg="(.*)"/);
            if (msgMatch && line.includes('level=')) {
                console.debug(`[DEBUG] Extracting msg payload: ${msgMatch[1]}`);
                line = msgMatch[1];
            }

            // 4. Strip ANSI escape control codes (e.g., \x1b[1;30m, \x1b[0m, \x1b[32m)
            line = line.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');

            parsedLogs.push(line);
          }
        }
      }
      
      if (totalLines > 0) {
         console.log(`Parsed ${parsedLogs.length} logs from ${totalLines} total lines.`);
      }
      return parsedLogs;
    };

    let logs = await fetchAndParse(logql);

    // If no workflow logs found with namespace label, try without it (global query)
    if (logs.length === 0 && type === 'workflow') {
      console.log(`No logs found with namespace-filtered workflow label. Attempting global workflow query (without namespace)...`);
      logs = await fetchAndParse(`{${ARGO_WORKFLOW_LABEL}="${safeId}"}`);
    }

    // Fallbacks for pod log fetching if the standard `pod` label isn't used by their Promtail
    if (logs.length === 0 && type !== 'workflow') {
      console.log(`No logs found with pod label. Executing lean fallback queries in parallel...`);
      
      const fallbackQueries = [
        { key: 'ns_k8s_pod', query: `{${NAMESPACE_LABEL}="${ns}", k8s_pod_name="${podName}"}` },
        { key: 'global_pod', query: `{pod="${podName}"}` },
        { key: 'global_k8s_pod', query: `{k8s_pod_name="${podName}"}` }
      ];

      // Add original fallback with safeId if different from podName
      if (podName !== safeId) {
        fallbackQueries.push(
          { key: 'ns_k8s_pod_id', query: `{${NAMESPACE_LABEL}="${ns}", k8s_pod_name="${safeId}"}` },
          { key: 'global_pod_id', query: `{pod="${safeId}"}` },
          { key: 'global_k8s_pod_id', query: `{k8s_pod_name="${safeId}"}` }
        );
      }

      const fallbackPromises = fallbackQueries.map(async (q) => {
        const resLogs = await fetchAndParse(q.query);
        return { key: q.key, logs: resLogs };
      });

      const fallbackResults = await Promise.all(fallbackPromises);
      
      // Choose the first non-empty logs in order of priority (which matches the array order)
      for (const q of fallbackQueries) {
        const match = fallbackResults.find(r => r.key === q.key);
        if (match && match.logs && match.logs.length > 0) {
          logs = match.logs;
          console.log(`[API LOGS] Fallback matched successfully via query key: ${q.key}`);
          break;
        }
      }

      // If still empty, execute regex searches as a final safety fallback
      if (logs.length === 0) {
        const idParts = safeId.split('-');
        const hash = idParts[idParts.length - 1]; // Assume the last part is the unique hash
        
        console.log(`[API LOGS] Attempting regex matching on POD LABEL for ID ending in ${hash} in parallel...`);
        const regexQueries = [
          { key: 'ns_regex_pod', query: `{${NAMESPACE_LABEL}="${ns}", pod=~".*${hash}.*"}` },
          { key: 'ns_regex_k8s_pod', query: `{${NAMESPACE_LABEL}="${ns}", k8s_pod_name=~".*${hash}.*"}` },
          { key: 'global_regex_pod', query: `{pod=~".*${hash}.*"}` },
          { key: 'global_regex_k8s_pod', query: `{k8s_pod_name=~".*${hash}.*"}` }
        ];

        // Also add regex using podName hash if different
        if (podName !== safeId) {
          const podParts = podName.split('-');
          const podHash = podParts[podParts.length - 1];
          if (podHash !== hash) {
            regexQueries.push(
              { key: 'ns_regex_pod_name', query: `{${NAMESPACE_LABEL}="${ns}", pod=~".*${podHash}.*"}` },
              { key: 'ns_regex_k8s_pod_name', query: `{${NAMESPACE_LABEL}="${ns}", k8s_pod_name=~".*${podHash}.*"}` }
            );
          }
        }

        const regexPromises = regexQueries.map(async (q) => {
          const resLogs = await fetchAndParse(q.query);
          return { key: q.key, logs: resLogs };
        });

        const regexResults = await Promise.all(regexPromises);

        for (const q of regexQueries) {
          const match = regexResults.find(r => r.key === q.key);
          if (match && match.logs && match.logs.length > 0) {
            logs = match.logs;
            console.log(`[API LOGS] Regex fallback matched successfully via query key: ${q.key}`);
            break;
          }
        }
      }
    }

    if (logs.length === 0) {
      console.log(`[API LOGS] Loki returned 0 logs. Executing direct Kubernetes API pod log fallback for ID: "${safeId}"`);
      try {
        const podCoreApi = coreV1Api || k8sCoreApi || (kc ? kc.makeApiClient(k8s.CoreV1Api) : null);
        let targetPodName = podName || safeId;

        if (type === 'workflow') {
          try {
            const podsRes = await podCoreApi.listNamespacedPod({
              namespace: ns,
              labelSelector: `workflows.argoproj.io/workflow=${safeId}`
            });
            const foundPods = podsRes.body?.items || podsRes.items || [];
            if (foundPods.length > 0) {
              targetPodName = foundPods[0].metadata?.name || safeId;
            }
          } catch (pErr) {
            console.warn(`[API LOGS] Pod list for workflow ${safeId} failed:`, pErr.message);
          }
        }

        let rawText = "";
        try {
          const podLogRes = await podCoreApi.readNamespacedPodLog({
            name: targetPodName,
            namespace: ns,
            container: 'main'
          });
          rawText = typeof podLogRes === 'string' ? podLogRes : (podLogRes?.body || '');
        } catch (e1) {
          try {
            const prevLogRes = await podCoreApi.readNamespacedPodLog({
              name: targetPodName,
              namespace: ns,
              container: 'main',
              previous: true
            });
            rawText = typeof prevLogRes === 'string' ? prevLogRes : (prevLogRes?.body || '');
          } catch (e2) {
            try {
              const defLogRes = await podCoreApi.readNamespacedPodLog({
                name: targetPodName,
                namespace: ns
              });
              rawText = typeof defLogRes === 'string' ? defLogRes : (defLogRes?.body || '');
            } catch (e3) {}
          }
        }

        if (rawText && rawText.trim() !== '') {
          console.log(`[API LOGS] Successfully retrieved direct K8s Pod Logs for "${targetPodName}"`);
          const cleanText = rawText.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
          return res.send(cleanText);
        }
      } catch (k8sErr) {
        console.warn(`[API LOGS] Direct K8s Pod Log fallback failed for "${safeId}":`, k8sErr.message);
      }

      console.log(`[API LOGS] No logs found across all labels and fallbacks for ID: "${id}"`);
      try {
        const config = getLokiConfig(req);
        const labelsResp = await axios.get(`${lokiUrl}/loki/api/v1/labels`, config);
        console.log(`[API LOGS] DIAGNOSTIC: All available Loki label keys in your cluster are:`, labelsResp.data.data || []);
      } catch (labelErr) {
        console.error(`[API LOGS] DIAGNOSTIC ERROR: Failed to fetch Loki labels:`, labelErr.message);
      }
      return res.send("No logs found in Loki or Kubernetes for the specified execution.");
    }
    
    console.log(`[API LOGS] Successfully returning ${logs.length} log lines for ID: "${id}"`);
    res.send(logs.reverse().join('\n'));
  } catch (error) {
    console.error(`Error fetching logs for ${req.params.id}:`, error.message);
    res.status(500).send("Error fetching logs from Loki.");
  }
});

/**
 * GET /api/artifacts/:workflow/:nodeId/:artifactName
 * Fetches artifacts directly from the backing S3 repository.
 */
router.get("/artifacts/:workflow/:nodeId/:artifactName", async (req, res, next) => {
  try {
    const { workflow, nodeId, artifactName } = req.params;
    const namespace = process.env.ARGO_NAMESPACE || "default";

    // 1. Fetch the workflow object from Kubernetes to find the artifact definition
    const wfResponse = await customObjectsApi.getNamespacedCustomObject({
      group: 'argoproj.io',
      version: 'v1alpha1',
      namespace: namespace,
      plural: 'workflows',
      name: workflow
    });
    const wf = wfResponse;

    const node = wf.status?.nodes?.[nodeId];
    if (!node) {
      return res.status(404).json({ message: "Node not found in workflow status." });
    }

    // Attempt to find the artifact in outputs first, then inputs
    let artifact = node.outputs?.artifacts?.find(a => a.name === artifactName);
    if (!artifact) {
      artifact = node.inputs?.artifacts?.find(a => a.name === artifactName);
    }

    if (!artifact) {
      return res.status(404).json({ message: "Artifact not found in node outputs or inputs." });
    }

    // Input artifacts might just have 'name' and lack the full 's3' definition 
    // if they are passed down from a parent or another step.
    // However, Argo typically resolves the full storage path in the `status.nodes[id].inputs.artifacts[x].s3` 
    // field during execution. If it doesn't, we will fall back to the workflow's default artifactRepository.
    
    let s3Config = artifact.s3;

    if (!s3Config) {
      // Try to get default artifact repository from workflow spec
      const defaultRepo = wf.spec?.artifactRepositoryRef;
      if (defaultRepo) {
         // It's complex to resolve configmap references here without full Argo Controller logic.
         // We will rely on our global environment fallbacks if the specific artifact lacks s3 info.
         s3Config = {}; 
      } else {
         s3Config = {};
      }
    }

    // Ensure we have an S3 key to fetch. If it's not on the artifact, we can't proceed.
    if (!s3Config.key) {
       // Input artifacts from other steps usually have their resolved key populated by Argo.
       // If it's missing, it might not be supported yet by this direct method.
       return res.status(501).json({ 
         message: "Artifact S3 key is missing. This might be a pass-through artifact not fully resolved in the status." 
       });
    }

    // 2. Resolve S3 configuration (Artifact definition overrides global env vars)
    const endpoint = s3Config.endpoint || process.env.AWS_ENDPOINT_URL || process.env.S3_ENDPOINT;
    const bucket = s3Config.bucket || process.env.BUCKET_NAME || process.env.S3_BUCKET;
    const region = s3Config.region || process.env.AWS_REGION || process.env.S3_REGION || "eu-nl";
    let accessKey = process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY;
    let secretKey = process.env.AWS_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY;
    
    // Determine if connection should be insecure. If URL starts with https, it's secure.
    let insecure = false;
    if (s3Config.insecure !== undefined) {
      insecure = s3Config.insecure;
    } else if (endpoint && endpoint.startsWith('http://')) {
      insecure = true;
    } else if (process.env.S3_SECURE === "false") {
      insecure = true;
    }

    if (!endpoint || !bucket) {
      return res.status(500).json({ message: "S3 endpoint or bucket not configured globally or in the artifact." });
    }

    // 3. Extract credentials from K8s secrets if defined in the artifact
    const podCoreApi = coreV1Api || k8sCoreApi || (kc ? kc.makeApiClient(k8s.CoreV1Api) : null);
    if (s3Config.accessKeySecret) {
      try {
        const secretRes = await podCoreApi.readNamespacedSecret({
          name: s3Config.accessKeySecret.name,
          namespace
        });
        if (secretRes.body.data && secretRes.body.data[s3Config.accessKeySecret.key]) {
          accessKey = Buffer.from(secretRes.body.data[s3Config.accessKeySecret.key], 'base64').toString('utf8');
        }
      } catch (err) {
        console.warn(`Failed to read accessKeySecret ${s3Config.accessKeySecret.name}: ${err.message}`);
      }
    }

    if (s3Config.secretKeySecret) {
      try {
        const secretRes = await podCoreApi.readNamespacedSecret({
          name: s3Config.secretKeySecret.name,
          namespace
        });
        if (secretRes.body.data && secretRes.body.data[s3Config.secretKeySecret.key]) {
          secretKey = Buffer.from(secretRes.body.data[s3Config.secretKeySecret.key], 'base64').toString('utf8');
        }
      } catch (err) {
        console.warn(`Failed to read secretKeySecret ${s3Config.secretKeySecret.name}: ${err.message}`);
      }
    }

    if (!accessKey || !secretKey) {
      return res.status(500).json({ message: "S3 credentials missing. Ensure global env vars or K8s secrets are configured." });
    }

    // 4. Connect to S3
    let endpointUrl = endpoint;
    // If the endpoint doesn't have a protocol, prepend one based on the insecure flag
    if (!endpointUrl.startsWith('http://') && !endpointUrl.startsWith('https://')) {
      endpointUrl = (insecure ? 'http://' : 'https://') + endpointUrl;
    }

    const s3Client = new S3Client({
      region,
      endpoint: endpointUrl,
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
      forcePathStyle: true // Recommended for MinIO and many on-prem S3 providers
    });

    console.log(`Fetching artifact ${artifact.s3.key} from s3://${bucket} at ${endpointUrl}`);

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: artifact.s3.key
    });

    const s3Response = await s3Client.send(command);

    // 5. Unpack .tgz stream on the fly if needed
    if (artifact.s3.key.endsWith('.tgz') || artifact.s3.key.endsWith('.tar.gz')) {
      const extract = tar.extract();
      let fileFound = false;

      // Ensure we clean up if the client disconnects
      req.on('close', () => {
         extract.destroy();
      });

      extract.on('entry', (header, stream, nextStream) => {
        // Just extract and send the first file found (since an artifact is usually a single file or directory)
        if (!fileFound && header.type === 'file') {
          fileFound = true;
          
          // Basic content-type detection based on filename
          let contentType = 'application/octet-stream';
          const ext = header.name.split('.').pop().toLowerCase();
          const mimeTypes = {
            'txt': 'text/plain', 'log': 'text/plain', 'md': 'text/markdown',
            'json': 'application/json', 'csv': 'text/csv', 'yaml': 'text/yaml', 'yml': 'text/yaml',
            'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
            'gif': 'image/gif', 'svg': 'image/svg+xml', 'webp': 'image/webp'
          };
          if (mimeTypes[ext]) contentType = mimeTypes[ext];

          res.setHeader('Content-Type', contentType);
          res.setHeader('Content-Disposition', `inline; filename="${header.name.split('/').pop()}"`);
          
          stream.pipe(res);
          stream.on('end', () => {
             // Do not process further files once we found one, to avoid writing to a closed response
             extract.destroy();
          });
        } else {
          stream.on('end', nextStream);
          stream.resume(); // drain the stream
        }
      });

      extract.on('finish', () => {
        if (!fileFound && !res.headersSent) {
          res.status(404).json({ message: "No files found in artifact archive." });
        }
      });

      extract.on('error', (err) => {
        console.error("Tar extraction error:", err);
        if (!res.headersSent) res.status(500).json({ message: "Error extracting artifact archive." });
      });

      s3Response.Body.pipe(zlib.createGunzip()).pipe(extract);

    } else {
      // Stream raw file directly
      res.setHeader('Content-Type', s3Response.ContentType || 'application/octet-stream');
      const filename = artifact.s3.key.split('/').pop();
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      s3Response.Body.pipe(res);
    }

  } catch (error) {
    console.error(`Error fetching artifact ${req.params.artifactName} for node ${req.params.nodeId}:`, error.message);
    if (!res.headersSent) {
      if (error.name === 'NoSuchKey') {
        res.status(404).json({ message: "Artifact key not found in S3 bucket." });
      } else {
        res.status(500).json({ message: "Failed to fetch artifact from storage.", error: error.message });
      }
    }
  }
});



  return router;
}

module.exports = { createLogRouter };
