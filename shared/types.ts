// Types shared by the server and the admin app.

export type FieldType =
  | "text"
  | "textarea"
  | "richtext"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "select"
  | "multiselect"
  | "image"
  | "gallery"
  | "file"
  | "url"
  | "email"
  | "color"
  | "code"
  | "reference"
  | "tags"
  | "list";

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  help?: string;
  placeholder?: string;
  default?: unknown;
  /** select / multiselect options */
  options?: { value: string; label: string }[];
  /** code fields */
  language?: "html" | "css" | "javascript" | "jsx" | "liquid" | "json";
  /** reference fields: content type key */
  refType?: string;
  /** list (repeater) fields */
  fields?: FieldDef[];
  /** show only in the "Style" tab of the widget inspector */
  group?: "content" | "style" | "advanced";
  min?: number;
  max?: number;
}

export interface WidgetNode {
  id: string;
  type: string;
  props: Record<string, any>;
}

export interface ColumnNode {
  id: string;
  width: number; // out of 12
  props: Record<string, any>;
  widgets: WidgetNode[];
}

export interface SectionNode {
  id: string;
  props: Record<string, any>;
  columns: ColumnNode[];
}

export interface PageLayout {
  sections: SectionNode[];
}

export interface PageSeo {
  metaTitle?: string;
  metaDescription?: string;
  ogImage?: string;
  noIndex?: boolean;
  canonical?: string;
}

export interface Page {
  id: number;
  parentId: number | null;
  title: string;
  slug: string;
  path: string;
  sort: number;
  templateId: number | null;
  status: "draft" | "published" | "review" | "scheduled";
  hasUnpublishedChanges: boolean;
  showInNav: boolean;
  isHome: boolean;
  seo: PageSeo;
  layout: PageLayout;
  customCss: string;
  customJs: string;
  customHead: string;
  publishAt: string | null;
  publishedAt: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface ContentType {
  id: number;
  key: string;
  name: string;
  singular: string;
  icon: string;
  color: string;
  description: string;
  fields: FieldDef[];
  urlPrefix: string;
  hasDetailPages: boolean;
  detailTemplate: string;
  listTemplate: string;
  sort: number;
  itemCount?: number;
}

export interface ContentItem {
  id: number;
  typeId: number;
  title: string;
  slug: string;
  data: Record<string, any>;
  status: "draft" | "published" | "review" | "scheduled";
  tags: string[];
  categories: string[];
  publishAt: string | null;
  publishedAt: string | null;
  sort: number;
  createdAt: string;
  updatedAt: string;
  authorName?: string | null;
}

export interface MediaItem {
  id: number;
  folder: string;
  filename: string;
  originalName: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  alt: string;
  title: string;
  url: string;
  /** resized WebP copies, narrowest first */
  variants: { w: number; url: string }[];
  /** CSS position of the focal point, e.g. "30% 20%" ("" = centre) */
  focal: string;
  createdAt: string;
}

export interface FormField {
  id: string;
  key: string;
  label: string;
  type: "text" | "email" | "phone" | "textarea" | "number" | "select" | "radio" | "checkbox" | "date" | "consent" | "hidden" | "heading";
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: string[];
  width?: "full" | "half";
  defaultValue?: string;
}

export interface FormDef {
  id: number;
  key: string;
  name: string;
  fields: FormField[];
  settings: {
    submitLabel: string;
    successMessage: string;
    redirectUrl?: string;
    notifyEmail?: string;
    storeSubmissions: boolean;
  };
  submissionCount?: number;
  updatedAt: string;
}

export interface Template {
  id: number;
  name: string;
  html: string;
  css: string;
  js: string;
  head: string;
  isDefault: boolean;
  updatedAt: string;
}

export interface CustomWidget {
  id: number;
  key: string;
  name: string;
  icon: string;
  category: string;
  description: string;
  fields: FieldDef[];
  /** "liquid": template is Liquid HTML. "react": template is a JSX component (default export). */
  renderer: "liquid" | "react";
  /** React widgets only: render on the server for SEO, then hydrate. */
  ssr: boolean;
  template: string;
  css: string;
  js: string;
  updatedAt: string;
}

export interface CodeAsset {
  id: number;
  name: string;
  kind: "css" | "js" | "html";
  location: "head" | "body-end";
  content: string;
  enabled: boolean;
  sort: number;
  updatedAt: string;
}

export interface ServerFunction {
  id: number;
  name: string;
  kind: "endpoint" | "hook" | "schedule";
  route: string; // endpoint: /api/fn/<route>
  method: string; // endpoint: GET/POST/ANY
  event: string; // hook: content.beforeSave etc.
  intervalMinutes: number; // schedule
  code: string;
  enabled: boolean;
  isPublic: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  updatedAt: string;
}

export type Permission =
  | "pages.edit"
  | "pages.publish"
  | "content.edit"
  | "content.publish"
  | "content.types"
  | "media.manage"
  | "forms.manage"
  | "forms.submissions"
  | "templates.edit"
  | "code.edit"
  | "users.manage"
  | "settings.manage";

export const ALL_PERMISSIONS: { key: Permission; label: string; group: string }[] = [
  { key: "pages.edit", label: "Create and edit pages", group: "Pages" },
  { key: "pages.publish", label: "Publish pages", group: "Pages" },
  { key: "content.edit", label: "Create and edit content", group: "Content" },
  { key: "content.publish", label: "Publish content", group: "Content" },
  { key: "content.types", label: "Design content types", group: "Content" },
  { key: "media.manage", label: "Upload and manage media", group: "Media" },
  { key: "forms.manage", label: "Build forms", group: "Forms" },
  { key: "forms.submissions", label: "View form responses", group: "Forms" },
  { key: "templates.edit", label: "Edit templates", group: "Developer" },
  { key: "code.edit", label: "Edit code, widgets and server functions", group: "Developer" },
  { key: "users.manage", label: "Manage users and roles", group: "Administration" },
  { key: "settings.manage", label: "Manage site settings", group: "Administration" },
];

export interface Role {
  id: number;
  name: string;
  description: string;
  permissions: Permission[];
  isSystem: boolean;
  userCount?: number;
}

export interface User {
  id: number;
  email: string;
  name: string;
  roleId: number;
  roleName?: string;
  permissions?: Permission[];
  active: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface SiteSettings {
  siteName: string;
  tagline: string;
  logo: string;
  favicon: string;
  primaryColor: string;
  accentColor: string;
  footerText: string;
  robotsTxt: string;
  sitemapEnabled: boolean;
  headlessApiEnabled: boolean;
  defaultMetaDescription: string;
  socialLinks: { label: string; url: string }[];
  analyticsHead: string;
  /** compile Tailwind utilities for classes used on each page */
  tailwindEnabled: boolean;
  /** include Tailwind's Preflight reset (off by default: it changes Reef's base styles) */
  tailwindPreflight: boolean;
  /** extra Tailwind input: @theme, @utility, @custom-variant … */
  tailwindCss: string;
}

export interface Redirect {
  id: number;
  fromPath: string;
  toPath: string;
  code: number;
  hits: number;
}

export interface Revision {
  id: number;
  entity: string;
  entityId: number;
  note: string;
  userName: string | null;
  createdAt: string;
}

export interface Activity {
  id: number;
  userName: string | null;
  action: string;
  entity: string;
  entityId: number | null;
  label: string;
  createdAt: string;
}

export interface SiteGraphNode {
  id: string;
  kind: "home" | "page" | "type" | "item" | "form";
  label: string;
  path?: string;
  status: string;
  /** visible to the public right now */
  live: boolean;
  changesPending?: boolean;
  /** page views over the last 30 days (pages only) */
  views?: number;
  /** widgets on a page, items in a type, responses to a form */
  size?: number;
  depth: number;
  /** admin route for this node */
  href: string;
  color?: string;
  parent?: string;
}

export interface SiteGraphEdge {
  source: string;
  target: string;
  kind: "child" | "link" | "lists" | "item" | "form";
}

export interface SiteGraph {
  nodes: SiteGraphNode[];
  edges: SiteGraphEdge[];
  stats: { pages: number; types: number; items: number; forms: number; links: number; totalItems: number };
}
