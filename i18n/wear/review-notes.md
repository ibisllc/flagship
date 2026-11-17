# Wear OS strings that need a native reader

Added with the Wear OS quality fixes (WO-V9, WO-V10; 0.4). Machine drafts. The tile, complication and app now
take every text from the watch's own resources, in the watch's language (the phone sends only data).

- The complication's text (`watch_servers_up`, `watch_waiting`, `watch_open_phone_short`, `watch_no_servers` and
  the `watch_phase_short_*` words) shows about 7 characters on most watch faces. Shorten anything that reads badly
  when cut there; the tile has room for two lines of the same words.
- `watch_open_flagship_on_your_phone` (tile) and `watch_open_phone_short` (complication): what to do when the watch
  has nothing from the phone yet. An instruction, the same informal or formal "you" as the rest of the app.
- `watch_servers_up` ("2/3 up"): "up" means online. de keeps "online", ja 稼働, zh 在线; check they read as a count
  of servers that are running.
- `watch_waiting` is a plural ("1 waiting" / "2 waiting": servers waiting for a start-up approval). de changes the
  verb (wartet / warten); ja and zh use one form.
- `watch_phase_short_installed` ("Unplug"): the install finished and the USB stick can come out. An imperative.
- `watch_event_*`: the same account events the phone app lists; most reuse the phone app's translations
  (`i18n/android`). `watch_event_recovery_set_up` is a past event ("Set up recovery" = recovery was set up), not
  the imperative the phone's button uses.
- `watch_leader_name`: "Leader" is the server that leads the others, not a person; the drafts match the app's own `leader` label.
