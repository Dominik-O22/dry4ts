// Fingerprint ids are 53-bit structural hashes, so identical subtrees produce the
// same id with no shared state. That keeps id assignment deterministic across
// worker threads; the collision probability is negligible for candidate finding.
export class FingerprintInterner {
  private readonly tagHashes = new Map<string, number>();

  idFor(tag: string, childIds: readonly number[]): number {
    const tagHash = this.tagHash(tag);
    let h1 = tagHash >>> 0;
    let h2 = (tagHash ^ 0x9e3779b9) >>> 0;
    for (const childId of childIds) {
      const lo = childId >>> 0;
      const hi = Math.floor(childId / 0x100000000) >>> 0;
      h1 = mix(h1, lo, 0xcc9e2d51, 0x1b873593);
      h1 = mix(h1, hi, 0xcc9e2d51, 0x1b873593);
      h2 = mix(h2, lo, 0x85ebca6b, 0xc2b2ae35);
      h2 = mix(h2, hi, 0x85ebca6b, 0xc2b2ae35);
    }
    h1 = finalize(h1 ^ childIds.length);
    h2 = finalize(h2 ^ childIds.length);
    return (h2 & 0x1fffff) * 0x100000000 + (h1 >>> 0);
  }

  private tagHash(tag: string): number {
    const cached = this.tagHashes.get(tag);
    if (cached !== undefined) {
      return cached;
    }
    let hash = 0x811c9dc5;
    for (let i = 0; i < tag.length; i += 1) {
      hash ^= tag.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    hash >>>= 0;
    this.tagHashes.set(tag, hash);
    return hash;
  }
}

function mix(h: number, k: number, c1: number, c2: number): number {
  k = Math.imul(k, c1);
  k = ((k << 15) | (k >>> 17)) >>> 0;
  k = Math.imul(k, c2);
  h ^= k;
  h = ((h << 13) | (h >>> 19)) >>> 0;
  return (Math.imul(h, 5) + 0xe6546b64) >>> 0;
}

function finalize(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export class NormalizedNode {
  readonly count: number;
  private cachedFor: FingerprintInterner | undefined;
  private cachedId = 0;

  constructor(
    private readonly tag: string,
    private readonly children: readonly NormalizedNode[],
  ) {
    this.count = 1 + children.reduce((sum, child) => sum + child.count, 0);
  }

  nodeCount(): number {
    return this.count;
  }

  fingerprints(interner: FingerprintInterner): Float64Array {
    const result = new Set<number>();
    this.collectFingerprints(interner, result);
    const sorted = Float64Array.from(result);
    sorted.sort();
    return sorted;
  }

  private collectFingerprints(interner: FingerprintInterner, result: Set<number>): number {
    // Nested candidates re-walk shared subtrees; the single-slot cache keeps the
    // hash computation to once per unique node for the most recently used
    // interner (alternating interners recompute — fine, scans use one interner).
    if (this.cachedFor === interner) {
      for (const child of this.children) {
        child.collectFingerprints(interner, result);
      }
      result.add(this.cachedId);
      return this.cachedId;
    }
    const childIds: number[] = [];
    for (const child of this.children) {
      childIds.push(child.collectFingerprints(interner, result));
    }
    const id = interner.idFor(this.tag, childIds);
    this.cachedFor = interner;
    this.cachedId = id;
    result.add(id);
    return id;
  }
}
