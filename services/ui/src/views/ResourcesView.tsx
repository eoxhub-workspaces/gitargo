import React, { useEffect, useState, useMemo } from "react";
import {
  getExecutions,
  WorkflowExecution,
  getConfig,
  AppConfig
} from "../utils/api";
import Spinner from "../components/global/Spinner";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  AreaChart,
  Area
} from "recharts";
import {
  CpuChipIcon,
  CircleStackIcon,
  FunnelIcon,
  ArrowPathIcon,
  ServerStackIcon,
  ComputerDesktopIcon
} from "@heroicons/react/24/outline";

const COLORS = ["#004170", "#0078b4", "#00a3e0", "#71c5ee", "#b1e4ff"];

const formatCpu = (coreHours: number) => {
  if (coreHours === 0) return "0 core-hours";
  if (coreHours < 0.0167) {
    // Less than 1 minute
    return `${(coreHours * 3600).toFixed(1)} core-seconds`;
  }
  if (coreHours < 1) {
    // Less than 1 hour
    return `${(coreHours * 60).toFixed(1)} core-minutes`;
  }
  return `${coreHours.toFixed(3)} core-hours`;
};

const formatBytes = (gbHours: number) => {
  if (gbHours === 0) return "0 GB-hours";
  const mbHours = gbHours * 1024;
  if (mbHours < 0.0167) {
    // Less than 1 MB-minute
    return `${(mbHours * 3600).toFixed(1)} MB-seconds`;
  }
  if (mbHours < 1) {
    // Less than 1 MB-hour
    return `${(mbHours * 60).toFixed(1)} MB-minutes`;
  }
  if (gbHours < 1) {
    // Less than 1 GB-hour
    return `${mbHours.toFixed(1)} MB-hours`;
  }
  return `${gbHours.toFixed(3)} GB-hours`;
};

const formatGpu = (gpuHours: number) => {
  if (gpuHours === 0) return "0 GPU-hours";
  if (gpuHours < 0.0167) {
    return `${(gpuHours * 3600).toFixed(1)} GPU-seconds`;
  }
  if (gpuHours < 1) {
    return `${(gpuHours * 60).toFixed(1)} GPU-minutes`;
  }
  return `${gpuHours.toFixed(3)} GPU-hours`;
};

const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    return (
      <div className="bg-white p-3 rounded-lg shadow-lg border border-gray-100 text-xs space-y-1">
        <p
          className="font-bold text-gray-800 truncate max-w-[200px]"
          title={label}
        >
          {label}
        </p>
        {data.formattedTime && (
          <p className="text-gray-500 italic mb-1">
            Run Time: {data.formattedTime}
          </p>
        )}
        {payload.map((item: any) => {
          const val = Number(item.value);
          let formattedVal = val.toFixed(3);
          if (item.name.toLowerCase().includes("cpu")) {
            formattedVal = formatCpu(val);
          } else if (
            item.name.toLowerCase().includes("memory") ||
            item.name.toLowerCase().includes("storage")
          ) {
            formattedVal = formatBytes(val);
          } else if (item.name.toLowerCase().includes("gpu")) {
            formattedVal = formatGpu(val);
          }
          return (
            <p key={item.name} className="flex justify-between space-x-4">
              <span
                style={{ color: item.color || item.fill }}
                className="font-medium"
              >
                {item.name}:
              </span>
              <span className="font-mono font-semibold text-gray-900">
                {formattedVal}
              </span>
            </p>
          );
        })}
      </div>
    );
  }
  return null;
};

const getWorkflowIdentifier = (exe: any) => {
  let name =
    exe.metadata.labels?.["workflows.argoproj.io/workflow-template"] ||
    exe.metadata.labels?.["workflows.argoproj.io/cron-workflow"];

  if (!name) {
    const parts = exe.metadata.name.split("-");
    if (parts.length > 1) {
      parts.pop();
      name = parts.join("-");
    } else {
      name = exe.metadata.name;
    }
  }
  return name;
};

const getEstimatedDurations = (exe: any) => {
  const duration = exe.status?.resourcesDuration || {};
  let cpu = duration.cpu || 0;
  let memory = duration.memory || 0;
  let storage = duration["ephemeral-storage"] || duration.storage || 0;
  const gpu = duration["nvidia.com/gpu"] || duration.gpu || 0;

  // FALLBACK: If Argo did not compute durations (e.g. no resource requests were explicitly written in YAML)
  if (cpu === 0 && exe.status?.nodes) {
    let totalPodDurationSec = 0;
    Object.values(exe.status.nodes).forEach((n: any) => {
      if (n.type === "Pod" && n.startedAt && n.finishedAt) {
        const runTimeMs =
          new Date(n.finishedAt).getTime() - new Date(n.startedAt).getTime();
        if (runTimeMs > 0) {
          totalPodDurationSec += runTimeMs / 1000;
        }
      }
    });

    if (totalPodDurationSec > 0) {
      // Estimate CPU: Assume standard default of 100m CPU (base unit multiplier 0.1)
      cpu = totalPodDurationSec * 0.1;

      // Estimate Memory: Assume standard default of 100Mi (Argo memoryDuration base unit multiplier 1)
      if (memory === 0) {
        memory = totalPodDurationSec * 1;
      }

      // Estimate Storage: Assume standard default of 100Mi (Argo storageDuration base unit multiplier 1)
      if (storage === 0) {
        storage = totalPodDurationSec * 1;
      }
    }
  }

  return { cpu, memory, storage, gpu };
};

const ResourcesView: React.FC = () => {
  const [executions, setExecutions] = useState<WorkflowExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [, setError] = useState<string | null>(null);
  const [, setConfig] = useState<AppConfig | null>(null);

  // Filters
  const [workflowFilter, setWorkflowFilter] = useState("");
  const [phaseFilter, setPhaseFilter] = useState("");
  const [timeRange, setTimeRange] = useState("7d");

  const fetchData = async () => {
    try {
      setLoading(true);
      const [exes, cfg] = await Promise.all([getExecutions(), getConfig()]);
      setExecutions(exes);
      setConfig(cfg);
    } catch (err: any) {
      setError(err.message || "Failed to fetch data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const filteredData = useMemo(() => {
    let result = executions;

    // Filter by time range
    const now = new Date();
    const rangeMs =
      timeRange === "24h"
        ? 24 * 3600000
        : timeRange === "7d"
          ? 7 * 24 * 3600000
          : 30 * 24 * 3600000;

    result = result.filter((exe) => {
      const created = new Date(exe.metadata.creationTimestamp);
      return now.getTime() - created.getTime() <= rangeMs;
    });

    if (workflowFilter) {
      result = result.filter(
        (exe) => getWorkflowIdentifier(exe) === workflowFilter
      );
    }

    if (phaseFilter) {
      result = result.filter(
        (exe) => (exe.status?.phase || "Pending") === phaseFilter
      );
    }

    return result;
  }, [executions, workflowFilter, phaseFilter, timeRange]);

  const stats = useMemo(() => {
    const workflowStats: Record<
      string,
      { cpu: number; memory: number; storage: number; gpu: number }
    > = {};
    const dailyStats: Record<
      string,
      { cpu: number; memory: number; storage: number; gpu: number }
    > = {};

    filteredData.forEach((exe) => {
      const { cpu, memory, storage, gpu } = getEstimatedDurations(exe);

      // Group by workflow
      const wfName = getWorkflowIdentifier(exe);
      if (!workflowStats[wfName])
        workflowStats[wfName] = { cpu: 0, memory: 0, storage: 0, gpu: 0 };
      workflowStats[wfName].cpu += cpu;
      workflowStats[wfName].memory += memory;
      workflowStats[wfName].storage += storage;
      workflowStats[wfName].gpu += gpu;

      // Group by day
      const day = new Date(exe.metadata.creationTimestamp).toLocaleDateString();
      if (!dailyStats[day])
        dailyStats[day] = { cpu: 0, memory: 0, storage: 0, gpu: 0 };
      dailyStats[day].cpu += cpu;
      dailyStats[day].memory += memory;
      dailyStats[day].storage += storage;
      dailyStats[day].gpu += gpu;
    });

    const workflowChartData = filteredData
      .map((exe, index) => {
        const name = exe.metadata.name;
        const { cpu, memory, storage, gpu } = getEstimatedDurations(exe);

        return {
          name,
          timestamp: new Date(exe.metadata.creationTimestamp).getTime(),
          formattedTime: new Date(
            exe.metadata.creationTimestamp
          ).toLocaleString(),
          cpu: Number((cpu / 3600).toFixed(5)), // in core-hours (5 decimals to preserve low consumption)
          memory: Number(((memory * 0.1) / 3600).toFixed(5)), // in GB-hours (Argo stores Memory in 100Mi-seconds, so multiply by 0.1)
          storage: Number(((storage * 0.1) / 3600).toFixed(5)), // in GB-hours (Argo stores Storage in 100Mi-seconds, so multiply by 0.1)
          gpu: Number((gpu / 3600).toFixed(5)), // in GPU-hours
          fill: COLORS[index % COLORS.length] // Inject color directly into data
        };
      })
      .sort((a, b) => a.timestamp - b.timestamp);

    const dailyChartData = Object.entries(dailyStats)
      .map(([date, data]) => ({
        date,
        cpu: Number((data.cpu / 3600).toFixed(5)),
        memory: Number(((data.memory * 0.1) / 3600).toFixed(5)),
        storage: Number(((data.storage * 0.1) / 3600).toFixed(5)),
        gpu: Number((data.gpu / 3600).toFixed(5))
      }))
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    // Reduce over estimated durations for totals
    let totalCpu = 0;
    let totalMem = 0;
    let totalStorage = 0;
    let totalGpu = 0;

    filteredData.forEach((exe) => {
      const ests = getEstimatedDurations(exe);
      totalCpu += ests.cpu;
      totalMem += ests.memory;
      totalStorage += ests.storage;
      totalGpu += ests.gpu;
    });

    return {
      workflowChartData,
      dailyChartData,
      totalCpu: (totalCpu / 3600).toFixed(4),
      totalMem: ((totalMem * 0.1) / 3600).toFixed(4),
      totalStorage: ((totalStorage * 0.1) / 3600).toFixed(4),
      totalGpu: (totalGpu / 3600).toFixed(4)
    };
  }, [filteredData]);

  const uniqueWorkflows = useMemo(() => {
    const set = new Set<string>();
    executions.forEach((exe) => {
      set.add(getWorkflowIdentifier(exe));
    });
    return Array.from(set).sort();
  }, [executions]);

  if (loading && executions.length === 0)
    return (
      <div className="flex justify-center p-12">
        <Spinner className="w-8 h-8 text-[#004170]" />
      </div>
    );

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] bg-gray-50 overflow-hidden">
      <header className="bg-white border-b border-gray-200 px-8 py-5 flex justify-between items-center flex-shrink-0 z-10 shadow-sm">
        <div>
          <h1 className="text-2xl font-bold text-[#004170]">
            Resources Dashboard
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Aggregated resource consumption across workflow runs
          </p>
        </div>
        <button
          onClick={fetchData}
          className="p-2 rounded-full border border-gray-200 hover:bg-gray-50 transition-colors bg-white shadow-sm"
          title="Refresh"
        >
          <ArrowPathIcon className="h-5 w-5 text-gray-600" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-8 max-w-7xl mx-auto w-full space-y-8 pb-20">
        {/* Filters */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
          <div className="flex flex-col">
            <label className="text-xs text-gray-500 font-medium mb-1 flex items-center">
              <FunnelIcon className="w-3 h-3 mr-1" /> Workflow Template
            </label>
            <select
              value={workflowFilter}
              onChange={(e) => setWorkflowFilter(e.target.value)}
              className="border border-gray-300 text-sm rounded px-3 py-2 focus:outline-none focus:border-[#004170] bg-white"
            >
              <option value="">All Templates</option>
              {uniqueWorkflows.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col">
            <label className="text-xs text-gray-500 font-medium mb-1">
              Status
            </label>
            <select
              value={phaseFilter}
              onChange={(e) => setPhaseFilter(e.target.value)}
              className="border border-gray-300 text-sm rounded px-3 py-2 focus:outline-none focus:border-[#004170] bg-white"
            >
              <option value="">All Statuses</option>
              <option value="Succeeded">Succeeded</option>
              <option value="Failed">Failed</option>
              <option value="Running">Running</option>
            </select>
          </div>
          <div className="flex flex-col">
            <label className="text-xs text-gray-500 font-medium mb-1">
              Time Range
            </label>
            <select
              value={timeRange}
              onChange={(e) => setTimeRange(e.target.value)}
              className="border border-gray-300 text-sm rounded px-3 py-2 focus:outline-none focus:border-[#004170] bg-white"
            >
              <option value="24h">Last 24 Hours</option>
              <option value="7d">Last 7 Days</option>
              <option value="30d">Last 30 Days</option>
            </select>
          </div>
          <div className="flex items-end">
            <div className="bg-blue-50 px-4 py-2 rounded-md border border-blue-100 w-full text-center">
              <span className="text-xs text-blue-600 font-bold uppercase block">
                Executions
              </span>
              <span className="text-xl font-bold text-[#004170]">
                {filteredData.length}
              </span>
            </div>
          </div>
        </div>

        {/* Overview Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm flex items-center space-x-4">
            <div className="p-3 bg-blue-100 rounded-lg flex-shrink-0">
              <CpuChipIcon className="w-8 h-8 text-blue-600" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-gray-500 font-medium uppercase tracking-wider truncate mb-1">
                Total CPU
              </p>
              <h2
                className="text-lg font-bold text-gray-900 truncate"
                title={`${stats.totalCpu} core-hours`}
              >
                {formatCpu(Number(stats.totalCpu))}
              </h2>
            </div>
          </div>
          <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm flex items-center space-x-4">
            <div className="p-3 bg-indigo-100 rounded-lg flex-shrink-0">
              <CircleStackIcon className="w-8 h-8 text-indigo-600" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-gray-500 font-medium uppercase tracking-wider truncate mb-1">
                Total Memory
              </p>
              <h2
                className="text-lg font-bold text-gray-900 truncate"
                title={`${stats.totalMem} GB-hours`}
              >
                {formatBytes(Number(stats.totalMem))}
              </h2>
            </div>
          </div>
          <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm flex items-center space-x-4">
            <div className="p-3 bg-emerald-100 rounded-lg flex-shrink-0">
              <ServerStackIcon className="w-8 h-8 text-emerald-600" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-gray-500 font-medium uppercase tracking-wider truncate mb-1">
                Total Storage
              </p>
              <h2
                className="text-lg font-bold text-gray-900 truncate"
                title={`${stats.totalStorage} GB-hours`}
              >
                {formatBytes(Number(stats.totalStorage))}
              </h2>
            </div>
          </div>
          <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm flex items-center space-x-4">
            <div className="p-3 bg-purple-100 rounded-lg flex-shrink-0">
              <ComputerDesktopIcon className="w-8 h-8 text-purple-600" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-gray-500 font-medium uppercase tracking-wider truncate mb-1">
                Total GPU
              </p>
              <h2
                className="text-lg font-bold text-gray-900 truncate"
                title={`${stats.totalGpu} GPU-hours`}
              >
                {formatGpu(Number(stats.totalGpu))}
              </h2>
            </div>
          </div>
        </div>

        {/* Charts Row 1: Trends */}
        <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
          <h3 className="text-lg font-bold text-gray-800 mb-6 flex items-center">
            Usage Trends over Time
          </h3>
          <div className="h-80 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={stats.dailyChartData}>
                <defs>
                  <linearGradient id="colorCpu" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#004170" stopOpacity={0.1} />
                    <stop offset="95%" stopColor="#004170" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="colorMem" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#0078b4" stopOpacity={0.1} />
                    <stop offset="95%" stopColor="#0078b4" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="colorStorage" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.1} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="colorGpu" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.1} />
                    <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="#f0f0f0"
                />
                <XAxis
                  dataKey="date"
                  fontSize={11}
                  tickMargin={10}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis fontSize={11} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{
                    borderRadius: "8px",
                    border: "none",
                    boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)"
                  }}
                />
                <Legend
                  verticalAlign="top"
                  align="right"
                  height={36}
                  iconType="circle"
                />
                <Area
                  type="monotone"
                  dataKey="cpu"
                  name="CPU (core-hours)"
                  stroke="#004170"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#colorCpu)"
                />
                <Area
                  type="monotone"
                  dataKey="memory"
                  name="Memory (GB-hours)"
                  stroke="#0078b4"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#colorMem)"
                />
                <Area
                  type="monotone"
                  dataKey="storage"
                  name="Storage (GB-hours)"
                  stroke="#10b981"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#colorStorage)"
                />
                <Area
                  type="monotone"
                  dataKey="gpu"
                  name="GPU (GPU-hours)"
                  stroke="#8b5cf6"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#colorGpu)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Charts Row 2: Breakdown */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pb-12">
          <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
            <h3 className="text-lg font-bold text-gray-800 mb-6">
              CPU Consumption by Workflow Run
            </h3>
            <div className="h-96 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={stats.workflowChartData}
                  margin={{ bottom: 90, left: 10, right: 10 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    horizontal={true}
                    vertical={false}
                    stroke="#f0f0f0"
                  />
                  <XAxis
                    dataKey="name"
                    fontSize={8}
                    angle={-45}
                    textAnchor="end"
                    height={85}
                    interval={0}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    type="number"
                    fontSize={10}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(val) => Number(val).toFixed(5)}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar
                    dataKey="cpu"
                    name="CPU (core-hours)"
                    radius={[4, 4, 0, 0]}
                    fill="#004170"
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
            <h3 className="text-lg font-bold text-gray-800 mb-6">
              Memory Consumption by Workflow Run
            </h3>
            <div className="h-96 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={stats.workflowChartData}
                  margin={{ bottom: 90, left: 10, right: 10 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    horizontal={true}
                    vertical={false}
                    stroke="#f0f0f0"
                  />
                  <XAxis
                    dataKey="name"
                    fontSize={8}
                    angle={-45}
                    textAnchor="end"
                    height={85}
                    interval={0}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    type="number"
                    fontSize={10}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(val) => Number(val).toFixed(5)}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar
                    dataKey="memory"
                    name="Memory (GB-hours)"
                    radius={[4, 4, 0, 0]}
                    fill="#0078b4"
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
            <h3 className="text-lg font-bold text-gray-800 mb-6">
              Storage Consumption by Workflow Run
            </h3>
            <div className="h-96 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={stats.workflowChartData}
                  margin={{ bottom: 90, left: 10, right: 10 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    horizontal={true}
                    vertical={false}
                    stroke="#f0f0f0"
                  />
                  <XAxis
                    dataKey="name"
                    fontSize={8}
                    angle={-45}
                    textAnchor="end"
                    height={85}
                    interval={0}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    type="number"
                    fontSize={10}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(val) => Number(val).toFixed(5)}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar
                    dataKey="storage"
                    name="Storage (GB-hours)"
                    radius={[4, 4, 0, 0]}
                    fill="#10b981"
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
            <h3 className="text-lg font-bold text-gray-800 mb-6">
              GPU Consumption by Workflow Run
            </h3>
            <div className="h-96 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={stats.workflowChartData}
                  margin={{ bottom: 90, left: 10, right: 10 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    horizontal={true}
                    vertical={false}
                    stroke="#f0f0f0"
                  />
                  <XAxis
                    dataKey="name"
                    fontSize={8}
                    angle={-45}
                    textAnchor="end"
                    height={85}
                    interval={0}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    type="number"
                    fontSize={10}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(val) => Number(val).toFixed(5)}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar
                    dataKey="gpu"
                    name="GPU (GPU-hours)"
                    radius={[4, 4, 0, 0]}
                    fill="#8b5cf6"
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ResourcesView;
