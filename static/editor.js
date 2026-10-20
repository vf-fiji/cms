// Runs inside the page-editor canvas iframe. Talks to the admin via postMessage.
(function () {
  "use strict";
  var parentWin = window.parent;
  var names = {};
  var selectedId = null;
  var editingInline = null;
  var pendingScroll = false;
  function scrollToSelected() {
    var el = selectedId && nodeEl(selectedId);
    if (el) setTimeout(function () { el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, 60);
  }
  var indicator = document.createElement("div");
  indicator.className = "rfe-indicator";
  var REEF_TYPES = ["application/x-reef-widget", "application/x-reef-layout", "application/x-reef-move", "application/x-reef-section"];

  // The canvas is loaded via srcdoc, so its origin may be opaque; the parent verifies e.source instead.
  function post(msg) { parentWin.postMessage(Object.assign({ source: "reef-canvas" }, msg), "*"); }
  function root() { return document.getElementById("reef-content"); }

  function decorate() {
    document.querySelectorAll("[data-rf-widget]").forEach(function (el) {
      el.setAttribute("data-rf-label", names[el.getAttribute("data-rf-type")] || el.getAttribute("data-rf-type"));
    });
    document.querySelectorAll("[data-rf-section]").forEach(function (el, i) {
      el.setAttribute("data-rf-label", "Section " + (i + 1));
    });
    applySelection();
  }

  function nodeEl(id) {
    return document.querySelector('[data-rf-widget="' + id + '"],[data-rf-section="' + id + '"],[data-rf-column="' + id + '"]');
  }

  function applySelection() {
    document.querySelectorAll(".rfe-selected").forEach(function (n) { n.classList.remove("rfe-selected"); });
    document.querySelectorAll(".rfe-toolbar").forEach(function (n) { n.remove(); });
    if (!selectedId) return;
    var el = nodeEl(selectedId);
    if (!el) return;
    el.classList.add("rfe-selected");
    var kind = el.hasAttribute("data-rf-widget") ? "widget" : el.hasAttribute("data-rf-section") ? "section" : "column";
    if (kind === "column") return;
    var bar = document.createElement("div");
    bar.className = "rfe-toolbar rfe-toolbar-" + kind;
    bar.setAttribute("contenteditable", "false");
    var label = kind === "widget" ? names[el.getAttribute("data-rf-type")] || "Widget" : el.getAttribute("data-rf-label");
    bar.innerHTML =
      '<span class="rfe-handle" draggable="true" title="Drag to move">' + icon("grip") + "</span>" +
      '<span class="rfe-name">' + escapeHtml(label) + "</span>" +
      btn("up", "Move up", "up") + btn("down", "Move down", "down") + btn("duplicate", "Duplicate", "copy") + btn("delete", "Delete", "trash");
    el.appendChild(bar);
    var handle = bar.querySelector(".rfe-handle");
    handle.addEventListener("dragstart", function (e) {
      e.stopPropagation();
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(kind === "widget" ? "application/x-reef-move" : "application/x-reef-section", selectedId);
      e.dataTransfer.setData("text/plain", selectedId);
      document.body.classList.add("rfe-dragging");
      try { e.dataTransfer.setDragImage(el, 20, 20); } catch (_) {}
    });
    handle.addEventListener("dragend", function () { document.body.classList.remove("rfe-dragging"); hideIndicator(); });
  }

  function btn(action, title, ic) {
    return '<button type="button" data-action="' + action + '" title="' + title + '" aria-label="' + title + '">' + icon(ic) + "</button>";
  }
  function icon(name) {
    var p = {
      grip: '<circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/>',
      up: '<path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
      down: '<path d="M12 5v14M19 12l-7 7-7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
      copy: '<rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
      trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    }[name];
    return '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">' + p + "</svg>";
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // ---------- selection & hover ----------
  document.addEventListener("click", function (e) {
    var actionBtn = e.target.closest(".rfe-toolbar button[data-action]");
    if (actionBtn) {
      e.preventDefault();
      e.stopPropagation();
      post({ type: "action", action: actionBtn.dataset.action, id: selectedId });
      return;
    }
    if (editingInline && editingInline.contains(e.target)) return;
    e.preventDefault();
    var w = e.target.closest("[data-rf-widget]");
    var c = e.target.closest("[data-rf-column]");
    var s = e.target.closest("[data-rf-section]");
    var target = w || (c && c.querySelector(".rfe-empty-col") ? c : null) || s;
    if (!target) { selectedId = null; applySelection(); post({ type: "select", id: null }); return; }
    var id = target.getAttribute("data-rf-widget") || target.getAttribute("data-rf-column") || target.getAttribute("data-rf-section");
    var kind = target.hasAttribute("data-rf-widget") ? "widget" : target.hasAttribute("data-rf-column") ? "column" : "section";
    selectedId = id;
    applySelection();
    post({ type: "select", id: id, kind: kind });
  }, true);

  document.addEventListener("mouseover", function (e) {
    var el = e.target.closest("[data-rf-widget],[data-rf-section]");
    document.querySelectorAll(".rfe-hover").forEach(function (n) { if (n !== el) n.classList.remove("rfe-hover"); });
    if (el) el.classList.add("rfe-hover");
  });
  document.addEventListener("mouseleave", function () {
    document.querySelectorAll(".rfe-hover").forEach(function (n) { n.classList.remove("rfe-hover"); });
  });
  document.addEventListener("submit", function (e) { e.preventDefault(); }, true);

  // ---------- inline editing ----------
  document.addEventListener("dblclick", function (e) {
    var el = e.target.closest("[data-rf-inline]");
    if (!el) return;
    var w = el.closest("[data-rf-widget]");
    if (!w) return;
    startInline(el, w.getAttribute("data-rf-widget"));
  });

  function startInline(el, widgetId) {
    if (editingInline) editingInline.blur();
    editingInline = el;
    var field = el.getAttribute("data-rf-inline");
    el.contentEditable = field === "text" ? "plaintext-only" : "true";
    if (el.contentEditable !== "plaintext-only" && field === "text") el.contentEditable = "true";
    el.classList.add("rfe-inline-editing");
    el.focus();
    var range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    post({ type: "inline-start", id: widgetId });
    function finish() {
      el.removeEventListener("blur", finish);
      el.removeEventListener("keydown", onKey);
      el.contentEditable = "false";
      el.classList.remove("rfe-inline-editing");
      editingInline = null;
      var value = field === "text" ? el.textContent.replace(/\s+/g, " ").trim() : el.innerHTML;
      post({ type: "inline", id: widgetId, field: field, value: value });
    }
    function onKey(ev) {
      if (ev.key === "Escape" || (ev.key === "Enter" && field === "text")) { ev.preventDefault(); el.blur(); }
      ev.stopPropagation();
    }
    el.addEventListener("blur", finish);
    el.addEventListener("keydown", onKey);
  }

  // ---------- drag & drop ----------
  function reefType(dt) {
    var types = Array.prototype.slice.call(dt.types || []);
    for (var i = 0; i < REEF_TYPES.length; i++) if (types.indexOf(REEF_TYPES[i]) !== -1) return REEF_TYPES[i];
    return null;
  }
  function hideIndicator() { if (indicator.parentNode) indicator.parentNode.removeChild(indicator); }

  function placeIndicator(rect, vertical) {
    if (!indicator.parentNode) document.body.appendChild(indicator);
    indicator.className = "rfe-indicator" + (vertical ? " rfe-indicator-section" : "");
    indicator.style.top = rect.top + window.scrollY - 2 + "px";
    indicator.style.left = rect.left + window.scrollX + "px";
    indicator.style.width = rect.width + "px";
  }

  // Returns {columnId, index, rect} for widget drops.
  function widgetTarget(e) {
    var col = e.target.closest && e.target.closest("[data-rf-column]");
    if (!col) return null;
    var widgets = Array.prototype.filter.call(col.children, function (n) { return n.hasAttribute("data-rf-widget"); });
    var index = widgets.length;
    for (var i = 0; i < widgets.length; i++) {
      var r = widgets[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { index = i; break; }
    }
    var cr = col.getBoundingClientRect();
    var y;
    if (!widgets.length) y = cr.top + cr.height / 2;
    else if (index < widgets.length) y = widgets[index].getBoundingClientRect().top - 6;
    else y = widgets[widgets.length - 1].getBoundingClientRect().bottom + 6;
    return { columnId: col.getAttribute("data-rf-column"), index: index, rect: { top: y, left: cr.left, width: cr.width } };
  }

  // Returns {sectionIndex, rect} for section-level drops.
  function sectionTarget(e) {
    var sections = Array.prototype.slice.call(document.querySelectorAll("[data-rf-section]"));
    var r0 = root().getBoundingClientRect();
    if (!sections.length) return { sectionIndex: 0, rect: { top: r0.top + 40, left: r0.left + 24, width: r0.width - 48 } };
    var index = sections.length;
    for (var i = 0; i < sections.length; i++) {
      var r = sections[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { index = i; break; }
    }
    var y = index < sections.length ? sections[index].getBoundingClientRect().top : sections[sections.length - 1].getBoundingClientRect().bottom;
    return { sectionIndex: index, rect: { top: y, left: r0.left, width: r0.width } };
  }

  document.addEventListener("dragover", function (e) {
    var t = reefType(e.dataTransfer);
    if (!t) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = t === "application/x-reef-move" || t === "application/x-reef-section" ? "move" : "copy";
    if (t === "application/x-reef-widget" || t === "application/x-reef-move") {
      var wt = widgetTarget(e);
      if (wt) return placeIndicator(wt.rect, false);
    }
    placeIndicator(sectionTarget(e).rect, true);
  });
  document.addEventListener("dragleave", function (e) { if (!e.relatedTarget) hideIndicator(); });
  document.addEventListener("drop", function (e) {
    var t = reefType(e.dataTransfer);
    hideIndicator();
    document.body.classList.remove("rfe-dragging");
    if (!t) return;
    e.preventDefault();
    var payload = e.dataTransfer.getData(t);
    var wt = (t === "application/x-reef-widget" || t === "application/x-reef-move") ? widgetTarget(e) : null;
    var st = sectionTarget(e);
    post({
      type: "drop",
      kind: { "application/x-reef-widget": "new-widget", "application/x-reef-layout": "new-section", "application/x-reef-move": "move-widget", "application/x-reef-section": "move-section" }[t],
      payload: payload,
      columnId: wt ? wt.columnId : null,
      index: wt ? wt.index : null,
      sectionIndex: st.sectionIndex,
    });
  });

  // ---------- keyboard shortcuts forwarded to the editor ----------
  document.addEventListener("keydown", function (e) {
    if (editingInline) return;
    var mod = e.ctrlKey || e.metaKey;
    if ((mod && ["z", "y", "s", "d", "c", "v"].indexOf(e.key.toLowerCase()) !== -1) || e.key === "Delete" || e.key === "Backspace" || e.key === "Escape") {
      e.preventDefault();
      post({ type: "key", key: e.key, ctrl: mod, shift: e.shiftKey });
    }
  });

  // ---------- messages from the editor ----------
  window.addEventListener("message", function (e) {
    if (e.source !== parentWin || !e.data || e.data.source !== "reef-editor") return;
    var m = e.data;
    if (m.type === "init") { names = m.names || {}; decorate(); }
    if (m.type === "select") {
      selectedId = m.id;
      applySelection();
      if (m.scroll && selectedId) {
        // a just-added block may not be rendered yet; scroll once it arrives
        if (nodeEl(selectedId)) scrollToSelected();
        else pendingScroll = true;
      }
    }
    if (m.type === "update" && !editingInline) {
      var doc = new DOMParser().parseFromString(m.html, "text/html");
      var next = doc.getElementById("reef-content");
      if (next) root().innerHTML = next.innerHTML;
      // refresh widget/page styles that live in <head>
      document.querySelectorAll("style[data-widget],style[data-page-css],style[data-template],style[data-tailwind]").forEach(function (n) { n.remove(); });
      doc.querySelectorAll("style[data-tailwind],style[data-widget],style[data-page-css],style[data-template]").forEach(function (n) { document.head.appendChild(n); });
      // (re)run React mount scripts that are new or whose code changed
      doc.querySelectorAll("script[data-reef-mount]").forEach(function (n) {
        var id = n.getAttribute("data-reef-mount");
        var current = document.querySelector('script[data-reef-mount="' + id + '"]');
        if (current && current.textContent === n.textContent) return;
        if (current) current.remove();
        var s = document.createElement("script");
        s.type = "module";
        s.setAttribute("data-reef-mount", id);
        s.textContent = n.textContent;
        document.body.appendChild(s);
      });
      document.dispatchEvent(new CustomEvent("reef:rendered"));
      decorate();
      if (pendingScroll && selectedId && nodeEl(selectedId)) { pendingScroll = false; scrollToSelected(); }
    }
  });

  decorate();
  post({ type: "ready" });
})();
