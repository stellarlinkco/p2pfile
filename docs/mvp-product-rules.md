# MVP Product Rules

This document captures first-version product and operational rules that were intentionally removed from `CONTEXT.md` so the context file stays focused on shared domain language.

## Product surface

- The first version ships as a normal website, not as an installable app-first product surface.
- Sender refresh, tab close, or page exit ends the live session. The sender cannot reattach to the same live session and must create a new one.
- The first version does not add an application-layer password or extra encryption passphrase on top of the normal session entry flow.

## Session runtime rules

- The service may keep only the short-lived server-side state needed to coordinate a live session.
- A sender session depends on the original local source files remaining readable; the frozen manifest does not imply a staged local copy.
- When a visitor reaches a blocked or terminal state that cannot continue in-place, the default recovery guidance is to ask the sender to create a new session.

## Share-surface exposure

- Share pages are bearer-link surfaces and must not be publicly indexable or archive-friendly.
- Social/link preview metadata should stay generic and must not expose file-manifest details.

## Retry and release behavior

- A claimed receiver may retry connection establishment within the same claimed session while the sender remains online.
- In-session retry is bounded by a small retry budget rather than being infinite.
- A claimed receiver may voluntarily release the claim, reopening the same live session for a new claim while the sender remains online.
- Claim release returns the session to the pre-claim waiting/viewing states.
- View-only presence is ephemeral and leaves no durable visit history.
- Only the current receiver-token holder may release a claim.
- The sender may receive a short-lived notice when the receiver releases a claim, but this is not durable event history.

## Relay policy

- The first version enables relay fallback by default rather than pre-gating it behind budget controls.
- Relay use must still be disclosed to users as relayed transfer rather than direct transfer.

## Why this document exists

`CONTEXT.md` should define domain language such as transfer modes, sessions, manifests, claims, and completed views. This document carries implementation-facing first-version rules so the domain glossary stays small, stable, and readable.
