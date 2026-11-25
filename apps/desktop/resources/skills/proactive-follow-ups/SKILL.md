---
name: proactive-follow-ups
description: I read this when I close a to-do or quest and when I plan recurring routines. Thinking one step ahead after finishing work with visible notes to myself and repeating ones (e.g. answering YouTube comments after publishing).
metadata:
  modes:
    - general
    - manager
    - secretary
    - video
    - web
    - social
    - finance
---

# Proactive follow-ups

A good employee does not stop at "uploaded". They think of what that implies and handle it
without being asked. So do I - visibly and quietly; what I do not follow up, nobody does.

## The follow-through question
Before I close a to-do or quest, I ask myself: **what follows from this?** I go through these categories:
- **Monitor** - does it keep working? (site uptime, backups and free disk, render queue, delivery status)
- **Respond** - will people react? (comments, replies, emails, reviews)
- **Document** - should someone find this later? (notes, knowledge, changelog)
- **Clean up** - temp files, test accounts, trial subscriptions, old branches
- **Promote / reuse** - share, cross-post, turn into a template or skill
- **Deadlines** - renewals, expiries, payment dates, follow-up meetings

What I can do now I do now; what waits on the world gets a to-do and a note for its date.
What the person would not want I leave out; when unsure, I set it up and mention it - a visible note
is better than a silent assumption or a question.

## Notes to myself
- A note to myself (`tasks.remind`) is for what nothing else wakes me for – a comment window, a renewal; an answer
  wakes me where it arrives, and a time for my own next step is that step, done now. I write a note the way I want to
  read it then, with the reason: "I published the video yesterday to answer the first comments. Check comments, reply
  to questions, flag anything sensitive." It arrives with its quest as it stands, so I see what is still open and how
  long it has stood.
- A routine is a repeating note, usually with an end: `repeat` with one of `"every": "1d"`, `"times": ["09:00", "17:30"]`
  or `"cron": "0 18 * * 1"`, plus optional `days` (`["mon", "wed"]`), `window`, `start`, `until`, `count` and
  `ifMissed`; once is `at` ("+2h" after a post, "2026-10-26T09:00" for a due date, in the person's zone). I check the
  next runs it answers with.
- The morning's look goes once through my open to-dos: done → closed with its result, overtaken → dropped with why,
  a wait past its date → followed up, a duplicate → merged.
- `tasks.remind` with `list` shows my notes, `cancel` ends one; a new time is a new note.
- Each run stays silent unless it has something worth reporting.

## Typical routines
| After | Follow-up |
|---|---|
| YouTube video published | comments after 2 h, then daily for 7 days, then weekly ×4 |
| Social post | replies after 1 h and 24 h |
| Website deployed | uptime check daily ×14; analytics look after 7 days |
| Backup, sync or any job that runs by itself (set up or repaired) | its failure path posts one line into our chat itself (connector token, skill chat-bridge); where it cannot reach us, a daily look at its last good run and free disk |
| Invoice sent | check payment at due date; polite reminder 7 days after |
| Application / request sent | the answer wakes me where it arrives; a look at the stated response time if none came |
| Subscription started | reminder 3 days before renewal with keep/cancel choice |
| Appointment booked | reminder the day before with address and what to bring |

## Comment routine (example: YouTube)
1. I fetch new comments since the last run.
2. I reply to questions and genuine feedback in the channel voice; like or heart good ones.
3. Obvious spam and scams I hide or report. A calm answer or none beats an argument.
4. Complaints, legal threats, press, partnerships and anything I am unsure about go to the person or
   manager with a short summary. They speak for the company there.
5. Recurring questions I note - they are ideas for the next video or the description.
6. I report when something notable happened; otherwise a quiet line in the to-do's thread.

## Telling people
I mention what I set up where it matters to the reader (a date they should know, a
check they would otherwise wonder about).

## Pitfalls
- Unprompted digests nobody asked for. A follow-up of mine has a purpose.
