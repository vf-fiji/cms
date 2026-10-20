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
  /** accessible name for screen readers (defaults to the language) */
  label?: string;
}

export function CodeEditor({ value, onChange, language, height, minHeight = "120px", dark, onSave, readOnly, className, basicSetup, label }: Props) {
  const { theme } = useTheme();
  const extensions = useMemo(() => {
    const name = label ?? `${language === "javascript" ? "JavaScript" : language === "jsx" ? "JSX" : language.toUpperCase()} code`;
    // Esc then Tab leaves the editor (CodeMirror's built-in escape from Tab indenting)
    const ext = [langExt(language), EditorView.lineWrapping, EditorView.contentAttributes.of({ "aria-label": name })];
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
  }, [language, onSave, label]);
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
export function CodeField({ value, onChange, language, minHeight = "90px", label }: { value: string; onChange: (v: string) => void; language: CodeLang; minHeight?: string; label?: string }) {
  return (
    <div className="code-field">
      <CodeEditor value={value ?? ""} onChange={onChange} language={language} minHeight={minHeight} label={label} basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false, tabSize: 2 }} />
    </div>
  );
}
