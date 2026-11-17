const axios = require('axios');

const PROMETHEUS_CANDIDATES = [
  process.env.PROMETHEUS_URL,
  'http://mon-kube-prom-stack-prometheus.core.svc:9090',
  'http://prometheus-operated.core.svc:9090',
  'http://mon-kube-prom-stack-prometheus.core:9090',
  'http://prometheus-operated.core:9090',
  'http://prometheus-operated.monitoring.svc:9090',
  'http://prometheus-kube-prometheus-prometheus.monitoring.svc:9090',
  'http://prometheus-k8s.monitoring.svc:9090',
  'http://prometheus-server.monitoring.svc:9090'
].filter(Boolean);

let cachedWorkingPrometheusUrl = null;

async function discoverPrometheusUrl() {
  if (cachedWorkingPrometheusUrl) return cachedWorkingPrometheusUrl;
  if (process.env.PROMETHEUS_URL) return process.env.PROMETHEUS_URL;

  for (const url of PROMETHEUS_CANDIDATES) {
    try {
      const res = await axios.get(`${url}/api/v1/query`, {
        params: { query: '1' },
        timeout: 1500
      });
      if (res.data && res.data.status === 'success') {
        console.log(`[PROMETHEUS] Auto-discovered working Prometheus service at: ${url}`);
        cachedWorkingPrometheusUrl = url;
        return url;
      }
    } catch (e) {
      // try next candidate
    }
  }

  return PROMETHEUS_CANDIDATES[0] || 'http://mon-kube-prom-stack-prometheus.core.svc:9090';
}

async function queryPrometheus(query, time = null) {
  const baseURL = await discoverPrometheusUrl();
  try {
    const params = { query };
    if (time) params.time = time;
    const response = await axios.get(`${baseURL}/api/v1/query`, {
      params,
      timeout: 5000
    });
    if (response.data && response.data.status === 'success') {
      return response.data.data;
    }
    return null;
  } catch (err) {
    console.warn(`[PROMETHEUS] Query failed on ${baseURL} for "${query}":`, err.message);
    return null;
  }
}

function parsePrometheusValue(data) {
  if (!data || !data.result || data.result.length === 0) return 0;
  const val = data.result[0]?.value?.[1];
  if (!val) return 0;
  const num = parseFloat(val);
  return isNaN(num) ? 0 : num;
}

function extractPodSearchPattern(name, username = null) {
  if (!name) return "";
  let target = name;
  if (username && target.startsWith(`${username}-`)) {
    target = target.slice(username.length + 1);
  }
  return target;
}

async function getWorkflowPeakMetrics(namespace, workflowName, startTime, finishTime, stepPod = null, username = null) {
  const now = Math.floor(Date.now() / 1000);
  const startTs = startTime ? Math.floor(new Date(startTime).getTime() / 1000) : now - 3600;
  const endTs = finishTime ? Math.floor(new Date(finishTime).getTime() / 1000) : now;
  const durationSec = Math.max(endTs - startTs, 30);

  let durationStr = `${durationSec}s`;
  if (durationSec > 3600) {
    durationStr = `${Math.ceil(durationSec / 3600)}h`;
  } else if (durationSec > 60) {
    durationStr = `${Math.ceil(durationSec / 60)}m`;
  }

  const rawTarget = stepPod || workflowName;
  const targetName = extractPodSearchPattern(rawTarget, username);
  const podRegex = `.*${targetName}.*`;

  const memoryPeakQuery = `max_over_time(sum(container_memory_working_set_bytes{namespace="${namespace}", pod=~"${podRegex}", container!="POD", container!=""})[${durationStr}:15s])`;
  const memoryCurrentQuery = `sum(container_memory_working_set_bytes{namespace="${namespace}", pod=~"${podRegex}", container!="POD", container!=""})`;

  const cpuPeakQuery = `max_over_time(sum(rate(container_cpu_usage_seconds_total{namespace="${namespace}", pod=~"${podRegex}", container!="POD", container!=""}[1m]))[${durationStr}:15s])`;
  const cpuCurrentQuery = `sum(rate(container_cpu_usage_seconds_total{namespace="${namespace}", pod=~"${podRegex}", container!="POD", container!=""}[1m]))`;

  const cpuRequestQuery = `sum(kube_pod_container_resource_requests{namespace="${namespace}", pod=~"${podRegex}", resource="cpu"})`;
  const cpuLimitQuery = `sum(kube_pod_container_resource_limits{namespace="${namespace}", pod=~"${podRegex}", resource="cpu"})`;

  const memoryRequestQuery = `sum(kube_pod_container_resource_requests{namespace="${namespace}", pod=~"${podRegex}", resource="memory"})`;
  const memoryLimitQuery = `sum(kube_pod_container_resource_limits{namespace="${namespace}", pod=~"${podRegex}", resource="memory"})`;

  const [
    memPeakRes,
    memCurrRes,
    cpuPeakRes,
    cpuCurrRes,
    cpuReqRes,
    cpuLimRes,
    memReqRes,
    memLimRes
  ] = await Promise.all([
    queryPrometheus(memoryPeakQuery, endTs),
    queryPrometheus(memoryCurrentQuery, endTs),
    queryPrometheus(cpuPeakQuery, endTs),
    queryPrometheus(cpuCurrentQuery, endTs),
    queryPrometheus(cpuRequestQuery, endTs),
    queryPrometheus(cpuLimitQuery, endTs),
    queryPrometheus(memoryRequestQuery, endTs),
    queryPrometheus(memoryLimitQuery, endTs)
  ]);

  const peakMemoryBytes = Math.max(parsePrometheusValue(memPeakRes), parsePrometheusValue(memCurrRes));
  const peakCpuCores = Math.max(parsePrometheusValue(cpuPeakRes), parsePrometheusValue(cpuCurrRes));

  const cpuRequestsCores = parsePrometheusValue(cpuReqRes);
  const cpuLimitsCores = parsePrometheusValue(cpuLimRes);
  const memoryRequestsBytes = parsePrometheusValue(memReqRes);
  const memoryLimitsBytes = parsePrometheusValue(memLimRes);

  return {
    available: peakMemoryBytes > 0 || peakCpuCores > 0,
    peakMemoryBytes,
    peakCpuCores,
    cpuRequestsCores,
    cpuLimitsCores,
    memoryRequestsBytes,
    memoryLimitsBytes,
    durationSec
  };
}

module.exports = {
  getWorkflowPeakMetrics,
  queryPrometheus,
  parsePrometheusValue,
  discoverPrometheusUrl,
  extractPodSearchPattern
};
