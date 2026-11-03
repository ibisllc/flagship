// The App Store and Google Play listings live here and nowhere else: the
// homepage and the open-in-app page (/open/) both render their store buttons
// from this file, so the two can never disagree. A null url leaves the
// button as an inert placeholder showing the store name.
//
// STUDIO_EXPERIMENTAL is the one switch per desktop platform for the
// "Experimental" tag on the Flagship Studio downloads: every page, in every
// language, marks the tag with data-studio-experimental="<platform>", and a
// platform set to false here loses it everywhere. The tag stays in the HTML
// (shown without JavaScript), so a platform is only ever un-tagged on purpose.
(function () {
  "use strict";
  const STUDIO_EXPERIMENTAL = {
    mac: false,
    windows: true,
    linux: true,
  };
  document.querySelectorAll("[data-studio-experimental]").forEach((el) => {
    if (STUDIO_EXPERIMENTAL[el.getAttribute("data-studio-experimental")] === false) el.remove();
  });
})();
(function () {
  "use strict";
  const STORES = {
    ios: { url: "https://apps.apple.com/app/id6768945985", label: "App Store", aria: "Download Flagship on the App Store" },
    android: { url: "https://play.google.com/store/apps/details?id=com.flagshipserver.app", label: "Google Play", aria: "Get Flagship on Google Play" },
  };
  const PENDING_CLASSES = ["btn--pending", "pending"];

  document.querySelectorAll("[data-app-store]").forEach((el) => {
    const store = STORES[el.getAttribute("data-app-store")];
    if (!store || !store.url) return;
    const a = document.createElement("a");
    a.className = el.className;
    PENDING_CLASSES.forEach((c) => a.classList.remove(c));
    a.href = store.url;
    a.rel = "noopener";
    // A page's own title is in its language (scripts/i18n-web.mjs); store.aria is the English fallback.
    const title = el.getAttribute("title");
    if (title) a.title = title;
    a.setAttribute("aria-label", title || store.aria);
    a.setAttribute("data-app-store", el.getAttribute("data-app-store"));
    while (el.firstChild) a.appendChild(el.firstChild);
    const label = a.querySelector("[data-app-store-label]");
    if (label) label.textContent = store.label;
    el.replaceWith(a);
  });
})();
