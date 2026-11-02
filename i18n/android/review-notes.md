# Strings that need a native reader before a language ships

Added with the "ask the owner before a key-erasing sign-out" change. Machine drafts.

- `sign_out_of_flagship` (title) and `confirm_its_you` (subtitle) of the biometric / device PIN prompt shown before a sign-out from the lock screens. `confirm_its_you` uses the informal "you" form per language, like the other unlock text.

Added with the release/0.3 security strings (boot-service lock, recovery veto, publisher keys, security sliver). Machine drafts; these terms were new and are now used throughout, so check them once per language:

- "boot service" (servicio de arranque / service de démarrage / Boot-Dienst / serviço de inicialização / 起動サービス / 启动服务), "lock" and "remote lock", "resume" (reanudar / reprendre / fortsetzen / retomar / 再開 / 恢复), "publisher" (editor / éditeur / Herausgeber / editor / 発行元 / 发布者).
- "lease" in the dead-man lock (`DeadManViewModel`): concesión / bail / Freigabe / concessão / リース / 租约 — the weakest choice; it means a time-limited permission to unlock.
- `couldnt_lock_this_server_at_the`: says the restart was NOT sent; check it can't be read as "restarted anyway".

Added with voi.ci pages and Messages (release 0.3, H11; `voici_*` keys). Machine drafts; these three need a native reader before 0.3 ships (docs/voici-and-messages.md §11.5):

- `voici_warning`: the linkability warning (owner rule O1). It must say plainly that the page shares the username with the person's apps and servers, so they can be connected; not softened into "may".
- `voici_rules_body`: the page and message rules shown before a first publish and a first sign-in (store UGC requirement). Check the list of forbidden content reads as rules, not legal boilerplate.
- `voici_report_body` and `voici_signin_privacy`: that a report lets Flagship see which account sent the message. "Visitor" (`voici_visitor_name`: Besucher / Visitante / Visiteur / 訪問者 / Visitante / 访客) is the generated name; keep it neutral.
