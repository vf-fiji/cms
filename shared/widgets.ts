// Built-in widget catalogue. The server renders these; the admin uses the
// same definitions to build the inspector and the "Add" palette.
import type { FieldDef, SectionNode, ColumnNode, WidgetNode } from "./types";

export interface WidgetDef {
  type: string;
  name: string;
  icon: string; // lucide icon name
  category: "Basic" | "Media" | "Layout" | "Content" | "Interactive" | "Developer" | "Custom";
  description: string;
  fields: FieldDef[];
  defaults: Record<string, any>;
  /** widgets whose main text can be edited inline on the canvas */
  inlineField?: string;
}

const align: FieldDef = {
  key: "align",
  label: "Alignment",
  type: "select",
  group: "style",
  options: [
    { value: "left", label: "Left" },
    { value: "center", label: "Center" },
    { value: "right", label: "Right" },
  ],
};

/** Fields every widget gets on the Advanced tab. */
export const COMMON_WIDGET_FIELDS: FieldDef[] = [
  {
    key: "_spacing",
    label: "Space below",
    type: "select",
    group: "advanced",
    options: [
      { value: "none", label: "None" },
      { value: "sm", label: "Small" },
      { value: "md", label: "Medium" },
      { value: "lg", label: "Large" },
    ],
  },
  {
    key: "_visibility",
    label: "Show on",
    type: "select",
    group: "advanced",
    options: [
      { value: "all", label: "All devices" },
      { value: "desktop", label: "Desktop only" },
      { value: "mobile", label: "Mobile only" },
    ],
  },
  { key: "_anchor", label: "Anchor ID", type: "text", group: "advanced", placeholder: "e.g. pricing" },
  { key: "_class", label: "CSS classes", type: "text", group: "advanced", placeholder: "rounded-3xl shadow-xl p-6", help: "Your own classes or Tailwind utilities, separated by spaces." },
  {
    key: "_style",
    label: "Inline CSS",
    type: "code",
    language: "css",
    group: "advanced",
    help: "Declarations applied to this widget, e.g. border-radius: 12px;",
  },
];

export const SECTION_FIELDS: FieldDef[] = [
  {
    key: "background",
    label: "Background",
    type: "select",
    options: [
      { value: "none", label: "None" },
      { value: "subtle", label: "Subtle" },
      { value: "dark", label: "Dark" },
      { value: "primary", label: "Brand colour" },
      { value: "custom", label: "Custom colour" },
    ],
  },
  { key: "bgColor", label: "Custom colour", type: "color" },
  { key: "bgImage", label: "Background image", type: "image" },
  { key: "overlay", label: "Image overlay (%)", type: "number", min: 0, max: 90 },
  {
    key: "paddingY",
    label: "Vertical padding",
    type: "select",
    options: [
      { value: "none", label: "None" },
      { value: "sm", label: "Small" },
      { value: "md", label: "Medium" },
      { value: "lg", label: "Large" },
      { value: "xl", label: "Extra large" },
    ],
  },
  {
    key: "width",
    label: "Content width",
    type: "select",
    options: [
      { value: "narrow", label: "Narrow (760px)" },
      { value: "contained", label: "Contained (1180px)" },
      { value: "wide", label: "Wide (1440px)" },
      { value: "full", label: "Full width" },
    ],
  },
  {
    key: "gap",
    label: "Column gap",
    type: "select",
    options: [
      { value: "none", label: "None" },
      { value: "sm", label: "Small" },
      { value: "md", label: "Medium" },
      { value: "lg", label: "Large" },
    ],
  },
  {
    key: "valign",
    label: "Vertical alignment",
    type: "select",
    options: [
      { value: "start", label: "Top" },
      { value: "center", label: "Middle" },
      { value: "end", label: "Bottom" },
      { value: "stretch", label: "Stretch" },
    ],
  },
  { key: "minHeight", label: "Minimum height (px)", type: "number", min: 0 },
  { key: "anchor", label: "Anchor ID", type: "text", group: "advanced" },
  { key: "cssClass", label: "CSS classes", type: "text", group: "advanced", placeholder: "bg-neutral-950 text-white", help: "Your own classes or Tailwind utilities." },
  { key: "style", label: "Inline CSS", type: "code", language: "css", group: "advanced" },
];

export const SECTION_DEFAULTS = {
  background: "none",
  paddingY: "lg",
  width: "contained",
  gap: "md",
  valign: "start",
  overlay: 40,
};

export const COLUMN_LAYOUTS: { label: string; widths: number[] }[] = [
  { label: "1 column", widths: [12] },
  { label: "2 equal", widths: [6, 6] },
  { label: "Sidebar right", widths: [8, 4] },
  { label: "Sidebar left", widths: [4, 8] },
  { label: "3 equal", widths: [4, 4, 4] },
  { label: "4 equal", widths: [3, 3, 3, 3] },
  { label: "Wide centre", widths: [3, 6, 3] },
  { label: "Two-thirds", widths: [7, 5] },
];

export const BUILTIN_WIDGETS: WidgetDef[] = [
  {
    type: "heading",
    name: "Heading",
    icon: "Heading",
    category: "Basic",
    description: "Title text, H1 to H4",
    inlineField: "text",
    fields: [
      { key: "text", label: "Text", type: "text", required: true },
      {
        key: "level",
        label: "Level",
        type: "select",
        options: [
          { value: "h1", label: "H1 - Page title" },
          { value: "h2", label: "H2 - Section" },
          { value: "h3", label: "H3 - Subsection" },
          { value: "h4", label: "H4 - Small" },
        ],
      },
      { key: "eyebrow", label: "Eyebrow text", type: "text", help: "Small label above the heading" },
      align,
      { key: "color", label: "Colour", type: "color", group: "style" },
    ],
    defaults: { text: "A clear, confident heading", level: "h2", align: "left" },
  },
  {
    type: "text",
    name: "Text",
    icon: "Pilcrow",
    category: "Basic",
    description: "Rich text with links and lists",
    inlineField: "html",
    fields: [
      { key: "html", label: "Content", type: "richtext" },
      align,
      {
        key: "size",
        label: "Text size",
        type: "select",
        group: "style",
        options: [
          { value: "sm", label: "Small" },
          { value: "md", label: "Normal" },
          { value: "lg", label: "Large (lead)" },
        ],
      },
    ],
    defaults: {
      html: "<p>Start writing here. Select this block to format text, add links and lists.</p>",
      align: "left",
      size: "md",
    },
  },
  {
    type: "button",
    name: "Button",
    icon: "MousePointerClick",
    category: "Basic",
    description: "Call-to-action link",
    fields: [
      { key: "label", label: "Label", type: "text" },
      { key: "url", label: "Link", type: "url" },
      {
        key: "variant",
        label: "Style",
        type: "select",
        options: [
          { value: "primary", label: "Primary" },
          { value: "secondary", label: "Secondary" },
          { value: "outline", label: "Outline" },
          { value: "link", label: "Text link" },
        ],
      },
      {
        key: "size",
        label: "Size",
        type: "select",
        options: [
          { value: "sm", label: "Small" },
          { value: "md", label: "Medium" },
          { value: "lg", label: "Large" },
        ],
      },
      { key: "newTab", label: "Open in new tab", type: "boolean" },
      { key: "secondLabel", label: "Second button label", type: "text" },
      { key: "secondUrl", label: "Second button link", type: "url" },
      align,
    ],
    defaults: { label: "Get started", url: "#", variant: "primary", size: "md", align: "left" },
  },
  {
    type: "image",
    name: "Image",
    icon: "Image",
    category: "Media",
    description: "Single responsive image",
    fields: [
      { key: "src", label: "Image", type: "image" },
      { key: "alt", label: "Alt text", type: "text", help: "Describe the image for screen readers" },
      { key: "caption", label: "Caption", type: "text" },
      { key: "link", label: "Link", type: "url" },
      {
        key: "ratio",
        label: "Aspect ratio",
        type: "select",
        group: "style",
        options: [
          { value: "auto", label: "Original" },
          { value: "16/9", label: "16:9" },
          { value: "4/3", label: "4:3" },
          { value: "1/1", label: "Square" },
          { value: "3/4", label: "Portrait" },
        ],
      },
      { key: "rounded", label: "Rounded corners", type: "boolean", group: "style" },
      { key: "shadow", label: "Shadow", type: "boolean", group: "style" },
    ],
    defaults: { src: "", alt: "", ratio: "auto", rounded: true },
  },
  {
    type: "hero",
    name: "Hero banner",
    icon: "PanelTop",
    category: "Layout",
    description: "Big headline with background",
    fields: [
      { key: "eyebrow", label: "Eyebrow", type: "text" },
      { key: "title", label: "Title", type: "text" },
      { key: "subtitle", label: "Subtitle", type: "textarea" },
      { key: "image", label: "Background image", type: "image" },
      { key: "overlay", label: "Overlay darkness (%)", type: "number", min: 0, max: 90 },
      { key: "ctaLabel", label: "Button label", type: "text" },
      { key: "ctaUrl", label: "Button link", type: "url" },
      { key: "cta2Label", label: "Second button label", type: "text" },
      { key: "cta2Url", label: "Second button link", type: "url" },
      {
        key: "height",
        label: "Height",
        type: "select",
        group: "style",
        options: [
          { value: "sm", label: "Compact" },
          { value: "md", label: "Medium" },
          { value: "lg", label: "Tall" },
          { value: "screen", label: "Full screen" },
        ],
      },
      align,
    ],
    defaults: {
      eyebrow: "Welcome",
      title: "Build something people remember",
      subtitle: "A short supporting sentence that explains the value in plain language.",
      overlay: 45,
      ctaLabel: "Learn more",
      ctaUrl: "#",
      height: "md",
      align: "left",
    },
  },
  {
    type: "card",
    name: "Card",
    icon: "SquareStack",
    category: "Layout",
    description: "Image, title, text and link",
    fields: [
      { key: "image", label: "Image", type: "image" },
      { key: "title", label: "Title", type: "text" },
      { key: "text", label: "Text", type: "textarea" },
      { key: "linkLabel", label: "Link label", type: "text" },
      { key: "url", label: "Link", type: "url" },
      {
        key: "style",
        label: "Card style",
        type: "select",
        group: "style",
        options: [
          { value: "elevated", label: "Elevated" },
          { value: "outlined", label: "Outlined" },
          { value: "flat", label: "Flat" },
        ],
      },
    ],
    defaults: { title: "Card title", text: "Short description of what this card is about.", linkLabel: "Read more", url: "#", style: "elevated" },
  },
  {
    type: "features",
    name: "Feature grid",
    icon: "LayoutGrid",
    category: "Layout",
    description: "Icons or numbers with short text",
    fields: [
      {
        key: "items",
        label: "Items",
        type: "list",
        fields: [
          { key: "icon", label: "Emoji or number", type: "text" },
          { key: "title", label: "Title", type: "text" },
          { key: "text", label: "Text", type: "textarea" },
        ],
      },
      {
        key: "columns",
        label: "Columns",
        type: "select",
        options: [
          { value: "2", label: "2" },
          { value: "3", label: "3" },
          { value: "4", label: "4" },
        ],
      },
      align,
    ],
    defaults: {
      columns: "3",
      align: "left",
      items: [
        { icon: "⚡", title: "Fast", text: "Pages render on the server and load quickly." },
        { icon: "🎨", title: "Flexible", text: "Change layout, colour and spacing visually." },
        { icon: "🛠️", title: "Extensible", text: "Drop into code whenever you need to." },
      ],
    },
  },
  {
    type: "stats",
    name: "Stats",
    icon: "ChartNoAxesColumn",
    category: "Layout",
    description: "Large numbers with labels",
    fields: [
      {
        key: "items",
        label: "Stats",
        type: "list",
        fields: [
          { key: "value", label: "Value", type: "text" },
          { key: "label", label: "Label", type: "text" },
        ],
      },
    ],
    defaults: {
      items: [
        { value: "120+", label: "Pages published" },
        { value: "99.9%", label: "Uptime" },
        { value: "4.9", label: "Editor rating" },
      ],
    },
  },
  {
    type: "quote",
    name: "Quote",
    icon: "Quote",
    category: "Basic",
    description: "Testimonial or pull quote",
    fields: [
      { key: "quote", label: "Quote", type: "textarea" },
      { key: "author", label: "Author", type: "text" },
      { key: "role", label: "Role or company", type: "text" },
      { key: "avatar", label: "Photo", type: "image" },
    ],
    defaults: { quote: "This is the easiest CMS our team has ever used.", author: "Alex Rivera", role: "Marketing lead" },
  },
  {
    type: "gallery",
    name: "Gallery",
    icon: "GalleryHorizontal",
    category: "Media",
    description: "Grid of images with lightbox",
    fields: [
      { key: "images", label: "Images", type: "gallery" },
      {
        key: "columns",
        label: "Columns",
        type: "select",
        options: [
          { value: "2", label: "2" },
          { value: "3", label: "3" },
          { value: "4", label: "4" },
        ],
      },
      { key: "lightbox", label: "Open in lightbox", type: "boolean" },
    ],
    defaults: { images: [], columns: "3", lightbox: true },
  },
  {
    type: "video",
    name: "Video",
    icon: "Video",
    category: "Media",
    description: "YouTube, Vimeo or MP4",
    fields: [
      { key: "url", label: "Video URL", type: "url", help: "YouTube, Vimeo or a direct .mp4 link" },
      { key: "title", label: "Accessible title", type: "text" },
      { key: "autoplay", label: "Autoplay (muted)", type: "boolean" },
    ],
    defaults: { url: "", title: "Video" },
  },
  {
    type: "accordion",
    name: "Accordion",
    icon: "ListCollapse",
    category: "Interactive",
    description: "Expandable FAQ list",
    fields: [
      {
        key: "items",
        label: "Items",
        type: "list",
        fields: [
          { key: "title", label: "Question", type: "text" },
          { key: "body", label: "Answer", type: "textarea" },
        ],
      },
      { key: "openFirst", label: "Open first item", type: "boolean" },
    ],
    defaults: {
      openFirst: true,
      items: [
        { title: "How do I edit this page?", body: "Click any block in the page editor and change it in the panel on the right." },
        { title: "Can I add my own code?", body: "Yes. Use the Code block, page settings or the Code Studio." },
      ],
    },
  },
  {
    type: "tabs",
    name: "Tabs",
    icon: "PanelsTopLeft",
    category: "Interactive",
    description: "Content in switchable tabs",
    fields: [
      {
        key: "items",
        label: "Tabs",
        type: "list",
        fields: [
          { key: "title", label: "Tab label", type: "text" },
          { key: "body", label: "Content", type: "textarea" },
        ],
      },
    ],
    defaults: {
      items: [
        { title: "Overview", body: "Overview content." },
        { title: "Details", body: "More detailed content." },
      ],
    },
  },
  {
    type: "contentList",
    name: "Content list",
    icon: "Newspaper",
    category: "Content",
    description: "News, events or any content type",
    fields: [
      { key: "contentType", label: "Content type", type: "reference", refType: "__types" },
      { key: "limit", label: "Number of items", type: "number", min: 1, max: 100 },
      {
        key: "layout",
        label: "Layout",
        type: "select",
        options: [
          { value: "grid", label: "Card grid" },
          { value: "list", label: "List" },
          { value: "compact", label: "Compact links" },
          { value: "custom", label: "Custom template" },
        ],
      },
      {
        key: "columns",
        label: "Columns (grid)",
        type: "select",
        options: [
          { value: "2", label: "2" },
          { value: "3", label: "3" },
          { value: "4", label: "4" },
        ],
      },
      {
        key: "sort",
        label: "Sort by",
        type: "select",
        options: [
          { value: "newest", label: "Newest first" },
          { value: "oldest", label: "Oldest first" },
          { value: "title", label: "Title A-Z" },
          { value: "manual", label: "Manual order" },
        ],
      },
      { key: "tag", label: "Only with tag", type: "text" },
      { key: "category", label: "Only in category", type: "text" },
      { key: "showImage", label: "Show image", type: "boolean" },
      { key: "showDate", label: "Show date", type: "boolean" },
      { key: "showSummary", label: "Show summary", type: "boolean" },
      { key: "paginate", label: "Pagination", type: "boolean" },
      {
        key: "template",
        label: "Custom Liquid template",
        type: "code",
        language: "liquid",
        group: "advanced",
        help: "Used when layout is 'Custom template'. Loop over {{ items }}.",
      },
    ],
    defaults: {
      contentType: "news",
      limit: 6,
      layout: "grid",
      columns: "3",
      sort: "newest",
      showImage: true,
      showDate: true,
      showSummary: true,
      paginate: false,
      template:
        '<ul class="my-list">\n{% for item in items %}\n  <li><a href="{{ item.url }}">{{ item.title }}</a></li>\n{% endfor %}\n</ul>',
    },
  },
  {
    type: "form",
    name: "Form",
    icon: "ClipboardList",
    category: "Interactive",
    description: "Embed a form from Forms",
    fields: [
      { key: "formKey", label: "Form", type: "reference", refType: "__forms" },
      { key: "title", label: "Title above form", type: "text" },
    ],
    defaults: { formKey: "contact", title: "" },
  },
  {
    type: "map",
    name: "Map",
    icon: "MapPin",
    category: "Media",
    description: "Embedded map for an address",
    fields: [
      { key: "address", label: "Address or place", type: "text" },
      { key: "height", label: "Height (px)", type: "number", min: 150, max: 900 },
    ],
    defaults: { address: "Suva, Fiji", height: 360 },
  },
  {
    type: "spacer",
    name: "Spacer",
    icon: "MoveVertical",
    category: "Layout",
    description: "Vertical whitespace",
    fields: [{ key: "height", label: "Height (px)", type: "number", min: 0, max: 400 }],
    defaults: { height: 48 },
  },
  {
    type: "divider",
    name: "Divider",
    icon: "Minus",
    category: "Layout",
    description: "Horizontal line",
    fields: [
      {
        key: "style",
        label: "Style",
        type: "select",
        options: [
          { value: "solid", label: "Solid" },
          { value: "dashed", label: "Dashed" },
          { value: "dotted", label: "Dotted" },
        ],
      },
    ],
    defaults: { style: "solid" },
  },
  {
    type: "navigation",
    name: "Navigation",
    icon: "Menu",
    category: "Content",
    description: "Menu built from your page tree",
    fields: [
      {
        key: "source",
        label: "Pages",
        type: "select",
        options: [
          { value: "top", label: "Top-level pages" },
          { value: "children", label: "Children of this page" },
          { value: "siblings", label: "Siblings of this page" },
        ],
      },
      {
        key: "direction",
        label: "Direction",
        type: "select",
        options: [
          { value: "horizontal", label: "Horizontal" },
          { value: "vertical", label: "Vertical" },
        ],
      },
    ],
    defaults: { source: "top", direction: "horizontal" },
  },
  {
    type: "react",
    name: "React block",
    icon: "Atom",
    category: "Developer",
    description: "A React component written in JSX",
    fields: [
      {
        key: "code",
        label: "Component (JSX)",
        type: "code",
        language: "jsx",
        help: "Default-export a React component. Import npm packages by name, e.g. import confetti from \"canvas-confetti\".",
      },
      { key: "props", label: "Props (JSON)", type: "code", language: "json", help: "Passed to your component." },
      { key: "css", label: "CSS", type: "code", language: "css" },
    ],
    defaults: {
      code: `import { useState } from "react";

export default function Counter({ label = "Clicks" }) {
  const [count, setCount] = useState(0);
  return (
    <div className="react-demo">
      <strong>{label}: {count}</strong>
      <button onClick={() => setCount(count + 1)}>Add one</button>
    </div>
  );
}
`,
      props: `{
  "label": "Clicks"
}`,
      css: `.react-demo {
  display: flex;
  gap: 16px;
  align-items: center;
  padding: 20px 24px;
  border-radius: 14px;
  background: #f1f5f9;
}
.react-demo button {
  padding: 8px 16px;
  border-radius: 999px;
  border: 0;
  background: var(--rf-primary);
  color: #fff;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}`,
    },
  },
  {
    type: "search",
    name: "Search",
    icon: "Search",
    category: "Interactive",
    description: "Search box with results from pages and content",
    fields: [
      { key: "placeholder", label: "Placeholder", type: "text" },
      { key: "buttonLabel", label: "Button label", type: "text" },
      { key: "limit", label: "Results to show", type: "number", min: 1, max: 50 },
    ],
    defaults: { placeholder: "Search the site", buttonLabel: "Search", limit: 10 },
  },
  {
    type: "html",
    name: "Code block",
    icon: "CodeXml",
    category: "Developer",
    description: "Raw HTML, CSS and JavaScript",
    fields: [
      { key: "html", label: "HTML (Liquid allowed)", type: "code", language: "liquid" },
      { key: "css", label: "CSS", type: "code", language: "css" },
      { key: "js", label: "JavaScript", type: "code", language: "javascript", help: "Runs on the live site after the page loads." },
    ],
    defaults: {
      html: '<div class="hello-box">\n  <strong>Hello from code</strong>\n  <p>Today is {{ "now" | date: "%A, %B %e" }}.</p>\n</div>',
      css: ".hello-box {\n  padding: 24px;\n  border-radius: 14px;\n  background: linear-gradient(135deg, #eef2ff, #fdf2f8);\n}",
      js: "",
    },
  },
];

export function getWidgetDef(type: string): WidgetDef | undefined {
  return BUILTIN_WIDGETS.find((w) => w.type === type);
}

let counter = 0;
export function uid(prefix = "n"): string {
  counter = (counter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}${counter.toString(36)}`;
}

export function makeWidget(type: string, defaults: Record<string, any> = {}): WidgetNode {
  return { id: uid("w"), type, props: structuredClone(defaults) };
}

export function makeSection(widths: number[] = [12], widgets: WidgetNode[][] = []): SectionNode {
  return {
    id: uid("s"),
    props: { ...SECTION_DEFAULTS },
    columns: widths.map(
      (width, i): ColumnNode => ({ id: uid("c"), width, props: {}, widgets: widgets[i] ?? [] }),
    ),
  };
}

/** Deep copy with fresh ids, used for duplicate/paste. */
export function cloneWithNewIds<T extends SectionNode | WidgetNode | ColumnNode>(node: T): T {
  const copy: any = structuredClone(node);
  const walk = (n: any) => {
    if (n.columns) {
      n.id = uid("s");
      n.columns.forEach(walk);
    } else if (n.widgets) {
      n.id = uid("c");
      n.widgets.forEach(walk);
    } else {
      n.id = uid("w");
    }
  };
  walk(copy);
  return copy;
}
