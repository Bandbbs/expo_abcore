import type { InstallJob, InstallJobInput, Subscription } from './types';

export interface InstallQueueBackend {
  connect(profileId: string): Promise<unknown>;
  executeInstall(job: InstallJob): Promise<void>;
  loadInstallJobs(): Promise<InstallJob[]>;
  saveInstallJobs(jobs: InstallJob[]): Promise<void>;
  addProgressListener(listener: (job: InstallJob) => void): Subscription;
}

export class InstallQueueController {
  private jobs: InstallJob[] = [];
  private hydrated = false;
  private hydratePromise: Promise<void> | null = null;
  private running = false;
  private paused = false;
  private listeners = new Set<() => void>();
  private progressSubscription: Subscription;

  constructor(private readonly backend: InstallQueueBackend) {
    this.progressSubscription = backend.addProgressListener((job) => {
      const current = this.jobs.find((item) => item.id === job.id);
      if (!current || current.status !== 'running') return;
      this.patch(job.id, {
        progress: Math.max(0, Math.min(1, job.progress)),
        progressDescription: job.progressDescription,
        updatedAt: Date.now(),
      });
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): readonly InstallJob[] {
    return this.jobs;
  }

  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    if (!this.hydratePromise) {
      this.hydratePromise = this.hydrateNow();
    }
    await this.hydratePromise;
  }

  private async hydrateNow(): Promise<void> {
    const stored = await this.backend.loadInstallJobs();
    const now = Date.now();
    this.jobs = stored.map((job) => {
      if (job.status === 'running') {
        return {
          ...job,
          status: 'interrupted',
          errorCode: 'PROCESS_INTERRUPTED',
          errorMessage: 'Installation was interrupted when the app stopped.',
          updatedAt: now,
        } satisfies InstallJob;
      }
      if (job.status === 'waitingForConnection') {
        return {
          ...job,
          status: 'pending',
          updatedAt: now,
        } satisfies InstallJob;
      }
      return job;
    });
    this.hydrated = true;
    this.hydratePromise = null;
    await this.persist();
    this.emit();
    void this.run();
  }

  async enqueue(input: InstallJobInput): Promise<InstallJob> {
    await this.hydrate();
    const existing = this.jobs.find((job) => job.id === input.id);
    if (existing && ['pending', 'waitingForConnection', 'running'].includes(existing.status)) {
      return existing;
    }
    const now = Date.now();
    const job: InstallJob = {
      ...input,
      status: 'pending',
      progress: 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.jobs = existing
      ? this.jobs.map((item) => (item.id === job.id ? job : item))
      : [...this.jobs, job];
    await this.persistAndEmit();
    void this.run();
    return job;
  }

  async retry(id: string, options?: { force?: boolean }): Promise<void> {
    await this.hydrate();
    const job = this.jobs.find((item) => item.id === id);
    if (!job || job.status === 'running' || job.status === 'waitingForConnection') return;
    this.patch(id, {
      status: 'pending',
      progress: 0,
      progressDescription: undefined,
      errorCode: undefined,
      errorMessage: undefined,
      force: options?.force ?? job.force,
      updatedAt: Date.now(),
    });
    await this.persist();
    void this.run();
  }

  async remove(id: string): Promise<boolean> {
    await this.hydrate();
    const job = this.jobs.find((item) => item.id === id);
    if (!job || job.status === 'running' || job.status === 'waitingForConnection') {
      return false;
    }
    this.jobs = this.jobs.filter((item) => item.id !== id);
    await this.persistAndEmit();
    return true;
  }

  async removeBySourceId(sourceId: string): Promise<void> {
    await this.hydrate();
    this.jobs = this.jobs.filter(
      (job) =>
        job.sourceId !== sourceId
        || job.status === 'running'
        || job.status === 'waitingForConnection',
    );
    await this.persistAndEmit();
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    void this.run();
  }

  dispose(): void {
    this.progressSubscription.remove();
    this.listeners.clear();
  }

  private async run(): Promise<void> {
    await this.hydrate();
    if (this.running || this.paused) return;
    this.running = true;
    try {
      while (!this.paused) {
        const next = this.jobs.find((job) => job.status === 'pending');
        if (!next) break;
        this.patch(next.id, {
          status: 'waitingForConnection',
          updatedAt: Date.now(),
        });
        await this.persist();
        try {
          await this.backend.connect(next.profileId);
          this.patch(next.id, {
            status: 'running',
            progress: 0,
            errorCode: undefined,
            errorMessage: undefined,
            updatedAt: Date.now(),
          });
          await this.persist();
          await this.backend.executeInstall(
            this.jobs.find((job) => job.id === next.id) ?? next,
          );
          this.patch(next.id, {
            status: 'success',
            progress: 1,
            progressDescription: undefined,
            updatedAt: Date.now(),
          });
        } catch (error) {
          const details = normalizeError(error);
          this.patch(next.id, {
            status: 'error',
            errorCode: details.code,
            errorMessage: details.message,
            updatedAt: Date.now(),
          });
        }
        await this.persist();
      }
    } finally {
      this.running = false;
      this.emit();
    }
  }

  private patch(id: string, patch: Partial<InstallJob>): void {
    this.jobs = this.jobs.map((job) =>
      job.id === id ? { ...job, ...patch } : job,
    );
    this.emit();
  }

  private async persist(): Promise<void> {
    await this.backend.saveInstallJobs(this.jobs);
  }

  private async persistAndEmit(): Promise<void> {
    await this.persist();
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function normalizeError(error: unknown): { code: string; message: string } {
  if (error && typeof error === 'object') {
    const value = error as { code?: unknown; message?: unknown };
    return {
      code: typeof value.code === 'string' ? value.code : 'INSTALL_FAILED',
      message:
        typeof value.message === 'string' ? value.message : 'Installation failed.',
    };
  }
  return {
    code: 'INSTALL_FAILED',
    message: typeof error === 'string' ? error : 'Installation failed.',
  };
}
