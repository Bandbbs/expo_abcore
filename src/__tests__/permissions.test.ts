import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizePermissionState } from '../types';

test('Android 12 and newer treats nearby devices as the only scan permission', () => {
  assert.deepEqual(
    normalizePermissionState({ status: 'granted' }, { OS: 'android', Version: 31 }),
    { bluetooth: 'granted', location: 'notRequired', canAskAgain: true },
  );
});

test('Android 11 and older keeps location permission in the result', () => {
  assert.deepEqual(
    normalizePermissionState({ status: 'denied' }, { OS: 'android', Version: 30 }),
    { bluetooth: 'denied', location: 'denied', canAskAgain: true },
  );
});
