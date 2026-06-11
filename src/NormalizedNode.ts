export class NormalizedNode {
  constructor(
    private readonly tag: string,
    private readonly children: readonly NormalizedNode[],
  ) {}

  nodeCount(): number {
    return 1 + this.children.reduce((count, child) => count + child.nodeCount(), 0);
  }

  fingerprints(): Set<string> {
    const result = new Set<string>();
    this.collectFingerprints(result);
    return new Set([...result].sort());
  }

  private collectFingerprints(result: Set<string>): void {
    result.add(this.toFingerprint());
    for (const child of this.children) {
      child.collectFingerprints(result);
    }
  }

  private toFingerprint(): string {
    if (this.children.length === 0) {
      return this.tag;
    }
    return `(${[this.tag, ...this.children.map((child) => child.toFingerprint())].join(" ")})`;
  }
}
