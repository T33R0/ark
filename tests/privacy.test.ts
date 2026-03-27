// ============================================================================
// Ark — Privacy & Multi-Agent Isolation Tests
// ============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ScopedStore, PrivacyError, checkAccess, DEFAULT_PRIVACY } from '../src/persistence/privacy.js';
import { MemoryStore } from '../src/persistence/memory.js';
import type { PrivacyConfig } from '../src/types.js';

describe('Privacy & Isolation', () => {

  describe('checkAccess', () => {
    it('owner can access everything', () => {
      assert.equal(checkAccess('owner', 'owner'), true);
      assert.equal(checkAccess('owner', 'admin'), true);
      assert.equal(checkAccess('owner', 'public'), true);
    });

    it('admin can access admin and public', () => {
      assert.equal(checkAccess('admin', 'owner'), false);
      assert.equal(checkAccess('admin', 'admin'), true);
      assert.equal(checkAccess('admin', 'public'), true);
    });

    it('other can only access public', () => {
      assert.equal(checkAccess('other', 'owner'), false);
      assert.equal(checkAccess('other', 'admin'), false);
      assert.equal(checkAccess('other', 'public'), true);
    });
  });

  describe('DEFAULT_PRIVACY', () => {
    it('has sensible defaults', () => {
      assert.equal(DEFAULT_PRIVACY.owner, 'self');
      assert.equal(DEFAULT_PRIVACY.visibility?.conversations, 'owner');
      assert.equal(DEFAULT_PRIVACY.visibility?.mind, 'owner');
      assert.equal(DEFAULT_PRIVACY.visibility?.soul, 'admin');
      assert.equal(DEFAULT_PRIVACY.visibility?.state, 'owner');
      assert.equal(DEFAULT_PRIVACY.visibility?.ledger, 'admin');
      assert.equal(DEFAULT_PRIVACY.visibility?.handoff, 'owner');
    });
  });

  describe('ScopedStore', () => {
    const privacy: PrivacyConfig = {
      owner: 'ellie',
      visibility: {
        conversations: 'owner',
        mind: 'owner',
        soul: 'admin',
        state: 'owner',
        ledger: 'admin',
        handoff: 'owner',
      },
    };

    it('owner can access all resources', async () => {
      const inner = new MemoryStore();
      await inner.init();
      const store = new ScopedStore(inner, 'liora', privacy, 'owner');

      // These should all succeed without throwing
      await store.getSoul();
      await store.getMind();
      await store.getLedger();
      await store.getAllState();
      await store.getLatestHandoff();
      await store.listSessions();
    });

    it('admin can access admin-visible resources', async () => {
      const inner = new MemoryStore();
      await inner.init();
      const store = new ScopedStore(inner, 'liora', privacy, 'admin');

      // Soul and ledger are admin-visible
      await store.getSoul();
      await store.getLedger();
    });

    it('admin cannot access owner-only resources', async () => {
      const inner = new MemoryStore();
      await inner.init();
      const store = new ScopedStore(inner, 'liora', privacy, 'admin');

      await assert.rejects(() => store.getMind(), PrivacyError);
      await assert.rejects(() => store.getAllState(), PrivacyError);
      await assert.rejects(() => store.getLatestHandoff(), PrivacyError);
      await assert.rejects(() => store.listSessions(), PrivacyError);
    });

    it('other cannot access any default resource', async () => {
      const inner = new MemoryStore();
      await inner.init();
      const store = new ScopedStore(inner, 'liora', privacy, 'other');

      await assert.rejects(() => store.getSoul(), PrivacyError);
      await assert.rejects(() => store.getMind(), PrivacyError);
      await assert.rejects(() => store.getLedger(), PrivacyError);
      await assert.rejects(() => store.getAllState(), PrivacyError);
      await assert.rejects(() => store.getLatestHandoff(), PrivacyError);
      await assert.rejects(() => store.listSessions(), PrivacyError);
    });

    it('public visibility allows all access', async () => {
      const publicPrivacy: PrivacyConfig = {
        owner: 'test',
        visibility: {
          conversations: 'public',
          mind: 'public',
          soul: 'public',
          state: 'public',
          ledger: 'public',
          handoff: 'public',
        },
      };

      const inner = new MemoryStore();
      await inner.init();
      const store = new ScopedStore(inner, 'test', publicPrivacy, 'other');

      // All should succeed
      await store.getSoul();
      await store.getMind();
      await store.getLedger();
      await store.getAllState();
      await store.getLatestHandoff();
      await store.listSessions();
    });

    it('canAccess reports correctly', () => {
      const inner = new MemoryStore();
      const store = new ScopedStore(inner, 'liora', privacy, 'admin');

      assert.equal(store.canAccess('soul'), true);      // admin visibility
      assert.equal(store.canAccess('ledger'), true);     // admin visibility
      assert.equal(store.canAccess('mind'), false);      // owner only
      assert.equal(store.canAccess('state'), false);     // owner only
      assert.equal(store.canAccess('handoff'), false);   // owner only
      assert.equal(store.canAccess('conversations'), false); // owner only
    });

    it('asRole creates a new scoped view', async () => {
      const inner = new MemoryStore();
      await inner.init();
      const ownerStore = new ScopedStore(inner, 'liora', privacy, 'owner');
      const adminStore = ownerStore.asRole('admin');

      // Owner can access mind
      await ownerStore.getMind();

      // Admin cannot
      await assert.rejects(() => adminStore.getMind(), PrivacyError);
    });

    it('delegates write operations with privacy checks', async () => {
      const inner = new MemoryStore();
      await inner.init();

      const ownerStore = new ScopedStore(inner, 'liora', privacy, 'owner');
      const adminStore = new ScopedStore(inner, 'liora', privacy, 'admin');

      // Owner can write to mind
      const nodeId = await ownerStore.addMindNode({
        content: 'Private knowledge',
        node_type: 'fact',
        signal: 0.5,
        heat: 1.0,
        depth: 1,
        tags: ['private'],
      });
      assert.ok(nodeId);

      // Admin cannot write to mind (owner-only)
      await assert.rejects(
        () => adminStore.addMindNode({
          content: 'Admin trying to write',
          node_type: 'fact',
          signal: 0.5,
          heat: 1.0,
          depth: 1,
          tags: [],
        }),
        PrivacyError,
      );

      // Admin CAN add soul directives (admin visibility)
      const soulId = await adminStore.addSoulDirective({
        directive: 'System maintenance rule',
        priority: 5,
        active: true,
      });
      assert.ok(soulId);
    });

    it('PrivacyError has correct name', () => {
      const err = new PrivacyError('test');
      assert.equal(err.name, 'PrivacyError');
      assert.ok(err instanceof Error);
    });

    it('defaults missing visibility to owner', async () => {
      const minimalPrivacy: PrivacyConfig = { owner: 'test' };
      const inner = new MemoryStore();
      await inner.init();

      const adminStore = new ScopedStore(inner, 'test', minimalPrivacy, 'admin');

      // Without explicit visibility, defaults to owner-only
      await assert.rejects(() => adminStore.getMind(), PrivacyError);
    });
  });
});
