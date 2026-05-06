import { useFormikContext } from "formik";
import { IEditTemplateForm } from "../../../types";
import CodeEditor from "../../CodeEditor";

const IO = () => {
  const formik = useFormikContext<IEditTemplateForm>();

  return (
    <div className="space-y-6">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Inputs (YAML)
        </label>
        <p className="text-xs text-gray-500 mb-2">
          Define input artifacts and parameters. Example:{" "}
          <code>{`artifacts: [{ name: my-artifact, path: /tmp/file }]`}</code>
        </p>
        <div
          className="border border-gray-300 rounded-md overflow-hidden bg-[#1e1e1e]"
          style={{ height: "200px" }}
        >
          <CodeEditor
            data={formik.values.data.template.inputs || ""}
            language="yaml"
            onChange={(val) =>
              formik.setFieldValue("data.template.inputs", val)
            }
            disabled={false}
            lineWrapping={true}
            height="200px"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Outputs (YAML)
        </label>
        <p className="text-xs text-gray-500 mb-2">
          Define output artifacts and parameters.
        </p>
        <div
          className="border border-gray-300 rounded-md overflow-hidden bg-[#1e1e1e]"
          style={{ height: "200px" }}
        >
          <CodeEditor
            data={formik.values.data.template.outputs || ""}
            language="yaml"
            onChange={(val) =>
              formik.setFieldValue("data.template.outputs", val)
            }
            disabled={false}
            lineWrapping={true}
            height="200px"
          />
        </div>
      </div>
    </div>
  );
};

export default IO;
