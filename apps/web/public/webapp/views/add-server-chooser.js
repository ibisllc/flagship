// "Add a server" chooser. Adding a server is two genuinely different
// acts and the native apps distinguish them: PROVISION a brand-new box
// (mint a recipe → burn → boot) vs. PAIR an existing, already-running
// box (paste its address). The webapp used to jump straight into the
// create-server flow, leaving pod-pair.js reachable only from a Settings
// shortcut. This view is the fork the native apps already have.

import { $, registerView, show } from "../lib/router.js";

registerView("view-add-server-chooser");

export function initAddServerChooserView() {
  $("add-server-back")?.addEventListener("click", () => show("view-home"));
  $("add-server-provision")?.addEventListener("click", async () => {
    const { enterCreateServer } = await import("./create-server.js");
    await enterCreateServer();
  });
  $("add-server-pair")?.addEventListener("click", async () => {
    const { enterPodPair } = await import("./pod-pair.js");
    await enterPodPair();
  });
}

export function enterAddServerChooser() {
  show("view-add-server-chooser");
}
