---
name: org-setup-onboarding
description: I read this when I add, change or remove colleagues. Building and keeping a clean agent organisation - as deep as its work (leads, topic leads, doers), split before hiring, each agent owning its SYSTEM.md, merging and archiving, hiring tools.
metadata:
  modes:
    - manager
---

# Building and keeping a clean agent organisation

## The shape
The person steers and prompts; the organisation holds it all together and carries it out: each piece
of work has one owner, each owner a lead who keeps its quest until it is closed, and a doer finishes
or tells its lead at once what is going on. On top the leads stand side by side: each person's
personal manager (an employee who joins gets one, skill head-of-staff) and a head per area with
steady work (`agents.create`, template `head`, reporting to the person). Below, depth follows the
amount of work:
- **Small and demanding** (a book, one product, a few clients): the head and two to four doers.
- **Much coming in** (hundreds of mails a week, many customers): topic leads under the head, each
  with its doers; the head reads their results, not every piece.
- **A doer** for work that comes back every week with its own accounts, skills or voice. One-off or
  parallel pieces are splits (`agents.split`, Ultra): a fixed agent works one thing at a time.
- **A lead under me** when results wait on my look for hours, past about five steady doers, or for
  two topics with their own people and rhythm; it owns that topic's quests, I own that it holds.
- **One level less** when a lead has one doer or passes work on unchanged: a relay, it merges.
- **A personal assistant** beside the personal manager when the person's day needs someone who
  follows every chat (template `secretary`).
I explain this shape to whoever builds the team with me – the person, an employee – and propose
another one before I build it; the shape they choose stands.

## Each agent owns its SYSTEM.md
- A new agent starts from the team's standard SYSTEM.md (the leads' one when it leads) with the few lines I give it at
  hire (`instructions`) under "## My role": what the role is for, who it works with, an example of good work.
- In its first turn it writes its role (skill system-prompt); my first line in our 1:1 is the brief for
  that, its first real work a task beside it. A colleague runs on the model its kind of work needs, which I name when I hire it.
- From then on its SYSTEM.md is its own (`agents.update` on itself). What I would change there I
  tell it in a chat; it takes in what fits. When the team's standard changes, an agent whose part is
  still the standard gets the new one by itself; one that made it its own gets the changed lines.

## Keeping it clean
- Two agents doing the same: I merge them – one takes over (`agents.archive` with `successorId`
  hands role, reports and open tasks to the successor).
- An agent idle for a long time with nothing in its area: I archive it; its reports move up and its
  open tasks to the next manager. At least one agent stays.
- Roles that grew apart from their names: the agent renames its role itself; I tell it what I see.
- `agents.update` changes anyone's mode, model, manager, space or home device – the SYSTEM.md
  text stays each agent's own.

## Tools and material
- `agents.templates` lists the role templates; `agents.create` hires one colleague or several (up to
  6 in one call), each with a first name and a role; a template puts them in their area – company,
  brand or private (the secretary: "Private", reporting to the person).
- Patterns (`patterns.find`, `patterns.load`) are example teams; I take what fits.
- An agent system the person already has (`.claude/agents/*.md`, `AGENTS.md`, CrewAI yaml): I read
  its files and create the agents with `agents.create` (skill `import-agent-system`).
- `spaces.list` shows the areas; `spaces.save` creates another one or renames one. The personal
  manager stands outside the spaces and spans all of them.
