import React, { useState, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import YAML from "yaml";
import axios from "axios";
import toast from "react-hot-toast";
import {
  getPackages,
  getPackageRaw,
  savePackage,
  deletePackage,
  submitCwlExecution,
  getExecutions,
  getLogs,
  getWorkspaceFileDownloadUrl,
  PackageFile
} from "../utils/api";
import CodeEditor from "../components/CodeEditor";
import { WorkspaceBrowser } from "../components/WorkspaceBrowser";
import {
  CloudArrowDownIcon,
  PlayIcon,
  FolderOpenIcon,
  ArrowPathIcon,
  TrashIcon,
  PlusIcon,
  DocumentTextIcon,
  CheckCircleIcon,
  XCircleIcon,
  ClockIcon,
  Square3Stack3DIcon,
  PencilSquareIcon,
  KeyIcon,
  CommandLineIcon,
  XMarkIcon,
  ExclamationTriangleIcon,
  ExclamationCircleIcon,
  EyeIcon,
  EyeSlashIcon
} from "@heroicons/react/24/outline";

interface CwlInputDef {
  id: string;
  type: string;
  doc?: string;
  default?: any;
  isFile?: boolean;
}

export const ApplicationPackagesView: React.FC = () => {
  const [searchParams] = useSearchParams();
  const lastLoadedUrlRef = useRef<string>("");

  // Saved packages list
  const [packages, setPackages] = useState<PackageFile[]>([]);
  const [loadingPackages, setLoadingPackages] = useState<boolean>(true);
  const [selectedPackagePath, setSelectedPackagePath] = useState<string | null>(null);

  // Active package state
  const [url, setUrl] = useState<string>(
    "https://github.com/sunnydean/lightning2earthcare/blob/main/cwl/package.cwl"
  );
  const [loadingUrl, setLoadingUrl] = useState<boolean>(false);
  const [executing, setExecuting] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [rawCwl, setRawCwl] = useState<string>("");
  const [cwlDoc, setCwlDoc] = useState<any>(null);
  const [inputs, setInputs] = useState<CwlInputDef[]>([]);
  const [paramValues, setParamValues] = useState<Record<string, any>>({});
  const [paramTypes, setParamTypes] = useState<Record<string, string>>({});
  const [enabledOptionalParams, setEnabledOptionalParams] = useState<Record<string, boolean>>({});
  const [fileContents, setFileContents] = useState<Record<string, string>>({});
  const [hiddenFields, setHiddenFields] = useState<Record<string, boolean>>({});
  const [executionName, setExecutionName] = useState<string>("");

  const toggleHideField = (id: string) => {
    setHiddenFields((prev) => ({ ...prev, [id]: !prev[id] }));
  };
  const [packageFileName, setPackageFileName] = useState<string>("");
  const [graphProcesses, setGraphProcesses] = useState<{ id: string; label?: string; class?: string; inputs?: any }[]>([]);
  const [selectedProcessId, setSelectedProcessId] = useState<string>("");

  // Tabs & Views
  const [activeTab, setActiveTab] = useState<"configure" | "edit" | "executions">("configure");
  const [showFileBrowser, setShowFileBrowser] = useState<boolean>(false);
  const [fileBrowserPath, setFileBrowserPath] = useState<string>("application_packages_executions");
  const [fileBrowserRoot, setFileBrowserRoot] = useState<string>("application_packages_executions");

  // Executions for selected package
  const [allExecutions, setAllExecutions] = useState<any[]>([]);
  const [loadingExecutions, setLoadingExecutions] = useState<boolean>(false);

  // Logs modal
  const [showLogModal, setShowLogModal] = useState<boolean>(false);
  const [logExecName, setLogExecName] = useState<string>("");
  const [logsText, setLogsText] = useState<string>("");
  const [logsLoading, setLogsLoading] = useState<boolean>(false);

  // Load saved packages list on mount
  const fetchPackageList = async () => {
    setLoadingPackages(true);
    try {
      const list = await getPackages();
      setPackages(list);
    } catch (err: any) {
      console.error("Failed to list packages:", err);
    } finally {
      setLoadingPackages(false);
    }
  };

  // Load all executions from K8s API
  const fetchExecutions = async () => {
    setLoadingExecutions(true);
    try {
      const data = await getExecutions();
      setAllExecutions(Array.isArray(data) ? data : []);
    } catch (err: any) {
      console.error("Failed to load executions:", err);
    } finally {
      setLoadingExecutions(false);
    }
  };

  useEffect(() => {
    fetchPackageList();
    fetchExecutions();

    const interval = setInterval(() => {
      fetchExecutions();
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  // Helper to convert Github web URLs to raw URLs
  const getRawUrl = (inputUrl: string): string => {
    let clean = inputUrl.trim();
    if (clean.includes("github.com") && clean.includes("/blob/")) {
      clean = clean
        .replace("github.com", "raw.githubusercontent.com")
        .replace("/blob/", "/");
    }
    return clean;
  };

  const isFileInput = (id: string, typeStr: string) => {
    const t = typeStr.toLowerCase();
    const i = id.toLowerCase();
    return (
      t.includes("file") ||
      i.includes("file") ||
      i.includes("credentials") ||
      i.includes("secret") ||
      i.includes("config")
    );
  };

  const formatTypeString = (typeVal: any): string => {
    if (!typeVal) return "string";
    if (typeof typeVal === "string") return typeVal;
    if (Array.isArray(typeVal)) {
      const validTypes = typeVal
        .map((t) => formatTypeString(t))
        .filter((t) => t !== "null");
      return validTypes.join(" | ") || "string";
    }
    if (typeof typeVal === "object") {
      if (typeVal.type === "array") {
        return `${typeVal.items || "string"}[]`;
      }
      return typeVal.type || JSON.stringify(typeVal);
    }
    return String(typeVal);
  };

  const formatDefaultValue = (defVal: any): any => {
    if (defVal === undefined) return undefined;
    if (Array.isArray(defVal)) {
      return defVal.join(", ");
    }
    return defVal;
  };

  const parseInputsFromObject = (targetInputs: any) => {
    const parsedInputs: CwlInputDef[] = [];
    const defaultValues: Record<string, any> = {};
    const typesMap: Record<string, string> = {};

    if (targetInputs) {
      if (Array.isArray(targetInputs)) {
        targetInputs.forEach((input: any) => {
          const inputId = String(input.id || input.name || "").replace(/^#/, "");
          const inputType = formatTypeString(input.type);
          const defVal = formatDefaultValue(input.default);

          typesMap[inputId] = inputType;
          parsedInputs.push({
            id: inputId,
            type: inputType,
            doc: input.doc || input.label,
            default: defVal,
            isFile: isFileInput(inputId, inputType)
          });
          if (defVal !== undefined) {
            defaultValues[inputId] = defVal;
          }
        });
      } else if (typeof targetInputs === "object") {
        Object.entries(targetInputs).forEach(([inputIdRaw, inputVal]: [string, any]) => {
          const inputId = inputIdRaw.replace(/^#/, "");
          let inputType = "string";
          let doc = "";
          let rawDefVal = undefined;

          if (typeof inputVal === "string") {
            inputType = inputVal;
          } else if (typeof inputVal === "object") {
            inputType = formatTypeString(inputVal.type);
            doc = inputVal.doc || inputVal.label || "";
            rawDefVal = inputVal.default;
          }

          const defVal = formatDefaultValue(rawDefVal);
          typesMap[inputId] = inputType;

          parsedInputs.push({
            id: inputId,
            type: inputType,
            doc,
            default: defVal,
            isFile: isFileInput(inputId, inputType)
          });

          if (defVal !== undefined) {
            defaultValues[inputId] = defVal;
          }
        });
      }
    }

    setInputs(parsedInputs);
    setParamValues(defaultValues);
    setParamTypes(typesMap);
  };

  const handleProcessChange = (procId: string) => {
    setSelectedProcessId(procId);
    if (cwlDoc && Array.isArray(cwlDoc.$graph)) {
      const selectedObj = cwlDoc.$graph.find(
        (item: any) => String(item.id || "").replace(/^#/, "") === procId
      );
      if (selectedObj) {
        parseInputsFromObject(selectedObj.inputs);
      }
    }
  };

  // Helper to parse CWL text into state
  const parseCwlText = (textContent: string, sourceName?: string) => {
    setRawCwl(textContent);
    try {
      const parsed = YAML.parse(textContent);
      setCwlDoc(parsed);

      let targetInputs: any = null;
      let targetDoc = parsed?.doc || parsed?.label || "";
      let targetLabel = parsed?.label || parsed?.id || "";

      if (parsed && parsed.inputs) {
        targetInputs = parsed.inputs;
        setGraphProcesses([]);
        setSelectedProcessId("");
      } else if (parsed && Array.isArray(parsed.$graph)) {
        const processes = parsed.$graph
          .filter((item: any) => item && (item.id || item.class))
          .map((item: any) => ({
            id: String(item.id || "").replace(/^#/, ""),
            label: item.label || item.id,
            class: item.class || "Process",
            inputs: item.inputs
          }));

        setGraphProcesses(processes);

        const mainObj =
          parsed.$graph.find(
            (item: any) => item.id === "main" || item.id === "#main" || item.class === "Workflow"
          ) ||
          parsed.$graph.find((item: any) => item.inputs) ||
          parsed.$graph[0];

        if (mainObj) {
          const mainId = String(mainObj.id || "").replace(/^#/, "");
          setSelectedProcessId(mainId);
          targetInputs = mainObj.inputs;
          if (mainObj.doc) targetDoc = mainObj.doc;
          if (mainObj.label || mainObj.id) targetLabel = mainObj.label || mainObj.id;
        }
      } else {
        setGraphProcesses([]);
        setSelectedProcessId("");
      }

      parseInputsFromObject(targetInputs);

      let rawUrlFilename = "";
      if (url) {
        const parts = url.trim().split("/");
        const last = parts[parts.length - 1];
        if (last && (last.endsWith(".cwl") || last.endsWith(".yaml") || last.endsWith(".yml"))) {
          rawUrlFilename = last;
        }
      }

      let suggestedFileName = sourceName || rawUrlFilename || targetLabel || "package.cwl";
      if (!suggestedFileName.endsWith(".cwl") && !suggestedFileName.endsWith(".yaml") && !suggestedFileName.endsWith(".yml")) {
        suggestedFileName += ".cwl";
      }

      const cleanSlug = suggestedFileName
        .replace(/\.(cwl|yaml|yml)$/i, "")
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-");

      setExecutionName(cleanSlug);
      setPackageFileName(suggestedFileName);
    } catch (err: any) {
      toast.error(`Invalid CWL structure: ${err.message}`);
    }
  };

  const handleLoadSampleFileOutput = () => {
    setSelectedPackagePath(null);
    const sampleCwl = `cwlVersion: v1.0
class: CommandLineTool
label: "file-output-sample"
doc: "Simple CWL tool that writes a message to output.txt file on storage."
baseCommand: echo
stdout: output.txt
inputs:
  message:
    type: string
    default: "Hello from Gitargo Results Storage!"
    inputBinding:
      position: 1
outputs:
  output_file:
    type: File
    outputBinding:
      glob: output.txt`;
    parseCwlText(sampleCwl, "file-output-sample.cwl");
    toast.success("Loaded File Output Sample!");
  };

  // Core helper to fetch and parse CWL from URL
  const fetchAndParseUrl = async (targetUrl: string, silent = false) => {
    if (!targetUrl) return;
    lastLoadedUrlRef.current = targetUrl;
    setUrl(targetUrl);
    setLoadingUrl(true);
    setSelectedPackagePath(null);
    const rawUrl = getRawUrl(targetUrl);

    try {
      const response = await axios.get(rawUrl, { responseType: "text" });
      parseCwlText(response.data);
      if (!silent) {
        toast.success("Remote OGC Application Package loaded!");
      }
    } catch (err: any) {
      console.error("Failed to load CWL:", err);
      toast.error(`Failed to fetch URL: ${err.message}`);
    } finally {
      setLoadingUrl(false);
    }
  };

  // Load CWL from user input URL
  const handleLoadUrl = async () => {
    if (!url) {
      toast.error("Please enter a CWL Package URL.");
      return;
    }
    await fetchAndParseUrl(url);
  };

  // Auto-load CWL URL from search parameter (e.g. ?cwlUrl=... or ?url=...)
  useEffect(() => {
    const queryCwlUrl = searchParams.get("cwlUrl") || searchParams.get("url");
    if (queryCwlUrl && queryCwlUrl !== lastLoadedUrlRef.current) {
      fetchAndParseUrl(queryCwlUrl);
    }
  }, [searchParams]);

  // Load saved package
  const handleSelectPackage = async (pkg: PackageFile) => {
    setSelectedPackagePath(pkg.path);
    try {
      const content = await getPackageRaw(pkg.path);
      parseCwlText(content, pkg.name);
    } catch (err: any) {
      toast.error(`Failed to load saved package: ${err.message}`);
    }
  };

  // Delete saved package
  const handleDeletePackage = async (e: React.MouseEvent, pkg: PackageFile) => {
    e.stopPropagation();
    if (!window.confirm(`Are you sure you want to delete "${pkg.name}"?`)) {
      return;
    }

    try {
      await deletePackage(pkg.path);
      toast.success(`Deleted ${pkg.name}`);
      if (selectedPackagePath === pkg.path) {
        setSelectedPackagePath(null);
        setCwlDoc(null);
      }
      fetchPackageList();
    } catch (err: any) {
      toast.error(`Failed to delete package: ${err.message}`);
    }
  };

  // Save package
  const handleSaveToGit = async () => {
    if (!rawCwl) {
      toast.error("No package content to save.");
      return;
    }

    const savePath = packageFileName || "ogc-package.cwl";
    setSaving(true);
    try {
      await savePackage(
        savePath,
        rawCwl,
        `Save OGC Application Package ${savePath}`
      );
      toast.success("Package saved successfully!");
      fetchPackageList();
      setSelectedPackagePath(savePath);
    } catch (err: any) {
      toast.error(`Failed to save package: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  // Execute package
  const handleExecute = async () => {
    if (!cwlDoc) {
      toast.error("Please load or select an Application Package first.");
      return;
    }

    setExecuting(true);
    try {
      const cleanPkgId = (selectedPackagePath || executionName || "cwl-execution")
        .toLowerCase()
        .replace(/\.cwl$/i, "")
        .replace(/[^a-z0-9-]/g, "-")
        .substring(0, 63)
        .replace(/-+$/, "");

      // Filter active parameters, omitting disabled optional parameters
      const activeParams: Record<string, any> = {};
      const activeTypes: Record<string, string> = {};

      inputs.forEach((input) => {
        const typeLower = (input.type || "").toLowerCase();
        const isOptional =
          input.type.endsWith("?") ||
          typeLower.includes("null") ||
          typeLower.includes("optional");

        const isEnabled = !isOptional || enabledOptionalParams[input.id] === true;

        if (isEnabled && paramValues[input.id] !== undefined && paramValues[input.id] !== "") {
          activeParams[input.id] = paramValues[input.id];
        }
        if (isEnabled && paramTypes[input.id]) {
          activeTypes[input.id] = paramTypes[input.id];
        }
      });

      await submitCwlExecution({
        cwlUrl: selectedPackagePath ? undefined : getRawUrl(url),
        cwlContent: rawCwl,
        processId: selectedProcessId || undefined,
        parameters: activeParams,
        inputTypes: activeTypes,
        inlineFiles: fileContents,
        name: executionName || "cwl-execution",
        packageId: cleanPkgId
      });

      toast.success("Application Package execution submitted successfully!");
      fetchExecutions();
      setActiveTab("executions");
    } catch (err: any) {
      console.error("Execution failed:", err);
      toast.error(
        `Execution failed: ${err.response?.data?.message || err.message}`
      );
    } finally {
      setExecuting(false);
    }
  };

  const handleInputChange = (inputId: string, value: any) => {
    setParamValues((prev) => ({
      ...prev,
      [inputId]: value
    }));
  };

  // Fetch execution logs
  const handleViewLogs = async (execName: string, startTime?: string, endTime?: string) => {
    setLogExecName(execName);
    setLogsText("Fetching execution logs...");
    setLogsLoading(true);
    setShowLogModal(true);

    try {
      // 1. Try reading execution.log from saved workspace execution directory
      const logFilePath = `application_packages_executions/${execName}/execution.log`;
      try {
        const downloadUrl = getWorkspaceFileDownloadUrl(logFilePath);
        const res = await axios.get(downloadUrl, { responseType: "text" });
        if (res.data && String(res.data).trim().length > 0) {
          setLogsText(String(res.data));
          setLogsLoading(false);
          return;
        }
      } catch (fileErr) {
        // Fall back if file is not created yet
      }

      // 2. Fall back to live pod/workflow logs
      let startBuf = startTime;
      let endBuf = endTime;
      if (startBuf) {
        startBuf = new Date(new Date(startBuf).getTime() - 24 * 3600 * 1000).toISOString();
      }
      if (endBuf) {
        endBuf = new Date(new Date(endBuf).getTime() + 24 * 3600 * 1000).toISOString();
      }

      const logs = await getLogs(execName, "workflow", undefined, startBuf, endBuf, execName);
      setLogsText(logs || "No logs recorded for this execution.");
    } catch (err: any) {
      setLogsText(
        "Failed to load logs: " + (err.response?.data?.message || err.message)
      );
    } finally {
      setLogsLoading(false);
    }
  };

  // Filter executions for currently active package
  const currentCleanPackageId = (selectedPackagePath || executionName || "")
    .toLowerCase()
    .replace(/\.cwl$/i, "")
    .replace(/[^a-z0-9-]/g, "-")
    .substring(0, 63)
    .replace(/-+$/, "");

  const packageFilenameSlug = selectedPackagePath
    ? selectedPackagePath
        .split("/")
        .pop()
        ?.replace(/\.cwl$/i, "")
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .substring(0, 63)
        .replace(/-+$/, "")
    : "";

  const packageExecutions = allExecutions
    .filter((item) => {
      const pkgLabel = item.metadata?.labels?.["gitargo.eox.at/package-id"];
      const typeLabel = item.metadata?.labels?.["gitargo.eox.at/type"];
      const name = (item.metadata?.name || "").toLowerCase();

      // 1. Direct label match or inclusion
      if (pkgLabel && currentCleanPackageId && (pkgLabel === currentCleanPackageId || currentCleanPackageId.includes(pkgLabel) || pkgLabel.includes(currentCleanPackageId))) {
        return true;
      }
      if (pkgLabel && packageFilenameSlug && (pkgLabel === packageFilenameSlug || packageFilenameSlug.includes(pkgLabel) || pkgLabel.includes(packageFilenameSlug))) {
        return true;
      }

      // 2. Name substring / prefix match
      if (currentCleanPackageId && name.includes(currentCleanPackageId)) {
        return true;
      }
      if (packageFilenameSlug && name.includes(packageFilenameSlug)) {
        return true;
      }

      // 3. Fallback for CWL package type
      if (typeLabel === "cwl-package") {
        if (!currentCleanPackageId && !packageFilenameSlug) return true;
      }

      return false;
    })
    .sort((a, b) => {
      const timeA = new Date(a.metadata?.creationTimestamp || a.status?.startedAt || 0).getTime();
      const timeB = new Date(b.metadata?.creationTimestamp || b.status?.startedAt || 0).getTime();
      return timeB - timeA;
    });

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] bg-gray-50 overflow-hidden">
      {/* Top Bar */}
      <div className="bg-white border-b px-6 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4 dark:bg-gray-800 dark:border-gray-700">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white flex items-center space-x-2">
            <Square3Stack3DIcon className="w-6 h-6 text-blue-600" />
            <span>OGC Application Packages</span>
          </h1>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Configure, edit, and run OGC Application Packages.
          </p>
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={() => {
              setSelectedPackagePath(null);
              setCwlDoc(null);
              setRawCwl("");
              setActiveTab("configure");
            }}
            className="inline-flex items-center space-x-1.5 bg-blue-50 text-blue-600 hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-400 px-3.5 py-2 rounded-lg text-xs font-semibold transition"
          >
            <PlusIcon className="w-4 h-4" />
            <span>Import / New Package</span>
          </button>

          <button
            onClick={() => {
              setFileBrowserPath("application_packages_executions");
              setFileBrowserRoot("application_packages_executions");
              setShowFileBrowser(true);
            }}
            className="inline-flex items-center space-x-1.5 bg-slate-800 hover:bg-slate-900 text-white px-3.5 py-2 rounded-lg text-xs font-semibold transition"
          >
            <FolderOpenIcon className="w-4 h-4" />
            <span>All Execution Results</span>
          </button>
        </div>
      </div>

      {/* Main Content Area (Sidebar + Editor/Form) */}
      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Sidebar: Saved Packages in Git */}
        <div className="w-80 bg-white border-r border-gray-200 dark:bg-gray-800 dark:border-gray-700 flex flex-col overflow-hidden">
          <div className="p-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50 flex justify-between items-center">
            <span className="text-xs font-bold uppercase tracking-wider text-gray-600 dark:text-gray-400">
              Saved Packages ({packages.length})
            </span>
            <button
              onClick={fetchPackageList}
              className="p-1 text-gray-500 hover:text-gray-800 dark:hover:text-white"
              title="Refresh package list"
            >
              <ArrowPathIcon className={`w-4 h-4 ${loadingPackages ? "animate-spin" : ""}`} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700/60">
            {loadingPackages ? (
              <div className="p-6 text-center text-xs text-gray-400">Loading packages...</div>
            ) : packages.length === 0 ? (
              <div className="p-6 text-center text-xs text-gray-400 italic">
                No saved packages yet. Use "Import / New Package" to load or create one.
              </div>
            ) : (
              packages.map((pkg) => {
                const isSelected = selectedPackagePath === pkg.path;
                return (
                  <div
                    key={pkg.path}
                    onClick={() => handleSelectPackage(pkg)}
                    className={`p-3 cursor-pointer transition flex items-center justify-between group ${
                      isSelected
                        ? "bg-blue-50/80 dark:bg-blue-900/30 border-l-4 border-blue-600"
                        : "hover:bg-gray-50 dark:hover:bg-gray-700/40"
                    }`}
                  >
                    <div className="flex items-center space-x-2.5 overflow-hidden">
                      <DocumentTextIcon className="w-5 h-5 text-blue-500 flex-shrink-0" />
                      <div className="truncate">
                        <p className="text-xs font-semibold text-gray-800 dark:text-gray-200 truncate">
                          {pkg.name}
                        </p>
                        <p className="text-[10px] font-mono text-gray-400 truncate">
                          {pkg.path}
                        </p>
                      </div>
                    </div>

                    <button
                      onClick={(e) => handleDeletePackage(e, pkg)}
                      className="p-1 opacity-0 group-hover:opacity-100 hover:text-red-600 transition"
                      title="Delete package"
                    >
                      <TrashIcon className="w-4 h-4" />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Main Content */}
        <div className="flex-1 flex flex-col overflow-y-auto p-6 space-y-6">
          {/* URL Import Card if no package loaded or creating new */}
          {!selectedPackagePath && (
            <div className="bg-white dark:bg-gray-800 p-5 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm space-y-3">
              <label className="block text-xs font-bold uppercase tracking-wider text-gray-600 dark:text-gray-300">
                Import Application Package URL
              </label>
              <div className="flex gap-3">
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo/blob/main/cwl/package.cwl"
                  className="flex-1 px-3.5 py-2 rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-900 dark:text-white text-xs outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={handleLoadUrl}
                  disabled={loadingUrl}
                  className="inline-flex items-center space-x-1.5 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-xs font-bold transition disabled:opacity-50"
                >
                  {loadingUrl ? (
                    <ArrowPathIcon className="w-4 h-4 animate-spin" />
                  ) : (
                    <CloudArrowDownIcon className="w-4 h-4" />
                  )}
                  <span>Fetch Package</span>
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1 text-[11px] text-gray-500">
                <span className="font-semibold text-gray-600 dark:text-gray-400">Examples:</span>
                <button
                  type="button"
                  onClick={handleLoadSampleFileOutput}
                  className="text-emerald-700 dark:text-emerald-400 hover:underline bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 rounded font-mono font-semibold"
                >
                  File Output Sample (Storage Test)
                </button>
                <button
                  type="button"
                  onClick={() => setUrl("https://raw.githubusercontent.com/common-workflow-language/cwltool/main/tests/echo.cwl")}
                  className="text-blue-600 hover:underline bg-blue-50 dark:bg-blue-950/40 px-2 py-0.5 rounded font-mono"
                >
                  Simple Echo Tool
                </button>
                <button
                  type="button"
                  onClick={() => setUrl("https://github.com/sunnydean/lightning2earthcare/blob/main/cwl/package.cwl")}
                  className="text-blue-600 hover:underline bg-blue-50 dark:bg-blue-950/40 px-2 py-0.5 rounded font-mono"
                >
                  Lightning2EarthCare Package
                </button>
              </div>
            </div>
          )}

          {/* Active Package Section */}
          {cwlDoc ? (
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm flex flex-col flex-1 overflow-hidden">
              {/* Tabs Navigation */}
              <div className="border-b border-gray-200 dark:border-gray-700 px-6 pt-3 flex items-center justify-between bg-gray-50/50 dark:bg-gray-900/30">
                <div className="flex space-x-6">
                  <button
                    onClick={() => setActiveTab("configure")}
                    className={`pb-3 text-xs font-bold border-b-2 transition ${
                      activeTab === "configure"
                        ? "border-blue-600 text-blue-600 dark:text-blue-400"
                        : "border-transparent text-gray-500 hover:text-gray-700"
                    }`}
                  >
                    Configure & Execute
                  </button>
                  <button
                    onClick={() => setActiveTab("edit")}
                    className={`pb-3 text-xs font-bold border-b-2 transition flex items-center space-x-1.5 ${
                      activeTab === "edit"
                        ? "border-blue-600 text-blue-600 dark:text-blue-400"
                        : "border-transparent text-gray-500 hover:text-gray-700"
                    }`}
                  >
                    <PencilSquareIcon className="w-3.5 h-3.5" />
                    <span>Edit Definition</span>
                  </button>
                  <button
                    onClick={() => setActiveTab("executions")}
                    className={`pb-3 text-xs font-bold border-b-2 transition flex items-center space-x-1.5 ${
                      activeTab === "executions"
                        ? "border-blue-600 text-blue-600 dark:text-blue-400"
                        : "border-transparent text-gray-500 hover:text-gray-700"
                    }`}
                  >
                    <PlayIcon className="w-3.5 h-3.5" />
                    <span>Executions ({packageExecutions.length})</span>
                  </button>
                </div>

                <div className="pb-2 flex items-center space-x-2">
                  <input
                    type="text"
                    value={packageFileName}
                    onChange={(e) => setPackageFileName(e.target.value)}
                    placeholder="package.cwl"
                    className="px-2.5 py-1 rounded border border-gray-300 dark:border-gray-600 dark:bg-gray-900 text-xs font-mono text-gray-800 dark:text-gray-200"
                  />
                  <button
                    onClick={handleSaveToGit}
                    disabled={saving}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1 rounded text-xs font-semibold transition disabled:opacity-50"
                  >
                    {saving ? "Saving..." : "Save Package"}
                  </button>
                </div>
              </div>

              {/* Tab 1: Configure & Execute */}
              {activeTab === "configure" && (
                <div className="p-6 space-y-6 overflow-y-auto flex-1">
                  <div>
                    <h2 className="text-lg font-bold text-gray-900 dark:text-white">
                      {cwlDoc.label || cwlDoc.id || "Package Configuration"}
                    </h2>
                    {cwlDoc.doc && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
                        {cwlDoc.doc}
                      </p>
                    )}
                  </div>

                  {/* Process Selector for $graph CWL Files */}
                  {graphProcesses.length > 1 && (
                    <div className="p-3.5 bg-blue-50/50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg space-y-1.5">
                      <label className="block text-xs font-bold text-blue-900 dark:text-blue-300">
                        Target Process / Workflow (#id)
                      </label>
                      <select
                        value={selectedProcessId}
                        onChange={(e) => handleProcessChange(e.target.value)}
                        className="w-full text-xs bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-md px-3 py-2 text-gray-900 dark:text-white font-mono"
                      >
                        {graphProcesses.map((proc) => (
                          <option key={proc.id} value={proc.id}>
                            #{proc.id} ({proc.class}){proc.label ? ` - ${proc.label}` : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Input Parameters Form */}
                  <div className="space-y-4 pt-2">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-gray-700 dark:text-gray-300">
                      Input Parameters ({inputs.length})
                    </h3>

                    {inputs.length === 0 ? (
                      <p className="text-xs text-gray-400 italic">
                        No input parameters required by this application package definition.
                      </p>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {inputs.map((input) => {
                          const typeLower = (input.type || "").toLowerCase();
                          const isOptional =
                            input.type.endsWith("?") ||
                            typeLower.includes("null") ||
                            typeLower.includes("optional");

                          const isEnabled = !isOptional || enabledOptionalParams[input.id] === true;

                          return (
                            <div
                              key={input.id}
                              className={`p-3.5 rounded-lg border transition space-y-2 ${
                                !isEnabled
                                  ? "bg-gray-100/60 dark:bg-gray-900/20 border-gray-200 dark:border-gray-800 opacity-60"
                                  : "bg-gray-50 dark:bg-gray-900/50 border-gray-200 dark:border-gray-700/60"
                              }`}
                            >
                              <div className="flex justify-between items-center">
                                <div className="flex items-center space-x-2">
                                  {isOptional && (
                                    <input
                                      type="checkbox"
                                      checked={isEnabled}
                                      onChange={(e) =>
                                        setEnabledOptionalParams((prev) => ({
                                          ...prev,
                                          [input.id]: e.target.checked
                                        }))
                                      }
                                      title={
                                        isEnabled
                                          ? "Uncheck to disable/omit this optional parameter"
                                          : "Check to enable and provide this optional parameter"
                                      }
                                      className="w-3.5 h-3.5 text-blue-600 rounded border-gray-300 focus:ring-blue-500 cursor-pointer"
                                    />
                                  )}
                                  <span className="font-semibold text-xs text-gray-900 dark:text-white flex items-center space-x-1">
                                    {input.isFile && <KeyIcon className="w-3.5 h-3.5 text-amber-500" />}
                                    <span>{input.id}</span>
                                  </span>
                                </div>

                                <div className="flex items-center space-x-1.5">
                                  {isOptional && (
                                    <span className="text-[9px] font-semibold font-mono text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800/40 px-1.5 py-0.5 rounded">
                                      Optional
                                    </span>
                                  )}
                                  <span className="text-[10px] font-mono text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 px-1.5 py-0.5 rounded">
                                    {input.type}
                                  </span>
                                </div>
                              </div>

                              {input.doc && (
                                <p className="text-[11px] text-gray-500 dark:text-gray-400">
                                  {input.doc}
                                </p>
                              )}

                              {isEnabled && (
                                <>
                                  {input.isFile ? (
                                    <div className="space-y-1">
                                      <div className="flex justify-between items-center text-[10px] text-gray-500 dark:text-gray-400">
                                        <span>Paste file content (e.g. JSON/Secret) OR path (/workspace/...)</span>
                                        <div className="flex items-center space-x-2">
                                          <button
                                            type="button"
                                            onClick={() => toggleHideField(input.id)}
                                            className="inline-flex items-center space-x-1 text-xs text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 px-2 py-0.5 rounded transition font-medium"
                                            title={hiddenFields[input.id] ? "Click to reveal secret content" : "Click to hide sensitive keys/credentials for presentations"}
                                          >
                                            {hiddenFields[input.id] ? (
                                              <>
                                                <EyeSlashIcon className="w-3.5 h-3.5 text-amber-500" />
                                                <span className="text-[11px] font-semibold text-amber-600 dark:text-amber-400">Hidden</span>
                                              </>
                                            ) : (
                                              <>
                                                <EyeIcon className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
                                                <span className="text-[11px]">Hide Content</span>
                                              </>
                                            )}
                                          </button>
                                          <span className="font-mono text-amber-600 dark:text-amber-400 font-semibold bg-amber-50 dark:bg-amber-950/40 px-1 py-0.5 rounded">
                                            File / Secret Input
                                          </span>
                                        </div>
                                      </div>
                                      <textarea
                                        rows={3}
                                        value={fileContents[input.id] ?? ""}
                                        onChange={(e) =>
                                          setFileContents((prev) => ({
                                            ...prev,
                                            [input.id]: e.target.value
                                          }))
                                        }
                                        placeholder={
                                          input.default !== undefined
                                            ? `Default: ${input.default}`
                                            : "Paste file/credentials content or path /workspace/file.json..."
                                        }
                                        style={{
                                          WebkitTextSecurity: hiddenFields[input.id] ? ("disc" as any) : "none"
                                        }}
                                        className={`w-full px-3 py-1.5 rounded border text-xs font-mono outline-none focus:ring-1 focus:ring-blue-500 transition ${
                                          hiddenFields[input.id]
                                            ? "border-amber-300 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200"
                                            : "border-gray-300 dark:border-gray-600 dark:bg-gray-900 text-gray-800 dark:text-gray-200"
                                        }`}
                                      />
                                    </div>
                                  ) : (
                                    <div className="relative flex items-center">
                                      <input
                                        type={hiddenFields[input.id] ? "password" : "text"}
                                        value={paramValues[input.id] ?? ""}
                                        onChange={(e) =>
                                          handleInputChange(input.id, e.target.value)
                                        }
                                        placeholder={
                                          input.default !== undefined
                                            ? `Default: ${input.default}`
                                            : "Enter value..."
                                        }
                                        className={`w-full pr-10 px-3 py-1.5 rounded border text-xs outline-none focus:ring-1 focus:ring-blue-500 font-mono transition ${
                                          hiddenFields[input.id]
                                            ? "border-amber-300 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200"
                                            : "border-gray-300 dark:border-gray-600 dark:bg-gray-900 text-gray-800 dark:text-gray-200"
                                        }`}
                                      />
                                      <button
                                        type="button"
                                        onClick={() => toggleHideField(input.id)}
                                        className="absolute right-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-1 rounded transition"
                                        title={hiddenFields[input.id] ? "Reveal parameter value" : "Hide parameter value for presentation"}
                                      >
                                        {hiddenFields[input.id] ? (
                                          <EyeSlashIcon className="w-4 h-4 text-amber-500" />
                                        ) : (
                                          <EyeIcon className="w-4 h-4 text-gray-400" />
                                        )}
                                      </button>
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Submit Action */}
                  <div className="pt-4 border-t dark:border-gray-700 flex justify-end">
                    <button
                      onClick={handleExecute}
                      disabled={executing}
                      className="inline-flex items-center space-x-2 bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-2 rounded-lg text-xs font-bold transition disabled:opacity-50 shadow-sm"
                    >
                      {executing ? (
                        <ArrowPathIcon className="w-4 h-4 animate-spin" />
                      ) : (
                        <PlayIcon className="w-4 h-4" />
                      )}
                      <span>Execute Package</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Tab 2: Edit CWL Definition */}
              {activeTab === "edit" && (
                <div className="p-4 flex flex-col flex-1 min-h-[450px]">
                  <div className="flex justify-between items-center pb-2">
                    <span className="text-xs text-gray-500">
                      Adapt raw CWL YAML definition. Click "Reparse" to update input parameters.
                    </span>
                    <button
                      onClick={() => parseCwlText(rawCwl, selectedPackagePath || undefined)}
                      className="px-3 py-1 bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 text-xs font-semibold rounded text-gray-700 dark:text-gray-300"
                    >
                      Reparse Inputs
                    </button>
                  </div>

                  <div className="flex-1 border rounded-lg overflow-hidden border-gray-200 dark:border-gray-700 min-h-[400px]">
                    <CodeEditor
                      data={rawCwl}
                      language="yaml"
                      onChange={(val) => setRawCwl(val)}
                      disabled={false}
                      lineWrapping={true}
                      height="100%"
                    />
                  </div>
                </div>
              )}

              {/* Tab 3: Executions & Results */}
              {activeTab === "executions" && (
                <div className="p-6 space-y-4 overflow-y-auto flex-1">
                  <div className="flex justify-between items-center">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-gray-700 dark:text-gray-300">
                      Executions for {executionName || "this package"}
                    </h3>

                    <button
                      onClick={fetchExecutions}
                      className="text-xs text-blue-600 hover:underline flex items-center space-x-1"
                    >
                      <ArrowPathIcon className={`w-3.5 h-3.5 ${loadingExecutions ? "animate-spin" : ""}`} />
                      <span>Refresh Runs</span>
                    </button>
                  </div>

                  {packageExecutions.length === 0 ? (
                    <div className="p-8 text-center text-xs text-gray-400 italic bg-gray-50 dark:bg-gray-900/30 rounded-lg">
                      No execution runs found for this package yet.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {packageExecutions.map((exec) => {
                        const execName = exec.metadata?.name;
                        const phase = exec.status?.phase || "Unknown";
                        const creationTimestamp = exec.metadata?.creationTimestamp;

                        // Extract error message from exec status or failed nodes
                        const statusMessage = exec.status?.message || "";
                        const nodes = exec.status?.nodes || {};
                        const failedNode = Object.values(nodes).find((n: any) => n.message || n.phase === "Failed" || n.phase === "Error") as any;
                        const nodeMessage = failedNode?.message || "";
                        const displayError = statusMessage || nodeMessage;

                        const execStr = JSON.stringify(exec).toLowerCase();
                        const isArchMismatch =
                          execStr.includes("exec format error") ||
                          (execStr.includes("exec format") && execStr.includes("error"));

                        return (
                          <div
                            key={execName}
                            className="p-4 bg-gray-50 dark:bg-gray-900/40 rounded-lg border border-gray-200 dark:border-gray-700 flex flex-col space-y-3"
                          >
                            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                              <div className="space-y-1">
                                <div className="flex items-center space-x-2">
                                  {phase === "Succeeded" ? (
                                    <CheckCircleIcon className="w-5 h-5 text-emerald-500" />
                                  ) : phase === "Failed" || phase === "Error" ? (
                                    <XCircleIcon className="w-5 h-5 text-red-500" />
                                  ) : (
                                    <ClockIcon className="w-5 h-5 text-amber-500 animate-pulse" />
                                  )}
                                  <span className="font-mono text-xs font-bold text-gray-800 dark:text-gray-200">
                                    {execName}
                                  </span>
                                  <span className="text-[10px] px-2 py-0.5 rounded font-semibold bg-gray-200 dark:bg-gray-800 text-gray-700 dark:text-gray-300">
                                    {phase}
                                  </span>
                                </div>

                                <p className="text-[11px] text-gray-500 dark:text-gray-400">
                                  Started: {creationTimestamp ? new Date(creationTimestamp).toLocaleString() : "-"}
                                </p>

                                {displayError && (
                                  <div className="p-2.5 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 rounded text-xs text-red-700 dark:text-red-300 font-mono flex flex-col space-y-1.5 mt-1 max-w-full overflow-hidden">
                                    <div className="flex items-start space-x-2 min-w-0">
                                      <ExclamationCircleIcon className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                                      <span className="font-semibold break-all max-h-28 overflow-y-auto block pr-1 leading-relaxed min-w-0">
                                        {displayError}
                                      </span>
                                    </div>
                                    <p className="text-[11px] text-red-600 dark:text-red-400 font-normal pl-6">
                                      Tip: Click <span className="font-bold underline">Saved Results</span> or <span className="font-bold underline">View Execution Logs</span> to inspect complete diagnostic logs.
                                    </p>
                                  </div>
                                )}
                              </div>

                              <div className="flex items-center space-x-2">
                                <button
                                  onClick={() => handleViewLogs(execName, creationTimestamp)}
                                  className="inline-flex items-center space-x-1.5 bg-slate-800 hover:bg-slate-900 text-white px-3 py-1.5 rounded text-xs font-semibold transition"
                                >
                                  <CommandLineIcon className="w-4 h-4" />
                                  <span>View Execution Logs</span>
                                </button>

                                <button
                                  onClick={() => {
                                    const runPath = `application_packages_executions/${execName}`;
                                    setFileBrowserPath(runPath);
                                    setFileBrowserRoot(runPath);
                                    setShowFileBrowser(true);
                                  }}
                                  className="inline-flex items-center space-x-1.5 bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded text-xs font-semibold transition"
                                >
                                  <FolderOpenIcon className="w-4 h-4" />
                                  <span>Saved Results</span>
                                </button>
                              </div>
                            </div>

                            {isArchMismatch && (
                              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 dark:bg-amber-950/40 dark:border-amber-800 dark:text-amber-300 space-y-1">
                                <div className="font-bold flex items-center space-x-1 text-amber-800 dark:text-amber-200">
                                  <ExclamationTriangleIcon className="w-4 h-4 text-amber-600 flex-shrink-0" />
                                  <span>CPU Architecture Mismatch Detected</span>
                                </div>
                                <p className="text-[11px]">
                                  The container image requested by this CWL package (e.g. ghcr.io/...) was compiled for a different CPU architecture (such as ARM64) than your Kubernetes cluster worker node (x86_64 / amd64).
                                </p>
                                <p className="text-[11px] font-mono bg-amber-100/70 dark:bg-amber-900/40 p-1.5 rounded text-amber-950 dark:text-amber-200">
                                  Fix: Rebuild image for amd64: <code>docker buildx build --platform linux/amd64 ...</code>
                                </p>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center py-16 text-gray-400 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
              <Square3Stack3DIcon className="w-12 h-12 text-gray-300 dark:text-gray-600 mb-2" />
              <p className="text-sm font-semibold">No Application Package Selected</p>
              <p className="text-xs text-gray-400 mt-1">
                Select a saved package from the sidebar or fetch a URL to start configuring.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Workspace Results Browser Modal */}
      {showFileBrowser && (
        <WorkspaceBrowser
          onClose={() => setShowFileBrowser(false)}
          initialPath={fileBrowserPath}
          rootPath={fileBrowserRoot}
        />
      )}

      {/* Execution Logs Viewer Modal */}
      {showLogModal && (
        <div
          className="fixed inset-0 z-50 overflow-y-auto"
          role="dialog"
          aria-modal="true"
        >
          <div className="flex items-center justify-center min-h-screen p-4 text-center">
            <div
              className="fixed inset-0 bg-black/60 transition-opacity"
              onClick={() => setShowLogModal(false)}
            ></div>

            <div className="relative inline-block w-full max-w-4xl bg-gray-900 rounded-xl text-left overflow-hidden shadow-2xl transform transition-all border border-gray-800 my-8">
              <div className="bg-gray-800 px-5 py-3.5 border-b border-gray-700 flex justify-between items-center">
                <div className="flex items-center space-x-2 text-gray-200">
                  <CommandLineIcon className="w-5 h-5 text-blue-400" />
                  <span className="text-sm font-semibold">
                    Execution Logs: <span className="font-mono text-blue-300">{logExecName}</span>
                  </span>
                </div>

                <button
                  onClick={() => setShowLogModal(false)}
                  className="p-1 text-gray-400 hover:text-white rounded"
                >
                  <XMarkIcon className="w-5 h-5" />
                </button>
              </div>

              <div className="p-4 bg-gray-950 font-mono text-xs leading-relaxed" style={{ height: "480px" }}>
                {logsLoading ? (
                  <div className="flex items-center space-x-2 text-gray-400 p-4">
                    <ArrowPathIcon className="w-4 h-4 animate-spin text-blue-500" />
                    <span>Fetching logs from cluster...</span>
                  </div>
                ) : (
                  <pre className="h-full overflow-y-auto p-3 bg-gray-950 text-emerald-400 rounded whitespace-pre-wrap select-text">
                    {logsText}
                  </pre>
                )}
              </div>

              <div className="bg-gray-800 px-5 py-3 flex justify-end border-t border-gray-700">
                <button
                  onClick={() => setShowLogModal(false)}
                  className="px-4 py-1.5 bg-gray-700 hover:bg-gray-600 text-white rounded text-xs font-semibold transition"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
