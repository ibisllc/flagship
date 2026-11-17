# Google Play: fix the Wear OS listing rejection (2026-11-17)

Google Play rejected the Wear OS bundle **versionCode 1000011** (`com.flagshipserver.app`) under the Wear App Quality
Guidelines, requirement **WO-G2** (Play listing description): the description did not mention the **tile** or the
**complication**, though the watch app has both. Older versions stay live, so production is not affected.

## First: does resubmitting need a new bundle?

**No.** Only the listing text is at fault; the bundle itself was not faulted. Fix the description in every language,
then send the changes for review again from **Publishing overview**. Google's own text covers this: "If you made
changes to your app bundle, store listing, or APK, please … submit the update(s)". A store-listing change is enough.

Build and upload a new phone + Wear pair **only** if the Console will not let the rejected release go back to review
(for example it shows the release as rejected with no "Send for review", or Google's reply asks for a new bundle).
See "Only if a new bundle is needed" below.

## 1. Paste the new descriptions

The texts live in `store/listings/<lang>.json`, field `playstore.fullDescription` (branch `0.4/wear-listing`).
Each now has an "On your Wear OS watch" block naming the watch app, the **tile** and the **complication** and saying
what each shows. The short description is unchanged (Google only asked about the full description).

Copy one language's text to the clipboard (from the repo root):

```sh
node -e 'process.stdout.write(require("./store/listings/en.json").playstore.fullDescription)' | pbcopy
```

Swap `en` for the language below. In the Play Console: **Grow users → Store presence → Store listings → Default
store listing** (older consoles: **Main store listing**).

| Repo file | Play language | Where |
|---|---|---|
| `en.json` | English (United States) – en-US | Default language: the **Full description** field on the listing itself |
| `es.json` | Spanish (Spain) – es-ES | **Manage translations → Add/Edit your own translations** → es-ES → Full description |
| `fr.json` | French (France) – fr-FR | same, fr-FR |
| `de.json` | German – de-DE | same, de-DE |
| `pt-BR.json` | Portuguese (Brazil) – pt-BR | same, pt-BR |
| `ja.json` | Japanese – ja-JP | same, ja-JP |
| `zh-Hans.json` | Chinese (Simplified) – zh-CN | same, zh-CN |

If the listing has other translations (machine translations Google made, or es-419 and the like), open each one: a
Google-made translation of the old English text still lacks the tile and complication. Delete it or paste the
closest language above.

Every text is within Play's 4,000-character limit (`node scripts/store-assets/listings.mjs counts`; fr and de are at
about 3,995, so paste the whole field and do not add anything). Save each language.

## 2. Send it for review

1. **Publishing overview**: the listing changes appear under "Changes not yet sent for review". Click **Send N changes
   for review** (if Managed publishing is on, publish once approved).
2. If the rejected Wear release (1000011) is still in a track (Production, Open or Closed testing) and the overview
   offers to resubmit it with the listing, include it. If a **draft** release in any track holds 1000011 and the
   Console blocks the submission on it, discard that draft.
3. When approved, open each track that holds the release and make sure the rollout is at **100%**.

## 3. Fallback: opt out of Wear OS for now

If review keeps blocking the phone update on the Wear artifact: **Test and release → Advanced settings → Release
types** (form factors), **Wear OS → Opt out / Remove** temporarily. The phone app's updates then go out without the
watch; opt back in with the next Wear bundle. (Google's FAQ also allows replacing the Wear artifact with an empty
submission.)

## Only if a new bundle is needed

Version codes are burned by any upload. Read the highest in **App bundle explorer** (today at least 11 phone,
1000011 Wear). Set `androidVersionCode` in `release/version.json` to one above the phone's highest (e.g. 12; the Wear
build is that + 1,000,000, so 1000012), then:

```sh
node scripts/check-versions.mjs --write
cd apps/mobile/android
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
./gradlew :app:bundleRelease :wear:bundleRelease        # needs keystore/keystore.properties + the upload .jks
bash scripts/check-release-clean.sh app wear
```

(`bash scripts/release.sh --only android` does the same from a release worktree and links the upload key from the
main checkout.) Bundles: `app/build/outputs/bundle/release/*.aab` (phone) and
`wear/build/outputs/bundle/release/*.aab` (Wear). In **every** track that holds 1000011 (Closed, Open, Production):
create a release, add both AABs (the Wear one under the Wear OS form factor), so 1000011 moves to "Not included";
discard any draft holding 1000011; review and roll out at 100%.

## What a reviewer may hit next (Wear quality checklist, checked 2026-11-17)

- **WO-V10 tile preview:** the tile's preview (`androidx.wear.tiles.PREVIEW` in `wear/src/main/AndroidManifest.xml`)
  is the launcher icon, not a picture of the tile. Needs a real preview image of the tile: next Wear bundle.
- **WO-V9 tile empty state:** with no data from the phone the tile reads "No servers" instead of telling the person to
  open Flagship on the phone (the watch app already says so). Next Wear bundle.
- **WO-G5 screenshots:** the Wear screenshots (384 × 384, slides 07 / 07b in `store/store.json`) show the app only, no
  frame or mask: fine. Google recommends a screenshot of the tile too; none exists yet.
- **Not translated:** the tile and complication texts ("2/3 up", "1 waiting", "Leader: …", the setup phases) are
  English in code (`WatchProjection` in `apps/mobile/android/companion`), against the i18n rule. Next Wear bundle.
- WO-G2's other points are met: main features listed, no "Android Wear", every app language has a description.
