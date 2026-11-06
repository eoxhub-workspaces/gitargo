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

export interface AppConfig {
  version?: string;
  enableWorkflows?: boolean;
  enableOgcPackages?: boolean;
  enableApplications?: boolean;
  features?: {
    workflows?: boolean;
    ogcPackages?: boolean;
    applications?: boolean;
  };
  profiles: Record<
    string,
    {
      label: string;
      resources: any;
      tolerations?: any[];
      nodeSelector?: Record<string, string>;
      affinity?: any;
    }
  >;
  availableTolerations?: any[];
  availableNodeSelectors?: any[];
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
  logViewerUrl?: string;
  allowPublishing: boolean;
  allowPublicIngress?: boolean;
  ingress?: IngressConfig;
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
