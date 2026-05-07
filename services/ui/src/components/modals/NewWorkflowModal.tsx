import React, { useState } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";

interface INewWorkflowModalProps {
  onClose: () => void;
  onSubmit: (name: string, kind: string) => void;
}

export const NewWorkflowModal: React.FC<INewWorkflowModalProps> = ({
  onClose,
  onSubmit
}) => {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("WorkflowTemplate");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    let finalName = name.trim();
    if (!finalName) return;

    // Ensure it always ends with .yaml and strip user-provided extensions
    finalName = finalName.replace(/\.ya?ml$/i, "");
    finalName += ".yaml";

    onSubmit(finalName, kind);
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
                  <label className="block text-gray-700 text-sm font-bold mb-2">
                    Workflow Name
                  </label>
                  <div className="flex items-center">
                    <input
                      type="text"
                      value={name}
                      onChange={(e) =>
                        setName(e.target.value.replace(/\.ya?ml$/i, ""))
                      }
                      placeholder="e.g. data-pipeline"
                      className="shadow appearance-none border rounded-l w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"
                      required
                      autoFocus
                    />
                    <span className="bg-gray-100 border border-l-0 rounded-r px-3 py-2 text-gray-500 text-sm">
                      .yaml
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    The name of the workflow. The .yaml extension is added
                    automatically.
                  </p>
                </div>
                <div className="mb-4">
                  <label className="block text-gray-700 text-sm font-bold mb-2">
                    Workflow Kind
                  </label>
                  <select
                    value={kind}
                    onChange={(e) => setKind(e.target.value)}
                    className="shadow border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline bg-white"
                  >
                    <option value="WorkflowTemplate">
                      WorkflowTemplate (Recommended)
                    </option>
                    <option value="Workflow">Workflow</option>
                    <option value="CronWorkflow">CronWorkflow</option>
                    <option value="ClusterWorkflowTemplate">
                      ClusterWorkflowTemplate
                    </option>
                  </select>
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
