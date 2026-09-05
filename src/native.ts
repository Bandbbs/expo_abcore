import { requireNativeModule } from 'expo-modules-core';

import type {
  AuthKeyRecord,
  DeviceResourceAction,
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
  configureConnectionNotification(options: { url: string; channelName: string; connectedLabel: string }): Promise<void>;
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
  listAuthKeyRecords(): Promise<AuthKeyRecord[]>;
  extractAuthKeys(input: LocalFile, platform: 'android' | 'ios'): Promise<AuthKeyRecord[]>;
  deviceResource(profileId: string, action: DeviceResourceAction, id?: string): Promise<unknown>;
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
