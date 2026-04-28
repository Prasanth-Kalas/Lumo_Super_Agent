/**
 * Google Contacts (People API) tool handler.
 *
 * Single tool today: contacts_search(query). Matches on name, email,
 * phone, org. Returns compact {name, emails, phones, org} rows. Nothing
 * persisted — the People API response passes through to Claude and is
 * forgotten on turn end.
 */

import { googleFetchJson } from "./google.js";

export interface ContactResult {
  name: string;
  emails: string[];
  phones: string[];
  org: string | null;
}

export async function contactsSearch(args: {
  access_token: string;
  query: string;
  max_results?: number;
}): Promise<{ contacts: ContactResult[] }> {
  const max = Math.min(25, Math.max(1, args.max_results ?? 10));

  // People API's searchContacts needs a "warmup" call first per Google's
  // docs (the query engine lazily indexes on first use). We still get
  // usable results from a cold call — it's just best-practice to warm
  // once per token. For MVP we skip the warmup and accept a slightly
  // colder first result; if users complain we'll add it.
  const data = await googleFetchJson<{
    results?: Array<{
      person?: {
        names?: Array<{ displayName?: string }>;
        emailAddresses?: Array<{ value?: string }>;
        phoneNumbers?: Array<{ value?: string }>;
        organizations?: Array<{ name?: string; title?: string }>;
      };
    }>;
  }>({
    access_token: args.access_token,
    url: "https://people.googleapis.com/v1/people:searchContacts",
    query: {
      query: args.query,
      readMask: "names,emailAddresses,phoneNumbers,organizations",
      pageSize: max,
    },
  });

  const contacts: ContactResult[] = [];
  for (const r of data.results ?? []) {
    const p = r.person;
    if (!p) continue;
    contacts.push({
      name: p.names?.[0]?.displayName ?? "(unknown)",
      emails: (p.emailAddresses ?? []).map((e) => e.value ?? "").filter(Boolean),
      phones: (p.phoneNumbers ?? []).map((e) => e.value ?? "").filter(Boolean),
      org: p.organizations?.[0]?.name ?? null,
    });
  }
  return { contacts };
}
