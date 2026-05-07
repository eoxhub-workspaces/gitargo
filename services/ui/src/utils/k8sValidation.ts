import YAML from "yaml";

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

  const allowedArgoKinds = [
    "Workflow",
    "CronWorkflow",
    "WorkflowTemplate",
    "ClusterWorkflowTemplate"
  ];

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
