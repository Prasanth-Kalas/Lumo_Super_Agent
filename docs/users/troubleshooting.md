# Troubleshooting

Common things that go wrong, and how to fix them. If your issue isn't here, open the browser console (Cmd-Opt-J on Mac, Ctrl-Shift-J on Windows), reproduce the issue, and send the error text to your operator — it usually tells them exactly what's broken.

## Sign-in and sign-out

**"I signed up but never got the confirmation email."**
Check spam. Wait two minutes — some email providers delay. If still nothing, use the "Resend confirmation" link on `/login`. If THAT doesn't work, your deployment's Supabase SMTP may not be configured — tell your operator.

**"I'm signed in but pages keep bouncing me to /login."**
Cookies got wedged, usually by an out-of-band sign-out somewhere (closed a different Lumo tab, session expired during a long idle). Hit Sign out (bottom of the left sidebar) explicitly, then sign back in.

**"Sign out doesn't seem to do anything."**
The button fires but the page reloads to whatever you were on? Make sure your deployment has the `/api/auth/logout` route deployed (it's part of the standard build). If it's missing, your deployment is outdated — tell your operator to redeploy.

## Connecting apps

**"The Connect button redirects me, then immediately comes back with an error."**
Almost always a misconfigured OAuth app on the operator's side. The most common variants:
- *"redirect URI mismatch"* — the URL the operator configured in Google/Microsoft/Spotify doesn't match `https://<your-lumo-domain>/api/connections/callback`. Operator fix.
- *"invalid_client"* — the client secret value stored in Vercel env is actually a Secret ID, not a Secret Value. Operator fix (both look similar in some provider UIs).

**"I connected Google but my email isn't showing up."**
Try sending a specific query: *"Search my Gmail for 'test' and list the subjects."* If Lumo replies that it can't find any mail, either the account has no matches or the scope is narrower than it looks — check `/connections` to confirm `gmail.readonly` is in the scope list.

**"I got a 'token expired' banner on /connections."**
Hit Reconnect on the marketplace card. The OAuth flow restarts and your connection goes back to green.

**"Spotify says 'temporarily unavailable'."**
Deployment's Spotify app requires Premium on the owner account. Not something you can fix — tell your operator.

## Chat

**"Lumo gave me a wrong answer."**
- If it's a fact about you ("I thought you lived in Austin") — go to `/memory` and correct it. Facts can be edited or deleted.
- If it's a misinterpretation of your query — rephrase more specifically. Lumo is good, not psychic.
- If it's a tool that returned bad data (a flight price that doesn't exist) — that's a bug in the specialist agent. Report the conversation to your operator with a timestamp.

**"Lumo is slow."**
Most turns complete in under a second. If you're seeing 5+ seconds:
- Check the top of the response for a thinking indicator. Long tool chains take time; Lumo will show what it's doing.
- If the indicator is frozen, the orchestrator is stuck — reload the tab and try again.
- If every query is slow, the model providers (Anthropic, OpenAI) may be having an incident. Not under Lumo's control.

**"Lumo keeps forgetting things I told it."**
- Check `/memory` → Facts. Is the fact actually stored? If not, try saying "Remember that ..." explicitly — the memory_save tool fires on that phrasing.
- If it's stored but not being retrieved: the fact may be phrased in a way that doesn't match your queries semantically. Edit the fact to use clearer language.

## Voice

**"Voice mode is silent — I see the mic listening but Lumo isn't speaking back."**
Reload the tab. After an ElevenLabs upstream failure, the client holds a 60-second cooldown before re-probing. Fresh reload clears it.

**"The voice sounds like a cheap robot."**
You're on the browser-native `speechSynthesis` fallback. Premium TTS is currently unavailable. See the voice mode doc: [voice-mode.md](voice-mode.md#when-voice-breaks).

**"Voice mode isn't available — no mic icon in the composer."**
You're on Firefox or an older browser. Try Chrome, Edge, Safari, or Arc. Firefox doesn't ship `SpeechRecognition`.

**"The voice preview on /memory won't play."**
Same cooldown issue as above. Reload and retry. If it still fails after reload, your operator's ElevenLabs account has a billing issue.

## Notifications and proactive

**"The bell never gets any notifications."**
Either nothing's triggering (no standing intents, no trip issues) — in which case, great, that's the expected state. Or the cron isn't running. Check with your operator; `/ops` shows cron run health.

**"The bell fires way too often."**
Almost always a too-vague standing intent. Go to `/intents`, click the intent that's firing, tighten the trigger. "Notify me about deals" is too broad; "Notify me if flight ABC-123 drops below $280" is right.

**"I'm getting notifications for stuff that happened hours ago."**
The proactive scan runs every 15 minutes. If the notification is older than that, the cron was paused and recently resumed — normal. If it's consistently delayed, tell your operator to check cron health at `/ops`.

## Memory

**"I hit Forget everything but some stuff is still there."**
Profile fields that Lumo needs to function (email, timezone) aren't wiped by Forget everything. OAuth connections and standing intents have their own delete paths (`/connections`, `/intents`). Full account deletion is a separate request — contact your operator.

**"I added a fact manually but Lumo still doesn't use it."**
The fact may take a turn or two to surface. Try the query that should have matched — if it still doesn't, the fact's phrasing is semantically too far from your query. Rewrite it.

## Performance and layout

**"Console is noisy with React hydration errors."**
Known issue class — usually from a component reading `window.location`, `Date.now()`, or a locale-dependent formatter at render time. Operator can check recent commits for the specific source. Page itself should still work.

**"Layout is broken on mobile."**
The sidebars tuck into a drawer on mobile; tap the ☰ icon top-left to open it. If the drawer itself is broken, reload the page.

## Autonomy

**"Lumo did something I didn't approve."**
- Check your autonomy tier at `/autonomy`. If it's Balanced or Proactive, Lumo can act within your spend cap without asking.
- Check the action log on the same page — every autonomous action is recorded with timestamp, cost, and a link to the conversation.
- If the action wasn't in the log, that's a serious bug — open an incident.

**"The kill-switch is on but cron-style actions still fired."**
Kill-switch stops autonomous actions but proactive scans continue (they don't write notifications while paused, though). If a scan produced a side effect while paused, that's a bug — escalate.

## When all else fails

1. Open the browser console and copy any red error text.
2. Note the URL and the time.
3. Send to your operator with a one-line description of what you were trying to do.

Your operator has access to the `/ops` dashboard (cron runs, notification stats, autonomy activity) and can correlate your report with server-side signals.

If you're self-hosting, the same information is what you'd dig into yourself — start at [../operators/incident-runbook.md](../operators/incident-runbook.md).
