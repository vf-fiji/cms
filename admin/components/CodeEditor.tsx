import CodeMirror, { type ReactCodeMirrorProps } from "@uiw/react-codemirror";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { javascript } from "@codemirror/lang-javascript";
import { vscodeDark, vscodeLight } from "@uiw/codemirror-theme-vscode";
import { EditorView, keymap } from "@codemirror/view";
import { useMemo } from "react";
import { useTheme } from "../lib/theme";

export type CodeLang = "html" | "css" | "javascript" | "jsx" | "liquid" | "json";

function langExt(lang: CodeLang) {
  switch (lang) {
    case "css":
      return css();
    case "javascript":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "json":
      return javascript({ jsx: false, typescript: false });
    default:
      return html({ autoCloseTags: true });
  }
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  language: CodeLang;
  height?: string;
  minHeight?: string;
  dark?: boolean;
  onSave?: () => void;
  readOnly?: boolean;
  className?: string;
  basicSetup?: ReactCodeMirrorProps["basicSetup"];
}

export function CodeEditor({ value, onChange, language, height, minHeight = "120px", dark, onSave, readOnly, className, basicSetup }: Props) {
  const { theme } = useTheme();
  const extensions = useMemo(() => {
    const ext = [langExt(language), EditorView.lineWrapping];
    if (onSave)
      ext.push(
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              onSave();
              return true;
            },
          },
        ]),
      );
    return ext;
  }, [language, onSave]);
  return (
    <CodeMirror
      className={className}
      value={value}
      onChange={onChange}
      height={height}
      minHeight={minHeight}
      theme={dark || theme === "dark" ? vscodeDark : vscodeLight}
      extensions={extensions}
      readOnly={readOnly}
      basicSetup={basicSetup ?? { foldGutter: true, highlightActiveLine: true, autocompletion: true, bracketMatching: true, closeBrackets: true, tabSize: 2 }}
    />
  );
}

/** Compact code input for inspectors and forms. */
export function CodeField({ value, onChange, language, minHeight = "90px" }: { value: string; onChange: (v: string) => void; language: CodeLang; minHeight?: string }) {
  return (
    <div className="code-field">
      <CodeEditor value={value ?? ""} onChange={onChange} language={language} minHeight={minHeight} basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false, tabSize: 2 }} />
    </div>
  );
}
