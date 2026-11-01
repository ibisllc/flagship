// Fills /security/runtime.html from /api/runtime/manifest. Values only: every sentence is in the page.
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var NAMES = { "linux-amd64": "Linux x86-64", "linux-arm64": "Linux ARM64" };
  function cell(text, code) {
    var td = document.createElement("td");
    if (code) { var c = document.createElement("code"); c.textContent = text; td.appendChild(c); } else td.textContent = text;
    td.className = "hash";
    return td;
  }
  fetch("/api/runtime/manifest", { cache: "no-cache" }).then(function (res) {
    $("rt-loading").hidden = true;
    if (res.status === 204) { $("rt-none").hidden = false; return null; }
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  }).then(function (doc) {
    if (!doc) return;
    var m = doc.manifest, lock = JSON.parse(doc.lockJson);
    var values = {
      version: m.version, release: m.release, securityFloor: m.securityFloor, sequence: String(m.sequence),
      validUntil: new Date(m.validUntil).toISOString().slice(0, 10), lockSha256: m.lockSha256,
      signer: ((lock.keyring && lock.keyring.signers) || []).map(function (s) { return s.fingerprint.toUpperCase(); }).join(", "),
    };
    Array.prototype.forEach.call(document.querySelectorAll("[data-field]"), function (el) { el.textContent = values[el.getAttribute("data-field")] || ""; });
    var body = $("rt-targets").querySelector("tbody");
    Object.keys(lock.targets).sort().forEach(function (name) {
      var t = lock.targets[name], tr = document.createElement("tr");
      tr.appendChild(cell(NAMES[name] || name, false));
      var a = document.createElement("td"), link = document.createElement("a");
      link.href = lock.upstream.base + t.file; link.textContent = t.file;
      var sum = document.createElement("code"); sum.textContent = t.sha256;
      a.appendChild(link); a.appendChild(document.createElement("br")); a.appendChild(sum); a.className = "hash";
      tr.appendChild(a);
      tr.appendChild(cell(t.executableSha256, true));
      body.appendChild(tr);
    });
    var amd = lock.targets["linux-amd64"];
    if (amd) {
      $("rt-cmd-upstream").textContent = [
        "curl -fsSLO " + lock.upstream.base + amd.file,
        "curl -fsSLO " + lock.upstream.base + lock.upstream.shasums,
        "curl -fsSLO " + lock.upstream.base + lock.upstream.shasumsSignature,
        "gpg --verify " + lock.upstream.shasumsSignature + " " + lock.upstream.shasums,
        "grep ' " + amd.file + "$' " + lock.upstream.shasums,
        "sha256sum " + amd.file,
      ].join("\n");
    }
    $("rt-table").hidden = false;
    $("rt-targets").hidden = false;
  }).catch(function () {
    $("rt-loading").hidden = true;
    $("rt-error").hidden = false;
  });
})();
