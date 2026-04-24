# Getting started

The first five minutes with Lumo. By the end, you'll have an account, one connected app, and your first completed turn.

## 1. Sign up

Head to the Lumo deployment (`https://lumo-super-agent.vercel.app/` for the managed host, or your own domain if self-hosted). Click **Create account**, enter an email and password. Check your inbox for the confirmation link and click through — the link bounces you back into Lumo signed in.

If your organization uses magic links or SSO instead of passwords, the sign-in flow looks slightly different but lands the same place. Don't worry about which one you have — the UI guides you.

## 2. Meet the dashboard

After sign-in you land on the main chat. What's where:

- **Center column** — the conversation. Type in the composer at the bottom; the assistant replies above.
- **Left sidebar** — recent conversations, connected agents and their health (green = working, grey = not connected), and the footer links (History, Marketplace, Connections, Sign out).
- **Right sidebar** — the live trip panel when you're actively working on a booking, and the memory HUD showing what Lumo has learned about you.
- **Top right** — theme toggle, notification bell (the bell goes amber when there's an unread proactive nudge).

On mobile, the sidebars tuck into a drawer — tap the ☰ icon top-left.

## 3. Connect your first app

Most interesting things Lumo does require access to at least one of your accounts. Click **Marketplace** in the left sidebar, pick an app — say, **Google (Gmail · Calendar · Contacts)** — and hit **Connect**.

You're bounced to Google's consent screen. Google shows exactly what Lumo is asking for (read mail, read/write calendar, read contacts, keep access while you're not here). If you approve, Google sends you back to Lumo with a short success banner and the card flips to a green **CONNECTED** badge.

That's it. Lumo can now read your email and manage your calendar.

For the full provider-by-provider walkthrough, see [connecting-apps.md](connecting-apps.md).

## 4. Try a real turn

Back in chat, try something the specialist agent can actually do. Some starter prompts depending on what you connected:

- Google or Microsoft: *"Did anyone email me about the quarterly review today?"* or *"Block 2–3pm Thursday for a call with Alex."*
- Spotify (with Premium): *"Play something chill."*
- First-party travel agents (always available): *"Find me a cheap flight to Austin Friday afternoon."*

Lumo replies, shows a card when there's a booking or confirmation, and — depending on how you've tuned autonomy — either asks before acting or just acts. See [autonomy.md](autonomy.md) for that control.

## 5. Optional: turn on voice

If you like talking more than typing, hit the mic icon in the composer. The first tap turns voice mode on (hands-free by default — after Lumo finishes speaking, the mic auto-restarts listening). Pick a voice you like at `/memory` → Voice.

Full guide: [voice-mode.md](voice-mode.md).

---

## What's next

- **[Connecting more apps](connecting-apps.md)** — one connection is enough to try Lumo; most people end up with three or four.
- **[What Lumo remembers](memory.md)** — peek at, edit, or wipe the memory page any time.
- **[Autonomy](autonomy.md)** — start with the default "ask before spending"; turn it up only when you trust Lumo on a specific class of task.
- **[Privacy](privacy.md)** — the plain-English contract about your data. Read this before you hand Lumo any sensitive scope.

If something breaks on day one, jump to [troubleshooting.md](troubleshooting.md) — most first-run issues are listed there with one-line fixes.
