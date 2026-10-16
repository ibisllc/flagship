// The webapp never runs inside another page's frame. Framed, its clicks could
// be steered by an overlay the user can't see (clickjacking). The Worker
// already refuses framing with CSP frame-ancestors and X-Frame-Options; this
// is the second guard, for a copy served without those headers. It is app.js's
// first import, so a throw here stops the app before anything else boots.

export function isFramed(win = globalThis) {
  try {
    return win.top !== win.self;
  } catch {
    // Reading a cross-origin top can throw: that is a frame too.
    return true;
  }
}

if (isFramed()) {
  const p = document.createElement("p");
  p.textContent = `Flagship can't open inside another page. Go to ${location.origin} directly.`;
  document.body.replaceChildren(p);
  throw new Error("Flagship refuses to run in a frame");
}
