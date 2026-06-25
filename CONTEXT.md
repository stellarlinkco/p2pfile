# P2P File Transfer

A browser-first file transfer product that prioritizes direct peer-to-peer delivery while allowing relay fallback when direct connectivity fails.

## Language

**Direct Transfer**:
File data flows peer-to-peer without passing through a relay.
_Avoid_: pure offline, zero server, serverless transfer

**Relayed Transfer**:
File data is forwarded through a relay service because a direct peer-to-peer path could not be established.
_Avoid_: direct transfer, pure P2P

**Signaling Service**:
A coordination service that exchanges connection setup information but does not carry file contents.
_Avoid_: file server, storage server

**Transfer Mode Disclosure**:
The product explicitly tells the user whether a session is using direct transfer or relayed transfer.
_Avoid_: hidden fallback, silent relay

**Direct Transfer Tool**:
The product is promised to users as a file transfer tool whose primary path is direct transfer and whose fallback path is relayed transfer.
_Avoid_: pure P2P site, zero-server file site

**Temporary Session Window**:
A short-lived transfer session that exists only while the sender keeps the session open and allows the same receiver to re-enter.
_Avoid_: public download page, persistent share link

**Receiver Token**:
A one-time receiver identity token that reserves the temporary session window for a specific receiver and allows that receiver to re-enter.
_Avoid_: shared link, browser guess, anonymous reopen

**Anonymous Receiver**:
A receiver who participates in a transfer session without providing a human-readable identity.
_Avoid_: nickname, device-derived identity, user profile

**File Manifest**:
A complete list of files in a transfer session that must be received as a whole.
_Avoid_: zip package, partial selection, ad hoc file batch

**Completed Session**:
A transfer session whose entire file manifest has been received successfully.
_Avoid_: partial success, first-file success, started session

**Environment-Dependent Size Limit**:
The practical size limit of a transfer depends on browser, device storage, memory, and network conditions rather than a single universal promise.
_Avoid_: unlimited file size, fixed universal cap

**Open Session TTL**:
The short expiration window for a share link before any receiver has claimed the session.
_Avoid_: permanent link lifetime, post-claim timeout

**Sender-Ended Session**:
A temporary session window that was explicitly closed by the sender before or during transfer.
_Avoid_: browser accident only, implicit disappearance

**Reconnecting Session**:
A temporary recovery state after an accidental sender signaling disconnect where the original sender may reconnect before a short grace window expires.
_Avoid_: completed session, sender-ended session, durable pause

**Frozen Manifest**:
A file manifest that cannot change after the temporary session window is created.
_Avoid_: mutable share list, append-only live batch

**Secondary Access Code**:
A backup entry code that resolves to the same temporary session window as the primary share link.
_Avoid_: separate session, parallel room, primary share path

**Claimed Session**:
A temporary session window that has been reserved by a receiver immediately after they commit to receiving the file manifest.
_Avoid_: connected-only receiver, post-handshake ownership

**Occupied Session Notice**:
The message shown to later visitors when a claimed session is already reserved by another receiver.
_Avoid_: generic invalid link, silent failure

**Completed Session View**:
A short-lived read-only result state shown after a session completes, briefly available to the sender and the original receiver without allowing the files to be received again.
_Avoid_: durable history page, downloadable archive page, reusable share page

**Integrity-Gated Completion**:
A completion rule in which a session is only considered complete after internal file integrity checks pass, even if the UI does not expose the checks directly.
_Avoid_: transport-only success, UI-visible hash requirement

**Manifest View Presence**:
A sender-visible state indicating that at least one visitor has opened the session and is viewing the frozen manifest before claiming the session.
_Avoid_: identity tracking, detailed audience analytics, named visitor

**Completion Notice**:
A minimal message shown to non-owning visitors after a session has already completed.
_Avoid_: reusable completed share page, reopened transfer path

**Session Creation**:
The sender action that creates a temporary session window and freezes the file manifest before any transfer begins.
_Avoid_: start transfer, immediate send, implicit upload

**QR Share**:
A QR encoding of the primary share link used as an alternative presentation of the same session entry path.
_Avoid_: separate mobile session, special QR-only room

**Link-Based Entry**:
A first-version access rule in which a share link or access code is itself the only required entry credential for a session, without an additional password.
_Avoid_: password-protected session, second-factor entry

**Metadata-Only Preview**:
A first-version display rule in which both the sender and a pre-claim receiver see only manifest metadata and never content thumbnails or embedded file previews.
_Avoid_: gallery preview, inline media preview, content inspector

**Bearer Share Link**:
A share link that acts as a bearer credential: whoever holds it may view session metadata and attempt to claim the session within the first-version rules.
_Avoid_: public index page, non-sensitive URL, password follow-up link


## User-facing vocabulary

**Share Link**:
The user-facing name for the primary link created by **Session Creation**.
_Avoid_: room link, session link, transport URL

**Access Code**:
The user-facing name for the backup code that maps to the same session as the share link.
_Avoid_: room code, session code, transfer token

**QR Code**:
The user-facing name for the QR rendering of the same session entry path as the share link.
_Avoid_: QR room, mobile code

## Relationships

- A transfer session prefers **Direct Transfer**
- A transfer session may fall back to **Relayed Transfer**
- A **Signaling Service** coordinates both peers before either transfer mode starts
- Every transfer session must disclose its current **Transfer Mode Disclosure** to the user
- A **Direct Transfer Tool** promises **Direct Transfer** as the default path and **Relayed Transfer** as the fallback path
- A share link opens exactly one **Temporary Session Window**
- A **Receiver Token** reserves a **Temporary Session Window** for one receiver
- A receiver may re-enter the same **Temporary Session Window** only by presenting the same **Receiver Token**
- A **Receiver Token** belongs to one **Anonymous Receiver**
- One transfer session exposes exactly one **File Manifest**
- A **Completed Session** requires successful receipt of the entire **File Manifest**
- An **Environment-Dependent Size Limit** constrains every **File Manifest** in practice
- An unclaimed **Temporary Session Window** is constrained by an **Open Session TTL**
- Once a receiver claims the session, the **Open Session TTL** no longer ends that session
- A sender may turn a **Temporary Session Window** into a **Sender-Ended Session** at any time
- A **Frozen Manifest** is shown to the receiver before claim and stays unchanged for the life of the session
- A **Secondary Access Code** resolves to the same **Temporary Session Window** as its primary share link
- A **Claimed Session** begins as soon as the receiver commits to receiving the **Frozen Manifest**
- A **Claimed Session** may still be establishing connectivity while already reserved
- An **Occupied Session Notice** is shown to any later visitor after the session becomes a **Claimed Session**
- A **Completed Session** transitions into a short-lived **Completed Session View**
- The original receiver may re-enter a **Completed Session View** during its short-lived window without reopening transfer
- A **Completed Session** requires **Integrity-Gated Completion**
- A **Manifest View Presence** may exist before a session becomes a **Claimed Session**
- A non-owning visitor to a finished session sees a **Completion Notice**, not a **Completed Session View**
- **Session Creation** produces a **Temporary Session Window** and a **Frozen Manifest**
- A **QR Share** encodes the same primary share link created by **Session Creation**
- The product UI calls the primary session entry a **Share Link**
- The product UI calls the backup entry code an **Access Code**
- The product UI calls the QR rendering a **QR Code**
- First-version session entry follows **Link-Based Entry**
- Sender review and pre-claim receiver review both follow **Metadata-Only Preview**

## Example dialogue

> **Dev:** "When a transfer cannot connect directly, do we fail the session?"
> **Domain expert:** "No — the session should prefer **Direct Transfer** first, then automatically fall back to **Relayed Transfer** and label that state clearly in the UI."
> **Dev:** "If we fall back to relay, can we keep calling it peer-to-peer in the UI?"
> **Domain expert:** "No — we must explicitly disclose that the session is using **Relayed Transfer**."
> **Dev:** "What do we call the product if some sessions relay?"
> **Domain expert:** "It is a **Direct Transfer Tool** because direct transfer is the primary promise and relayed transfer is the fallback."
> **Dev:** "If the receiver refreshes the page, can they come back?"
> **Domain expert:** "Yes — the same **Receiver Token** lets them re-enter the same **Temporary Session Window**."
> **Dev:** "What if someone else opens the copied link later?"
> **Domain expert:** "They do not own the session, because they do not have the original **Receiver Token**."
> **Dev:** "Do we ask the receiver for a display name?"
> **Domain expert:** "No — first version receivers are **Anonymous Receivers** and the session only shows connection state."
> **Dev:** "If the receiver only gets four out of five files, is that done?"
> **Domain expert:** "No — the session is a **Completed Session** only when the entire **File Manifest** arrives successfully."
> **Dev:** "Can we promise unlimited file size?"
> **Domain expert:** "No — transfer size is an **Environment-Dependent Size Limit**, so we describe the dependency instead of promising a universal maximum or unlimited size."
> **Dev:** "Does the share link expire the same way after a receiver starts?"
> **Domain expert:** "No — **Open Session TTL** only applies before claim; after claim, the session lives until completion, sender exit, or a **Sender-Ended Session**."
> **Dev:** "Can the sender explicitly cancel the transfer?"
> **Domain expert:** "Yes — the sender can end the session at any time, creating a **Sender-Ended Session**."
> **Dev:** "Can the sender change the files after sharing the link?"
> **Domain expert:** "No — the receiver sees a **Frozen Manifest**, so any change requires a new session."
> **Dev:** "Is the access code a different kind of session?"
> **Domain expert:** "No — the **Secondary Access Code** is only a backup way into the same **Temporary Session Window**."
> **Dev:** "If the receiver clicks accept but the connection is still negotiating, do they already own the session?"
> **Domain expert:** "Yes — that is already a **Claimed Session**, even before transport finishes establishing."
> **Dev:** "What does a second visitor see then?"
> **Domain expert:** "They see an **Occupied Session Notice** explaining that another receiver already claimed the session."
> **Dev:** "If the sender copies a share link into chat, what does the receiver get?"
> **Domain expert:** "A **Share Link** opens one **Temporary Session Window** with a **Frozen Manifest**."
> **Dev:** "Can the receiver inspect the file contents before accepting?"
> **Domain expert:** "No — both sides follow **Metadata-Only Preview**, so the receiver sees only manifest metadata before claim."
> **Dev:** "When does the session become exclusive to one receiver?"
> **Domain expert:** "At claim time: the receiver gets a **Receiver Token** and the session becomes a **Claimed Session**."
> **Dev:** "What happens after every file arrives successfully?"
> **Domain expert:** "The session becomes a **Completed Session** and then a short-lived **Completed Session View** for the sender and the original receiver."

## Flagged ambiguities

- "No server" was ambiguous — resolved: file contents should prefer **Direct Transfer**, while a **Signaling Service** is still allowed and **Relayed Transfer** is allowed as fallback.
- Relay fallback disclosure was unspecified — resolved: every session must clearly disclose whether it is in **Direct Transfer** or **Relayed Transfer**.
- Product positioning was fuzzy — resolved: this product is a **Direct Transfer Tool**, not a pure P2P or zero-server product.
- Session re-entry was vague — resolved: each share link opens one **Temporary Session Window**, and re-entry belongs only to the holder of the original **Receiver Token**.
- Receiver identity was unspecified — resolved: first-version receivers are **Anonymous Receivers** and sessions expose state, not human-readable receiver identity.
- Multi-file session semantics were vague — resolved: a session exposes one **File Manifest**, the receiver accepts it as a whole, and completion requires the entire manifest to succeed.
- File size promises were vague — resolved: first-version messaging must treat transfer limits as an **Environment-Dependent Size Limit**, not as unlimited size.
- Session lifetime was underdefined — resolved: unclaimed sessions expire by **Open Session TTL**, claimed sessions do not, and the sender may explicitly create a **Sender-Ended Session** at any time.
- Share entry semantics were vague — resolved: the receiver sees a **Frozen Manifest** before claim, and any backup access code maps to the same **Temporary Session Window** rather than a separate session.
- Claim timing was ambiguous — resolved: a session becomes a **Claimed Session** at the receiver's commit moment, not at successful connectivity, and later visitors receive an **Occupied Session Notice**.
- Post-completion behavior was vague — resolved: completed sessions become a short-lived read-only **Completed Session View**, and the original receiver may re-enter that result state during the view window without reopening transfer.
- Integrity semantics were vague — resolved: session completion is **Integrity-Gated Completion**, but first-version UI does not expose checksum details.
- Pre-claim visibility was ambiguous — resolved: senders may see **Manifest View Presence** before claim, but the product still does not expose receiver identity.
- Completed-link visibility was ambiguous — resolved: non-owning visitors to a finished session see only a **Completion Notice**, while the original receiver may re-enter the **Completed Session View**.
- Sender action semantics were vague — resolved: the primary sender action is **Session Creation**, which creates the session and freezes the manifest before any receiver joins.
- Mobile entry semantics were vague — resolved: **QR Share** is just an alternate rendering of the primary share link, not a separate session type.
- User-facing entry names were vague — resolved: UI terminology is **Share Link**, **Access Code**, and **QR Code**, while the underlying domain terms remain more precise.
- Entry security scope was vague — resolved: first-version access follows **Link-Based Entry**, so the share link or access code is the only required entry credential.
- Preview scope was vague — resolved: both sender review and pre-claim receiver review use **Metadata-Only Preview** and do not include content previews.
