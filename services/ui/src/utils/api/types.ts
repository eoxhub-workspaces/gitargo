export interface WorkflowFile {
  id: string;
  name: string;
  type: string;
  path: string;
  mode: string;
  content?: string;
}

export interface CommitHistory {
  id: string;
  short_id: string;
  title: string;
  author_name: string;
  author_email: string;
  authored_date: string;
  committer_name: string;
  committer_email: string;
  committed_date: string;
  message: string;
  stats?: {
    additions?: number;
    deletions?: number;
    total?: number;
  };
}

export interface IngressConfig {
  domain: string;
  ingressClassName: string;
  dnsTarget: string;
  certIssuer: string;
  tlsEnabled: boolean;
  middlewareEnabled: boolean;
  middlewareName: string;
  middlewareAnnotationKey: string;
  middlewareAnnotationValueTemplate: string;
  pathType: string;
  extraAnnotations?: Record<string, string>;
}

export interface KubespawnerOverride {
  mem_guarantee?: string;
  mem_limit?: string;
  cpu_guarantee?: number | string;
  cpu_limit?: number | string;
  extra_resource_limits?: Record<string, string>;
  extra_resource_requests?: Record<string, string>;
  node_selector?: Record<string, string>;
  tolerations?: any[];
  allowed_groups?: string[];
}

export interface JupyterHubProfile {
  display_name?: string;
  label?: string;
  kubespawner_override?: KubespawnerOverride;
  resources?: any;
  tolerations?: any[];
  nodeSelector?: Record<string, string>;
  allowed_groups?: string[];
}

export interface AppConfig {
  version?: string;
  username?: string;
  multiTenantMode?: boolean;
  enableWorkflows?: boolean;
  enableOgcPackages?: boolean;
  enableApplications?: boolean;
  features?: {
    workflows?: boolean;
    ogcPackages?: boolean;
    applications?: boolean;
  };
  profiles: Record<string, JupyterHubProfile>;
  ephemeralVolume: {
    name: string;
    storage: string;
    storageClassName: string;
    mountPath: string;
  };
  defaults: {
    namespace: string;
    serviceAccount: string;
  };
  allowPublishing?: boolean;
  allowPublicIngress?: boolean;
  ingress?: any;
  logViewerUrl?: string;
}

export interface WorkflowExecution {
  metadata: {
    name: string;
    namespace: string;
    creationTimestamp: string;
    labels?: Record<string, string>;
  };
  status?: {
    phase: string;
    message?: string;
    conditions?: any[];
    startedAt: string;
    finishedAt?: string;
    nodes?: Record<string, any>;
    resourcesDuration?: Record<string, number>;
  };
  spec: any;
}

export interface WorkflowExecutionMetrics {
  available: boolean;
  peakMemoryBytes: number;
  peakCpuCores: number;
  cpuRequestsCores: number;
  cpuLimitsCores: number;
  memoryRequestsBytes: number;
  memoryLimitsBytes: number;
  durationSec: number;
}

export interface Application {
  name: string;
  files: string[];
  folder?: string;
  component?: string;
  deployment?: string;
  service?: string;
  ingress?: string;
}

export interface ApplicationYamls {
  deployment: string;
  service: string;
  ingress?: string;
}

export interface ApplicationStatus {
  status: string;
  deployed?: boolean;
  deployment?: {
    replicas?: number;
    readyReplicas?: number;
    conditions?: any[];
  };
  ingress?: {
    ready: boolean;
  };
  vulnerabilities?: any[];
  pods: {
    name: string;
    status: string;
    phase?: string;
    ready: boolean;
    restarts: number;
    age: string;
    containerStatus?: any[];
    lastWarning?: string;
  }[];
}

export interface PackageFile {
  id: string;
  name: string;
  type: string;
  path: string;
  mode: string;
}

export interface CwlSubmissionPayload {
  cwlUrl?: string;
  cwlContent?: string;
  processId?: string;
  parameters?: Record<string, any>;
  inputTypes?: Record<string, string>;
  inlineFiles?: Record<string, string>;
  name?: string;
  packageId?: string;
}

export interface WorkspaceFileItem {
  name: string;
  isDirectory: boolean;
  size: number;
  mtime: string | null;
}

export interface WorkspaceFilesResponse {
  files: WorkspaceFileItem[];
  exists: boolean;
  currentPath: string;
}

export interface GetLogsOptions {
  type?: "pod" | "workflow" | "overview";
  query?: string;
  startTime?: string;
  endTime?: string;
  workflow?: string;
}
