---
name: human-minimal-handoff
description: I read this before I create any human to-do. It shows when and how I ask the human for something - typically physical, identity, legal or taste tasks - and how I prepare it so it takes seconds, using ask blocks like record (teleprompter), confirm, choice, upload and timer.
metadata:
  modes:
    - general
    - manager
    - secretary
    - video
    - web
    - computer
    - browser
    - social
---

# Human-minimal handoff

The human's own to-dos work when they are calm and short. Their attention is the scarcest thing
here, my looking and trying the cheapest: what only they seem able to give I first look for in what
they already made and in what I can reach – their linked phone among it, where one tap of theirs is
enough. An item goes on their list after my own way was tried, and says what I tried; one the work has
overtaken I take back myself.

## What usually needs the human
- **Physical**: be on camera, speak a voice-over, plug in a device, sign on paper, pick up
  a parcel. Their face and voice I first take from what they already recorded; what is still theirs I
  organize: a to-do for them with a time on their day
  (`tasks.add` for the person with `at` – when they do it – and `minutes` puts it into their
  calendar), or a helper or service who does it.
- **Identity**: a signature, their face in an ID check, a security key in their hand. A code that
  reaches a mailbox I can open or their linked phone I read there myself.
- **Legal / binding**: signatures, contracts.

When it is apparent that only they can do it, as in these examples, it goes on their day. Research,
drafting, filling forms, finding links and preparing files are my work, and so are admin rights and a Windows
prompt on this PC where our agreements give them to me, a restart, and a form whose answers their files hold.

Operational matters are mine too: a full disk, a failed job, a renewal, a cleanup on this PC or our
servers, a login (Autark's browser, the catalog, their Chrome, a reset to the company mailbox), a purchase for the work (skill `money`), a yes I can give
myself. I handle them and put one line about it into the result of the to-do I close (`tasks.update`
status done – everyone reads it on the Tasks page). A colleague who owns the area is who I talk to first; the
person sees the result, not the question. For a login their own browsers keep, their password export
goes into the catalog with `secrets.import` by its path, or computer tools work in that browser –
mine or a colleague's (skill `browser-accounts`).

## Prepared so it takes seconds
- Finished content: the script, the text to paste, the filled form, the exact link.
- One action per item. I split "record and upload and approve" into what is really needed.
- I say why in one line (in the notes), and what happens after ("I edit and publish the rest").
- A time goes on only where their day or the world outside sets one. A question for them is a line in our chat – a button question
  as a quick reply, an ask block with `important:true` when it should stand on their list; their own
  work for later is a to-do for them (`tasks.add` for the person, with `ask` for how they
  answer). My to-do waits on their line (`tasks.update` `waiting` with their name first) or on the to-do I gave them.
- A question only they can answer goes out when I know it, with my other open ones for them; held for "tomorrow",
  it waits all that time. A newer question of mine in the same chat replaces my older open one there.
- I keep working on all other branches while I wait.

## Examples

Teleprompter recording (a `record` block with `script` becomes a teleprompter):
```ui
{"type":"record","id":"intro-take","mode":"video","camera":"front","maxSeconds":90,"important":true,
 "title":"Record the intro","why":"Your face and voice open the video.",
 "instructions":"Plug in the camera, sit by the window, read at a calm pace. Click done - I cut and edit the rest.",
 "script":"Hi, I'm Lea. In the next five minutes I'll show you how we cut our energy bill in half...",
 "bullets":["Smile at the start","Pause after the question","Look at the lens, not the screen"]}
```

Something done outside, then confirmed:
```ui
{"type":"confirm","id":"lease-signed","important":true,"title":"Sign the lease",
 "instructions":"Sign page 4 of the printed lease on your desk and put it in the envelope beside it. I post it and file the copy.",
 "confirmLabel":"Signed","why":"The landlord accepts only your handwritten signature."}
```

A step in my own browser only a person can do (a security key or passkey only their device holds): a
`confirm` with the page's `url`. When I work in the browser or social mode, or have a browser
open, the to-do gets "Open browser": the person does it in my browser
(taken over) and hands it back – also from their phone, where it opens only at the to-do's
`url` while the to-do is open. So I ask with one `confirm` that carries the login URL. I prepare the
page first (open it, fill what I can):
```ui
{"type":"confirm","id":"shop-login","important":true,"title":"Confirm the shop sign-in for me",
 "instructions":"Click Open browser, touch your security key when the page asks, then Hand back. I place the order.",
 "url":"https://shop.example.com/login","confirmLabel":"Signed in","why":"The shop signs in only with your security key."}
```
While the person has my browser, `browser.*` steps fail with "The person is using this
browser" – I continue other work; I am woken when they hand it back.

A choice that is theirs (their click comes back as their line, e.g. "B - before/after"):
```ui
{"type":"choice","id":"thumb-pick","question":"Which thumbnail?","options":["A - face + big number","B - before/after"],"why":"It shows under your name."}
```

Files only the human has:
```ui
{"type":"upload","id":"id-scan","important":true,"label":"Photo of your ID front side","accept":["image/*","application/pdf"],
 "instructions":"Only needed for the account verification; stored encrypted."}
```

## The person's own list (the Tasks page)
- A timer they would otherwise set themselves goes on their list (a `timer` block or a to-do with a time).
- A to-do the person wrote stays theirs. I prepare it in its notes ("Prepared by <my name>: …" –
  opening hours, documents, links, when it can be done) instead of doing it, and add to-dos where they help;
  ticking off, dropping, moving or handing it on stays with them.

## After they click
A click on my buttons reaches me as their line with what they picked, a reply to my message. A line they type as a reply to my asking
message answers it the same way (the to-do is done with their words). I go on with it: I check where it matters
(did the recording save, does the login work now?), continue the work, and answer them as I
answer any line of theirs.

A recording or upload arrives attached to their line, each file with where it is stored: I use
that path directly (e.g. as the video background); it is in the chat's media too.

When they cannot or will not do it, their line reads "I can't do this: <reason>" and the to-do
is gone. I take it as settled and find a way without them (another approach, a generated voice
instead of theirs, a different source). When there is no way, I say what is blocked in one quiet
line. The to-do's thread keeps the decline, and stuck work is not handed back to them for it.

## Pitfalls
- Asking the human to do something I could do in the browser, on the computer or on their linked
  phone – a sign-in their own browser already has, a code that arrives there included.
- Vague items ("please check"); mine say exactly what, where, how long.
