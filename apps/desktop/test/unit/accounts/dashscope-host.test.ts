// Felix review (24.11.2026, ch_sc0nvyaa #173): the Qwen Token Plan note under "Plan credits" shows only for a DashScope address
// (shared/model/dashscope-host.ts isDashScopeBaseUrl), not for every compatible key with the switch (DeepSeek, OpenRouter).
// Owns: this host test. Never: the settings UI, accounts or network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDashScopeBaseUrl } from '../../../src/shared/model/dashscope-host.ts';

test('a DashScope address shows the Qwen Token Plan note: intl and China hosts, and their subdomains', () => {
  assert.equal(isDashScopeBaseUrl('https://dashscope-intl.aliyuncs.com/compatible-mode/v1'), true);
  assert.equal(isDashScopeBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1'), true);
  assert.equal(isDashScopeBaseUrl('https://DASHSCOPE-INTL.aliyuncs.com/compatible-mode/v1'), true);
  assert.equal(isDashScopeBaseUrl('https://coding.dashscope.aliyuncs.com/v1'), true);
});

test('other compatible keys do not: DeepSeek, OpenRouter, a missing or empty address', () => {
  assert.equal(isDashScopeBaseUrl('https://api.deepseek.com/v1'), false);
  assert.equal(isDashScopeBaseUrl('https://openrouter.ai/api/v1'), false);
  assert.equal(isDashScopeBaseUrl(''), false);
  assert.equal(isDashScopeBaseUrl(undefined), false);
  assert.equal(isDashScopeBaseUrl(null), false);
  assert.equal(isDashScopeBaseUrl('not a url'), false);
});

test('no wildcard on aliyun: other Alibaba hosts and look-alike hosts do not match', () => {
  assert.equal(isDashScopeBaseUrl('https://ecs.aliyuncs.com/v1'), false);
  assert.equal(isDashScopeBaseUrl('https://aliyun.com/dashscope'), false);
  assert.equal(isDashScopeBaseUrl('https://dashscope.aliyuncs.com.evil.example/v1'), false);
  assert.equal(isDashScopeBaseUrl('https://notdashscope.aliyuncs.com/v1'), false);
  assert.equal(isDashScopeBaseUrl('https://dashscope.aliyuncs.example/v1'), false);
});
