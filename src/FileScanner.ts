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

  scanFiles(
    files: readonly string[],
    minLines: number,
    minNodes = 1,
    excludeKinds: ReadonlySet<ts.SyntaxKind> = EMPTY_KIND_SET,
  ): Entry[] {
    return files.flatMap((file) => this.scanFile(file, minLines, minNodes, excludeKinds));
  }

  scanFile(
    file: string,
    minLines: number,
    minNodes = 1,
    excludeKinds: ReadonlySet<ts.SyntaxKind> = EMPTY_KIND_SET,
  ): Entry[] {
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

      if (candidateRootKinds.has(node.kind) && !excludeKinds.has(node.kind) && hashes.length - rangeStart >= minNodes) {
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

// Single source of truth for the candidate root kinds: the declaration shapes
// dry-ts treats as comparable units. Each entry carries the canonical name a
// user types for --exclude-kinds plus a plain-English blurb for the help/README
// docs. The name is spelled out explicitly rather than derived from
// ts.SyntaxKind[kind]: TS reverse-enum lookup returns the marker alias for
// boundary kinds (e.g. ts.SyntaxKind[VariableStatement] is "FirstStatement"),
// which is not the name users expect or that the docs advertise. Order here is
// the order shown to users.
const candidateKinds: readonly { name: string; kind: ts.SyntaxKind; blurb: string }[] = [
  { name: "ClassDeclaration", kind: ts.SyntaxKind.ClassDeclaration, blurb: "a `class Foo {}` declaration" },
  { name: "InterfaceDeclaration", kind: ts.SyntaxKind.InterfaceDeclaration, blurb: "an `interface Foo {}` declaration" },
  { name: "TypeAliasDeclaration", kind: ts.SyntaxKind.TypeAliasDeclaration, blurb: "a `type Foo = ...` alias" },
  { name: "EnumDeclaration", kind: ts.SyntaxKind.EnumDeclaration, blurb: "an `enum Foo {}` declaration" },
  { name: "ModuleDeclaration", kind: ts.SyntaxKind.ModuleDeclaration, blurb: "a `namespace Foo {}` / `module Foo {}` block" },
  { name: "FunctionDeclaration", kind: ts.SyntaxKind.FunctionDeclaration, blurb: "a `function foo() {}` declaration" },
  { name: "MethodDeclaration", kind: ts.SyntaxKind.MethodDeclaration, blurb: "a method body in a class or object literal: `foo() {}`" },
  { name: "Constructor", kind: ts.SyntaxKind.Constructor, blurb: "a class `constructor() {}`" },
  { name: "GetAccessor", kind: ts.SyntaxKind.GetAccessor, blurb: "a getter: `get foo() {}`" },
  { name: "SetAccessor", kind: ts.SyntaxKind.SetAccessor, blurb: "a setter: `set foo(v) {}`" },
  { name: "PropertyDeclaration", kind: ts.SyntaxKind.PropertyDeclaration, blurb: "a class field: `foo = ...` / `foo: T`" },
  { name: "PropertySignature", kind: ts.SyntaxKind.PropertySignature, blurb: "a property in an interface/type: `foo: T`" },
  { name: "MethodSignature", kind: ts.SyntaxKind.MethodSignature, blurb: "a method signature in an interface/type: `foo(): T`" },
  { name: "CallSignature", kind: ts.SyntaxKind.CallSignature, blurb: "a callable signature in a type: `(arg: T): U`" },
  { name: "ConstructSignature", kind: ts.SyntaxKind.ConstructSignature, blurb: "a constructable signature in a type: `new (): T`" },
  { name: "IndexSignature", kind: ts.SyntaxKind.IndexSignature, blurb: "an index signature: `[key: string]: T`" },
  { name: "VariableStatement", kind: ts.SyntaxKind.VariableStatement, blurb: "a `const` / `let` / `var` statement (the whole declaration line)" },
  { name: "EnumMember", kind: ts.SyntaxKind.EnumMember, blurb: "a single member inside an enum" },
  { name: "ArrowFunction", kind: ts.SyntaxKind.ArrowFunction, blurb: "an arrow function used as a value: `() => {}`" },
  { name: "FunctionExpression", kind: ts.SyntaxKind.FunctionExpression, blurb: "a `function () {}` used as a value" },
];

const candidateRootKinds = new Set<ts.SyntaxKind>(candidateKinds.map((entry) => entry.kind));

const EMPTY_KIND_SET: ReadonlySet<ts.SyntaxKind> = new Set();

// Derived from candidateKinds so the two can never drift.
const candidateKindByName = new Map<string, ts.SyntaxKind>(
  candidateKinds.map((entry) => [entry.name, entry.kind]),
);

export const candidateKindNames: readonly string[] = candidateKinds.map((entry) => entry.name);

// For help and README docs.
export const candidateKindDescriptions: readonly { name: string; blurb: string }[] =
  candidateKinds.map(({ name, blurb }) => ({ name, blurb }));

// Resolves --exclude-kinds names to SyntaxKinds, validating each against the
// candidate set. An unknown or non-candidate name throws rather than silently
// no-op'ing — a silent gate-flag bypass is a footgun.
export function resolveExcludeKinds(names: readonly string[]): ReadonlySet<ts.SyntaxKind> {
  const kinds = new Set<ts.SyntaxKind>();
  for (const name of names) {
    const kind = candidateKindByName.get(name);
    if (kind === undefined) {
      throw new Error(`Unknown candidate kind: ${name}`);
    }
    kinds.add(kind);
  }
  return kinds;
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
