const express = require('express');
const YAML = require('yaml');
const path = require('path');

function createApplicationRouter(ctx) {
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

router.get("/applications", requiresApplicationsEnabled, async (req, res, next) => {
  try {
    const response = await gitlabApi.get(
      `/projects/${GITLAB_PROJECT_ID}/repository/tree`,
      {
        params: {
          path: GITLAB_APPLICATIONS_PATH,
          ref: GITLAB_BRANCH,
          recursive: true,
          per_page: 200
        }
      }
    );

    const appsMap = {};
    for (const file of response.data) {
      if (file.type === "blob" && file.path.startsWith(GITLAB_APPLICATIONS_PATH + "/")) {
        const relativePath = file.path.slice(GITLAB_APPLICATIONS_PATH.length + 1);
        const parts = relativePath.split('/');
        if (parts.length === 2) {
          const folderName = parts[0];
          const filename = parts[1];
          const parsed = parseAppFilename(filename);
          if (parsed) {
            const comp = parsed.comp;
            const appKey = comp ? `${folderName}/${comp}` : folderName;
            if (!appsMap[appKey]) {
              appsMap[appKey] = {
                name: appKey,
                folder: folderName,
                component: comp,
                files: [],
                hasDeployment: false
              };
            }
            appsMap[appKey].files.push(filename);
            if (parsed.type === "deployment") {
              appsMap[appKey].hasDeployment = true;
            }
          }
        }
      }
    }

    // Only return application entries that possess a deployment YAML file
    const validApps = Object.values(appsMap)
      .filter(app => app.hasDeployment)
      .map(({ hasDeployment, ...app }) => app);

    res.json(validApps);
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return res.json([]);
    }
    next(error);
  }
});

// Helper to detect 404 Not Found errors across all @kubernetes/client-node error formats
function isK8sNotFoundError(err) {
  if (!err) return false;
  return (
    err.statusCode === 404 ||
    err.code === 404 ||
    err.response?.statusCode === 404 ||
    err.response?.body?.code === 404 ||
    (typeof err.body === 'string' && err.body.includes('"code":404')) ||
    (typeof err.message === 'string' && (err.message.includes('not found') || err.message.includes('HTTP-Code: 404')))
  );
}

// GET /api/applications/:appName/status
router.get(/^\/applications\/(.+)\/status$/, requiresApplicationsEnabled, async (req, res, next) => {
  try {
    const appName = getVirtualPath(req);
    const { folder, prefix } = resolveAppLocation(appName);
    let namespace = process.env.ARGO_NAMESPACE || "default";

    // Read deployment YAML from Git to determine exact metadata.name, metadata.namespace & spec.selector.matchLabels
    let targetK8sName = prefix || folder;
    const depFile = getAppFilename(prefix, "deployment");
    const filePath = `${GITLAB_APPLICATIONS_PATH}/${folder}/${depFile}`;
    try {
      const rawResponse = await gitlabApi.get(
        `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(filePath)}/raw`,
        { params: { ref: GITLAB_BRANCH } }
      );
      const parsed = YAML.parse(rawResponse.data);
      if (parsed?.metadata?.name) {
        targetK8sName = parsed.metadata.name;
      }
      if (parsed?.metadata?.namespace) {
        namespace = parsed.metadata.namespace;
      }
    } catch (err) {
      // Ignore
    }

    let deploymentStatus = null;
    let deploymentMatchLabels = null;
    try {
      const depResponse = await appsV1Api.readNamespacedDeployment({ name: targetK8sName, namespace });
      const d = depResponse.body || depResponse;
      deploymentMatchLabels = d.spec?.selector?.matchLabels || null;
      deploymentStatus = {
        replicas: d.status?.replicas || 0,
        readyReplicas: d.status?.readyReplicas || 0,
        availableReplicas: d.status?.availableReplicas || 0,
        conditions: d.spec?.replicas === 0 ? [{ type: "ScaledToZero", status: "True", message: "Application is scaled to zero." }] : (d.status?.conditions || [])
      };
    } catch (err) {
      if (!isK8sNotFoundError(err)) {
        console.error(`Failed to read deployment "${targetK8sName}" from K8s:`, err.message || err);
      }
    }

    let serviceStatus = null;
    try {
      const svcResponse = await coreV1Api.readNamespacedService({ name: targetK8sName, namespace });
      const s = svcResponse.body || svcResponse;
      serviceStatus = {
        type: s.spec?.type,
        clusterIP: s.spec?.clusterIP,
        ports: s.spec?.ports || []
      };
    } catch (err) {
      // 404 is expected if not reconciled
    }

    let ingressStatus = null;
    try {
      const ingResponse = await networkingV1Api.readNamespacedIngress({ name: targetK8sName, namespace });
      const ing = ingResponse.body || ingResponse;
      const lb = ing.status?.loadBalancer?.ingress || [];
      const hasRules = ing.spec?.rules && ing.spec.rules.length > 0;
      const isIngressReady = (lb.length > 0 && (lb[0].ip || lb[0].hostname)) || hasRules;

      ingressStatus = {
        ready: !!isIngressReady,
        loadBalancer: lb
      };
    } catch (err) {
      // 404 is expected if ingress doesn't exist
    }

    let pods = [];
    try {
      let labelSelectors = [];
      if (deploymentMatchLabels && Object.keys(deploymentMatchLabels).length > 0) {
        const sel = Object.entries(deploymentMatchLabels)
          .map(([k, v]) => `${k}=${v}`)
          .join(",");
        labelSelectors.push(sel);
      } else {
        labelSelectors = [
          `app.kubernetes.io/service=${targetK8sName}`,
          `app.kubernetes.io/name=${targetK8sName}`,
          `app.kubernetes.io/instance=${targetK8sName}`,
          `app=${targetK8sName}`
        ];
      }

      const podPromises = labelSelectors.map(labelSelector =>
        coreV1Api.listNamespacedPod({ namespace, labelSelector })
          .then(res => res.body?.items || res.items || [])
          .catch(() => [])
      );

      const results = await Promise.all(podPromises);
      const podMap = new Map();

      for (const items of results) {
        for (const p of items) {
          if (p.metadata?.name && !podMap.has(p.metadata.name)) {
            podMap.set(p.metadata.name, p);
          }
        }
      }

      if (podMap.size === 0) {
        try {
          const allPodsRes = await coreV1Api.listNamespacedPod({ namespace });
          const allItems = allPodsRes.body?.items || allPodsRes.items || [];
          for (const p of allItems) {
            const pName = p.metadata?.name || '';
            if (isPodOwnedByApp(p, targetK8sName) && !podMap.has(pName)) {
              podMap.set(pName, p);
            }
          }
        } catch (e) {
          // Ignore fallback error
        }
      }

      let k8sEvents = [];
      try {
        const eventsRes = await coreV1Api.listNamespacedEvent({ namespace });
        k8sEvents = eventsRes.body?.items || eventsRes.items || [];
      } catch (e) {
        // Ignore if events listing is not permitted
      }

      pods = Array.from(podMap.values()).map(p => {
        const pName = p.metadata?.name;
        const pUid = p.metadata?.uid;

        const podEvents = k8sEvents.filter(e => {
          const inv = e.involvedObject || {};
          return inv.name === pName || (pUid && inv.uid === pUid);
        });

        const warnings = podEvents
          .filter(e => e.type === 'Warning' || (e.reason && (e.reason.includes('Failed') || e.reason.includes('Error') || e.reason.includes('Unscheduled') || e.reason.includes('BackOff'))))
          .sort((a, b) => new Date(b.lastTimestamp || b.eventTime || b.metadata?.creationTimestamp || 0).getTime() - new Date(a.lastTimestamp || a.eventTime || a.metadata?.creationTimestamp || 0).getTime())
          .map(e => ({
            reason: e.reason,
            message: e.message,
            count: e.count || 1,
            lastTimestamp: e.lastTimestamp || e.eventTime || e.metadata?.creationTimestamp
          }));

        return {
          name: pName,
          phase: p.status?.phase,
          restarts: p.status?.containerStatuses?.reduce((acc, c) => acc + (c.restartCount || 0), 0) || 0,
          age: p.metadata?.creationTimestamp,
          containerStatus: p.status?.containerStatuses?.map(c => ({
            name: c.name,
            ready: c.ready,
            state: c.state
          })) || [],
          events: warnings.length > 0 ? warnings : undefined,
          lastWarning: warnings.length > 0 ? warnings[0].message : undefined
        };
      });
    } catch (err) {
      console.error("Failed to list pods from K8s:", err.message);
    }

    let vulnerabilities = null;
    try {
      const reportsResponse = await customObjectsApi.listNamespacedCustomObject({
        group: 'aquasecurity.github.io',
        version: 'v1alpha1',
        namespace,
        plural: 'vulnerabilityreports'
      });
      const items = reportsResponse.body?.items || reportsResponse.items || [];
      
      const appReports = items.filter(item => {
        const rName = item.metadata?.labels?.['trivy-operator.resource.name'] || '';
        const cName = item.metadata?.labels?.['trivy-operator.container.name'] || '';
        const repName = item.metadata?.name || '';
        return rName === targetK8sName || 
               rName.startsWith(`${targetK8sName}-`) || 
               cName === targetK8sName ||
               repName.startsWith(`replicaset-${targetK8sName}-`) ||
               repName.startsWith(`deployment-${targetK8sName}-`);
      });

      if (appReports.length > 0) {
        vulnerabilities = appReports.map(item => ({
          container: item.metadata?.labels?.['trivy-operator.container.name'] || 'unknown',
          summary: item.report?.summary || { criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0 },
          topVulnerabilities: item.report?.vulnerabilities?.slice(0, 5).map(v => ({
            id: v.vulnerabilityID,
            title: v.title,
            severity: v.severity,
            pkg: v.resource,
            installedVersion: v.installedVersion,
            fixedVersion: v.fixedVersion,
            link: v.primaryLink
          })) || []
        }));
      }
    } catch (err) {
      console.debug("Failed to fetch Trivy vulnerability reports:", err.message);
    }

    res.json({
      name: appName,
      deployed: !!deploymentStatus,
      deployment: deploymentStatus,
      service: serviceStatus,
      ingress: ingressStatus,
      pods: pods,
      vulnerabilities: vulnerabilities
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/applications/:appName/pods/:podName
router.delete(/^\/applications\/(.+)\/pods\/(.+)$/, requiresApplicationsEnabled, async (req, res, next) => {
  try {
    const rawAppName = req.params[0];
    const podName = req.params[1];
    let appName = rawAppName;
    try { appName = decodeURIComponent(rawAppName); } catch (e) {}

    const { folder, prefix } = resolveAppLocation(appName);
    let namespace = process.env.ARGO_NAMESPACE || "default";

    let targetK8sName = prefix || folder;
    const depFile = getAppFilename(prefix, "deployment");
    const filePath = `${GITLAB_APPLICATIONS_PATH}/${folder}/${depFile}`;
    try {
      const rawResponse = await gitlabApi.get(
        `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(filePath)}/raw`,
        { params: { ref: GITLAB_BRANCH } }
      );
      const parsed = YAML.parse(rawResponse.data);
      if (parsed?.metadata?.name) {
        targetK8sName = parsed.metadata.name;
      }
    } catch (err) {
      // Ignore
    }

    let pod;
    try {
      const podResponse = await coreV1Api.readNamespacedPod({ name: podName, namespace });
      pod = podResponse.body || podResponse;
    } catch (err) {
      if (err.statusCode === 404) {
        return res.status(404).json({ message: `Pod ${podName} not found.` });
      }
      throw err;
    }

    if (!isPodOwnedByApp(pod, targetK8sName) && !isPodOwnedByApp(pod, appName)) {
      return res.status(403).json({ message: `Unauthorized: Pod ${podName} does not belong to application ${appName}.` });
    }

    await coreV1Api.deleteNamespacedPod({ name: podName, namespace });
    res.json({ message: `Pod ${podName} restarted successfully.` });
  } catch (error) {
    next(error);
  }
});

// GET /api/applications/:appName
router.get(/^\/applications\/(.+)$/, requiresApplicationsEnabled, async (req, res, next) => {
  try {
    const appName = getVirtualPath(req);
    const { folder, prefix } = resolveAppLocation(appName);

    const files = [getAppFilename(prefix, "deployment"), getAppFilename(prefix, "service")];
    if (ALLOW_PUBLIC_INGRESS) {
      files.push(getAppFilename(prefix, "ingress"));
    }

    const payload = {};
    for (const f of files) {
      const parsed = parseAppFilename(f);
      const type = parsed ? parsed.type : "deployment";
      const filePath = `${GITLAB_APPLICATIONS_PATH}/${folder}/${f}`;
      try {
        const rawResponse = await gitlabApi.get(
          `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(filePath)}/raw`,
          { params: { ref: GITLAB_BRANCH } }
        );
        payload[type] = rawResponse.data;
      } catch (err) {
        if (err.response && err.response.status === 404) {
          payload[type] = null;
        } else {
          throw err;
        }
      }
    }

    res.json(payload);
  } catch (error) {
    next(error);
  }
});

// POST /api/applications/:appName
router.post(/^\/applications\/(.+)$/, requiresApplicationsEnabled, async (req, res, next) => {
  try {
    const appName = getVirtualPath(req);
    const { folder, prefix } = resolveAppLocation(appName);
    const { deployment, service, ingress, commit_message } = req.body;

    if (!deployment) {
      return res.status(400).json({ message: "Deployment YAML content is required." });
    }

    const depFile = getAppFilename(prefix, "deployment");
    const svcFile = getAppFilename(prefix, "service");
    const ingFile = getAppFilename(prefix, "ingress");

    const actions = [];
    try {
      const sanitizedDeployment = validateAndSanitizeAppYaml(appName, deployment, 'deployment');
      actions.push({
        action: "create",
        file_path: `${GITLAB_APPLICATIONS_PATH}/${folder}/${depFile}`,
        content: sanitizedDeployment
      });

      if (service) {
        const sanitizedService = validateAndSanitizeAppYaml(appName, service, 'service');
        actions.push({
          action: "create",
          file_path: `${GITLAB_APPLICATIONS_PATH}/${folder}/${svcFile}`,
          content: sanitizedService
        });
      }

      if (ingress && ALLOW_PUBLIC_INGRESS) {
        const sanitizedIngress = validateAndSanitizeAppYaml(appName, ingress, 'ingress');
        actions.push({
          action: "create",
          file_path: `${GITLAB_APPLICATIONS_PATH}/${folder}/${ingFile}`,
          content: sanitizedIngress
        });
      }
    } catch (err) {
      return res.status(400).json({ message: err.message });
    }

    const response = await gitlabApi.post(
      `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
      {
        branch: GITLAB_BRANCH,
        commit_message: commit_message || `Create application ${appName}`,
        ...getCommitOptions(req),
        actions: actions
      }
    );

    res.status(201).json(response.data);
  } catch (error) {
    next(error);
  }
});

// PUT /api/applications/:appName
router.put(/^\/applications\/(.+)$/, requiresApplicationsEnabled, async (req, res, next) => {
  try {
    const appName = getVirtualPath(req);
    const { folder, prefix } = resolveAppLocation(appName);
    const { deployment, service, ingress, commit_message } = req.body;

    if (!deployment) {
      return res.status(400).json({ message: "Deployment YAML content is required." });
    }

    const depFile = getAppFilename(prefix, "deployment");
    const svcFile = getAppFilename(prefix, "service");
    const ingFile = getAppFilename(prefix, "ingress");

    let existingFiles = [];
    try {
      const response = await gitlabApi.get(
        `/projects/${GITLAB_PROJECT_ID}/repository/tree`,
        {
          params: {
            path: `${GITLAB_APPLICATIONS_PATH}/${folder}`,
            ref: GITLAB_BRANCH
          }
        }
      );
      existingFiles = response.data.map(f => f.name);
    } catch (err) {
      // directory may not exist
    }

    const actions = [];
    try {
      const sanitizedDeployment = validateAndSanitizeAppYaml(appName, deployment, 'deployment');
      actions.push({
        action: existingFiles.includes(depFile) ? "update" : "create",
        file_path: `${GITLAB_APPLICATIONS_PATH}/${folder}/${depFile}`,
        content: sanitizedDeployment
      });

      if (service) {
        const sanitizedService = validateAndSanitizeAppYaml(appName, service, 'service');
        actions.push({
          action: existingFiles.includes(svcFile) ? "update" : "create",
          file_path: `${GITLAB_APPLICATIONS_PATH}/${folder}/${svcFile}`,
          content: sanitizedService
        });
      }

      if (ALLOW_PUBLIC_INGRESS) {
        if (ingress) {
          const sanitizedIngress = validateAndSanitizeAppYaml(appName, ingress, 'ingress');
          actions.push({
            action: existingFiles.includes(ingFile) ? "update" : "create",
            file_path: `${GITLAB_APPLICATIONS_PATH}/${folder}/${ingFile}`,
            content: sanitizedIngress
          });
        } else if (existingFiles.includes(ingFile)) {
          actions.push({
            action: "delete",
            file_path: `${GITLAB_APPLICATIONS_PATH}/${folder}/${ingFile}`
          });
        }
      }
    } catch (err) {
      return res.status(400).json({ message: err.message });
    }

    const response = await gitlabApi.post(
      `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
      {
        branch: GITLAB_BRANCH,
        commit_message: commit_message || `Update application ${appName}`,
        ...getCommitOptions(req),
        actions: actions
      }
    );

    res.json(response.data);
  } catch (error) {
    next(error);
  }
});

// DELETE /api/applications/:appName
router.delete(/^\/applications\/(.+)$/, requiresApplicationsEnabled, async (req, res, next) => {
  try {
    const appName = getVirtualPath(req);
    const { folder, prefix } = resolveAppLocation(appName);

    const depFile = getAppFilename(prefix, "deployment");
    const svcFile = getAppFilename(prefix, "service");
    const ingFile = getAppFilename(prefix, "ingress");

    let existingFiles = [];
    try {
      const response = await gitlabApi.get(
        `/projects/${GITLAB_PROJECT_ID}/repository/tree`,
        {
          params: {
            path: `${GITLAB_APPLICATIONS_PATH}/${folder}`,
            ref: GITLAB_BRANCH
          }
        }
      );
      existingFiles = response.data.filter(f => f.type === "blob").map(f => f.name);
    } catch (err) {
      return res.status(404).json({ message: `Application ${appName} not found in Git.` });
    }

    const targetsToDelete = [depFile, svcFile, ingFile].filter(f => existingFiles.includes(f));

    if (targetsToDelete.length === 0) {
      return res.json({ message: `Application ${appName} files are already deleted.` });
    }

    const actions = targetsToDelete.map(filename => ({
      action: "delete",
      file_path: `${GITLAB_APPLICATIONS_PATH}/${folder}/${filename}`
    }));

    const response = await gitlabApi.post(
      `/projects/${GITLAB_PROJECT_ID}/repository/commits`,
      {
        branch: GITLAB_BRANCH,
        commit_message: `Delete application ${appName}`,
        ...getCommitOptions(req),
        actions: actions
      }
    );

    res.json({ message: `Application ${appName} deleted from Git.`, gitlab: response.data });
  } catch (error) {
    next(error);
  }
});

const checkIngressUrlReachability = async (url) => {
  return new Promise((resolve) => {
    // Create an HTTPS/HTTP agent that strictly enforces SSL/TLS verification
    const isHttps = url.startsWith("https://");
    const options = {
      method: "HEAD",
      timeout: 1500,
    };

    if (isHttps) {
      options.agent = new https.Agent({ rejectUnauthorized: true });
    }

    const httpModule = isHttps ? https : require("http");
    const req = httpModule.request(url, options, () => {
      // Direct handshake completed and resolved
      resolve(true);
    });

    req.on("error", (err) => {
      // Handshake failed (DNS nxdomain, connection refused, or SSL verification failed!)
      console.debug(`[Ingress Probe] Reachability check failed for ${url}: ${err.message}`);
      resolve(false);
    });

    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });

    req.end();
  });
};

// Helper to strictly verify whether a Pod belongs to an application without cross-app pod bleeding
function isPodOwnedByApp(pod, appName) {
  if (!pod || !appName) return false;
  const labels = pod.metadata?.labels || {};

  // 1. Exact label match (strict string equality)
  if (
    labels['app.kubernetes.io/service'] === appName ||
    labels['app.kubernetes.io/name'] === appName ||
    labels['app.kubernetes.io/instance'] === appName ||
    labels['app'] === appName
  ) {
    return true;
  }

  // 2. Strict K8s ReplicaSet owner reference check (e.g. appName-66d5587ffd)
  const ownerRefs = pod.metadata?.ownerReferences || [];
  const escapedAppName = appName.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
  const replicaSetPattern = new RegExp(`^${escapedAppName}-[0-9a-z]{8,10}$`, 'i');

  for (const ref of ownerRefs) {
    if (ref.kind === 'ReplicaSet' && replicaSetPattern.test(ref.name)) {
      return true;
    }
  }

  return false;
}

router.get(/^\/applications\/(.+)\/status$/, requiresApplicationsEnabled, async (req, res, next) => {
  try {
    const appName = req.params[0];
    const { folder, prefix } = resolveAppLocation(appName);
    let namespace = process.env.ARGO_NAMESPACE || "default";

    // Read deployment YAML from Git to determine exact metadata.name, metadata.namespace & spec.selector.matchLabels
    let targetK8sName = prefix || folder;
    const depFile = getAppFilename(prefix, "deployment");
    const filePath = `${GITLAB_APPLICATIONS_PATH}/${folder}/${depFile}`;
    try {
      const rawResponse = await gitlabApi.get(
        `/projects/${GITLAB_PROJECT_ID}/repository/files/${encodeURIComponent(filePath)}/raw`,
        { params: { ref: GITLAB_BRANCH } }
      );
      const parsed = YAML.parse(rawResponse.data);
      if (parsed?.metadata?.name) {
        targetK8sName = parsed.metadata.name;
      }
      if (parsed?.metadata?.namespace) {
        namespace = parsed.metadata.namespace;
      }
    } catch (err) {
      // Ignore
    }

    let deploymentStatus = null;
    let deploymentMatchLabels = null;
    try {
      const depResponse = await appsV1Api.readNamespacedDeployment({ name: targetK8sName, namespace });
      const d = depResponse.body || depResponse;
      deploymentMatchLabels = d.spec?.selector?.matchLabels || null;
      deploymentStatus = {
        replicas: d.status?.replicas || 0,
        readyReplicas: d.status?.readyReplicas || 0,
        availableReplicas: d.status?.availableReplicas || 0,
        conditions: d.spec?.replicas === 0 ? [{ type: "ScaledToZero", status: "True", message: "Application is scaled to zero." }] : (d.status?.conditions || [])
      };
    } catch (err) {
      if (err.statusCode !== 404) {
        console.error(`Failed to read deployment "${targetK8sName}" from K8s:`, err.message);
      }
    }

    let serviceStatus = null;
    try {
      const svcResponse = await coreV1Api.readNamespacedService({ name: targetK8sName, namespace });
      const s = svcResponse.body || svcResponse;
      serviceStatus = {
        type: s.spec?.type,
        clusterIP: s.spec?.clusterIP,
        ports: s.spec?.ports || []
      };
    } catch (err) {
      // 404 is expected if not reconciled
    }

    let ingressStatus = null;
    try {
      const ingResponse = await networkingV1Api.readNamespacedIngress({ name: targetK8sName, namespace });
      const ing = ingResponse.body || ingResponse;
      const lb = ing.status?.loadBalancer?.ingress || [];
      const hasRules = ing.spec?.rules && ing.spec.rules.length > 0;
      const isIngressReady = (lb.length > 0 && (lb[0].ip || lb[0].hostname)) || hasRules;

      ingressStatus = {
        ready: !!isIngressReady,
        loadBalancer: lb
      };
    } catch (err) {
      // 404 is expected if ingress doesn't exist
    }

    let pods = [];
    try {
      let labelSelectors = [];
      if (deploymentMatchLabels && Object.keys(deploymentMatchLabels).length > 0) {
        const sel = Object.entries(deploymentMatchLabels)
          .map(([k, v]) => `${k}=${v}`)
          .join(",");
        labelSelectors.push(sel);
      } else {
        labelSelectors = [
          `app.kubernetes.io/service=${targetK8sName}`,
          `app.kubernetes.io/name=${targetK8sName}`,
          `app.kubernetes.io/instance=${targetK8sName}`,
          `app=${targetK8sName}`
        ];
      }

      const podPromises = labelSelectors.map(labelSelector =>
        coreV1Api.listNamespacedPod({ namespace, labelSelector })
          .then(res => res.body?.items || res.items || [])
          .catch(() => [])
      );

      const results = await Promise.all(podPromises);
      const podMap = new Map();

      for (const items of results) {
        for (const p of items) {
          if (p.metadata?.name && !podMap.has(p.metadata.name)) {
            podMap.set(p.metadata.name, p);
          }
        }
      }

      // If no pods matched standard label queries, list all pods in namespace and use strict ownership verification
      if (podMap.size === 0) {
        try {
          const allPodsRes = await coreV1Api.listNamespacedPod({ namespace });
          const allItems = allPodsRes.body?.items || allPodsRes.items || [];
          for (const p of allItems) {
            const pName = p.metadata?.name || '';
            if (isPodOwnedByApp(p, targetK8sName) && !podMap.has(pName)) {
              podMap.set(pName, p);
            }
          }
        } catch (e) {
          // Ignore fallback error
        }
      }

      let k8sEvents = [];
      try {
        const eventsRes = await coreV1Api.listNamespacedEvent({ namespace });
        k8sEvents = eventsRes.body?.items || eventsRes.items || [];
      } catch (e) {
        // Ignore if events listing is not permitted
      }

      pods = Array.from(podMap.values()).map(p => {
        const pName = p.metadata?.name;
        const pUid = p.metadata?.uid;

        const podEvents = k8sEvents.filter(e => {
          const inv = e.involvedObject || {};
          return inv.name === pName || (pUid && inv.uid === pUid);
        });

        const warnings = podEvents
          .filter(e => e.type === 'Warning' || (e.reason && (e.reason.includes('Failed') || e.reason.includes('Error') || e.reason.includes('Unscheduled') || e.reason.includes('BackOff'))))
          .sort((a, b) => new Date(b.lastTimestamp || b.eventTime || b.metadata?.creationTimestamp || 0).getTime() - new Date(a.lastTimestamp || a.eventTime || a.metadata?.creationTimestamp || 0).getTime())
          .map(e => ({
            reason: e.reason,
            message: e.message,
            count: e.count || 1,
            lastTimestamp: e.lastTimestamp || e.eventTime || e.metadata?.creationTimestamp
          }));

        return {
          name: pName,
          phase: p.status?.phase,
          restarts: p.status?.containerStatuses?.reduce((acc, c) => acc + (c.restartCount || 0), 0) || 0,
          age: p.metadata?.creationTimestamp,
          containerStatus: p.status?.containerStatuses?.map(c => ({
            name: c.name,
            ready: c.ready,
            state: c.state
          })) || [],
          events: warnings.length > 0 ? warnings : undefined,
          lastWarning: warnings.length > 0 ? warnings[0].message : undefined
        };
      });
    } catch (err) {
      console.error("Failed to list pods from K8s:", err.message);
    }

    let vulnerabilities = null;
    try {
      const reportsResponse = await customObjectsApi.listNamespacedCustomObject({
        group: 'aquasecurity.github.io',
        version: 'v1alpha1',
        namespace,
        plural: 'vulnerabilityreports'
      });
      const items = reportsResponse.body?.items || reportsResponse.items || [];
      
      const appReports = items.filter(item => {
        const rName = item.metadata?.labels?.['trivy-operator.resource.name'] || '';
        const cName = item.metadata?.labels?.['trivy-operator.container.name'] || '';
        const repName = item.metadata?.name || '';
        return rName === targetK8sName || 
               rName.startsWith(`${targetK8sName}-`) || 
               cName === targetK8sName ||
               repName.startsWith(`replicaset-${targetK8sName}-`) ||
               repName.startsWith(`deployment-${targetK8sName}-`);
      });

      if (appReports.length > 0) {
        vulnerabilities = appReports.map(item => ({
          container: item.metadata?.labels?.['trivy-operator.container.name'] || 'unknown',
          summary: item.report?.summary || { criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0 },
          topVulnerabilities: item.report?.vulnerabilities?.slice(0, 5).map(v => ({
            id: v.vulnerabilityID,
            title: v.title,
            severity: v.severity,
            pkg: v.resource,
            installedVersion: v.installedVersion,
            fixedVersion: v.fixedVersion,
            link: v.primaryLink
          })) || []
        }));
      }
    } catch (err) {
      console.debug("Failed to fetch Trivy vulnerability reports:", err.message);
    }

    res.json({
      name: appName,
      deployed: !!deploymentStatus,
      deployment: deploymentStatus,
      service: serviceStatus,
      ingress: ingressStatus,
      pods: pods,
      vulnerabilities: vulnerabilities
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/applications/:name/pods/:podName", requiresApplicationsEnabled, async (req, res, next) => {
  try {
    const { name, podName } = req.params;
    const namespace = process.env.ARGO_NAMESPACE || "default";

    // 1. Get the pod first to verify it belongs to this application (strict isolation)
    let pod;
    try {
      const podResponse = await coreV1Api.readNamespacedPod({ name: podName, namespace });
      pod = podResponse.body || podResponse;
    } catch (err) {
      if (err.statusCode === 404) {
        return res.status(404).json({ message: `Pod ${podName} not found.` });
      }
      throw err;
    }

    if (!isPodOwnedByApp(pod, name)) {
      return res.status(403).json({ message: `Unauthorized: Pod ${podName} does not belong to application ${name}.` });
    }

    // 2. Pod is verified, delete it
    await coreV1Api.deleteNamespacedPod({ name: podName, namespace });
    res.json({ message: `Pod ${podName} deleted successfully.` });
  } catch (error) {
    if (error.body) {
      return sendK8sError(res, error);
    }
    next(error);
  }
});

// --- Loki Log Integration ---
const LOKI_URL = process.env.LOKI_URL || "http://localhost:4567";
const NAMESPACE = process.env.ARGO_NAMESPACE || "default";
const NAMESPACE_LABEL = process.env.LOKI_NAMESPACE_LABEL || "namespace";
const ARGO_WORKFLOW_LABEL = process.env.ARGO_WORKFLOW_LABEL || "workflows_argoproj_io_workflow";
const LOKI_LABELS = [
  "app_kubernetes_io_name",
  "container",
  "instance",
  "job",
  "k8s_pod_name",
  "pod",
  "service_name",
  ARGO_WORKFLOW_LABEL,
];

function toLokiTimestamp(dtStr) {
  try {
    if (!dtStr) return "";
    const dt = new Date(dtStr);
    return (BigInt(dt.getTime()) * BigInt(1000000)).toString();
  } catch (e) {
    return "";
  }
}

/**
 * GET /api/logs/labels
 * Fetch all available label keys for the namespace.
 */

  return router;
}

module.exports = { createApplicationRouter };
