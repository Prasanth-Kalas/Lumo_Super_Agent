# Voice mode

Lumo has a hands-free mode for when typing isn't an option — driving, walking, hands full, or you just prefer talking. Tap the mic icon in the composer to turn it on. This page covers everything it does.

## The short version

1. Click the mic icon (bottom-right of the composer).
2. Speak. Lumo transcribes what you said, handles the turn, and reads the reply back to you.
3. After Lumo finishes speaking, the mic automatically reopens — continue the conversation, or tap the mic again to turn voice mode off.

That's the whole thing. Everything below is detail about the moving parts.

## What's happening under the hood

Lumo's voice stack has four distinct pieces. Each one is a small, visible state in the UI.

**Listening.** The browser's built-in `SpeechRecognition` API captures what you say and streams partial transcripts to the app. Works on Chromium (Chrome, Edge, Arc, Brave) and Safari; Firefox doesn't support it natively, so voice mode falls back to text-only on Firefox.

**Thinking.** Your transcript goes to the orchestrator, which picks tools, talks to providers, and streams the response back as text.

**Speaking.** As the text streams in, Lumo chunks it into sentence-sized bites and pushes each chunk to the TTS provider (currently ElevenLabs, model `eleven_v3`). The first audio bytes typically arrive within a couple hundred milliseconds, so Lumo starts talking while it's still writing.

**Listening again.** Once the reply finishes playing, the mic auto-reopens. This is the "hands-free" loop. You can speak immediately or stay silent — Lumo doesn't fire anything until you actually say something.

## The picker — choosing Lumo's voice

Head to `/memory` and scroll to the **Voice** section. You'll see a grid of voice cards (Sarah, Rachel, Charlotte, Domi, Antoni, Adam). Each card has:

- A one-line vibe description ("warm + conversational", "youthful + confident", "deep + authoritative").
- **Preview** — plays a short sample in that voice.
- **Use this voice** — sets it as your default.

Your selection is saved to your browser's `localStorage`, so it survives refresh but is per-device. If you use Lumo on your phone and your laptop, each picks up its own default until you change them.

## Barge-in

While Lumo is speaking, a second mic pipeline stays open, listening for your voice. If you start talking over Lumo — even one syllable — it detects the interrupt, stops the audio mid-sentence, and switches to listening mode. Same feeling as interrupting a person.

The detection threshold is tuned to ignore small background noises (keyboard clicks, distant traffic) while catching intentional speech. If you find it over-triggering or under-triggering, that's a tuning issue worth reporting.

## Wake word (optional)

If your deployment has a wake-word key configured, Lumo will listen for "Hey Lumo" in the background even when voice mode is technically off. The mic stays closed to server-side transcription; only when it detects the wake word does it actually start recording.

Wake word is opt-in and requires admin setup — see [architecture/voice-stack.md](../architecture/voice-stack.md) for the technical details. If you don't see a wake-word toggle in your settings, your deployment hasn't enabled it.

## When voice breaks — quick diagnostics

**"Lumo doesn't speak at all — no audio."**
- Check your volume and output device.
- Look at the browser's tab-audio indicator; if it's not lighting up, the audio stream isn't reaching the browser. Reload the tab — often fixes it (see the note about "premium TTS cooldown" below).
- If it still doesn't work, TTS is probably down upstream. The voice falls back to your browser's built-in synthesizer; if even that's silent, the browser is blocking autoplay — tap anywhere on the page once and try again.

**"The voice used to work but now it's the cheap-sounding browser voice."**
Lumo briefly flipped to fallback after an upstream hiccup and is now in a cooldown. A fresh tab reload clears the cooldown. If reloading doesn't help, the ElevenLabs subscription on the deployment is hitting a billing issue — tell your operator.

**"My mic isn't picking anything up."**
- Check the browser's mic permission. Some browsers show a small mic icon in the address bar; it needs to be set to Allow for the Lumo site.
- Make sure no other tab (Zoom, Meet, Teams) is holding the mic.
- If you're on macOS, System Settings → Privacy & Security → Microphone should show your browser with a green toggle.

**"Lumo keeps listening when I want it to stop."**
Tap the mic icon again to turn voice mode fully off. Hands-free auto-restart only runs while voice mode is on.

**"Voice mode is missing entirely — no mic icon in the composer."**
You're either on Firefox (no `SpeechRecognition` support) or on an older browser. Try Chrome, Edge, Safari, or Arc.

## Voice and privacy

- **Microphone access is explicit.** Your browser prompts you before Lumo can hear anything.
- **Transcripts go through the same orchestrator as typed messages.** There's no separate "voice pipeline" that sees audio Lumo's server doesn't see.
- **TTS audio isn't stored.** The MP3 stream from ElevenLabs is played once and discarded.
- **Wake-word detection (if enabled) runs in your browser, not on a server.** The audio never leaves your device until after the wake word has triggered and you've consented to a real interaction.

## Useful defaults and where they're stored

| Setting | Where | Persisted |
|---|---|---|
| Selected voice | `localStorage["lumo.selectedVoiceId"]` | This device |
| Voice mode on/off | `localStorage["lumo.voiceEnabled"]` | This device |
| Hands-free on/off | `localStorage["lumo.handsFree"]` | This device (default: on) |
| Voice muted | `localStorage["lumo.voiceMuted"]` | This device |
| Wake word (if set up) | Per deployment, not per user | N/A |

Clearing your browser's site data resets all of these. Nothing about voice mode is stored on the server.
