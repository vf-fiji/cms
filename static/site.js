// Reef CMS site runtime: forms, tabs and lightbox. No dependencies.
(function () {
  "use strict";

  // ---------- forms ----------
  document.addEventListener("submit", async function (e) {
    var form = e.target.closest && e.target.closest("form[data-rf-form]");
    if (!form || document.body.classList.contains("rf-editing")) return;
    e.preventDefault();
    var status = form.querySelector(".rf-form-status");
    var button = form.querySelector('button[type="submit"]');
    form.querySelectorAll(".rf-field-error").forEach(function (n) { n.remove(); });
    form.querySelectorAll("[aria-invalid]").forEach(function (n) { n.removeAttribute("aria-invalid"); });
    var data = {};
    new FormData(form).forEach(function (value, key) {
      if (key in data) data[key] = [].concat(data[key], value);
      else data[key] = value;
    });
    form.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
      if (cb.name && !(cb.name in data)) data[cb.name] = cb.closest("fieldset") ? [] : "";
    });
    button.disabled = true;
    var label = button.textContent;
    button.textContent = "Sending…";
    try {
      var res = await fetch(form.action, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(data) });
      var out = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        status.className = "rf-form-status is-error";
        status.textContent = out.error || "Something went wrong. Please try again.";
        if (out.fields) {
          Object.keys(out.fields).forEach(function (k) {
            var input = form.querySelector('[name="' + k + '"]');
            if (!input) return;
            input.setAttribute("aria-invalid", "true");
            var msg = document.createElement("span");
            msg.className = "rf-field-error";
            msg.textContent = out.fields[k];
            input.closest(".rf-field").appendChild(msg);
          });
        }
        return;
      }
      if (out.redirect) { window.location.href = out.redirect; return; }
      form.reset();
      status.className = "rf-form-status is-success";
      status.textContent = out.message || form.dataset.success;
    } catch (err) {
      status.className = "rf-form-status is-error";
      status.textContent = "We couldn't reach the server. Check your connection and try again.";
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  });

  // ---------- tabs ----------
  document.addEventListener("click", function (e) {
    var tab = e.target.closest && e.target.closest("[data-rf-tabs] [role=tab]");
    if (!tab) return;
    var root = tab.closest("[data-rf-tabs]");
    root.querySelectorAll("[role=tab]").forEach(function (t) { t.setAttribute("aria-selected", String(t === tab)); });
    root.querySelectorAll("[role=tabpanel]").forEach(function (p) { p.hidden = p.dataset.panel !== tab.dataset.tab; });
  });

  // ---------- lightbox ----------
  document.addEventListener("click", function (e) {
    var link = e.target.closest && e.target.closest("[data-rf-lightbox] a");
    if (!link || document.body.classList.contains("rf-editing")) return;
    e.preventDefault();
    var box = document.createElement("div");
    box.className = "rf-lightbox";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Image viewer");
    var img = document.createElement("img");
    img.src = link.getAttribute("href");
    img.alt = (link.querySelector("img") || {}).alt || "";
    box.appendChild(img);
    function close() { box.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(ev) { if (ev.key === "Escape") close(); }
    box.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    document.body.appendChild(box);
  });
})();
