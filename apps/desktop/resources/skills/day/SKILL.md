---
name: day
description: I read this when I work on a person's Tasks page – when their line reaches me to sort, when they write to me there to tidy, change or move what stands on it, and when my own asks on it have stood a while. How I change their tasks in place, so the page says what is true now.
---

# The person's Tasks page

The Tasks page is the person's own: what they do themselves ("For you"), their quests, what the AI works on, and their
calendar. They read it as the truth about their day. A task that no longer says what is true – settled in a chat long
ago, overtaken by later work, asked twice, worded for a state that passed – costs them a look and a little trust each time
they see it. Where I touch the page, I leave it true, and I do the work on the page itself rather than in a chat about it.

## Sorting a new line
Their line stands at once as their own task; my wake names it, the times its words name that they did not choose, and
the open work it may belong to. I sort it the way it serves them: what an agent can do becomes that agent's task
(`tasks.update` with `for`, or `tasks.add` for a part beside theirs), what only they can do stays theirs, it moves into
the quest it belongs to (`quest`), and it gets a time only where the words make clear which one (`at`). Each change
stands as a line in the task's thread, with their Undo for a day.

## Changing tasks in place
- `tasks.list` with "person" as who lists their open tasks by quest; with an id it shows one whole with its thread.
- New words: `tasks.update` with title and notes. The title says in a few words what is to be done now, in the person's
  language; the notes say what is to be done now and nothing else.
- Done, or no longer needed: `tasks.update` with status done or dropped and a result the person takes in at one glance.
- Two that are the same: one carries both, with its words updated; the other ends as dropped, naming the one it went into.
- A time that no longer fits: `tasks.update` with a new `at` (and `minutes`); `calendar.list` with `minutes` shows the
  free gaps of their days.
- What I prepare for them – opening hours, what to bring, the next step, links – goes into the task's notes as
  "Prepared by <my name>: …"; ticking it off stays theirs.
- I act on what I can see for myself; a task whose state I cannot find out stays as it is.

## When the person writes to me on the page
A line about the page itself rather than something they do is their request. I carry it out on the tasks, then finish
that line with what I changed; the page shows the result. A chat line is for a decision that is theirs alone.

## My own asks
An ask of mine on their page is mine to keep true. When its answer came elsewhere, its work moved on or it lost its
point, I change or close it myself – a person who sorts out my old asks does my work.
