// Rich text from the editor (Text blocks, rich text content fields) is HTML that anyone with
// page or content editing rights can send to the API directly. It's cleaned to what the rich
// text editor itself produces, so it can't carry scripts, event handlers or javascript: links.
import sanitizeHtml from "sanitize-html";

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "code",
    "strong", "b", "em", "i", "u", "s", "strike", "del", "ins", "mark", "sub", "sup", "small", "span",
    "ul", "ol", "li", "a", "img", "figure", "figcaption",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
  ],
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "title", "width", "height", "loading"],
    th: ["colspan", "rowspan", "scope"],
    td: ["colspan", "rowspan"],
    ol: ["start", "type"],
    "*": ["class", "id"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https", "data"] },
  allowProtocolRelative: false,
  transformTags: {
    // a link opening a new tab mustn't get a handle on this one
    a: (tagName, attribs) => (attribs.target === "_blank" ? { tagName, attribs: { ...attribs, rel: "noopener noreferrer" } } : { tagName, attribs }),
  },
};

export function sanitizeRichText(html: unknown): string {
  if (html === null || html === undefined || html === "") return "";
  return sanitizeHtml(String(html), OPTIONS);
}
