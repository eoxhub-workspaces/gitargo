const k8s = require('@kubernetes/client-node');

function createK8sClients() {
  const kc = new k8s.KubeConfig();
  let customObjectsApi = null;
  let appsV1Api = null;
  let coreV1Api = null;
  let networkingV1Api = null;

  try {
    kc.loadFromDefault();
    customObjectsApi = kc.makeApiClient(k8s.CustomObjectsApi);
    appsV1Api = kc.makeApiClient(k8s.AppsV1Api);
    coreV1Api = kc.makeApiClient(k8s.CoreV1Api);
    networkingV1Api = kc.makeApiClient(k8s.NetworkingV1Api);
  } catch (err) {
    console.warn('Kubernetes client initialization warning:', err.message);
  }

  return {
    kc,
    customObjectsApi,
    appsV1Api,
    coreV1Api,
    networkingV1Api,
    k8sApi: customObjectsApi,
    k8sCustomApi: customObjectsApi,
    k8sCoreApi: coreV1Api
  };
}

module.exports = { createK8sClients };
