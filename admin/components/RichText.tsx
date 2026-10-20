import { useEditor, EditorContent, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Image from "@tiptap/extension-image";
import { useEffect, useState } from "react";
import { Icon } from "../lib/icons";
import { promptDialog } from "./ui";
import { MediaPicker } from "./MediaPicker";
import { CodeField } from "./CodeEditor";

export function RichText({ value, onChange, placeholder, compact, label }: { value: string; onChange: (html: string) => void; placeholder?: string; compact?: boolean; label?: string }) {
  const [source, setSource] = useState(false);
  const [picking, setPicking] = useState(false);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3, 4] }, link: { openOnClick: false, autolink: true } }),
      Placeholder.configure({ placeholder: placeholder ?? "Write something…" }),
      Image.configure({ inline: false }),
    ],
    content: value || "",
    onUpdate: ({ editor }) => onChange(editor.isEmpty ? "" : editor.getHTML()),
    immediatelyRender: true,
    editorProps: { attributes: { role: "textbox", "aria-multiline": "true", "aria-label": label ?? "Rich text" } },
  });

  // keep in sync when the value changes from outside (e.g. inline edit on canvas, undo)
  useEffect(() => {
    if (!editor || editor.isFocused) return;
    if ((value || "") !== editor.getHTML() && !(editor.isEmpty && !value)) editor.commands.setContent(value || "", { emitUpdate: false });
  }, [value, editor]);

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive("bold"),
            italic: e.isActive("italic"),
            underline: e.isActive("underline"),
            strike: e.isActive("strike"),
            h2: e.isActive("heading", { level: 2 }),
            h3: e.isActive("heading", { level: 3 }),
            ul: e.isActive("bulletList"),
            ol: e.isActive("orderedList"),
            quote: e.isActive("blockquote"),
            link: e.isActive("link"),
          }
        : null,
  });
  if (!editor) return null;
  const btn = (icon: string, title: string, active: boolean | undefined, run: () => void) => (
    <button type="button" className={`rte-btn ${active ? "active" : ""}`} title={title} aria-label={title} aria-pressed={!!active} onMouseDown={(e) => e.preventDefault()} onClick={run}>
      <Icon name={icon} size={15} />
    </button>
  );
  const setLink = async () => {
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = await promptDialog({ title: prev ? "Edit link" : "Add link", label: "URL", initial: prev ?? "https://", confirmLabel: "Apply", message: "Use a full address (https://…) or a page path like /contact." });
    if (url === null) return;
    if (!url || url === "https://") editor.chain().focus().unsetLink().run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  };
  return (
    <div className="rte">
      <div className="rte-toolbar">
        {btn("Bold", "Bold (Ctrl+B)", state?.bold, () => editor.chain().focus().toggleBold().run())}
        {btn("Italic", "Italic (Ctrl+I)", state?.italic, () => editor.chain().focus().toggleItalic().run())}
        {btn("Underline", "Underline (Ctrl+U)", state?.underline, () => editor.chain().focus().toggleUnderline().run())}
        {btn("Strikethrough", "Strikethrough", state?.strike, () => editor.chain().focus().toggleStrike().run())}
        <span className="rte-sep" />
        {btn("Heading2", "Heading", state?.h2, () => editor.chain().focus().toggleHeading({ level: 2 }).run())}
        {btn("Heading3", "Subheading", state?.h3, () => editor.chain().focus().toggleHeading({ level: 3 }).run())}
        {btn("List", "Bulleted list", state?.ul, () => editor.chain().focus().toggleBulletList().run())}
        {btn("ListOrdered", "Numbered list", state?.ol, () => editor.chain().focus().toggleOrderedList().run())}
        {btn("Quote", "Quote", state?.quote, () => editor.chain().focus().toggleBlockquote().run())}
        <span className="rte-sep" />
        {btn("Link", "Link", state?.link, setLink)}
        {btn("Image", "Insert image", false, () => setPicking(true))}
        {btn("RemoveFormatting", "Clear formatting", false, () => editor.chain().focus().unsetAllMarks().clearNodes().run())}
        <span className="spacer" />
        {btn("CodeXml", source ? "Back to visual editor" : "Edit HTML source", source, () => setSource((s) => !s))}
      </div>
      {source ? (
        <CodeField
          value={value}
          language="html"
          minHeight="160px"
          onChange={(v) => {
            onChange(v);
            editor.commands.setContent(v, { emitUpdate: false });
          }}
        />
      ) : (
        <EditorContent editor={editor} className={`rte-content ${compact ? "compact" : ""}`} />
      )}
      {picking && (
        <MediaPicker
          accept="image"
          onClose={() => setPicking(false)}
          onPick={(m) => {
            setPicking(false);
            editor.chain().focus().insertContent(`<p><img src="${m.url}" alt="${(m.alt || "").replace(/"/g, "&quot;")}"></p>`).run();
          }}
        />
      )}
    </div>
  );
}
