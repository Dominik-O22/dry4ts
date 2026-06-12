import fs from "node:fs";
import path from "node:path";

import ignore from "ignore";
import ts from "typescript";

import { ClusterCollector } from "./Clusters.js";
import { FingerprintInterner, NormalizedNode } from "./NormalizedNode.js";
import { Options, type OptionsInput } from "./Options.js";
import { TypeScriptNormalizer } from "./TypeScriptNormalizer.js";
import type { Cluster, Location } from "./types.js";

interface Entry {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly nodes: number;
  readonly fingerprints: Set<string>;
}

interface ScanContext {
  readonly minLines: number;
  readonly interner: FingerprintInterner;
}

type MatchingPair = readonly [Entry, Entry, number];

type IgnoreMatcher = (filePath: string, isDirectory: boolean) => boolean;

export class TypeScriptDuplicateFinder {
  private readonly normalizer = new TypeScriptNormalizer();

  findClusters(options: Options | OptionsInput = Options.defaults()): Cluster[] {
    const resolvedOptions = options instanceof Options ? options : Options.from(options);
    const entries = this.entriesFor(resolvedOptions);
    const collector = new ClusterCollector();

    for (const [left, right, score] of this.matchingPairs(entries, resolvedOptions.threshold)) {
      collector.addMatch({ ...location(left), nodes: left.nodes }, { ...location(right), nodes: right.nodes }, score);
    }

    return collector.clusters();
  }

  private matchingPairs(entries: readonly Entry[], threshold: number): MatchingPair[] {
    const pairs: MatchingPair[] = [];
    const fingerprintKeys = new Map<Entry, string>();
    const identicalGroups = new Map<string, Entry[]>();
    for (const entry of entries) {
      const key = fingerprintSetKey(entry);
      fingerprintKeys.set(entry, key);
      const group = identicalGroups.get(key) ?? [];
      group.push(entry);
      identicalGroups.set(key, group);
    }

    for (const group of identicalGroups.values()) {
      if (group.length > 1 && group[0].fingerprints.size > 0) {
        addIdenticalFingerprintPairs(group, pairs);
      }
    }

    const entriesBySize = [...entries].sort(compareEntriesByFingerprintSize);
    for (let i = 0; i < entriesBySize.length; i += 1) {
      const left = entriesBySize[i];
      const maximumRightSize = Math.floor(left.fingerprints.size / threshold);
      for (let j = i + 1; j < entriesBySize.length; j += 1) {
        const right = entriesBySize[j];
        if (right.fingerprints.size > maximumRightSize) {
          break;
        }
        if (fingerprintKeys.get(left) === fingerprintKeys.get(right)) {
          continue;
        }
        if (overlaps(left, right) || maxPossibleSimilarity(left, right) < threshold) {
          continue;
        }
        const score = similarity(left, right);
        if (score >= threshold) {
          pairs.push([left, right, score]);
        }
      }
    }
    return pairs;
  }

  private entriesFor(options: Options): Entry[] {
    const interner = new FingerprintInterner();
    const ctx: ScanContext = { minLines: options.minLines, interner };
    return this.scan(options, ctx).filter((entry) => entry.nodes >= options.minNodes);
  }

  private scan(options: Options, ctx: ScanContext): Entry[] {
    const isIgnored = options.respectGitignore ? this.gitignoreMatcher() : null;
    return this.dedupeFiles(
      options.paths.flatMap((sourcePath) => this.typeScriptFiles(sourcePath, isIgnored)),
    )
      .sort()
      .flatMap((file) => this.scanFile(file, ctx));
  }

  private gitignoreMatcher(): IgnoreMatcher | null {
    const cwd = process.cwd();
    const gitignorePath = path.join(cwd, ".gitignore");
    let content: string;
    try {
      content = fs.readFileSync(gitignorePath, "utf8");
    } catch {
      return null;
    }
    const matcher = ignore().add(content);
    return (filePath, isDirectory) => {
      const relative = path.relative(cwd, filePath);
      if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
        return false;
      }
      const slashed = relative.split(path.sep).join("/");
      return matcher.ignores(isDirectory ? `${slashed}/` : slashed);
    };
  }

  private dedupeFiles(files: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const file of files) {
      const resolved = path.resolve(file);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        result.push(file);
      }
    }
    return result;
  }

  private typeScriptFiles(sourcePath: string, isIgnored: IgnoreMatcher | null): string[] {
    if (!fs.existsSync(sourcePath)) {
      return [];
    }
    const stats = fs.statSync(sourcePath);
    if (stats.isFile()) {
      return isTypeScriptSource(sourcePath) ? [sourcePath] : [];
    }
    if (!stats.isDirectory()) {
      return [];
    }

    const files: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (isIgnored?.(fullPath, true)) {
            continue;
          }
          visit(fullPath);
        } else if (entry.isFile() && isTypeScriptSource(fullPath)) {
          if (isIgnored?.(fullPath, false)) {
            continue;
          }
          files.push(fullPath);
        }
      }
    };
    visit(sourcePath);
    return files.sort();
  }

  private scanFile(file: string, ctx: ScanContext): Entry[] {
    const text = fs.readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
    const parseDiagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] })
      .parseDiagnostics;
    if (parseDiagnostics && parseDiagnostics.length > 0) {
      const first = parseDiagnostics[0];
      const message = ts.flattenDiagnosticMessageText(first.messageText, "\n");
      throw new Error(`Unable to parse ${file}: ${message}`);
    }

    const memo = new Map<ts.Node, NormalizedNode>();
    const entries: Entry[] = [];
    this.collectEntries(file, sourceFile, sourceFile, entries, ctx, memo);
    return entries;
  }

  private collectEntries(
    file: string,
    sourceFile: ts.SourceFile,
    node: ts.Node,
    entries: Entry[],
    ctx: ScanContext,
    memo: Map<ts.Node, NormalizedNode>,
  ): void {
    if (this.isCandidateRoot(node)) {
      const { startLine, endLine } = lineRangeFor(sourceFile, node);
      if (endLine - startLine + 1 >= ctx.minLines) {
        entries.push(this.entry(file, node, startLine, endLine, ctx, memo));
      }
    }
    node.forEachChild((child) => this.collectEntries(file, sourceFile, child, entries, ctx, memo));
  }

  private isCandidateRoot(node: ts.Node): boolean {
    return (
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertySignature(node) ||
      ts.isMethodSignature(node) ||
      ts.isCallSignatureDeclaration(node) ||
      ts.isConstructSignatureDeclaration(node) ||
      ts.isIndexSignatureDeclaration(node) ||
      ts.isVariableStatement(node) ||
      ts.isEnumMember(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node)
    );
  }

  private entry(
    file: string,
    node: ts.Node,
    startLine: number,
    endLine: number,
    ctx: ScanContext,
    memo: Map<ts.Node, NormalizedNode>,
  ): Entry {
    const normalized = this.normalizer.normalize(node, memo);
    return {
      file,
      startLine,
      endLine,
      nodes: normalized.nodeCount(),
      fingerprints: normalized.fingerprints(ctx.interner),
    };
  }
}

function isTypeScriptSource(file: string): boolean {
  return (
    [".js", ".jsx", ".ts", ".tsx", ".mts", ".cts"].some((extension) => file.endsWith(extension)) &&
    ![".d.ts", ".d.mts", ".d.cts"].some((extension) => file.endsWith(extension))
  );
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }
  if (file.endsWith(".js")) {
    return ts.ScriptKind.JS;
  }
  if (file.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }
  return ts.ScriptKind.TS;
}

function lineRangeFor(sourceFile: ts.SourceFile, node: ts.Node): { startLine: number; endLine: number } {
  return {
    startLine: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, false)).line + 1,
    endLine: sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
  };
}

function location(entry: Entry): Location {
  return { file: entry.file, startLine: entry.startLine, endLine: entry.endLine };
}

function overlaps(left: Entry, right: Entry): boolean {
  return left.file === right.file && left.startLine <= right.endLine && right.startLine <= left.endLine;
}

function addIdenticalFingerprintPairs(group: readonly Entry[], pairs: MatchingPair[]): void {
  const components: Entry[][] = [];
  for (const entry of group) {
    const connectors: Array<{ componentIndex: number; entry: Entry }> = [];
    for (let componentIndex = 0; componentIndex < components.length; componentIndex += 1) {
      const connector = components[componentIndex].find((candidate) => !overlaps(candidate, entry));
      if (connector) {
        connectors.push({ componentIndex, entry: connector });
      }
    }

    if (connectors.length === 0) {
      components.push([entry]);
      continue;
    }

    const primary = connectors[0];
    pairs.push([primary.entry, entry, 1]);
    components[primary.componentIndex].push(entry);

    for (let i = connectors.length - 1; i >= 1; i -= 1) {
      const connector = connectors[i];
      pairs.push([connector.entry, entry, 1]);
      components[primary.componentIndex].push(...components[connector.componentIndex]);
      components.splice(connector.componentIndex, 1);
    }
  }
}

function fingerprintSetKey(entry: Entry): string {
  return [...entry.fingerprints].sort().join("\0");
}

function compareEntriesByFingerprintSize(left: Entry, right: Entry): number {
  return left.fingerprints.size - right.fingerprints.size;
}

function similarity(left: Entry, right: Entry): number {
  if (left.fingerprints.size === 0 && right.fingerprints.size === 0) {
    return 0;
  }
  const smaller = left.fingerprints.size <= right.fingerprints.size ? left.fingerprints : right.fingerprints;
  const larger = smaller === left.fingerprints ? right.fingerprints : left.fingerprints;
  let shared = 0;
  for (const fingerprint of smaller) {
    if (larger.has(fingerprint)) {
      shared += 1;
    }
  }
  return shared / (left.fingerprints.size + right.fingerprints.size - shared);
}

function maxPossibleSimilarity(left: Entry, right: Entry): number {
  const smaller = Math.min(left.fingerprints.size, right.fingerprints.size);
  const larger = Math.max(left.fingerprints.size, right.fingerprints.size);
  return larger === 0 ? 0 : smaller / larger;
}
