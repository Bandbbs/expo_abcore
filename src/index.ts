import { ExpoABCoreNative } from './native';
import { InstallQueueController } from './queue';
import { Platform } from 'react-native';

import type {
  DeviceProfile,
  DeviceProfileInput,
  DeviceProfilePatch,
  DeviceSnapshot,
  ExpoABCoreEventMap,
  InstallCandidate,
  InstallJob,
  InstallJobInput,
  LocalFile,
  PermissionState,
  RuntimeLicense,
  ScanOptions,
  Subscription,
} from './types';

export * from './types';
export { InstallQueueController } from './queue';

const installQueue = new InstallQueueController({
  connect: (profileId) => ExpoABCoreNative.connect(profileId),
  executeInstall: (job) => ExpoABCoreNative.executeInstall(job),
  loadInstallJobs: () => ExpoABCoreNative.loadInstallJobs(),
  saveInstallJobs: (jobs) => ExpoABCoreNative.saveInstallJobs(jobs),
  addProgressListener: (listener) =>
    ExpoABCoreNative.addListener('installJobChanged', listener),
});

export async function requestPermissions(): Promise<PermissionState> {
  const result = await ExpoABCoreNative.requestPermissions();
  if ('bluetooth' in result) return result;
  const granted = result.granted === true || result.status === 'granted';
  const undetermined = result.status === 'undetermined';
  return {
    bluetooth: granted ? 'granted' : undetermined ? 'undetermined' : 'denied',
    location: Platform.OS === 'ios' || (Platform.OS === 'android' && Number(Platform.Version) >= 31)
      ? 'notRequired'
      : granted
        ? 'granted'
        : undetermined
          ? 'notRequired'
          : 'denied',
    canAskAgain: result.canAskAgain !== false,
  };
}

export function startScan(options?: ScanOptions): Promise<void> {
  return ExpoABCoreNative.startScan(options);
}

export function stopScan(): Promise<void> {
  return ExpoABCoreNative.stopScan();
}

export function listDeviceProfiles(): Promise<DeviceProfile[]> {
  return ExpoABCoreNative.listDeviceProfiles();
}

export function saveDeviceProfile(input: DeviceProfileInput): Promise<DeviceProfile> {
  return ExpoABCoreNative.saveDeviceProfile(input);
}

export function updateDeviceProfile(
  id: string,
  patch: DeviceProfilePatch,
): Promise<DeviceProfile> {
  return ExpoABCoreNative.updateDeviceProfile(id, patch);
}

export function removeDeviceProfile(id: string): Promise<void> {
  return ExpoABCoreNative.removeDeviceProfile(id);
}

export function connect(id: string): Promise<DeviceSnapshot> {
  return ExpoABCoreNative.connect(id);
}

export function disconnect(): Promise<void> {
  return ExpoABCoreNative.disconnect();
}

export function getDeviceSnapshot(id?: string): Promise<DeviceSnapshot | null> {
  return ExpoABCoreNative.getDeviceSnapshot(id);
}

export function refreshDeviceSnapshot(): Promise<DeviceSnapshot> {
  return ExpoABCoreNative.refreshDeviceSnapshot();
}

export function classifyInstallFile(input: LocalFile): Promise<InstallCandidate | null> {
  return ExpoABCoreNative.classifyInstallFile(input);
}

export async function enqueueInstall(input: InstallJobInput): Promise<InstallJob> {
  return installQueue.enqueue(input);
}

export async function listInstallJobs(): Promise<InstallJob[]> {
  await installQueue.hydrate();
  return [...installQueue.snapshot()];
}

export function subscribeInstallJobs(listener: () => void): () => void {
  return installQueue.subscribe(listener);
}

export function getInstallJobsSnapshot(): readonly InstallJob[] {
  return installQueue.snapshot();
}

export function retryInstall(id: string, options?: { force?: boolean }): Promise<void> {
  return installQueue.retry(id, options);
}

export function removeInstall(id: string): Promise<boolean> {
  return installQueue.remove(id);
}

export function removeInstallsForSource(sourceId: string): Promise<void> {
  return installQueue.removeBySourceId(sourceId);
}

export async function pauseInstallQueue(): Promise<void> {
  installQueue.pause();
}

export async function resumeInstallQueue(): Promise<void> {
  installQueue.resume();
}

export function getRuntimeLicenses(): Promise<RuntimeLicense[]> {
  return ExpoABCoreNative.getRuntimeLicenses();
}

export function addExpoABCoreListener<K extends keyof ExpoABCoreEventMap>(
  eventName: K,
  listener: (event: ExpoABCoreEventMap[K]) => void,
): Subscription {
  return ExpoABCoreNative.addListener(eventName, listener);
}
