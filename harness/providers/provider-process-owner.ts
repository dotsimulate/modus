export type ProviderProcessLease<TProcess> = Readonly<{
  generation: number;
  process: TProcess;
}>;

/**
 * Owns exactly one provider process generation at a time.
 *
 * A process remains owned until its `close` event releases the lease. Merely
 * sending a kill signal or observing `exit` is not sufficient: descendants may
 * still own the stdio handles, especially through Windows command wrappers.
 */
export class ProviderProcessOwner<TProcess> {
  private nextGeneration = 1;
  private active: ProviderProcessLease<TProcess> | null = null;

  claim(process: TProcess): ProviderProcessLease<TProcess> {
    if (this.active) {
      throw new Error(`refusing to spawn provider process generation ${this.nextGeneration} before generation ${this.active.generation} closed`);
    }
    const lease = { generation: this.nextGeneration++, process } as const;
    this.active = lease;
    return lease;
  }

  current(): ProviderProcessLease<TProcess> | null {
    return this.active;
  }

  isCurrent(lease: ProviderProcessLease<TProcess>): boolean {
    return this.active === lease;
  }

  release(lease: ProviderProcessLease<TProcess>): boolean {
    if (this.active !== lease) return false;
    this.active = null;
    return true;
  }

  releaseOnClose(
    lease: ProviderProcessLease<TProcess>,
    events: { once(event: "close", listener: () => void): unknown },
    onReleased: () => void,
  ): void {
    events.once("close", () => {
      if (!this.release(lease)) return;
      onReleased();
    });
  }
}
