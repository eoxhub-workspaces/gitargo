import React, { useEffect } from "react";
import Editor, { useMonaco } from "@monaco-editor/react";
import * as monaco from "monaco-editor";

// IMPORTANT: For Create React App, you need to manually copy these worker files
// from node_modules into your public/static/js directory. Without ejecting CRA
// or using a custom webpack setup, this is the most reliable way to load workers.
// Copy these files:
// - node_modules/monaco-editor/esm/vs/editor/editor.worker.js
// - node_modules/monaco-editor/esm/vs/language/json/json.worker.js
// - node_modules/monaco-yaml/yaml.worker.js
window.MonacoEnvironment = {
  getWorkerUrl: (moduleId, label) => {
    if (label === "yaml") {
      return "./static/js/yaml.worker.js";
    }
    if (label === "json") {
      return "./static/js/json.worker.js";
    }
    return "./static/js/editor.worker.js";
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
