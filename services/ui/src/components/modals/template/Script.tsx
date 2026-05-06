import { styled } from "@mui/material";
import { useFormikContext } from "formik";
import { IEditTemplateForm } from "../../../types";
import TextField from "../../global/FormElements/TextField";
import CodeEditor from "../../CodeEditor";

const Root = styled("div")`
  display: flex;
  flex-direction: column;
  row-gap: ${({ theme }) => theme.spacing(1)};
  @media (max-width: 640px) {
    row-gap: 0;
  }
`;

const Script = () => {
  const formik = useFormikContext<IEditTemplateForm>();

  return (
    <Root>
      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-3">
          <TextField
            id={"data.template.script.name"}
            name={"data.template.script.name"}
            placeholder={""}
            label={"Name of the container specified as a DNS_LABEL"}
            required={false}
          />
        </div>

        <div className="col-span-3">
          <TextField
            id={"data.template.script.image"}
            name={"data.template.script.image"}
            placeholder={"docker/whalesay"}
            label={"Image"}
            required={true}
          />
        </div>

        <div className="col-span-3">
          <TextField
            id={"data.template.script.command"}
            name={"data.template.script.command"}
            placeholder={"cowsay"}
            label={"Command"}
            required={false}
          />
        </div>

        <div className="col-span-3">
          <TextField
            id={"data.template.script.args"}
            name={"data.template.script.args"}
            placeholder={"hello world"}
            label={"Args"}
            required={false}
          />
        </div>

        <div className="col-span-3">
          <TextField
            id={"data.template.script.imagePullPolicy"}
            name={"data.template.script.imagePullPolicy"}
            placeholder={"Always, Never, IfNotPresent"}
            label={"Image pull policy"}
            required={false}
          />
        </div>

        <div className="col-span-3">
          <label
            htmlFor={`script-source`}
            className="block text-xs font-medium text-gray-700 mt-2 mb-2"
          >
            Source
          </label>
          <div
            className="border border-gray-300 rounded-md overflow-hidden bg-[#1e1e1e]"
            style={{ height: "300px" }}
          >
            <CodeEditor
              data={formik.values.data.template.script?.source || ""}
              language="python"
              onChange={(val) =>
                formik.setFieldValue("data.template.script.source", val)
              }
              disabled={false}
              lineWrapping={true}
              height="300px"
            />
          </div>
          <p className="text-[10px] text-gray-400 mt-1">
            Indentation and line breaks are preserved exactly as written using
            literal block scalars (|).
          </p>
        </div>
      </div>
    </Root>
  );
};

export default Script;
