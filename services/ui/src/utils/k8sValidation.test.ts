import { describe, it, expect } from "vitest";
import {
  validateK8sYaml,
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
