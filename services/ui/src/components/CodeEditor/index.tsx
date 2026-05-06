import React, { useEffect } from "react";
import Editor, { useMonaco } from "@monaco-editor/react";

// The window.MonacoEnvironment needs to be set up to tell Monaco where to find the workers.
// The workers must be served from the public directory (static/js).
window.MonacoEnvironment = {
  getWorkerUrl: function (_moduleId: any, label: string) {
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
    if (monaco && language === "yaml") {
      import("monaco-yaml")
        .then(({ configureMonacoYaml }) => {
          configureMonacoYaml(monaco, {
            enableSchemaRequest: false, // Set to false to avoid resetSchema errors on some builds
            hover: true,
            completion: true,
            validate: true,
            format: true,
            schemas: [
              {
                // Argo Workflow JSON Schema
                uri: "https://raw.githubusercontent.com/argoproj/argo-workflows/master/api/jsonschema/schema.json",
                fileMatch: ["*"]
              }
            ]
          });
        })
        .catch(console.error);
    }
  }, [monaco, language]);

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
          formatOnType: true,
          automaticLayout: true,
          scrollBeyondLastLine: false,
          fontSize: 14,
          tabSize: 2,
          suggestOnTriggerCharacters: true,
          quickSuggestions: {
            other: true,
            comments: false,
            strings: true
          }
        }}
      />
    </div>
  );
};

export default CodeEditor;
