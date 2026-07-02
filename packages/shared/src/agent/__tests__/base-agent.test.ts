/**
 * Tests for BaseAgent abstract class
 *
 * Uses TestAgent (concrete implementation) to verify BaseAgent functionality.
 * Tests model/thinking configuration, permission mode, source management,
 * and lifecycle management.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AbortReason } from '../backend/types.ts';
import {
  TestAgent,
  createMockBackendConfig,
  createMockSource,
  collectEvents,
} from './test-utils.ts';

describe('BaseAgent', () => {
  let agent: TestAgent;

  beforeEach(() => {
    agent = new TestAgent(createMockBackendConfig());
  });

  describe('Model Configuration', () => {
    it('should initialize with config model', () => {
      expect(agent.getModel()).toBe('test-model');
    });

    it('should allow setting model', () => {
      agent.setModel('new-model');
      expect(agent.getModel()).toBe('new-model');
    });
  });

  describe('Thinking Level Configuration', () => {
    it('should initialize with config thinking level', () => {
      expect(agent.getThinkingLevel()).toBe('medium');
    });

    it('should allow setting thinking level', () => {
      agent.setThinkingLevel('max');
      expect(agent.getThinkingLevel()).toBe('max');
    });

  });

  describe('Permission Mode', () => {
    it('should have a permission mode', () => {
      const mode = agent.getPermissionMode();
      expect(['safe', 'ask', 'allow-all']).toContain(mode);
    });

    it('should allow setting permission mode', () => {
      agent.setPermissionMode('safe');
      expect(agent.getPermissionMode()).toBe('safe');
    });

    it('should notify on permission mode change', () => {
      let notifiedMode = '';
      agent.onPermissionModeChange = (mode) => { notifiedMode = mode; };

      agent.setPermissionMode('allow-all');
      expect(notifiedMode).toBe('allow-all');
    });

    it('should cycle permission modes', () => {
      const initialMode = agent.getPermissionMode();
      const newMode = agent.cyclePermissionMode();
      expect(newMode).not.toBe(initialMode);
    });

    it('should report safe mode correctly', () => {
      agent.setPermissionMode('safe');
      expect(agent.isInSafeMode()).toBe(true);

      agent.setPermissionMode('ask');
      expect(agent.isInSafeMode()).toBe(false);
    });
  });

  describe('Workspace & Session', () => {
    it('should return workspace from config', () => {
      const workspace = agent.getWorkspace();
      expect(workspace.id).toBe('test-workspace-id');
    });

    it('should allow setting workspace', () => {
      agent.setWorkspace({
        id: 'new-workspace',
        name: 'New Workspace',
        slug: 'path',
        rootPath: '/new/path',
        createdAt: Date.now(),
      });
      expect(agent.getWorkspace().id).toBe('new-workspace');
    });

    it('should have session ID', () => {
      expect(agent.getSessionId()).toBeTruthy();
    });

    it('should allow setting session ID', () => {
      agent.setSessionId('new-session-id');
      expect(agent.getSessionId()).toBe('new-session-id');
    });
  });

  describe('Source Management', () => {
    it('should start with no active sources', () => {
      expect(agent.getActiveSourceSlugs()).toEqual([]);
    });

    it('should track source servers', async () => {
      await agent.setSourceServers(
        { 'source-1': { type: 'http', url: 'http://test' } },
        { 'source-2': {} },
        ['source-1', 'source-2']
      );

      expect(agent.getActiveSourceSlugs()).toContain('source-1');
      expect(agent.getActiveSourceSlugs()).toContain('source-2');
    });

    it('should check if source is active', async () => {
      await agent.setSourceServers(
        { 'active-source': { type: 'http', url: 'http://test' } },
        {},
        ['active-source']
      );

      expect(agent.isSourceServerActive('active-source')).toBe(true);
      expect(agent.isSourceServerActive('inactive-source')).toBe(false);
    });

    it('should track all sources', () => {
      const sources = [
        createMockSource({ slug: 'source-1' }),
        createMockSource({ slug: 'source-2' }),
      ];

      agent.setAllSources(sources);
      expect(agent.getAllSources()).toHaveLength(2);
    });

    it('should allow marking source as unseen', () => {
      // This should not throw
      agent.markSourceUnseen('some-source');
    });

    it('should track temporary clarifications', () => {
      agent.setTemporaryClarifications('Test clarification');
      // Clarifications are internal state - verify via PromptBuilder if needed
    });
  });

  describe('Manager Accessors', () => {
    it('should provide access to SourceManager', () => {
      const manager = agent.getSourceManager();
      expect(manager).toBeTruthy();
    });

    it('should provide access to PermissionManager', () => {
      const manager = agent.getPermissionManager();
      expect(manager).toBeTruthy();
    });

    it('should provide access to PromptBuilder', () => {
      const builder = agent.getPromptBuilder();
      expect(builder).toBeTruthy();
    });
  });

  describe('Lifecycle', () => {
    it('should track processing state', () => {
      expect(agent.isProcessing()).toBe(false);
    });

    it('should emit complete event from chat', async () => {
      const events = await collectEvents(agent.chat('test message'));
      expect(events.some(e => e.type === 'complete')).toBe(true);
    });

    it('should track chat calls', async () => {
      await collectEvents(agent.chat('test message'));
      expect(agent.chatCalls).toHaveLength(1);
      expect(agent.chatCalls[0]?.message).toBe('test message');
    });

    it('injects internal label-skill anchor context and strips provider options', async () => {
      await collectEvents(agent.chat('test message', undefined, {
        internal: {
          labelSkillAnchors: {
            block: '<label-skill-bindings-context>{}</label-skill-bindings-context>',
            kind: 'active',
            activeBindingIds: ['binding-1'],
            configHash: 'hash',
          },
        },
      }));
      expect(agent.chatCalls[0]?.message).toStartWith('<label-skill-bindings-context>');
      expect(agent.chatCalls[0]?.message).toEndWith('test message');
      expect(agent.chatCalls[0]?.options).toBeUndefined();
    });

    it('keeps /compact as the first bytes when injecting hidden context', async () => {
      await collectEvents(agent.chat('/compact preserve this', undefined, {
        internal: {
          labelSkillAnchors: {
            block: '<label-skill-bindings-context>{}</label-skill-bindings-context>',
            kind: 'active',
            activeBindingIds: ['binding-1'],
            configHash: 'hash',
          },
        },
      }));
      expect(agent.chatCalls[0]?.message.startsWith('/compact')).toBe(true);
      expect(agent.chatCalls[0]?.message).toContain('<label-skill-bindings-context>');
      expect(agent.chatCalls[0]?.options).toBeUndefined();
    });

    it('bootstraps label-bound skill paths through the standard read directive and strips internal options', async () => {
      let registered: unknown;
      await collectEvents(agent.chat('test message', undefined, {
        internal: {
          labelSkillAnchors: {
            block: '<label-skill-bindings-context>{}</label-skill-bindings-context>',
            kind: 'active',
            activeBindingIds: ['binding-1'],
            configHash: 'hash',
          },
          labelSkillBootstrap: {
            entries: [{
              bindingId: 'binding-1',
              labelId: 'review',
              skillSlug: 'audit',
              skillPath: '/tmp/audit/SKILL.md',
            }],
            configHash: 'hash',
            onRegistered: event => { registered = event; },
          },
        },
      }));

      expect(agent.chatCalls[0]?.message).toContain('Before proceeding with the user\'s request, you MUST read the following skill instruction files');
      expect(agent.chatCalls[0]?.message).toContain('/tmp/audit/SKILL.md (skill: audit)');
      expect(agent.chatCalls[0]?.message).toContain('<label-skill-bindings-context>');
      expect(agent.chatCalls[0]?.message).toEndWith('test message');
      expect(agent.chatCalls[0]?.options).toBeUndefined();
      expect(registered).toMatchObject({ bindingIds: ['binding-1'], skillSlugs: ['audit'], configHash: 'hash' });
    });

    it('keeps /compact as the first bytes when bootstrap options are present', async () => {
      await collectEvents(agent.chat('/compact preserve this', undefined, {
        internal: {
          labelSkillBootstrap: {
            entries: [{
              bindingId: 'binding-1',
              labelId: 'review',
              skillSlug: 'audit',
              skillPath: '/tmp/audit/SKILL.md',
            }],
            configHash: 'hash',
          },
        },
      }));

      expect(agent.chatCalls[0]?.message.startsWith('/compact')).toBe(true);
      expect(agent.chatCalls[0]?.message).toContain('/tmp/audit/SKILL.md (skill: audit)');
      expect(agent.chatCalls[0]?.options).toBeUndefined();
    });

    it('dedupes explicit skill mentions before label-bound bootstrap paths', async () => {
      const tmpRoot = mkdtempSync(join(tmpdir(), 'base-agent-skill-'));
      try {
        const skillDir = join(tmpRoot, 'skills', 'audit');
        mkdirSync(skillDir, { recursive: true });
        const skillPath = join(skillDir, 'SKILL.md');
        writeFileSync(skillPath, '---\nname: Audit\ndescription: Audit carefully\n---\nRead this skill.\n', 'utf-8');
        const tmpAgent = new TestAgent(createMockBackendConfig({
          workspace: {
            id: 'test-workspace-id',
            name: 'Test Workspace',
            slug: 'workspace',
            rootPath: tmpRoot,
            createdAt: Date.now(),
          },
          session: {
            id: 'test-session-id',
            workspaceRootPath: tmpRoot,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            workingDirectory: tmpRoot,
          },
        }));

        await collectEvents(tmpAgent.chat('[skill:audit] do it', undefined, {
          internal: {
            labelSkillBootstrap: {
              entries: [{ bindingId: 'binding-1', labelId: 'review', skillSlug: 'audit', skillPath: '/different/audit/SKILL.md' }],
              configHash: 'hash',
            },
          },
        }));

        const message = tmpAgent.chatCalls[0]?.message ?? '';
        expect(message).toContain(`${skillPath} (skill: audit)`);
        expect(message).not.toContain('/different/audit/SKILL.md');
        expect((message.match(/\(skill: audit\)/g) ?? []).length).toBe(1);
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it('should track abort calls', async () => {
      await agent.abort('test reason');
      expect(agent.abortCalls).toHaveLength(1);
      expect(agent.abortCalls[0]?.reason).toBe('test reason');
    });

    it('should delegate handoff interrupts to forceAbort by default', () => {
      agent.interruptForHandoff(AbortReason.AuthRequest);
      expect(agent.forceAbortCalls).toHaveLength(1);
      expect(agent.forceAbortCalls[0]?.reason).toBe(AbortReason.AuthRequest);
    });

    it('should track respondToPermission calls', () => {
      agent.respondToPermission('req-1', true, false);
      expect(agent.respondToPermissionCalls).toHaveLength(1);
      expect(agent.respondToPermissionCalls[0]).toEqual({
        requestId: 'req-1',
        allowed: true,
        alwaysAllow: false,
      });
    });

    it('should cleanup on destroy', () => {
      // Should not throw
      agent.destroy();
    });

    it('should cleanup on dispose (alias)', () => {
      // Should not throw
      agent.dispose();
    });
  });

  describe('Callbacks', () => {
    it('should support debug callback', () => {
      let message = '';
      agent.onDebug = (msg) => { message = msg; };

      // Trigger a debug message by setting thinking level
      agent.setThinkingLevel('off');
      expect(message).toContain('Thinking level');
    });

    it('should support permission mode change callback', () => {
      let mode = '';
      agent.onPermissionModeChange = (m) => { mode = m; };

      agent.setPermissionMode('allow-all');
      expect(mode).toBe('allow-all');
    });
  });

  describe('Config Watcher', () => {
    it('should not start config watcher when skipConfigWatcher is true', () => {
      // Simulates the SessionManager scenario: isHeadless=false but server owns the watcher
      const managedAgent = new TestAgent(createMockBackendConfig({
        isHeadless: false,
        skipConfigWatcher: true,
      }));
      // configWatcherManager should remain null — the guard in startConfigWatcher() returns early
      expect(managedAgent.getConfigWatcherManager()).toBeNull();
      managedAgent.destroy();
    });

    it('should not start config watcher when isHeadless is true (existing behavior)', () => {
      // Simulates temp/headless agents — existing isHeadless guard still works
      const headlessAgent = new TestAgent(createMockBackendConfig({
        isHeadless: true,
      }));
      expect(headlessAgent.getConfigWatcherManager()).toBeNull();
      headlessAgent.destroy();
    });
  });
});
