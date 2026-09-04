import assert from 'node:assert/strict';
import test from 'node:test';

import { InstallQueueController, type InstallQueueBackend } from '../queue';
import type { InstallJob, Subscription } from '../types';

function backend(initial: InstallJob[] = []) {
  let stored = initial;
  const executed: string[] = [];
  const listeners = new Set<(job: InstallJob) => void>();
  const value: InstallQueueBackend = {
    connect: async () => undefined,
    executeInstall: async (job) => {
      executed.push(job.id);
    },
    loadInstallJobs: async () => stored,
    saveInstallJobs: async (jobs) => {
      stored = structuredClone(jobs);
    },
    addProgressListener: (listener): Subscription => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
  };
  return { value, executed, getStored: () => stored };
}

test('restores a running job as interrupted', async () => {
  const now = Date.now();
  const fake = backend([
    {
      id: '1',
      profileId: 'p1',
      uri: 'file:///watchface.mwz',
      name: 'watchface.mwz',
      resourceType: 'watchface',
      status: 'running',
      progress: 0.5,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  const queue = new InstallQueueController(fake.value);
  await queue.hydrate();
  assert.equal(queue.snapshot()[0]?.status, 'interrupted');
  assert.equal(fake.getStored()[0]?.errorCode, 'PROCESS_INTERRUPTED');
});

test('resumes a job that was waiting for a connection', async () => {
  const now = Date.now();
  const fake = backend([
    {
      id: '1',
      profileId: 'p1',
      uri: 'file:///watchface.mwz',
      name: 'watchface.mwz',
      resourceType: 'watchface',
      status: 'waitingForConnection',
      progress: 0,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  const queue = new InstallQueueController(fake.value);
  await queue.hydrate();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(fake.executed, ['1']);
  assert.equal(queue.snapshot()[0]?.status, 'success');
});

test('deduplicates active jobs and runs serially', async () => {
  const fake = backend();
  const queue = new InstallQueueController(fake.value);
  const input = {
    id: '1',
    profileId: 'p1',
    uri: 'file:///watchface.mwz',
    name: 'watchface.mwz',
    resourceType: 'watchface' as const,
  };
  await Promise.all([queue.enqueue(input), queue.enqueue(input)]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(fake.executed, ['1']);
  assert.equal(queue.snapshot().length, 1);
  assert.equal(queue.snapshot()[0]?.status, 'success');
});

test('continues after a failed job', async () => {
  const fake = backend();
  fake.value.executeInstall = async (job) => {
    fake.executed.push(job.id);
    if (job.id === '1') throw new Error('failed');
  };
  const queue = new InstallQueueController(fake.value);
  queue.pause();
  await queue.enqueue({
    id: '1', profileId: 'p1', uri: 'file:///a', name: 'a', resourceType: 'watchface',
  });
  await queue.enqueue({
    id: '2', profileId: 'p1', uri: 'file:///b', name: 'b', resourceType: 'quickApp',
  });
  queue.resume();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(fake.executed, ['1', '2']);
  assert.equal(queue.snapshot().find((job) => job.id === '1')?.status, 'error');
  assert.equal(queue.snapshot().find((job) => job.id === '2')?.status, 'success');
});
