import fs from "node:fs";
import path from "node:path";

import ts from "typescript";

import { Options, type OptionsInput } from "./Options.js";
import { TypeScriptNormalizer } from "./TypeScriptNormalizer.js";
import type { Candidate, Location } from "./types.js";

interface Entry {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly nodes: number;
  readonly fingerprints: Set<string>;
}

export class TypeScriptDuplicateFinder {
  private readonly normalizer = new TypeScriptNormalizer();

  findDuplicates(options: Options | OptionsInput = Options.defaults()): Candidate[] {
    const resolvedOptions = options instanceof Options ? options : Options.from(options);
    const entries = this.scan(resolvedOptions.paths)
      .filter((entry) => lines(entry) >= resolvedOptions.minLines)
      .filter((entry) => entry.nodes >= resolvedOptions.minNodes);
    const candidates: Candidate[] = [];

    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const left = entries[i];
        const right = entries[j];
        const score = similarity(left, right);
        if (!overlaps(left, right) && score >= resolvedOptions.threshold) {
          candidates.push({
            score,
            left: location(left),
            right: location(right),
            leftNodes: left.nodes,
            rightNodes: right.nodes,
          });
        }
      }
    }

    return candidates.sort(compareCandidates);
  }

  private scan(paths: readonly string[]): Entry[] {
    return paths
      .flatMap((sourcePath) => this.typeScriptFiles(sourcePath))
      .sort()
      .flatMap((file) => this.scanFile(file));
  }

  private typeScriptFiles(sourcePath: string): string[] {
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
          visit(fullPath);
        } else if (entry.isFile() && isTypeScriptSource(fullPath)) {
          files.push(fullPath);
        }
      }
    };
    visit(sourcePath);
    return files.sort();
  }

  private scanFile(file: string): Entry[] {
    const text = fs.readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
    const parseDiagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] })
      .parseDiagnostics;
    if (parseDiagnostics && parseDiagnostics.length > 0) {
      const first = parseDiagnostics[0];
      const message = ts.flattenDiagnosticMessageText(first.messageText, "\n");
      throw new Error(`Unable to parse ${file}: ${message}`);
    }

    const entries: Entry[] = [];
    this.collectEntries(file, sourceFile, sourceFile, entries);
    return entries;
  }

  private collectEntries(file: string, sourceFile: ts.SourceFile, node: ts.Node, entries: Entry[]): void {
    if (this.isCandidateRoot(node)) {
      entries.push(this.entry(file, sourceFile, node));
    }
    node.forEachChild((child) => this.collectEntries(file, sourceFile, child, entries));
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

  private entry(file: string, sourceFile: ts.SourceFile, node: ts.Node): Entry {
    const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, false)).line + 1;
    const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    const normalized = this.normalizer.normalize(node);
    return {
      file,
      startLine,
      endLine,
      nodes: normalized.nodeCount(),
      fingerprints: normalized.fingerprints(),
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

function lines(entry: Entry): number {
  return entry.endLine - entry.startLine + 1;
}

function location(entry: Entry): Location {
  return { file: entry.file, startLine: entry.startLine, endLine: entry.endLine };
}

function overlaps(left: Entry, right: Entry): boolean {
  return left.file === right.file && left.startLine <= right.endLine && right.startLine <= left.endLine;
}

function similarity(left: Entry, right: Entry): number {
  const union = new Set([...left.fingerprints, ...right.fingerprints]);
  if (union.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const fingerprint of left.fingerprints) {
    if (right.fingerprints.has(fingerprint)) {
      shared += 1;
    }
  }
  return shared / union.size;
}

function compareCandidates(left: Candidate, right: Candidate): number {
  return (
    right.score - left.score ||
    left.left.file.localeCompare(right.left.file) ||
    left.left.startLine - right.left.startLine ||
    left.right.file.localeCompare(right.right.file) ||
    left.right.startLine - right.right.startLine
  );
}
