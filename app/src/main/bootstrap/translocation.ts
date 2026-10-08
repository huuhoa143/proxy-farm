/**
 * App-translocation guard (spec §9): a macOS app launched straight from the DMG
 * (`/Volumes/...`) or from a Gatekeeper-translocated path
 * (`/private/var/folders/.../AppTranslocation/...`) can't be updated in place, so the
 * user is asked to move it to /Applications. Pure so it can be unit-tested.
 */
export function isTranslocatedOrOnDmg(exePath: string): boolean {
  return /\/AppTranslocation\//.test(exePath) || exePath.startsWith('/Volumes/');
}
