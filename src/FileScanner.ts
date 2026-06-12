import fs from "node:fs";

import ts from "typescript";

import { FingerprintInterner } from "./NormalizedNode.js";
import { TypeScriptNormalizer } from "./TypeScriptNormalizer.js";

export interface Entry {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly nodes: number;
  readonly fingerprints: Float64Array;
}

// Parses and fingerprints files in a single AST walk, without materializing the
// normalized tree. Fingerprints are content hashes, so output is deterministic
// regardless of how files are split across scanner instances or worker threads.
export class FileScanner {
  private readonly normalizer = new TypeScriptNormalizer();
  private readonly interner = new FingerprintInterner();
  private readonly markerHashes = new Map<string, number>();

  scanFiles(files: readonly string[], minLines: number, minNodes = 1): Entry[] {
    return files.flatMap((file) => this.scanFile(file, minLines, minNodes));
  }

  scanFile(file: string, minLines: number, minNodes = 1): Entry[] {
    const text = fs.readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKind(file));
    const parseDiagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] })
      .parseDiagnostics;
    if (parseDiagnostics && parseDiagnostics.length > 0) {
      const first = parseDiagnostics[0];
      const message = ts.flattenDiagnosticMessageText(first.messageText, "\n");
      throw new Error(`Unable to parse ${file}: ${message}`);
    }

    // Post-order hashes of every kept node; a subtree always owns the contiguous
    // range it appended, so an entry's fingerprints are a slice of this array.
    const hashes: number[] = [];
    const entries: Array<{ order: number; entry: Entry }> = [];
    let nextOrder = 0;

    const visit = (node: ts.Node): number => {
      const order = nextOrder++;
      const rangeStart = hashes.length;
      const childHashes: number[] = [];
      for (const marker of this.normalizer.markers(node)) {
        const markerHash = this.markerHash(marker);
        hashes.push(markerHash);
        childHashes.push(markerHash);
      }
      node.forEachChild((child) => {
        if (this.normalizer.keepsStructuralChild(child)) {
          childHashes.push(visit(child));
        }
      });
      const hash = this.interner.idFor(this.normalizer.tag(node), childHashes);
      hashes.push(hash);

      if (candidateRootKinds.has(node.kind) && hashes.length - rangeStart >= minNodes) {
        const { startLine, endLine } = lineRangeFor(sourceFile, node);
        if (endLine - startLine + 1 >= minLines) {
          entries.push({
            order,
            entry: {
              file,
              startLine,
              endLine,
              nodes: hashes.length - rangeStart,
              fingerprints: sortedUnique(hashes, rangeStart),
            },
          });
        }
      }
      return hash;
    };
    sourceFile.forEachChild((child) => {
      if (this.normalizer.keepsStructuralChild(child)) {
        visit(child);
      }
    });

    // Entries were collected post-order; report them in document (pre-)order.
    return entries.sort((left, right) => left.order - right.order).map(({ entry }) => entry);
  }

  private markerHash(marker: string): number {
    let hash = this.markerHashes.get(marker);
    if (hash === undefined) {
      hash = this.interner.idFor(marker, []);
      this.markerHashes.set(marker, hash);
    }
    return hash;
  }
}

function sortedUnique(hashes: readonly number[], start: number): Float64Array {
  const sorted = new Float64Array(hashes.length - start);
  for (let i = start; i < hashes.length; i += 1) {
    sorted[i - start] = hashes[i];
  }
  sorted.sort();
  let writeIndex = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    if (i === 0 || sorted[i] !== sorted[i - 1]) {
      sorted[writeIndex] = sorted[i];
      writeIndex += 1;
    }
  }
  return sorted.slice(0, writeIndex);
}

const candidateRootKinds = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.CallSignature,
  ts.SyntaxKind.ConstructSignature,
  ts.SyntaxKind.IndexSignature,
  ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.EnumMember,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.FunctionExpression,
]);

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
