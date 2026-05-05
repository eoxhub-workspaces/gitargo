import React, { useEffect } from "react";
import Editor, { useMonaco, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";

// Force @monaco-editor/react to use our local monaco-editor package
loader.config({ monaco });

window.MonacoEnvironment = {
  getWorker(moduleId, label) {
    if (label === "yaml") {
      return new Worker(new URL("monaco-yaml/yaml.worker", import.meta.url));
    }
    if (label === "json") {
      return new Worker(
        new URL(
          "monaco-editor/esm/vs/language/json/json.worker",
          import.meta.url
        )
      );
    }
    return new Worker(
      new URL("monaco-editor/esm/vs/editor/editor.worker", import.meta.url)
    );
  }
};

interface ICodeEditorProps {
  data: string;
  language: string;
  onChange: (value: string) => void;
  disabled: boolean;
  lineWrapping: boolean;
  height: string | number;
}

const CodeEditor = (props: ICodeEditorProps) => {
  const { data, language, onChange, disabled, lineWrapping, height } = props;
  const monaco = useMonaco();

  useEffect(() => {
    if (monaco) {
      import("monaco-yaml")
        .then(({ configureMonacoYaml }) => {
          configureMonacoYaml(monaco, {
            enableSchemaRequest: true,
            schemas: [
              {
                uri: "https://raw.githubusercontent.com/argoproj/argo-workflows/master/api/jsonschema/schema.json",
                fileMatch: ["*"]
              }
            ]
          });
        })
        .catch(console.error);
    }
  }, [monaco]);

  const handleEditorChange = (value: string | undefined) => {
    if (value !== undefined) {
      onChange(value);
    }
  };

  return (
    <div className="pt-9 pb-2" style={{ height }}>
      <Editor
        height={typeof height === "number" ? `${height}px` : height}
        language={language}
        theme="vs-dark"
        value={data}
        onChange={handleEditorChange}
        options={{
          readOnly: disabled,
          wordWrap: lineWrapping ? "on" : "off",
          minimap: { enabled: false },
          formatOnPaste: true,
          formatOnType: true
        }}
      />
    </div>
  );
};

export default CodeEditor;
