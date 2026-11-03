/**
 * Whether a prebuilt appliance can host a recipe. The appliance's bootstrap refuses a release that is not the
 * exact commit signed into the recipe, so a recipe naming an exact commit (every 0.3 recipe) matches only the
 * manifest's `commit`: the release installed on the image. `installerGitRef` is only the label the image is
 * published under ("main", kept for 0.2 Studios). A recipe naming a branch or tag (made by an app older than
 * 0.3, refused at load anyway) keeps the old label match. Mirrors the Mac ApplianceMatch.swift and the Windows
 * ApplianceMatch.cs; pinned by apps/desktop-shared/golden/vm-core-vectors.json "applianceMatch".
 */
const EXACT_COMMIT = /^[0-9a-f]{40}$/;

export interface ApplianceIdentity {
  installerGitRef: string;
  commit?: string | null;
}

export function applianceMatchesRecipe(manifest: ApplianceIdentity, recipeRef: string): boolean {
  const ref = recipeRef.trim();
  return EXACT_COMMIT.test(ref) ? manifest.commit === ref : manifest.installerGitRef === ref;
}

/** What the image holds, as the mismatch sentence names it. */
export function appliancePublishedAs(manifest: ApplianceIdentity, recipeRef: string): string {
  return EXACT_COMMIT.test(recipeRef.trim()) ? (manifest.commit ?? manifest.installerGitRef) : manifest.installerGitRef;
}
