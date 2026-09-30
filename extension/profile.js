// This Chrome profile's identity as Yarvis sees it.

export const PROFILE_KEY = "profile";
export const MAX_NAME_CHARS = 40;

/**
 * The id is made once and kept, so renaming the profile doesn't make Yarvis
 * think a new browser arrived. The default name is meant to be replaced.
 */
export async function loadProfile() {
  const stored = (await chrome.storage.local.get(PROFILE_KEY))[PROFILE_KEY];
  if (stored?.id && stored?.name) return stored;
  const id = crypto.randomUUID();
  const profile = { id, name: `profile-${id.slice(0, 4)}` };
  await chrome.storage.local.set({ [PROFILE_KEY]: profile });
  return profile;
}

/** Null when the name has nothing usable left in it. */
export function cleanName(name) {
  const cleaned = String(name)
    .replace(/[\p{C}]/gu, "")
    .trim()
    .slice(0, MAX_NAME_CHARS);
  return cleaned || null;
}

export async function saveProfileName(name) {
  const cleaned = cleanName(name);
  if (!cleaned) return null;
  const profile = await loadProfile();
  const next = { ...profile, name: cleaned };
  await chrome.storage.local.set({ [PROFILE_KEY]: next });
  return next;
}
