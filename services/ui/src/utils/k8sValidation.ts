import YAML from "yaml";

export interface SecurityWarning {
  id: string;
  message: string;
  category: "podSecurity" | "containerSecurity" | "resources" | "image";
}

export const validateK8sYaml = (yamlContent: string): void => {
  let parsed;
  try {
    parsed = YAML.parse(yamlContent);
  } catch (e: any) {
    throw new Error(`Invalid YAML format: ${e.message}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("YAML must map to a valid Kubernetes object.");
  }

  if (!parsed.apiVersion) {
    throw new Error("Missing 'apiVersion'.");
  }

  if (!parsed.kind) {
    throw new Error("Missing 'kind'.");
  }

  const allowedArgoKinds = ["Workflow", "CronWorkflow", "WorkflowTemplate"];

  if (!allowedArgoKinds.includes(parsed.kind)) {
    throw new Error(
      `Invalid kind '${parsed.kind}'. Allowed kinds are: ${allowedArgoKinds.join(", ")}.`
    );
  }

  if (!parsed.metadata || typeof parsed.metadata !== "object") {
    throw new Error("Missing 'metadata' object.");
  }

  if (!parsed.metadata.name) {
    throw new Error(
      "Missing 'metadata.name'. This is explicitly required for Kustomize compatibility."
    );
  }
};

export const validateDeploymentSecurity = (
  yamlContent: string
): SecurityWarning[] => {
  const warnings: SecurityWarning[] = [];
  if (!yamlContent || !yamlContent.trim()) return warnings;

  let parsed: any;
  try {
    const docs = yamlContent
      .split("\n---")
      .map((d) => d.trim())
      .filter(Boolean);
    for (const d of docs) {
      const p = YAML.parse(d);
      if (p && p.kind === "Deployment") {
        parsed = p;
        break;
      }
    }
    if (!parsed) {
      parsed = YAML.parse(yamlContent);
    }
  } catch {
    return warnings;
  }

  if (!parsed || parsed.kind !== "Deployment") {
    return warnings;
  }

  const podSpec = parsed.spec?.template?.spec;
  if (!podSpec) {
    warnings.push({
      id: "pod-spec-missing",
      message: "Pod specification is missing",
      category: "podSecurity"
    });
    return warnings;
  }

  // 1. Pod securityContext
  const podSec = podSpec.securityContext;
  if (!podSec || typeof podSec !== "object") {
    warnings.push({
      id: "pod-security-context",
      message: "Pod security: Enable non-root execution ('runAsNonRoot: true')",
      category: "podSecurity"
    });
  } else {
    if (podSec.runAsNonRoot !== true) {
      warnings.push({
        id: "pod-run-as-non-root",
        message: "Pod security: Set 'runAsNonRoot: true'",
        category: "podSecurity"
      });
    }
    if (podSec.runAsUser === undefined || podSec.runAsUser === 0) {
      warnings.push({
        id: "pod-run-as-user",
        message: "Pod security: Set a non-root User ID ('runAsUser: 1000')",
        category: "podSecurity"
      });
    }
  }

  // 2. Containers
  const containers = podSpec.containers;
  if (!Array.isArray(containers) || containers.length === 0) {
    warnings.push({
      id: "containers-missing",
      message: "Deployment containers list is empty",
      category: "containerSecurity"
    });
  } else {
    containers.forEach((c: any, index: number) => {
      const cName = c?.name || `container #${index + 1}`;

      // Resources
      const res = c?.resources;
      if (!res || typeof res !== "object") {
        warnings.push({
          id: `container-${index}-resources`,
          message: `Container '${cName}': Set CPU and memory limits and requests`,
          category: "resources"
        });
      } else {
        if (!res.requests || !res.requests.cpu || !res.requests.memory) {
          warnings.push({
            id: `container-${index}-resource-requests`,
            message: `Container '${cName}': Set resource requests (CPU and memory)`,
            category: "resources"
          });
        }
        if (!res.limits || !res.limits.cpu || !res.limits.memory) {
          warnings.push({
            id: `container-${index}-resource-limits`,
            message: `Container '${cName}': Set resource limits (CPU and memory)`,
            category: "resources"
          });
        }
      }

      // Container securityContext
      const cSec = c?.securityContext;
      if (!cSec || typeof cSec !== "object") {
        warnings.push({
          id: `container-${index}-security-context`,
          message: `Container '${cName}': Enable security settings (no privilege escalation, drop capabilities)`,
          category: "containerSecurity"
        });
      } else {
        if (cSec.allowPrivilegeEscalation !== false) {
          warnings.push({
            id: `container-${index}-allow-privilege-escalation`,
            message: `Container '${cName}': Set 'allowPrivilegeEscalation: false'`,
            category: "containerSecurity"
          });
        }
        if (cSec.readOnlyRootFilesystem !== true) {
          warnings.push({
            id: `container-${index}-read-only-root-fs`,
            message: `Container '${cName}': Set 'readOnlyRootFilesystem: true'`,
            category: "containerSecurity"
          });
        }
        const drops = Array.isArray(cSec.capabilities?.drop)
          ? cSec.capabilities.drop.map((x: any) => String(x).toUpperCase())
          : [];
        if (!drops.includes("ALL")) {
          warnings.push({
            id: `container-${index}-capabilities-drop`,
            message: `Container '${cName}': Drop all Linux capabilities ('capabilities.drop: [ALL]')`,
            category: "containerSecurity"
          });
        }
      }

      // Image versioning
      const img = String(c?.image || "");
      if (!img) {
        warnings.push({
          id: `container-${index}-image-missing`,
          message: `Container '${cName}': Specify container image`,
          category: "image"
        });
      } else {
        const lastPart = img.split("/").pop() || "";
        if (!lastPart.includes(":") || lastPart.endsWith(":latest")) {
          warnings.push({
            id: `container-${index}-image-tag`,
            message: `Container '${cName}': Use a specific version tag instead of ':latest' or untagged`,
            category: "image"
          });
        }
      }
    });
  }

  return warnings;
};

export const applySecurityFix = (
  yamlContent: string,
  issueId: string
): string => {
  if (!yamlContent || !yamlContent.trim()) return yamlContent;

  let doc: any;
  try {
    doc = YAML.parseDocument(yamlContent);
  } catch {
    return yamlContent;
  }

  if (!doc || !doc.contents || doc.get("kind") !== "Deployment") {
    return yamlContent;
  }

  const podSecPath = ["spec", "template", "spec", "securityContext"];

  if (issueId === "all" || issueId === "pod-security-context") {
    doc.setIn(podSecPath, {
      runAsNonRoot: true,
      runAsUser: 1000,
      fsGroup: 1000
    });
  } else if (issueId === "pod-run-as-non-root") {
    doc.setIn([...podSecPath, "runAsNonRoot"], true);
  } else if (issueId === "pod-run-as-user") {
    doc.setIn([...podSecPath, "runAsUser"], 1000);
  }

  const containers = doc.getIn(["spec", "template", "spec", "containers"]);
  if (containers && containers.items && containers.items.length > 0) {
    containers.items.forEach((c: any, index: number) => {
      const cPath = ["spec", "template", "spec", "containers", index];
      const resPath = [...cPath, "resources"];
      const cSecPath = [...cPath, "securityContext"];

      // Container resources fixes
      if (issueId === "all" || issueId === `container-${index}-resources`) {
        doc.setIn(resPath, {
          requests: { cpu: "100m", memory: "128Mi" },
          limits: { cpu: "500m", memory: "512Mi" }
        });
      } else if (issueId === `container-${index}-resource-requests`) {
        if (!doc.getIn([...resPath, "requests", "cpu"])) {
          doc.setIn([...resPath, "requests", "cpu"], "100m");
        }
        if (!doc.getIn([...resPath, "requests", "memory"])) {
          doc.setIn([...resPath, "requests", "memory"], "128Mi");
        }
      } else if (issueId === `container-${index}-resource-limits`) {
        if (!doc.getIn([...resPath, "limits", "cpu"])) {
          doc.setIn([...resPath, "limits", "cpu"], "500m");
        }
        if (!doc.getIn([...resPath, "limits", "memory"])) {
          doc.setIn([...resPath, "limits", "memory"], "512Mi");
        }
      }

      // Container securityContext fixes
      if (
        issueId === "all" ||
        issueId === `container-${index}-security-context`
      ) {
        doc.setIn(cSecPath, {
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ["ALL"] }
        });
      } else {
        if (issueId === `container-${index}-allow-privilege-escalation`) {
          doc.setIn([...cSecPath, "allowPrivilegeEscalation"], false);
        }
        if (issueId === `container-${index}-read-only-root-fs`) {
          doc.setIn([...cSecPath, "readOnlyRootFilesystem"], true);
        }
        if (issueId === `container-${index}-capabilities-drop`) {
          const drops = doc.getIn([...cSecPath, "capabilities", "drop"]);
          if (!drops || !drops.items || drops.items.length === 0) {
            doc.setIn([...cSecPath, "capabilities", "drop"], ["ALL"]);
          } else {
            const dropValues = drops.items.map((x: any) =>
              String(x?.toJSON ? x.toJSON() : x).toUpperCase()
            );
            if (!dropValues.includes("ALL")) {
              drops.items.push("ALL");
            }
          }
        }
      }

      // Image tag fix
      if (issueId === "all" || issueId === `container-${index}-image-tag`) {
        const imageVal = String(doc.getIn([...cPath, "image"]) || "");
        if (imageVal === "nginx" || imageVal === "nginx:latest") {
          doc.setIn([...cPath, "image"], "nginx/nginx-unprivileged:1.31");
        } else if (!imageVal.includes(":")) {
          doc.setIn([...cPath, "image"], `${imageVal}:1.0.0`);
        } else if (imageVal.endsWith(":latest")) {
          doc.setIn(
            [...cPath, "image"],
            imageVal.replace(/:latest$/, ":1.0.0")
          );
        }
      }
    });
  }

  return doc.toString();
};

export const autoFixDeploymentSecurity = (yamlContent: string): string => {
  return applySecurityFix(yamlContent, "all");
};
