// "Add a server first": what Services and Activity show while the account has
// no server. One card for both pages, as iOS (ServicesTab / ActivityScreen,
// `NoServerYetCard`) and Android (ServicesListScreen / ActivityScreen,
// `NoServerYetState`) show one.

import { serverIcon } from "./icons.js";
import { tr } from "./i18n.js";

export function noServerCardHtml() {
  return `
    <div class="card empty-state no-server-card" data-no-server>
      <span class="icon empty-icon" aria-hidden="true">${serverIcon}</span>
      <h3 class="empty-headline">${tr("Add a server first")}</h3>
      <p class="note empty-message">${tr("Services run on your own server. Add one to start building.")}</p>
    </div>`;
}
