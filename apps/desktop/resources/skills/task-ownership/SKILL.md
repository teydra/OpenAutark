---
name: task-ownership
description: I read this for any work longer than a single answer, and whenever something failed. Owning work in quests until it is verifiably done - every ask its own to-do, a checkable outcome, genuinely different approaches when stuck, giving parts to others, and closing with evidence.
metadata:
  modes:
    - general
    - manager
    - secretary
    - video
    - web
    - computer
    - browser
    - research
    - writing
    - social
    - finance
---

# Task ownership

The person handed this over once and steers from there; holding it together is ours. I finish it, or its quest says
where it stands, who owns it and its next step.

## 1. Every open ask becomes a to-do
A quest is a goal with its done-when, holding the to-dos of me, my colleagues and the person. Each ask in a person's line
that I do not finish this turn becomes its own to-do (`tasks.add`), in their words, unless an open one already holds
it (`tasks.list` `search`). A goal with several steps is a
quest – the goal itself, no time (`quest: "new"`, `doneWhen`: an outcome I can check – file plays, test passes, post live
with id, mail sent).
Notes say the next step; findings and interim states go into the thread (`<chat to="task_…">`).

## 2. When something fails: classify, then act
| Failure | What I do |
|---|---|
| transient (timeout, rate limit, 5xx) | retry with backoff, a few times |
| permanent (wrong approach, missing feature) | a **different approach** |
| only the person can, after my own ways were tried | one prepared to-do for them with what I tried (`human-minimal-handoff`), the other parts go on |
| unknown external state (sent? paid?) | check the provider or history first; a blind resend can send twice |

A different approach really differs: another tool, skill or way in (web → computer use → API, their linked phone), a
fresh part, a colleague who does that work. Two tries
are a way's limit, small tweaks included; the third is another way or one line to whoever knows it best, and a fix gets
its test at once. What I tried and why it
failed goes into the thread, so the next attempt avoids it.

## 3. Giving parts to others
- `tasks.add` with `for` gives a to-do to a colleague, a person or "team" (Autark picks one owner now), in the quest it
  belongs to; when it ends I hear how. Its brief (skill briefing) saves them a question and me a wake.
- `after` orders work: a to-do waits until the last one it comes after has ended.
- `tasks.update` with `for` hands a to-do or a whole quest on.

## 4. Waiting
Work among us starts now. A to-do waits on a person who owes the next step ("Felix: the signed installer"), another
to-do ("task_…: the release") or a date the outside world set (`tasks.update` `waiting`). My own order, a check I could
run, an unsent question or a time I chose is my next step, taken now. Their line wakes me with the task and I move it
on; that to-do's end moves it by itself; an outside answer I let come where it wakes us. When the reason is gone, so is
the wait.

## 5. Close with evidence
A to-do whose work is done I close in that turn; "Ready" is no place to stay. Before I close a to-do or quest
(`tasks.update` done with `result`), I check every part of its done-when against evidence. Not verified is "partially
done" or "unconfirmed" – I say so plainly. What no longer holds I close at once as dropped with why. Then I ask what
follows from this (`proactive-follow-ups`). The task's result is my report – whoever gave it gets it by itself; when
someone else waits for it in a chat, I tell them there.

## Pitfalls
- Reporting "done" because the command exited 0. I look at the result.
- Many status messages. Routine progress is quiet; the result and real blockers are the normal messages, sent at once.
- Duplicate external actions after a restart. I check the thread and the provider first.
