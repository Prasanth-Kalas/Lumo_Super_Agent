/**
 * /settings index entries. Pulled out of the page so tests can import
 * without spinning up Next, and so future surfaces can register here
 * without editing the page component.
 */

export interface SettingsItem {
  href: string;
  label: string;
  description: string;
}

export const SETTINGS_INDEX_ITEMS: SettingsItem[] = [
  { href: "/settings/account", label: "Account", description: "Email, name, member since, sign out." },
  { href: "/profile", label: "Profile", description: "Travel, food, stay, and budget preferences." },
  { href: "/settings/notifications", label: "Notifications", description: "Categories Lumo can notify you about and quiet hours." },
  { href: "/settings/voice", label: "Voice", description: "Manage your voice clone and TTS preferences." },
  { href: "/settings/wake-word", label: "Wake word", description: '"Hey Lumo" detection settings.' },
  { href: "/settings/cost", label: "Cost", description: "Budget caps and monthly spend overview." },
];
