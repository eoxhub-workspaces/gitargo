import { styled } from "@mui/material";
import lodash from "lodash";
import { toaster } from ".";
import { FormikProps } from "formik";

export const checkArray = <T,>(array: unknown, name: string): T[] => {
  if (!Array.isArray(array)) {
    throw new Error(
      `Looks like we encountered a bug. The current implementation expects "${name}" to be an array.`
    );
  }
  return array as T[];
};

export const pruneArray = <T,>(array: (T | undefined)[]): T[] | undefined => {
  const result = array.filter(Boolean);
  if (result.length === 0) {
    return undefined;
  }
  return result as T[];
};

export const pruneObject = <T, R = T>(object: T): R | undefined => {
  const result = lodash.pickBy(object ?? {}, (value) => value !== undefined);
  if (Object.keys(result).length === 0) {
    return undefined;
  }
  return result as unknown as R;
};

export const pruneString = (value?: string): string | undefined => {
  if (!value) {
    return undefined;
  }
  return value;
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

export const splitKVPairs = (
  text: string,
  seperator: string,
  optional = true
): [string, string] => {
  const firstIndex = text.indexOf(seperator);
  if (firstIndex < 0) {
    if (optional) {
      return [text, ""];
    } else {
      throw new Error("Malformed document!");
    }
  }
  const key = text.substring(0, firstIndex);
  const value = text.substring(firstIndex + 1);
  return [key, value];
};

export type TTransformFunction = (
  item: string,
  index: number
) => Record<string, any>;
type KeyValue = { [key: string]: string };

export const extractObjectOrArray = (
  seperator: string,
  keyName: string,
  valueName: string,
  object: KeyValue | string[] | undefined
): { [key: string]: string }[] | undefined => {
  if (!object) {
    return undefined;
  }

  if (Array.isArray(object)) {
    return object.map((item: string) => {
      const [key, value] = splitKVPairs(item, seperator);
      return {
        [keyName]: key,
        [valueName]: value
      };
    });
  }

  return Object.entries(object).map(([key, value]) => {
    return {
      [keyName]: key,
      [valueName]: value
    };
  });
};

export const extractArray = (
  seperator: string,
  keyName: string,
  valueName: string,
  array: string[] | undefined
): { [key: string]: string }[] | undefined => {
  if (!array) {
    return undefined;
  }

  if (!Array.isArray(array)) {
    throw new Error("Malformed document. Expected an array at this point.");
  }

  return array.map((item: string) => {
    const [key, value] = splitKVPairs(item, seperator);
    return {
      [keyName]: key,
      [valueName]: value
    };
  });
};

/**
 * Converts an array of the form `[{ [K]: string, [V]: string}]` to `{K: V}`.
 * For example,
 * ```
 * [
 *     {
 *         key: "NODE_ENV",
 *         value: "production"
 *     }
 * ]
 *
 * becomes
 *
 * {
 *     NODE_ENV: "production"
 * }
 * ```
 */
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

/**
 * Converts an array objects of the form
 * ```
 * [
 *      {
 *          [K]: string,
 *          [V]: string
 *      }
 *      ...
 *  ]`
 *
 * to
 *
 * [
 *     `${item[i][K]]}${seperator}${item[i][V]}`,
 *      ...
 * ]
 * ```
 *
 * For example,
 * ```
 * [
 *     {
 *         key: "NODE_ENV",
 *         value: "production"
 *     }
 * ]
 *
 * becomes
 *
 * {
 *     "NODE_ENV=production"
 * }
 * ```
 */
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

const isObject = (value: any) => {
  return !!(value && typeof value === "object" && !Array.isArray(value));
};

const Path = styled("span")`
  font-weight: bold;
  font-size: 0.75rem;
`;

const renderToast = (path: string, message: string) => (
  <p>
    <Path>{path}</Path>
    <br />
    {message}
  </p>
);

const reportError = (
  prefix: string,
  error: string | Record<string, any> | any[]
) => {
  if (lodash.isString(error) && /\s/.test(error)) {
    toaster(renderToast(prefix, error as string), "error");
    return;
  }

  if (Array.isArray(error)) {
    error.forEach((item, index) => {
      reportError(`${prefix} > ${index}`, item);
    });
  }

  if (isObject(error)) {
    const normalizedPrefix = `${prefix}${prefix !== "" ? " > " : ""}`;
    for (const [key, value] of Object.entries(error)) {
      if (Array.isArray(value) || isObject(value)) {
        reportError(`${normalizedPrefix}${key}`, value);
      } else if (lodash.isString(value)) {
        toaster(renderToast(normalizedPrefix + key, value as string), "error");
      } else {
        throw new Error("Unknown path");
      }
    }
  }
};

/**
 * Formik is configured to validate fields automatically using Yup.
 * The problem is Formik does not call `onSubmit` function when errors
 * are present. Therefore, a work around was to call `formik.submitForm`
 * after showing errors to the user. The `reportErrorsAndSubmit` utility
 * function basically implements this.
 * @template T The type of the form values.
 */
export const reportErrorsAndSubmit =
  <T,>(formik: FormikProps<T>) =>
  () => {
    if (!formik.isValid) {
      reportError("", formik.errors);
    } else {
      formik.submitForm();
    }
  };
