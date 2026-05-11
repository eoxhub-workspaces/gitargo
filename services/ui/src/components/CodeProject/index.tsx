import { useState, useEffect } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import toast from "react-hot-toast";
import { validateK8sYaml } from "../../utils/k8sValidation";
import { CloudArrowUpIcon, Squares2X2Icon } from "@heroicons/react/20/solid";
import YAML from "yaml";

import * as api from "../../utils/api";
import { useTitle } from "../../hooks";
import Header from "../Project/Header";
import CodeEditor from "../CodeEditor";

export default function CodeProject() {
  const { filename } = useParams<{ filename?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryParams = new URLSearchParams(location.search);
  const initialName = queryParams.get("name") || undefined;
  const initialKind = queryParams.get("kind") || "WorkflowTemplate";
  const initialProfile = queryParams.get("profile") || "";
  const initialEphemeral = queryParams.get("ephemeral") === "true";
  const initialEphemeralSize = queryParams.get("ephemeralSize") || "2Gi";

  const [currentFilename, setCurrentFilename] = useState(
    filename || initialName
  );
  const [yamlContent, setYamlContent] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);

  useTitle([currentFilename || "New workflow", "Code Mode"].join(" | "));

  const isNewWorkflow = !filename && !!initialName;

  useEffect(() => {
    const init = async () => {
      try {
        if (filename) {
          const content = await api.getWorkflow(filename);
          setYamlContent(content);
          setCurrentFilename(filename);
        } else {
          const config = await api.getConfig();
          const logicalName = initialName
            ? initialName.replace(/\.ya?ml$/i, "")
            : "workflow-name";

          const profileData = initialProfile
            ? config.profiles[initialProfile]
            : null;

          const workflow: any = {
            apiVersion: "argoproj.io/v1alpha1",
            kind: initialKind,
            metadata: {
              name: logicalName,
              generateName: `${logicalName}-`
            },
            spec: {
              entrypoint: "main",
              templates: [
                {
                  name: "main",
                  container: {
                    image: "alpine:latest",
                    command: ["sh", "-c"],
                    args: ["echo Hello World"]
                  }
                }
              ]
            }
          };

          if (profileData) {
            workflow.spec.templates[0].container.resources =
              profileData.resources;
            if (profileData.tolerations) {
              workflow.spec.tolerations = profileData.tolerations;
            }
          }

          if (initialEphemeral) {
            const vol = {
              ...config.ephemeralVolume,
              storage: initialEphemeralSize
            };
            workflow.spec.volumeClaimTemplates = [
              {
                metadata: { name: vol.name },
                spec: {
                  accessModes: ["ReadWriteOnce"],
                  resources: { requests: { storage: vol.storage } },
                  storageClassName: vol.storageClassName
                }
              }
            ];
            workflow.spec.templates[0].container.volumeMounts = [
              { name: vol.name, mountPath: vol.mountPath }
            ];
          }

          setYamlContent(YAML.stringify(workflow));
          setCurrentFilename(initialName);
        }
      } catch (error) {
        toast.error("Failed to initialize workflow");
        console.error(error);
      } finally {
        setLoading(false);
      }
    };
    init();
  }, [
    filename,
    initialKind,
    initialName,
    initialProfile,
    initialEphemeral,
    initialEphemeralSize
  ]);

  const handleSave = async () => {
    const name = currentFilename;
    if (!name) {
      toast.error("Filename is required.");
      return;
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
      if (!isNewWorkflow) {
        await api.updateWorkflow(
          name,
          yamlContent,
          `Update ${name} via Code Editor`
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
