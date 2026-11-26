import { describe, it, expect } from "vitest";
import {
  validateK8sYaml,
  stripNullCreationTimestamps,
  validateDeploymentSecurity,
  applySecurityFix,
  autoFixDeploymentSecurity
} from "./k8sValidation";

describe("k8sValidation", () => {
  describe("validateK8sYaml", () => {
    it("should pass for valid Argo Workflow YAML", () => {
      const validYaml = `
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: test-workflow
spec:
  entrypoint: main
`;
      expect(() => validateK8sYaml(validYaml)).not.toThrow();
    });

    it("should throw error for non-Argo kind", () => {
      const invalidKind = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-dep
`;
      expect(() => validateK8sYaml(invalidKind)).toThrow(
        "Invalid kind 'Deployment'"
      );
    });

    it("should pass for valid Argo v4 CronWorkflow with schedules array", () => {
      const validCronYaml = `
apiVersion: argoproj.io/v1alpha1
kind: CronWorkflow
metadata:
  name: test-cron
spec:
  schedules:
    - "@daily"
  workflowSpec:
    entrypoint: execute
    templates: []
`;
      expect(() => validateK8sYaml(validCronYaml)).not.toThrow();
    });

    it("should reject CronWorkflow with deprecated spec.schedule in Argo v4", () => {
      const deprecatedCronYaml = `
apiVersion: argoproj.io/v1alpha1
kind: CronWorkflow
metadata:
  name: test-cron
spec:
  schedule: "0 0 * * *"
  workflowSpec:
    entrypoint: execute
`;
      expect(() => validateK8sYaml(deprecatedCronYaml)).toThrow(
        "In Argo v4, 'spec.schedule' has been removed for CronWorkflow. Please use 'spec.schedules' (list of strings) instead."
      );
    });

    it("should reject spec.synchronization.mutex in Argo v4", () => {
      const mutexYaml = `
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: test-mutex
spec:
  synchronization:
    mutex:
      name: test-lock
`;
      expect(() => validateK8sYaml(mutexYaml)).toThrow(
        "In Argo v4, 'spec.synchronization.mutex' has been removed. Please use 'spec.synchronization.mutexes' (list) instead."
      );
    });

    it("should reject spec.synchronization.semaphore in Argo v4", () => {
      const semYaml = `
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: test-sem
spec:
  synchronization:
    semaphore:
      configMapKeyRef:
        name: my-config
        key: lock
`;
      expect(() => validateK8sYaml(semYaml)).toThrow(
        "In Argo v4, 'spec.synchronization.semaphore' has been removed. Please use 'spec.synchronization.semaphores' (list) instead."
      );
    });

    it("should reject spec.podPriority in Argo v4", () => {
      const priorityYaml = `
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: test-priority
spec:
  podPriority: 10
`;
      expect(() => validateK8sYaml(priorityYaml)).toThrow(
        "In Argo v4, 'spec.podPriority' has been removed. Please use 'spec.podPriorityClassName' instead."
      );
    });

    it("should reject memoize.cache.configMap.key in Argo v4", () => {
      const memoizeYaml = `
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: test-memoize
spec:
  templates:
    - name: step1
      memoize:
        key: "{{inputs.parameters.val}}"
        cache:
          configMap:
            name: my-cache
            key: my-key
`;
      expect(() => validateK8sYaml(memoizeYaml)).toThrow(
        "In Argo v4, 'memoize.cache.configMap.key' has been removed (in template 'step1')."
      );
    });

    it("should reject creationTimestamp: null in metadata", () => {
      const nullMetaYaml = `
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: test-null
  creationTimestamp: null
spec:
  entrypoint: main
`;
      expect(() => validateK8sYaml(nullMetaYaml)).toThrow(
        "Argo v4 strict schema validation rejects 'creationTimestamp: null'. Please remove 'creationTimestamp' from metadata."
      );
    });

    it("should reject creationTimestamp: null in volumeClaimTemplates", () => {
      const nullVctYaml = `
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: test-vct
spec:
  entrypoint: main
  volumeClaimTemplates:
    - metadata:
        name: workdir
        creationTimestamp: null
      spec:
        accessModes: ["ReadWriteOnce"]
`;
      expect(() => validateK8sYaml(nullVctYaml)).toThrow(
        "Argo v4 strict schema validation rejects 'creationTimestamp: null' in volumeClaimTemplates. Please remove 'creationTimestamp' from volumeClaimTemplates metadata."
      );
    });
  });

  describe("stripNullCreationTimestamps", () => {
    it("should remove creationTimestamp: null lines without modifying other content", () => {
      const inputYaml = `apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: test-vct
  creationTimestamp: null
spec:
  entrypoint: main
  volumeClaimTemplates:
    - metadata:
        name: workdir
        creationTimestamp: null
      spec:
        accessModes: ["ReadWriteOnce"]
`;
      const cleaned = stripNullCreationTimestamps(inputYaml);
      expect(cleaned).not.toContain("creationTimestamp: null");
      expect(cleaned).toContain("name: test-vct");
      expect(cleaned).toContain("name: workdir");
      expect(() => validateK8sYaml(cleaned)).not.toThrow();
    });
  });

  describe("validateDeploymentSecurity", () => {
    it("should return no warnings for a compliant deployment manifest", () => {
      const secureYaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: secure-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: secure-app
  template:
    metadata:
      labels:
        app: secure-app
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      containers:
        - name: app
          image: ghcr.io/org/app:v1.0.0
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: "100m"
              memory: "128Mi"
            limits:
              cpu: "500m"
              memory: "512Mi"
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
`;
      const warnings = validateDeploymentSecurity(secureYaml);
      expect(warnings).toEqual([]);
    });

    it("should flag missing pod securityContext, resources, and insecure container settings", () => {
      const insecureYaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: insecure-app
spec:
  template:
    spec:
      containers:
        - name: app
          image: nginx:latest
`;
      const warnings = validateDeploymentSecurity(insecureYaml);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.some((w) => w.id === "pod-security-context")).toBe(true);
      expect(warnings.some((w) => w.id === "container-0-resources")).toBe(true);
      expect(
        warnings.some((w) => w.id === "container-0-security-context")
      ).toBe(true);
      expect(warnings.some((w) => w.id === "container-0-image-tag")).toBe(true);
    });
  });

  describe("applySecurityFix", () => {
    it("should fix a single specific issue when issueId is provided", () => {
      const insecureYaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
spec:
  template:
    spec:
      containers:
        - name: app
          image: nginx:latest
`;
      const initialWarnings = validateDeploymentSecurity(insecureYaml);
      expect(initialWarnings.some((w) => w.id === "pod-security-context")).toBe(
        true
      );

      // Fix only pod security context
      const fixedPodYaml = applySecurityFix(
        insecureYaml,
        "pod-security-context"
      );
      const warningsAfterPodFix = validateDeploymentSecurity(fixedPodYaml);
      expect(
        warningsAfterPodFix.some((w) => w.id === "pod-security-context")
      ).toBe(false);
      expect(
        warningsAfterPodFix.some((w) => w.id === "container-0-resources")
      ).toBe(true);
    });

    it("should automatically fix all issues when autoFixDeploymentSecurity is called", () => {
      const insecureYaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: insecure-app
spec:
  template:
    spec:
      containers:
        - name: app
          image: nginx:latest
`;
      const fixedYaml = autoFixDeploymentSecurity(insecureYaml);
      const warningsAfterFix = validateDeploymentSecurity(fixedYaml);
      expect(warningsAfterFix).toEqual([]);
    });
  });
});
