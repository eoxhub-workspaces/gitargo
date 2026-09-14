import React from "react";
import { AppConfig } from "../../utils/api";
import { InfoButton } from "./InfoButton";

export interface IResourcePlacementState {
  namespace: string; // The namespace name
  serviceAccount: string; // The service account name
  cpuRequest: string;
  cpuLimit: string;
  memoryRequest: string;
  memoryLimit: string;
  gpuLimit: string;
  tolerations: any[]; // Array of selected toleration objects
  nodeSelector: Record<string, string>; // Selected key-value pairs
}

interface ResourcePlacementFormProps {
  state: IResourcePlacementState;
  onChange: (newState: IResourcePlacementState) => void;
  config: AppConfig | null;
}

export const ResourcePlacementForm: React.FC<ResourcePlacementFormProps> = ({
  state,
  onChange,
  config
}) => {
  const availableTols = config?.availableTolerations || [];
  const availableSelectors = config?.availableNodeSelectors || [];
  const defaultNamespace = config?.defaults?.namespace || "default";
  const defaultServiceAccount = config?.defaults?.serviceAccount || "default";

  const handleFieldChange = (
    key: keyof IResourcePlacementState,
    value: any
  ) => {
    onChange({
      ...state,
      [key]: value
    });
  };

  const handleTolerationToggle = (tol: any) => {
    const isSelected = state.tolerations.some((t) => t.key === tol.key);
    let newTols;
    if (isSelected) {
      newTols = state.tolerations.filter((t) => t.key !== tol.key);
    } else {
      newTols = [
        ...state.tolerations,
        {
          key: tol.key,
          operator: tol.operator || "Exists",
          value: tol.value || undefined,
          effect: tol.effect || "NoSchedule"
        }
      ];
    }
    handleFieldChange("tolerations", newTols);
  };

  const handleNodeSelectorToggle = (sel: any) => {
    const isSelected = state.nodeSelector[sel.key] === sel.value;
    const newSelectors = { ...state.nodeSelector };
    if (isSelected) {
      delete newSelectors[sel.key];
    } else {
      newSelectors[sel.key] = sel.value;
    }
    handleFieldChange("nodeSelector", newSelectors);
  };

  const handleSetDefaultNamespace = () => {
    handleFieldChange("namespace", defaultNamespace);
  };

  const handleSetDefaultServiceAccount = () => {
    handleFieldChange("serviceAccount", defaultServiceAccount);
  };

  const handleRemoveUnsupportedTolerations = () => {
    const supported = state.tolerations.filter((t) =>
      availableTols.some((at) => at.key === t.key)
    );
    handleFieldChange("tolerations", supported);
  };

  const handleRemoveUnsupportedSelectors = () => {
    const supported: Record<string, string> = {};
    Object.entries(state.nodeSelector).forEach(([key, value]) => {
      if (
        availableSelectors.some((as) => as.key === key && as.value === value)
      ) {
        supported[key] = value;
      }
    });
    handleFieldChange("nodeSelector", supported);
  };

  // Find unsupported items currently present in the state/YAML
  const unsupportedTolerations = state.tolerations.filter(
    (t) => !availableTols.some((at) => at.key === t.key)
  );

  const unsupportedSelectors = Object.entries(state.nodeSelector).filter(
    ([key, value]) =>
      !availableSelectors.some((as) => as.key === key && as.value === value)
  );

  const isNamespaceMismatched =
    state.namespace && state.namespace !== defaultNamespace;

  const isServiceAccountMismatched =
    state.serviceAccount && state.serviceAccount !== defaultServiceAccount;

  return (
    <div className="space-y-6 text-sm text-gray-700">
      {/* Namespace Section */}
      <div>
        <h4 className="text-sm font-semibold text-gray-900 border-b pb-2 mb-3 flex items-center">
          <span>Namespace</span>
          <InfoButton text="The Kubernetes namespace defines the logical scope and isolation boundary where your workflow runs and its pods are scheduled." />
        </h4>
        <div className="flex space-x-2">
          <input
            type="text"
            value={state.namespace}
            onChange={(e) => handleFieldChange("namespace", e.target.value)}
            placeholder={`e.g. ${defaultNamespace}`}
            className="flex-1 bg-white border border-gray-300 text-sm rounded-lg p-2 focus:ring-blue-500 focus:border-blue-500 font-mono"
          />
        </div>

        {/* Namespace Warning Alert */}
        {(!state.namespace || isNamespaceMismatched) && (
          <div className="mt-3 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-xs text-yellow-800 space-y-2">
            <p className="font-semibold leading-relaxed">
              ⚠️{" "}
              {!state.namespace
                ? "No Namespace specified. This can cause the workflow to run in an incorrect namespace."
                : `Current Namespace "${state.namespace}" does not match the recommended default "${defaultNamespace}".`}
            </p>
            <button
              type="button"
              onClick={handleSetDefaultNamespace}
              className="px-2 py-1 bg-yellow-100 hover:bg-yellow-200 rounded font-semibold text-yellow-900 transition-colors border border-yellow-300"
            >
              Set to Recommended Default: "{defaultNamespace}"
            </button>
          </div>
        )}
      </div>

      {/* Service Account Section */}
      <div>
        <h4 className="text-sm font-semibold text-gray-900 border-b pb-2 mb-3 flex items-center">
          <span>Service Account</span>
          <InfoButton text="The identity used by workflow tasks to interact with the Kubernetes API and retrieve namespace resources." />
        </h4>
        <div className="flex space-x-2">
          <input
            type="text"
            value={state.serviceAccount}
            onChange={(e) =>
              handleFieldChange("serviceAccount", e.target.value)
            }
            placeholder={`e.g. ${defaultServiceAccount}`}
            className="flex-1 bg-white border border-gray-300 text-sm rounded-lg p-2 focus:ring-blue-500 focus:border-blue-500 font-mono"
          />
        </div>

        {/* Service Account Warning Alert */}
        {(!state.serviceAccount || isServiceAccountMismatched) && (
          <div className="mt-3 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-xs text-yellow-800 space-y-2">
            <p className="font-semibold leading-relaxed">
              ⚠️{" "}
              {!state.serviceAccount
                ? "No Service Account specified. This can prevent pods from running or reading secrets."
                : `Current Service Account "${state.serviceAccount}" does not match the recommended default "${defaultServiceAccount}".`}
            </p>
            <button
              type="button"
              onClick={handleSetDefaultServiceAccount}
              className="px-2 py-1 bg-yellow-100 hover:bg-yellow-200 rounded font-semibold text-yellow-900 transition-colors border border-yellow-300"
            >
              Set to Recommended Default: "{defaultServiceAccount}"
            </button>
          </div>
        )}
      </div>

      {/* Tolerations Selectors (Only shown if configured or has active tolerations) */}
      {(availableTols.length > 0 || unsupportedTolerations.length > 0) && (
        <div>
          <h4 className="text-sm font-semibold text-gray-900 border-b pb-2 mb-3 flex items-center">
            <span>Node Tolerations</span>
            <InfoButton text="Some servers in the cluster (like those with expensive GPUs) are tainted to preventing unauthorized pods from running. Selecting a toleration acts like a key that allows your workflow tasks to run on these dedicated servers." />
          </h4>
          {availableTols.length > 0 && (
            <div className="space-y-2">
              {availableTols.map((tol: any) => {
                const isChecked = state.tolerations.some(
                  (t) => t.key === tol.key
                );
                return (
                  <label
                    key={tol.key}
                    className="flex items-center space-x-3 p-2 border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => handleTolerationToggle(tol)}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    />
                    <div className="min-w-0 flex-1">
                      <span className="text-sm font-semibold text-gray-800">
                        {tol.label || tol.key}
                      </span>
                      <p className="text-xs text-gray-500 font-mono mt-0.5">
                        key: {tol.key} | operator: {tol.operator || "Exists"}
                      </p>
                    </div>
                  </label>
                );
              })}
            </div>
          )}

          {/* Unsupported Tolerations Warnings */}
          {unsupportedTolerations.length > 0 && (
            <div className="mt-3 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-xs text-yellow-800 space-y-2">
              <p className="font-semibold leading-relaxed">
                ⚠️ The following active tolerations do not seem to be officially
                supported on this cluster:
              </p>
              <ul className="list-disc list-inside font-mono text-[10px] text-yellow-700 bg-white/40 p-2 rounded">
                {unsupportedTolerations.map((t) => (
                  <li key={t.key}>
                    key: "{t.key}" | operator: "{t.operator || "Exists"}"
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={handleRemoveUnsupportedTolerations}
                className="px-2 py-1 bg-yellow-100 hover:bg-yellow-200 rounded font-semibold text-yellow-900 transition-colors border border-yellow-300"
              >
                Remove Unsupported Tolerations
              </button>
            </div>
          )}
        </div>
      )}

      {/* Node Selectors (Only shown if configured in backend) */}
      {availableSelectors.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold text-gray-900 border-b pb-2 mb-3 flex items-center">
            <span>Node Selectors</span>
            <InfoButton text="Specify constraints to force your workflow to run only on nodes matching particular labels (like CPU architecture or zones)." />
          </h4>
          <div className="space-y-2">
            {availableSelectors.map((sel: any) => {
              const isChecked = state.nodeSelector[sel.key] === sel.value;
              return (
                <label
                  key={`${sel.key}-${sel.value}`}
                  className="flex items-center space-x-3 p-2 border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => handleNodeSelectorToggle(sel)}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <div className="min-w-0 flex-1">
                    <span className="text-sm font-semibold text-gray-800">
                      {sel.label || `${sel.key}=${sel.value}`}
                    </span>
                    <p className="text-xs text-gray-500 font-mono mt-0.5">
                      {sel.key}: {sel.value}
                    </p>
                  </div>
                </label>
              );
            })}
          </div>

          {/* Unsupported Node Selectors Warnings */}
          {unsupportedSelectors.length > 0 && (
            <div className="mt-3 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-xs text-yellow-800 space-y-2">
              <p className="font-semibold leading-relaxed">
                ⚠️ The following active node selectors are not officially
                supported on this cluster:
              </p>
              <ul className="list-disc list-inside font-mono text-[10px] text-yellow-700 bg-white/40 p-2 rounded">
                {unsupportedSelectors.map(([key, value]) => (
                  <li key={key}>
                    {key}: "{value}"
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={handleRemoveUnsupportedSelectors}
                className="px-2 py-1 bg-yellow-100 hover:bg-yellow-200 rounded font-semibold text-yellow-900 transition-colors border border-yellow-300"
              >
                Remove Unsupported Selectors
              </button>
            </div>
          )}
        </div>
      )}

      {/* CPU & Memory Requests/Limits */}
      <div>
        <h4 className="text-sm font-semibold text-gray-900 border-b pb-2 mb-3 flex items-center">
          <span>Resources (Requests & Limits)</span>
          <InfoButton text="Configure default CPU and Memory allocations. Requests reserve a minimum guaranteed capacity, while limits cap the maximum consumption to protect other tasks in the cluster." />
        </h4>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">
              CPU Request
            </label>
            <input
              type="text"
              value={state.cpuRequest}
              onChange={(e) => handleFieldChange("cpuRequest", e.target.value)}
              placeholder="e.g. 500m, 1"
              className="w-full bg-white border border-gray-300 text-sm rounded-lg p-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">
              CPU Limit
            </label>
            <input
              type="text"
              value={state.cpuLimit}
              onChange={(e) => handleFieldChange("cpuLimit", e.target.value)}
              placeholder="e.g. 1, 2"
              className="w-full bg-white border border-gray-300 text-sm rounded-lg p-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">
              Memory Request
            </label>
            <input
              type="text"
              value={state.memoryRequest}
              onChange={(e) =>
                handleFieldChange("memoryRequest", e.target.value)
              }
              placeholder="e.g. 512Mi, 1Gi"
              className="w-full bg-white border border-gray-300 text-sm rounded-lg p-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">
              Memory Limit
            </label>
            <input
              type="text"
              value={state.memoryLimit}
              onChange={(e) => handleFieldChange("memoryLimit", e.target.value)}
              placeholder="e.g. 1Gi, 2Gi"
              className="w-full bg-white border border-gray-300 text-sm rounded-lg p-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div className="col-span-2">
            <label className="block text-xs font-semibold text-gray-600 mb-1">
              GPU Limit (Optional)
            </label>
            <input
              type="text"
              value={state.gpuLimit}
              onChange={(e) => handleFieldChange("gpuLimit", e.target.value)}
              placeholder="e.g. 1, 2"
              className="w-full bg-white border border-gray-300 text-sm rounded-lg p-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
        </div>
      </div>

      {/* Per-step YAML instructions */}
      <div className="border-t pt-4 bg-gray-50 p-3 rounded-lg border border-gray-200">
        <h5 className="text-xs font-bold text-gray-700 uppercase tracking-wider mb-2 flex items-center">
          <span>💡 How to configure per-step/template resources</span>
        </h5>
        <p className="text-xs text-gray-600 leading-relaxed mb-3">
          This panel configures resources and scheduling{" "}
          <strong>globally</strong>. To set specific limits or tolerations for
          an individual step/template, you can write them directly under that
          template in your YAML:
        </p>
        <pre className="text-[10px] font-mono bg-gray-900 text-green-400 p-2.5 rounded overflow-x-auto leading-normal">
          {`# Example of step-level overrides inside YAML:
spec:
  templates:
    - name: gpu-heavy-step
      # 1. Step-level toleration (unblocks specialized servers)
      tolerations:
        - key: "nvidia.com/gpu"
          operator: "Exists"
          effect: "NoSchedule"
      container:
        image: python:3.9
        command: [python]
        # 2. Step-level requests & limits
        resources:
          limits:
            cpu: "2"
            memory: "4Gi"
            nvidia.com/gpu: "1"`}
        </pre>
      </div>
    </div>
  );
};
