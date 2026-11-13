import React from "react";
import { AppConfig } from "../../utils/api";
import { InfoButton } from "./InfoButton";
import { isProfileAllowedForWorkspace } from "../../utils/forms";

export interface IResourcePlacementState {
  workspaceIdentifier: string;
  templateProfiles: Record<string, string>; // templateName -> profileKey
}

interface ResourcePlacementFormProps {
  state: IResourcePlacementState;
  onChange: (newState: IResourcePlacementState) => void;
  availableTemplates: string[];
  config: AppConfig | null;
}

export const ResourcePlacementForm: React.FC<ResourcePlacementFormProps> = ({
  state,
  onChange,
  availableTemplates,
  config
}) => {
  const defaultWorkspace = config?.defaults?.namespace || "default";
  const profiles = config?.profiles || {};

  const allowedProfileEntries = Object.entries(profiles).filter(
    ([key, profile]) =>
      isProfileAllowedForWorkspace(key, profile, state.workspaceIdentifier)
  );

  const isWorkspaceMismatched =
    state.workspaceIdentifier && state.workspaceIdentifier !== defaultWorkspace;

  const handleWorkspaceChange = (val: string) => {
    onChange({
      ...state,
      workspaceIdentifier: val
    });
  };

  const handleSetDefaultWorkspace = () => {
    handleWorkspaceChange(defaultWorkspace);
  };

  const handleProfileChange = (templateName: string, profileKey: string) => {
    onChange({
      ...state,
      templateProfiles: {
        ...state.templateProfiles,
        [templateName]: profileKey
      }
    });
  };

  return (
    <div className="space-y-6 text-sm text-gray-700">
      {/* Workspace Identifier Section */}
      <div>
        <h4 className="text-sm font-semibold text-gray-900 border-b pb-2 mb-3 flex items-center">
          <span>Workspace Identifier</span>
          <InfoButton text="The Workspace Identifier defines both the Kubernetes Namespace and Service Account used to execute your workflow tasks." />
        </h4>
        <div className="flex space-x-2">
          <input
            type="text"
            value={state.workspaceIdentifier}
            onChange={(e) => handleWorkspaceChange(e.target.value)}
            placeholder={`e.g. ${defaultWorkspace}`}
            className="flex-1 bg-white border border-gray-300 text-sm rounded-lg p-2 focus:ring-blue-500 focus:border-blue-500 font-mono"
          />
        </div>

        {/* Workspace Identifier Warning Alert */}
        {(!state.workspaceIdentifier || isWorkspaceMismatched) && (
          <div className="mt-3 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-xs text-yellow-800 space-y-2">
            <p className="font-semibold leading-relaxed">
              ⚠️{" "}
              {!state.workspaceIdentifier
                ? "No Workspace Identifier specified. This can cause the workflow to run in an incorrect namespace or service account."
                : `Current Workspace Identifier "${state.workspaceIdentifier}" does not match the recommended default "${defaultWorkspace}".`}
            </p>
            <button
              type="button"
              onClick={handleSetDefaultWorkspace}
              className="px-2.5 py-1 bg-yellow-100 hover:bg-yellow-200 rounded font-semibold text-yellow-900 transition-colors border border-yellow-300"
            >
              Set to Recommended Default: "{defaultWorkspace}"
            </button>
          </div>
        )}
      </div>

      {/* Container / Step Resource Profiles */}
      <div>
        <h4 className="text-sm font-semibold text-gray-900 border-b pb-2 mb-3 flex items-center">
          <span>Container Profiles</span>
          <InfoButton text="Select a resource profile (CPU, Memory, GPU, Node Pools) for each container or script template in your workflow." />
        </h4>

        {availableTemplates.length === 0 ? (
          <div className="p-4 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-500 italic">
            No container or script templates detected in the current workflow
            definition.
          </div>
        ) : (
          <div className="space-y-4">
            {availableTemplates.map((templateName) => {
              const currentProfile =
                state.templateProfiles[templateName] || "custom";

              const isCustom =
                currentProfile === "custom" || currentProfile === "";
              const selectedProfileData = profiles[currentProfile];

              return (
                <div
                  key={templateName}
                  className="p-3.5 bg-gray-50 border border-gray-200 rounded-lg space-y-2.5"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-gray-800 font-mono text-xs">
                      Step / Container:{" "}
                      <span className="text-blue-600">{templateName}</span>
                    </span>
                    {selectedProfileData ? (
                      <span className="text-[11px] text-gray-500 font-medium">
                        {selectedProfileData.display_name ||
                          selectedProfileData.label}
                      </span>
                    ) : (
                      <span className="text-[11px] text-amber-700 font-semibold">
                        Custom / No Match
                      </span>
                    )}
                  </div>

                  <select
                    value={currentProfile}
                    onChange={(e) =>
                      handleProfileChange(templateName, e.target.value)
                    }
                    className="w-full bg-white border border-gray-300 text-sm rounded-lg p-2 focus:ring-blue-500 focus:border-blue-500 font-medium text-gray-800"
                  >
                    <option value="custom">
                      No Match (Custom Configuration)
                    </option>
                    {allowedProfileEntries.map(([key, prof]) => (
                      <option key={key} value={key}>
                        {prof.display_name || prof.label || key}
                      </option>
                    ))}
                  </select>

                  {isCustom && (
                    <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 space-y-1">
                      <p className="font-semibold leading-relaxed">
                        ⚠️ No matching profile found for step "{templateName}".
                      </p>
                      <p className="text-[11px] text-amber-700">
                        Custom resource limits, requests, tolerations, or node
                        selectors are configured in the YAML. Select a profile
                        above if you wish to apply standard profile parameters.
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
