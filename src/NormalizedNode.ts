export class FingerprintInterner {
  private readonly idsByKey = new Map<string, string>();
  private nextId = 0;

  idFor(tag: string, childIds: readonly string[]): string {
    const key = `${tag}\0${childIds.length}\0${childIds.join("\0")}`;
    const existing = this.idsByKey.get(key);
    if (existing) {
      return existing;
    }
    const id = String(this.nextId++);
    this.idsByKey.set(key, id);
    return id;
  }
}

export class NormalizedNode {
  readonly count: number;

  constructor(
    private readonly tag: string,
    private readonly children: readonly NormalizedNode[],
  ) {
    this.count = 1 + children.reduce((sum, child) => sum + child.count, 0);
  }

  nodeCount(): number {
    return this.count;
  }

  fingerprints(interner: FingerprintInterner): Set<string> {
    const result = new Set<string>();
    this.collectFingerprints(interner, result);
    return result;
  }

  private collectFingerprints(interner: FingerprintInterner, result: Set<string>): string {
    const childIds: string[] = [];
    for (const child of this.children) {
      childIds.push(child.collectFingerprints(interner, result));
    }
    const id = interner.idFor(this.tag, childIds);
    result.add(id);
    return id;
  }
}
