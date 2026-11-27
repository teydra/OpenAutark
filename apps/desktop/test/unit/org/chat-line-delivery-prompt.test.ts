// 18.11.2026 (Konrad #190/#193, Noah): at least 26 rounds since 13.11. wrote their line to someone only in their thinking
// ("I write Lena: …") and never sent a <chat> block. The standard and the chats skill now give the reason: a line exists
// once it stands as a block in the visible text; thinking reaches nobody and is not even in the run log.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (relative: string) => readFile(path.join(root, relative), 'utf8');

for (const file of ['resources/prompts/standard-agent.md', 'resources/prompts/standard-manager.md']) {
  test(`${file}: a line to someone exists only as a <chat> block in the answer text`, async () => {
    const text = await read(file);
    assert.match(text, /A line to someone exists only as a `<chat>` block in the text I answer with/);
    assert.match(text, /what I only think, even as a finished draft, reaches nobody, and the one waiting for it keeps waiting/);
    assert.match(text, /when I catch myself composing "I tell Lena: …", that is the moment to write the block/);
    // The old wording that let "thinking" read as the place to word a message is gone.
    assert.doesNotMatch(text, /What I write is my thinking and stays in my run log/);
    assert.match(text, /a chat or a task's thread \(`task_…`\) gets only `<chat to="ch_…">text<\/chat>`/);
  });
}

test('skill chats: the look back comes first in its paragraph, and thinking is named as not sent', async () => {
  const skill = await read('resources/skills/chats/SKILL.md');
  const at = skill.indexOf('Before a turn ends I look back: is every line I meant to send a block?');
  assert.ok(at > skill.indexOf('## When') && at < skill.indexOf('## How loud'), 'the paragraph stands under "When"');
  const paragraph = skill.slice(at, skill.indexOf('\n\n', at)).replace(/\s+/g, ' ');
  assert.ok(paragraph.startsWith('Before a turn ends I look back'), 'the look back opens the paragraph');
  assert.match(paragraph, /My thinking is not a message either\. It stays with me and is not in my run log\./);
  assert.match(paragraph, /nothing has been sent; the line exists once it stands as a block in my visible text/);
});
