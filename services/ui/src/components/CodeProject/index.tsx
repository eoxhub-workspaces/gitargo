import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { validateK8sYaml } from "../../utils/k8sValidation";
import { CloudArrowUpIcon, Squares2X2Icon } from "@heroicons/react/20/solid";

import * as api from "../../utils/api";
import { useTitle } from "../../hooks";
import Header from "../Project/Header";
import CodeEditor from "../CodeEditor";

export default function CodeProject() {
  const { filename } = useParams<{ filename?: string }>();
  const navigate = useNavigate();

  const [currentFilename, setCurrentFilename] = useState(filename);
  const [yamlContent, setYamlContent] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(!!filename);

  useTitle([currentFilename || "New workflow", "Code Mode"].join(" | "));

  useEffect(() => {
    if (filename) {
      const loadWorkflow = async () => {
        try {
          const content = await api.getWorkflow(filename);
          setYamlContent(content);
          setCurrentFilename(filename);
        } catch (error) {
          toast.error("Failed to load workflow");
          console.error(error);
        } finally {
          setLoading(false);
        }
      };
      loadWorkflow();
    } else {
      setYamlContent(
        'apiVersion: argoproj.io/v1alpha1\nkind: Workflow\nmetadata:\n  name: workflow-name\n  generateName: workflow-name-\nspec:\n  entrypoint: main\n  templates:\n    - name: main\n      container:\n        image: alpine:latest\n        command: [sh, -c]\n        args: ["echo Hello World"]\n'
      );
      setLoading(false);
      setCurrentFilename(undefined);
    }
  }, [filename]);

  const handleSave = async () => {
    let name = currentFilename;
    if (!name) {
      const promptResult = window.prompt(
        "Enter filename (e.g. my-workflow.yaml)"
      );
      if (!promptResult) return;
      name = promptResult;
      if (!name.endsWith(".yaml") && !name.endsWith(".yml")) {
        name += ".yaml";
      }
    }

    try {
      // Validate for Kustomize and general Kubernetes correctness
      validateK8sYaml(yamlContent);
    } catch (e: any) {
      toast.error(`Validation Error: ${e.message}`, { duration: 5000 });
      return;
    }

    const saveToast = toast.loading("Saving workflow...");
    try {
      if (currentFilename) {
        await api.updateWorkflow(
          currentFilename,
          yamlContent,
          `Update ${currentFilename} via Code Editor`
        );
      } else {
        await api.createWorkflow(
          name,
          yamlContent,
          `Create ${name} via Code Editor`
        );
        setCurrentFilename(name);
        // Switch to the edit route for the new file
        navigate(`/edit/code/${encodeURIComponent(name)}`, { replace: true });
      }

      toast.success("Workflow saved successfully!", { id: saveToast });
    } catch (error: any) {
      const msg =
        error.response?.data?.message ||
        error.message ||
        "Failed to save workflow";
      toast.error(`Save Failed: ${msg}`, { id: saveToast, duration: 5000 });
      console.error(error);
    }
  };

  if (loading) {
    return <div className="p-8">Loading...</div>;
  }

  return (
    <div className="flex flex-col flex-1 h-screen bg-white">
      <Header name={currentFilename} />

      <div className="flex-1 relative flex flex-col">
        {/* Toolbar */}
        <div className="bg-gray-50 border-b border-gray-200 p-2 flex justify-between items-center z-10">
          <div className="flex items-center space-x-2">
            <span className="text-sm font-medium text-gray-500 ml-2">
              Code Editor Only Mode
            </span>
          </div>
          <div className="flex space-x-2">
            {currentFilename && (
              <button
                className="flex space-x-1 items-center px-3 py-1.5 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 transition-colors"
                onClick={() =>
                  navigate(
                    `/edit/canvas/${encodeURIComponent(currentFilename)}`
                  )
                }
                title="Switch to Canvas Mode"
              >
                <Squares2X2Icon className="w-4 h-4 text-[#0078b4]" />
                <span>Switch to Canvas</span>
              </button>
            )}
            <button
              className="flex space-x-1 items-center px-4 py-1.5 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-[#004170] hover:bg-[#002f52] focus:outline-none transition-colors"
              onClick={handleSave}
            >
              <CloudArrowUpIcon className="w-4 h-4" />
              <span>Save</span>
            </button>
          </div>
        </div>

        {/* Editor Area */}
        <div className="flex-1 relative">
          {/* 
              We use a wrapper to hide the negative padding/margin that the CodeEditor 
              might have, since it was originally built for the split view. 
              The CodeEditor component has 'pt-9' hardcoded which we just absorb here.
           */}
          <div className="absolute inset-0 bg-[#1e1e1e]">
            <CodeEditor
              data={yamlContent}
              language="yaml"
              onChange={(val) => setYamlContent(val)}
              disabled={false}
              lineWrapping={true}
              height="100%"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
