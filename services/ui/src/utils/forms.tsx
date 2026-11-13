import { FormikProps } from "formik";
import toast from "react-hot-toast";

/**
 * Report error on screen if any form validation errors occur.
 *
 * @param title The error title to display
 * @param errors The formik errors object
 */
export const reportError = (title: string, errors: any): void => {
  const processError = (error: any): string[] => {
    let result: string[] = [];

    if (typeof error === "string") {
      result.push(error);
    } else if (Array.isArray(error)) {
      error.forEach((subError) => {
        result = result.concat(processError(subError));
      });
    } else if (typeof error === "object" && error !== null) {
      Object.keys(error).forEach((key) => {
        result = result.concat(processError(error[key]));
      });
    }

    return result;
  };

  const errorMessages = processError(errors);

  if (errorMessages.length > 0) {
    toast.error(
      <div>
        <span className="text-[#333] border-b border-[#333] mb-1 font-semibold text-sm">
          {title || "Form Errors"}
        </span>
        <ul>
          {errorMessages.map((message, index) => (
            <li key={index} className="text-xs">
              {message}
            </li>
          ))}
        </ul>
      </div>
    );
  }
};

/**
 * Prunes `undefined` fields from object.
 *
 * @param object The object to prune fields from
 * @returns The pruned object
 */
export const pruneObject = (
  object?: Record<string, any>
): Record<string, any> | undefined => {
  if (object === undefined || object === null) {
    return undefined;
  }

  const prunedEntries = Object.entries(object).filter(
    ([, value]) => value !== undefined && value !== null && value !== ""
  );

  return prunedEntries.length > 0
    ? Object.fromEntries(prunedEntries)
    : undefined;
};

/**
 * Prunes `undefined` fields from array.
 *
 * @param array The array to prune fields from
 * @returns The pruned array
 */
export const pruneArray = (array?: any[]): any[] | undefined => {
  if (array === undefined || array === null) {
    return undefined;
  }

  const pruned = array.filter(
    (item) => item !== undefined && item !== null && item !== ""
  );

  return pruned.length > 0 ? pruned : undefined;
};

/**
 * Unpacks an object into an array of objects.
 * For example,
 * ```
 * {
 *     NODE_ENV: "production"
 * }
 *
 * becomes
 *
 * [
 *     {
 *         key: "NODE_ENV",
 *         value: "production"
 *     }
 * ]
 * ```
 *
 * @param object The object to unpack
 * @param keyName The key name for the Object key
 * @param valueName The value name for the Object value
 * @returns An array of unpacked Object key values
 */
export const unpackObjectAsArray = (
  object: Record<string, any>,
  keyName: string,
  valueName: string
): Record<string, any>[] => {
  if (object === undefined || object === null) {
    return [];
  }

  return Object.entries(object).map(([key, value]) => {
    return {
      [keyName]: key,
      [valueName]: value
    };
  });
};

type ArrayOfObjects = { [key: string]: any }[];
export const packArrayAsObject = (
  array: ArrayOfObjects,
  keyName: string,
  valueName: string
): Record<string, any> | undefined => {
  return pruneObject(
    Object.fromEntries(array.map((item) => [item[keyName], item[valueName]]))
  );
};

export const packArrayAsStrings = (
  objects: ArrayOfObjects,
  keyName: string,
  valueName: string,
  seperator: string
): string[] | undefined => {
  return pruneArray(
    objects.map((object) =>
      [object[keyName], object[valueName]].join(seperator)
    )
  );
};

export const unpackStringsAsArray = (
  strings: string[],
  keyName: string,
  valueName: string,
  seperator: string
): Record<string, any>[] => {
  return strings.map((item) => {
    const [key, value] = item.split(seperator);
    return {
      [keyName]: key,
      [valueName]: value
    };
  });
};

export const pruneNumber = (value?: number): number | undefined => {
  if (
    value === undefined ||
    value === null ||
    isNaN(value) ||
    (value as unknown as string) === ""
  ) {
    return undefined;
  }

  return value;
};

export const reportErrorsAndSubmit =
  <T,>(formik: FormikProps<T>) =>
  () => {
    if (!formik.isValid) {
      reportError("", formik.errors);
    } else {
      formik.submitForm();
    }
  };

export function parseKubespawnerQuantity(
  val: string | number | undefined,
  isMemory = false
): string | undefined {
  if (val === undefined || val === null || val === "") return undefined;

  if (typeof val === "number") {
    if (isMemory) {
      return `${Math.round(val)}`;
    }
    if (Number.isInteger(val)) {
      return `${val}`;
    }
    return `${Math.round(val * 1000)}m`;
  }

  const str = String(val).trim();
  if (!str) return undefined;

  if (!isMemory) {
    if (str.endsWith("m")) return str;
    const num = parseFloat(str);
    if (isNaN(num)) return str;
    if (Number.isInteger(num)) return `${num}`;
    return `${Math.round(num * 1000)}m`;
  }

  const match = str.match(/^([0-9.]+)\s*([a-zA-Z]*)$/);
  if (!match) return str;

  const num = parseFloat(match[1]);
  if (isNaN(num)) return str;

  const unit = match[2].toUpperCase();
  if (unit === "G" || unit === "GB") {
    const mb = num * 1000;
    return Number.isInteger(mb) ? `${mb}M` : `${Math.round(mb)}M`;
  }
  if (unit === "GI" || unit === "GIB") {
    const mi = num * 1024;
    return Number.isInteger(mi) ? `${mi}Mi` : `${Math.round(mi)}Mi`;
  }
  if (unit === "M" || unit === "MB" || unit === "MI" || unit === "MIB") {
    return `${Math.round(num)}Mi`;
  }
  if (unit === "K" || unit === "KB" || unit === "KI" || unit === "KIB") {
    return `${Math.round(num)}Ki`;
  }

  return str;
}

export function translateKubespawnerOverride(override?: any) {
  if (!override) return { resources: {}, tolerations: [], nodeSelector: {} };

  const requests: Record<string, string> = {};
  const limits: Record<string, string> = {};

  // CPU
  const cpuReq = parseKubespawnerQuantity(override.cpu_guarantee, false);
  if (cpuReq) requests.cpu = cpuReq;

  const cpuLim = parseKubespawnerQuantity(override.cpu_limit, false);
  if (cpuLim) limits.cpu = cpuLim;

  // Memory
  const memReq = parseKubespawnerQuantity(override.mem_guarantee, true);
  if (memReq) requests.memory = memReq;

  const memLim = parseKubespawnerQuantity(override.mem_limit, true);
  if (memLim) limits.memory = memLim;

  // Extra Resource Requests & Limits
  if (override.extra_resource_requests) {
    Object.assign(requests, override.extra_resource_requests);
  }
  if (override.extra_resource_limits) {
    Object.assign(limits, override.extra_resource_limits);
  }

  const resources: any = {};
  if (Object.keys(requests).length > 0) resources.requests = requests;
  if (Object.keys(limits).length > 0) resources.limits = limits;

  return {
    resources,
    tolerations: override.tolerations || [],
    nodeSelector: override.node_selector || {}
  };
}

export function isProfileAllowedForWorkspace(
  profileKey: string,
  profile: any,
  workspaceIdentifier: string
): boolean {
  const allowed =
    profile.allowed_groups || profile.kubespawner_override?.allowed_groups;
  if (!allowed || !Array.isArray(allowed) || allowed.length === 0) {
    return true;
  }

  if (!workspaceIdentifier) return false;

  const cleanWs = workspaceIdentifier.trim().replace(/^\//, "");
  return allowed.some((g: string) => {
    const cleanG = g.trim().replace(/^\//, "");
    return cleanG === cleanWs;
  });
}

export function parseCpuToMillicores(val: string | number | undefined): number {
  if (val === undefined || val === null || val === "") return 0;
  if (typeof val === "number") return Math.round(val * 1000);
  const str = String(val).trim();
  if (str.endsWith("m")) {
    const num = parseFloat(str.slice(0, -1));
    return isNaN(num) ? 0 : Math.round(num);
  }
  const num = parseFloat(str);
  return isNaN(num) ? 0 : Math.round(num * 1000);
}

export function parseMemoryToBytes(val: string | number | undefined): number {
  if (val === undefined || val === null || val === "") return 0;
  if (typeof val === "number") return Math.round(val);
  const str = String(val).trim();
  const match = str.match(/^([0-9.]+)\s*([a-zA-Z]*)$/);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  if (isNaN(num)) return 0;
  const unit = match[2].toUpperCase();

  switch (unit) {
    case "E":
    case "EB":
      return Math.round(num * 1e18);
    case "EI":
    case "EIB":
      return Math.round(num * Math.pow(1024, 6));
    case "P":
    case "PB":
      return Math.round(num * 1e15);
    case "PI":
    case "PIB":
      return Math.round(num * Math.pow(1024, 5));
    case "T":
    case "TB":
      return Math.round(num * 1e12);
    case "TI":
    case "TIB":
      return Math.round(num * Math.pow(1024, 4));
    case "G":
    case "GB":
      return Math.round(num * 1e9);
    case "GI":
    case "GIB":
      return Math.round(num * Math.pow(1024, 3));
    case "M":
    case "MB":
      return Math.round(num * 1e6);
    case "MI":
    case "MIB":
      return Math.round(num * Math.pow(1024, 2));
    case "K":
    case "KB":
      return Math.round(num * 1e3);
    case "KI":
    case "KIB":
      return Math.round(num * 1024);
    default:
      return Math.round(num);
  }
}

export function matchProfileForTemplate(
  template: any,
  configProfiles: Record<string, any>
): string {
  if (!template || (!template.container && !template.script)) return "";

  const containerKey = template.container ? "container" : "script";
  const target = template[containerKey] || {};
  const currentRes = target.resources || {};

  const currentCpuReq = parseCpuToMillicores(currentRes.requests?.cpu);
  const currentCpuLim = parseCpuToMillicores(currentRes.limits?.cpu);
  const currentMemReq = parseMemoryToBytes(currentRes.requests?.memory);
  const currentMemLim = parseMemoryToBytes(currentRes.limits?.memory);
  const currentGpuLim = currentRes.limits?.["nvidia.com/gpu"] || "";

  for (const [key, profile] of Object.entries(configProfiles)) {
    const override = profile.kubespawner_override || profile;
    const translated = translateKubespawnerOverride(override);

    const transCpuReq = parseCpuToMillicores(
      translated.resources?.requests?.cpu
    );
    const transCpuLim = parseCpuToMillicores(translated.resources?.limits?.cpu);
    const transMemReq = parseMemoryToBytes(
      translated.resources?.requests?.memory
    );
    const transMemLim = parseMemoryToBytes(
      translated.resources?.limits?.memory
    );
    const transGpuLim = translated.resources?.limits?.["nvidia.com/gpu"] || "";

    const cpuReqMatch =
      !transCpuReq || Math.abs(currentCpuReq - transCpuReq) <= 10;
    const cpuLimMatch =
      !transCpuLim || Math.abs(currentCpuLim - transCpuLim) <= 10;
    const memReqMatch =
      !transMemReq ||
      Math.abs(currentMemReq - transMemReq) / Math.max(transMemReq, 1) < 0.05;
    const memLimMatch =
      !transMemLim ||
      Math.abs(currentMemLim - transMemLim) / Math.max(transMemLim, 1) < 0.05;
    const gpuMatch = (currentGpuLim || "") === (transGpuLim || "");

    // Tolerations match check
    const transTols = translated.tolerations || [];
    const currentTols = template.tolerations || [];
    const tolsMatch =
      transTols.length === currentTols.length &&
      transTols.every((tt: any) =>
        currentTols.some(
          (ct: any) =>
            ct.key === tt.key &&
            (ct.value || "") === (tt.value || "") &&
            (ct.operator || "") === (tt.operator || "") &&
            (ct.effect || "") === (tt.effect || "")
        )
      );

    // NodeSelector match check
    const transNs = translated.nodeSelector || {};
    const currentNs = template.nodeSelector || {};
    const nsKeys = Object.keys(transNs);
    const nsMatch =
      Object.keys(currentNs).length === nsKeys.length &&
      nsKeys.every((k) => currentNs[k] === transNs[k]);

    if (
      cpuReqMatch &&
      cpuLimMatch &&
      memReqMatch &&
      memLimMatch &&
      gpuMatch &&
      tolsMatch &&
      nsMatch
    ) {
      return key;
    }
  }

  return "custom";
}
