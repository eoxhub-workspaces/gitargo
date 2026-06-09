import React, { useState, useEffect } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { getConfig, AppConfig } from "../../utils/api";
import { InfoButton } from "../global/InfoButton";

interface INewWorkflowModalProps {
  onClose: () => void;
  onSubmit: (
    name: string,
    kind: string,
    options: { profile?: string; ephemeral?: boolean; ephemeralSize?: string }
  ) => void;
}

export const NewWorkflowModal: React.FC<INewWorkflowModalProps> = ({
  onClose,
  onSubmit
}) => {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("WorkflowTemplate");
  const [profile, setProfile] = useState("");
  const [ephemeral, setEphemeral] = useState(false);
  const [ephemeralSize, setEphemeralSize] = useState("2Gi");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    getConfig()
      .then((res) => {
        setConfig(res);
        if (res.ephemeralVolume?.storage) {
          setEphemeralSize(res.ephemeralVolume.storage);
        }
      })
      .catch(console.error);
  }, []);

  const validateName = (val: string) => {
    if (!val) return null;
    const rfc1123Regex =
      /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
    if (!rfc1123Regex.test(val)) {
      return 'Name must consist of lower case alphanumeric characters, "-" or ".", and must start and end with an alphanumeric character.';
    }
    return null;
  };

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.replace(/\.ya?ml$/i, "");
    setName(val);
    setErrorMsg(validateName(val));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    let finalName = name.trim();
    if (!finalName) return;

    const validationError = validateName(finalName);
    if (validationError) {
      setErrorMsg(validationError);
      return;
    }

    // Ensure it always ends with .yaml and strip user-provided extensions
    finalName = finalName.replace(/\.ya?ml$/i, "");
    finalName += ".yaml";

    onSubmit(finalName, kind, { profile, ephemeral, ephemeralSize });
  };

  return (
    <div className="fixed z-50 inset-0 overflow-y-auto">
      <div className="justify-center items-center flex overflow-x-hidden overflow-y-auto fixed inset-0 outline-none focus:outline-none">
        <div
          onClick={onClose}
          className="opacity-25 fixed inset-0 z-40 bg-black"
        ></div>
        <div className="relative w-auto my-6 mx-auto max-w-md z-50 w-full px-4">
          <div className="border-0 rounded-lg shadow-lg relative flex flex-col w-full bg-white outline-none focus:outline-none">
            <div className="flex items-center justify-between px-4 py-3 border-b border-solid border-blueGray-200 rounded-t">
              <h3 className="text-sm font-semibold">New Workflow</h3>
              <button
                className="p-1 ml-auto text-black float-right outline-none focus:outline-none"
                onClick={onClose}
              >
                <XMarkIcon className="w-4" />
              </button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="relative px-4 py-3 flex-auto">
                <div className="mb-4">
                  <div className="flex items-center mb-2">
                    <label className="block text-gray-700 text-sm font-bold">
                      Workflow Name
                    </label>
                    <InfoButton text="The unique name for your workflow file. This is how you'll identify it in the list." />
                  </div>
                  <div className="flex items-center">
                    <input
                      type="text"
                      value={name}
                      onChange={handleNameChange}
                      placeholder="e.g. data-pipeline"
                      className={`shadow appearance-none border rounded-l w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline ${errorMsg ? "border-red-500" : ""}`}
                      required
                      autoFocus
                    />
                    <span
                      className={`bg-gray-100 border border-l-0 rounded-r px-3 py-2 text-gray-500 text-sm ${errorMsg ? "border-red-500" : ""}`}
                    >
                      .yaml
                    </span>
                  </div>
                  {errorMsg && (
                    <p className="text-red-500 text-xs italic mt-1">
                      {errorMsg}
                    </p>
                  )}
                </div>
                <div className="mb-4">
                  <div className="flex items-center mb-2">
                    <label className="block text-gray-700 text-sm font-bold">
                      Workflow Kind
                    </label>
                    <InfoButton text="The type of Argo resource to create. WorkflowTemplate is recommended for reusable logic." />
                  </div>
                  <select
                    value={kind}
                    onChange={(e) => setKind(e.target.value)}
                    className="shadow border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline bg-white text-sm"
                  >
                    <option value="WorkflowTemplate">
                      WorkflowTemplate (Recommended)
                    </option>
                    <option value="Workflow">Workflow</option>
                    <option value="CronWorkflow">CronWorkflow</option>
                  </select>
                </div>

                <div className="mb-4 border-t pt-4">
                  <div className="flex items-center mb-2">
                    <label className="block text-gray-700 text-sm font-bold">
                      Resource Profile
                    </label>
                    <InfoButton text="Pre-configured resource limits (CPU/Memory) and node tolerations for the workflow tasks." />
                  </div>
                  <select
                    value={profile}
                    onChange={(e) => setProfile(e.target.value)}
                    className="shadow border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline bg-white text-sm"
                  >
                    <option value="">None (Default)</option>
                    {config &&
                      Object.entries(config.profiles).map(([id, p]) => (
                        <option key={id} value={id}>
                          {p.label}
                        </option>
                      ))}
                  </select>
                  <p className="text-xs text-gray-500 mt-1">
                    Pre-configured resource limits and tolerations.
                  </p>
                </div>

                <div className="mb-4">
                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      id="ephemeral-vol"
                      checked={ephemeral}
                      onChange={(e) => setEphemeral(e.target.checked)}
                      className="h-4 w-4 text-[#004170] focus:ring-[#004170] border-gray-300 rounded"
                    />
                    <label
                      htmlFor="ephemeral-vol"
                      className="ml-2 block text-sm font-bold text-gray-700"
                    >
                      Enable Ephemeral Storage
                    </label>
                    <InfoButton text="Provides a temporary workspace (/workdir) shared among all containers within a workflow step. It is automatically deleted when the step completes." />
                  </div>
                  <div className="ml-6 mt-2">
                    {ephemeral && (
                      <div className="flex items-center mt-2">
                        <label className="text-xs font-semibold text-gray-700 mr-1">
                          Storage Size:
                        </label>
                        <InfoButton text="The amount of temporary storage to request (e.g. 2Gi, 10Gi)." />
                        <input
                          type="text"
                          value={ephemeralSize}
                          onChange={(e) => setEphemeralSize(e.target.value)}
                          placeholder="e.g. 2Gi, 10Gi"
                          className="shadow-sm appearance-none border rounded py-1 px-2 text-gray-700 text-xs focus:outline-none focus:ring-[#004170] focus:border-[#004170] w-24 ml-2"
                          required={ephemeral}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-end px-4 py-3 border-t border-solid border-blueGray-200 rounded-b space-x-2">
                <button
                  className="px-4 py-2 border border-gray-300 rounded text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                  type="button"
                  onClick={onClose}
                >
                  Cancel
                </button>
                <button
                  className="px-4 py-2 border border-transparent rounded shadow-sm text-sm font-medium text-white bg-[#004170] hover:bg-[#002f52] transition-colors"
                  type="submit"
                >
                  Create
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};
