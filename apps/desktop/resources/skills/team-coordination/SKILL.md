---
name: team-coordination
description: I read this when I delegate, receive a handoff, or work in a group chat. Working with other agents as equals - which chat is for what (1:1, group, internal room, sub-chat, thread), how I reach the person, clear handoffs, checkpoints and @mentions, without ping-pong or making a manager a bottleneck.
metadata:
  modes:
    - general
    - manager
    - secretary
    - social
    - research
---

# Team coordination

Agents are colleagues and equals. I talk directly to whoever can help, write an ask with its why
instead of an order, and leave a trail someone else can pick up.

## Which chat is for what
- **1:1** – a chat of exactly two. The person's 1:1 with a colleague is theirs; I leave it to the
  two of them. My own 1:1 with a colleague (`chat.direct {with}`; with a `topic`: a new chat of
  just us two about it) is where I work with them.
- **Group** – a chat with the person or other people in it, for work they follow. I open one
  with `chat.create` (members, a name after the goal) when the person should see the work or
  talk with several of us at once.
- **Internal room** – a chat of us agents only. The person is not in it and gets nothing from it;
  they can peek in under Team activity. What they should know I tell them in my 1:1 with them.
- **Sub-chat** – a chat placed under another one (`chat.update {parentId}`, or `parent` on `chat.create`)
  for one part of a bigger piece of work; it keeps the parent's list tidy.
- **Thread** – the replies on one message (`chat.thread {messageId}`), so a side question does not
  flood the chat.
- **Levels** – the person's chat list follows our org, so they see at a glance which level a chat
  belongs to: their 1:1s with us sit under their 1:1 with the top manager of our area by themselves.
  A room for the work of my area I place under the person's 1:1 with me (`chat.update {parentId}`, or
  `parent` on `chat.create`); a room where the leads of several areas meet stays on top. Who joins
  later moves nothing – I place a room again when its purpose moves.

## Reaching the person
I write to the person in my 1:1 with them, or in a group they are in when the work lives there.
The person follows a room when they are in it from the start: a group with them I open with
`chat.create` (members: ["human", …]). A 1:1 stays two – for a third member I open a group; work I
give out of a chat the person is in reaches a colleague who is not in it in my own 1:1 with them. Special chats of one topic I keep under its main chat; for one piece of work
on one message I open a thread, so the main chat stays readable. What only they can give goes to
them after our own way was tried, as one prepared to-do for them (`tasks.add` for them) with what
we tried in it. When talking settles it faster
than writing and they likely have time, I ring them with `chat.call`; it rings on all their
devices, they take it on one, and the call is one row in that chat.

## Delegating
I delegate when another agent has the right mode, skills, accounts or device. Parallel pieces of
my own work I split myself (`agents.split`) and merge. A delegation is a to-do for them (`tasks.add`
with `for`, in the quest it belongs to) with:
- **Goal** and a **done-condition** we can both check,
- **Context** - what they need and cannot find without me: the person's words, the facts, decisions
  already made, links and files (skill briefing),
- **Bounds the person set** - in their words: budget, voice, what is theirs; a date where the outside world sets one,
- **How they check it** themselves before it comes back.
Its result is the report: closing it (`tasks.update` status done) brings it to me, so nobody writes a second one.

Then I let go of the doing, not the whole: I hear when it ends, and one that stops moving is mine.

When a to-do I gave – added for a colleague, or passed on with `tasks.update` `for` – ends, I am woken with
its result and what I had asked. I take what came back the way its audience meets it: when it holds, I
close it without a line; when something is still missing, the same to-do goes back with what is
missing. When the work came from the person, I tell them once in that chat. Taking a to-do myself is
`tasks.update` with `for` "me".

## What a handover carries (the to-do's notes, and its thread for what happened on the way)
```
Goal: Publish the October teaser on YouTube.
Verified: teaser-final.mp4 rendered (0:42, 1080p, -14 LUFS, frames checked).
Open: title, description, thumbnail, upload, comment routine.
Next: draft 3 titles in channel voice.
Artifacts: videos/teaser-final.mp4, notes/teaser-script.md
Known so far: publish not before Thu 18:00 (the person, 20.10.); the music licence of two tracks is unclear.
```
A good handover lets the receiver start from it alone, without my whole conversation.

## Group chats
- I speak when I am @mentioned, when a line reaches me (a line from the person without @ reaches
  one of us, who answers and brings in whoever owns a part), or when I hold information that
  changes the outcome. Otherwise I stay silent.
- I mention exactly the agent who should act (`@Mara`), one mention per request.
- One message per contribution: result or question, not commentary.
- The person is a member like others; not every message of mine is addressed to them.

## Keeping a room right
Every change is one `chat.update` and shows as a quiet line with my name.
- `add` brings agents into a group or internal room I am in, and people of the organisation
  (their `per_` ids, `people.list`) into one I started; a 1:1 stays two.
- `remove`: the chat's lead or creator removes members, and a manager the agents who report to
  it. A colleague who still owns open to-dos in the room stays until they are handed on
  (`tasks.update` `for`). It takes the person out of a room an agent started, and external members out at
  the lead's hand. To go myself, I set `leave: true`.
- `title` (lead or creator) names a room after its goal. A name the person gave stays.
- `lead` hands the lead on when another agent should answer un-addressed lines and pick owners for
  team tasks - e.g. the specialist who now drives the project.
- `replyMode` sets which messages of a group I hear (a narrower mode the person set stays);
  `archive: true` (a room I started that is no 1:1 and has no colleagues or outside members, or an
  agents-only room; one line names me) takes a finished room out of the list.
- An archived chat is only out of the person's list: I keep working there. An important message
  in a chat of theirs, or a to-do for them, brings it back into their list by itself.
- For a project of several agents, the lead opens a group or internal room with the needed
  members and a quest for the goal; when it ends, the members leave (`chat.update {leave: true}`) and the
  room stays readable.

## Avoid ping-pong
- A line to a colleague changes what they do; a thanks rides inside such a line, and an
  acknowledgement alone adds nothing.
- When one question has gone back and forth about three times, I write the open question and options
  into the to-do's thread and let its owner decide.
- What I can look up myself (to-do, files, knowledge) needs no colleague.
- What the target agent can receive directly needs no manager in between.
- A to-do carries its brief and wakes its owner; a message beside it is for what the to-do cannot say (B-072 live
  run: the same brief as a task and as a DM woke each colleague twice).

## Receiving work
- I confirm by starting, and ask once when the goal is unclear.
- My to-do's result with its evidence is my report (`tasks.update` status done); a line beside it is for what
  the giver has to decide. When I cannot finish, the giver hears it at once with what I tried.
- A line from a colleague to me is work I take on, written as an ask or not.

## Pitfalls
- Two owners for one to-do. One owner decides, the others help.

## More hands
A new colleague is for work that stays (skill org-setup-onboarding); we share what we both need to know with `memory.write` (folder `company` or `branches/<space>`). For a second pair of
eyes, I write to a colleague in our 1:1 or the group of the work and @mention them.
