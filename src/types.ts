export type DeviceKind = 'xiaomi' | 'vivo';
export type Transport = 'ble' | 'spp';
export type ResourceType = 'watchface' | 'quickApp' | 'firmware';

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'failed';

export type InstallStatus =
  | 'pending'
  | 'waitingForConnection'
  | 'running'
  | 'success'
  | 'error'
  | 'interrupted';

export type PermissionState = {
  bluetooth: 'granted' | 'denied' | 'undetermined';
  location: 'granted' | 'denied' | 'notRequired';
  canAskAgain: boolean;
};

export type ScanOptions = {
  kind?: DeviceKind;
  transport?: Transport;
};

export type ScannedDevice = {
  name: string;
  address: string;
  kind: DeviceKind;
  transports: Transport[];
  rssi?: number;
};

export type DeviceProfile = {
  id: string;
  name: string;
  address: string;
  kind: DeviceKind;
  preferredTransport: Transport;
  sarVersion: number;
  txWinOverrunAllowance: number;
  hasCredentials: boolean;
  lastConnectedAt?: number;
};

export type DeviceProfileInput = Omit<
  DeviceProfile,
  'id' | 'hasCredentials' | 'lastConnectedAt'
> & {
  id?: string;
  authKey?: string;
  authKeyRecordId?: string;
  openId?: string;
};

export type DeviceProfilePatch = Partial<
  Omit<DeviceProfileInput, 'id' | 'kind' | 'address'>
>;

export type DeviceInfo = {
  serialNumber?: string;
  firmwareVersion?: string;
  imei?: string;
  model?: string;
  productDevice?: string;
  macAddress?: string;
  osVersion?: string;
  hardwareVersion?: string;
};

export type DeviceStatus = {
  battery?: {
    capacity: number;
    chargeStatus?: 'UNKNOWN' | 'CHARGING' | 'NOT_CHARGING' | 'FULL';
  };
};

export type DeviceStorage = {
  used: number;
  total: number;
};

export type DeviceSnapshot = {
  profile: DeviceProfile;
  connectionState: ConnectionState;
  info?: DeviceInfo;
  status?: DeviceStatus;
  storage?: DeviceStorage;
  errorCode?: string;
  errorMessage?: string;
};

export type LocalFile = {
  uri: string;
  name: string;
  size?: number;
};

export type InstallCandidate = {
  resourceType: ResourceType;
  compatibleDeviceKinds: DeviceKind[];
  confidence: 'content' | 'manifest' | 'extension';
  packageName?: string;
  versionName?: string;
};

export type InstallJobInput = LocalFile & {
  id: string;
  sourceId?: string;
  profileId: string;
  resourceType: ResourceType;
  packageName?: string;
  force?: boolean;
};

export type InstallJob = InstallJobInput & {
  status: InstallStatus;
  progress: number;
  progressDescription?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
};

export type ExpoABCoreEventMap = {
  scanResult: ScannedDevice;
  scanStateChanged: { scanning: boolean; errorCode?: string; errorMessage?: string };
  connectionChanged: DeviceSnapshot;
  deviceSnapshotChanged: DeviceSnapshot;
  installJobChanged: InstallJob;
};

export type Subscription = { remove(): void };

export type RuntimeLicense = {
  id: string;
  name: string;
  version: string;
  license: string;
  authors: string[];
  repository?: string;
  copyright?: string;
  licenseText?: string;
  source: 'project' | 'javascript' | 'rust' | 'android' | 'ios';
};

export type AuthKeyRecord = { id: string; name: string; platform: 'android' | 'ios' };
export type DeviceResourceAction = 'listWatchfaces' | 'listApps' | 'setWatchface' | 'removeWatchface' | 'launchApp' | 'removeApp';
export type DeviceWatchface = { id: string; name: string; isCurrent: boolean; canRemove?: boolean };
export type DeviceApp = { packageName: string; appName: string; versionCode?: number; canRemove?: boolean };
