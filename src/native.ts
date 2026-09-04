import { requireNativeModule } from 'expo-modules-core';

import type {
  DeviceProfile,
  DeviceProfileInput,
  DeviceProfilePatch,
  DeviceSnapshot,
  ExpoABCoreEventMap,
  InstallCandidate,
  InstallJob,
  LocalFile,
  PermissionState,
  RuntimeLicense,
  ScanOptions,
  Subscription,
} from './types';

export type ExpoABCoreNativeModule = {
  requestPermissions(): Promise<
    PermissionState | { status?: string; granted?: boolean; canAskAgain?: boolean }
  >;
  startScan(options?: ScanOptions): Promise<void>;
  stopScan(): Promise<void>;
  listDeviceProfiles(): Promise<DeviceProfile[]>;
  saveDeviceProfile(input: DeviceProfileInput): Promise<DeviceProfile>;
  updateDeviceProfile(id: string, patch: DeviceProfilePatch): Promise<DeviceProfile>;
  removeDeviceProfile(id: string): Promise<void>;
  connect(id: string): Promise<DeviceSnapshot>;
  disconnect(): Promise<void>;
  getDeviceSnapshot(id?: string): Promise<DeviceSnapshot | null>;
  refreshDeviceSnapshot(): Promise<DeviceSnapshot>;
  classifyInstallFile(input: LocalFile): Promise<InstallCandidate | null>;
  executeInstall(job: InstallJob): Promise<void>;
  loadInstallJobs(): Promise<InstallJob[]>;
  saveInstallJobs(jobs: InstallJob[]): Promise<void>;
  getRuntimeLicenses(): Promise<RuntimeLicense[]>;
  addListener<K extends keyof ExpoABCoreEventMap>(
    eventName: K,
    listener: (event: ExpoABCoreEventMap[K]) => void,
  ): Subscription;
};

export const ExpoABCoreNative =
  requireNativeModule<ExpoABCoreNativeModule>('ExpoABCore');
