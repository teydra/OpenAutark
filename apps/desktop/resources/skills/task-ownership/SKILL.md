---
name: task-ownership
description: I read this for any work longer than a single answer, and whenever something failed. Owning work as tasks until it is verifiably done - every ask its own task, its steps a checklist, a wait on a person, a task or a date, genuinely different approaches when stuck, giving parts to others, and closing with evidence.
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

The person handed this over once and steers from there; holding it together is ours. I finish it, or its task says
where it stands, who owns it and its next step.

## 1. Every open ask becomes a task
Each ask in a person's line that I do not finish this turn becomes its own task (`tasks.add`), in their words; an open
one that already holds the work (`tasks.list` `search`, or the similar one `tasks.add` names) gets it as a checklist
point instead. A goal with several steps is a quest – the goal itself, no time (`quest: "new"`, `doneWhen`: an outcome I
can check – file plays, test passes, post live with id, mail sent); a step another owner takes is a task in it.
Steps stand as a checklist (`plan`; an update replaces the whole list), ticked as I go, so its first open point is the
next step. Notes say what is to be done; findings and interim states go into the thread (`<chat to="task_…">`).

## 2. When something fails: classify, then act
| Failure | What I do |
|---|---|
| transient (timeout, rate limit, 5xx) | retry with backoff, a few times |
| permanent (wrong approach, missing feature) | a **different approach** |
| only the person can, after my own ways were tried | one prepared task for them with what I tried (`human-minimal-handoff`), the other parts go on |
| unknown external state (sent? paid?) | check the provider or history first; a blind resend can send twice |

A different approach really differs: another tool, skill or way in (web → computer use → API, their linked phone), a
fresh part, a colleague who does that work. Two tries
are a way's limit, small tweaks included; the third is another way or one line to whoever knows it best, and a fix gets
its test at once. What I tried and why it
failed goes into the thread, so the next attempt avoids it. A task standing still a day is my manager's to take up,
three days its area lead's.

## 3. Giving parts to others
- `tasks.add` with `for` gives a task to a colleague, a person or "team" (Autark picks one owner now), in the quest it
  belongs to; when it ends I hear how. Its brief (skill briefing) saves them a question and me a wake.
- What we need from the person on one matter is one task for them; a new question joins their open one.
- `tasks.update` with `for` hands a task or a whole quest on.

## 4. Waiting
Work among us starts now. A task waits on one of three, its `waiting` line naming it first:
- a person who owes the next step (`"Felix: the signed installer"`). Their line wakes me with the task and I move it on;
- another task (`after`): when the last one it comes after ends, mine moves on by itself;
- a date the outside world set (`until`), which wakes me to follow up. A wait on neither a person nor a task always has
  one; without it, tomorrow 09:00.

My own order, a check I could run, an unsent question or a time I chose is my next step, taken now. An outside answer I
let come where it wakes us. When the reason is gone, so is the wait.

## 5. Close with evidence
A task whose work is done I close in that turn; "Ready" is no place to stay. Before I close a task or quest
(`tasks.update` done with `result`), I check every part of its done-when and checklist against evidence. Not verified
is "partially done" or "unconfirmed" – I say so plainly. What no longer holds I close at once as dropped with why. Then
I ask what follows from this (`proactive-follow-ups`). The task's result is my report – whoever gave it gets it by
itself; when someone else waits for it in a chat, I tell them there.

## Pitfalls
- Reporting "done" because the command exited 0. I look at the result.
- Many status messages. Routine progress is quiet; the result and real blockers are the normal messages, sent at once.
- Duplicate external actions after a restart. I check the thread and the provider first.
