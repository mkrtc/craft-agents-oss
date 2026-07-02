import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listSkillSummaries, invalidateSkillsCache } from '../../skills/storage.ts';
import { ConfigWatcher } from '../watcher.ts';

function writeSkill(workspaceRoot: string, slug: string, name: string): void {
  const skillDir = join(workspaceRoot, 'skills', slug);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `---
name: "${name}"
description: "Cache invalidation test skill"
---

Instructions for ${name}.
`);
}

type SkillChangeHarness = {
  handleSkillChange(slug: string): void;
};

describe('ConfigWatcher skill cache invalidation', () => {
  it('invalidates skill summaries before broadcasting SKILL.md changes', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'watcher-skill-cache-'));

    try {
      writeSkill(workspaceRoot, 'cache-test', 'Original Skill');
      invalidateSkillsCache();

      const original = listSkillSummaries(workspaceRoot).find(summary => summary.slug === 'cache-test');
      expect(original?.metadata.name).toBe('Original Skill');

      writeSkill(workspaceRoot, 'cache-test', 'Updated Skill');

      let callbackSkillName: string | undefined;
      let callbackSummaryName: string | undefined;
      const watcher = new ConfigWatcher(workspaceRoot, {
        onSkillChange: (_slug, skill) => {
          callbackSkillName = skill?.metadata.name;
          callbackSummaryName = listSkillSummaries(workspaceRoot).find(summary => summary.slug === 'cache-test')?.metadata.name;
        },
      });

      (watcher as unknown as SkillChangeHarness).handleSkillChange('cache-test');

      expect(callbackSkillName).toBe('Updated Skill');
      expect(callbackSummaryName).toBe('Updated Skill');
      expect(listSkillSummaries(workspaceRoot).find(summary => summary.slug === 'cache-test')?.metadata.name).toBe('Updated Skill');
    } finally {
      invalidateSkillsCache();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
