import ts from "typescript";

import { NormalizedNode } from "./NormalizedNode.js";

export class TypeScriptNormalizer {
  normalize(node: ts.Node, memo?: Map<ts.Node, NormalizedNode>): NormalizedNode {
    if (memo) {
      const cached = memo.get(node);
      if (cached) {
        return cached;
      }
    }
    const children: NormalizedNode[] = [];
    for (const marker of this.markers(node)) {
      children.push(new NormalizedNode(marker, []));
    }
    node.forEachChild((child) => {
      if (this.keepsStructuralChild(child)) {
        children.push(this.normalize(child, memo));
      }
    });
    const result = new NormalizedNode(this.tag(node), children);
    if (memo) {
      memo.set(node, result);
    }
    return result;
  }

  tag(node: ts.Node): string {
    return ts.SyntaxKind[node.kind] ?? `SyntaxKind${node.kind}`;
  }

  keepsStructuralChild(child: ts.Node): boolean {
    return !this.isName(child) && !this.isLiteral(child) && child.kind !== ts.SyntaxKind.JSDocComment;
  }

  private isName(node: ts.Node): boolean {
    return ts.isIdentifier(node) || node.kind === ts.SyntaxKind.PrivateIdentifier;
  }

  private isLiteral(node: ts.Node): boolean {
    return (
      ts.isStringLiteral(node) ||
      ts.isNumericLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isRegularExpressionLiteral(node) ||
      node.kind === ts.SyntaxKind.BigIntLiteral ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword
    );
  }

  markers(node: ts.Node): string[] {
    const markers: string[] = [];
    this.addDecoratorMarkers(node, markers);
    this.addModifierMarkers(node, markers);
    this.addOperatorMarkers(node, markers);
    this.addTypeScriptShapeMarkers(node, markers);
    markers.sort();
    return markers;
  }

  private addDecoratorMarkers(node: ts.Node, markers: string[]): void {
    if (ts.canHaveDecorators(node)) {
      for (const _decorator of ts.getDecorators(node) ?? []) {
        markers.push("decorator");
      }
    }
  }

  private addModifierMarkers(node: ts.Node, markers: string[]): void {
    if (!ts.canHaveModifiers(node)) {
      return;
    }
    for (const modifier of ts.getModifiers(node) ?? []) {
      markers.push(`modifier:${this.tag(modifier)}`);
    }
  }

  private addOperatorMarkers(node: ts.Node, markers: string[]): void {
    if (ts.isBinaryExpression(node)) {
      markers.push(`operator:${this.tag(node.operatorToken)}`);
    } else if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      markers.push(`operator:${ts.SyntaxKind[node.operator]}`);
    }
  }

  private addTypeScriptShapeMarkers(node: ts.Node, markers: string[]): void {
    if (ts.isVariableDeclarationList(node)) {
      if ((node.flags & ts.NodeFlags.Const) !== 0) {
        markers.push("variable:const");
      } else if ((node.flags & ts.NodeFlags.Let) !== 0) {
        markers.push("variable:let");
      } else {
        markers.push("variable:var");
      }
    }
    if (ts.isHeritageClause(node)) {
      markers.push(`heritage:${ts.SyntaxKind[node.token]}`);
    }
    if (hasQuestionToken(node)) {
      markers.push("optional");
    }
    if (hasExclamationToken(node)) {
      markers.push("definite");
    }
  }
}

function hasQuestionToken(node: ts.Node): boolean {
  return "questionToken" in node && Boolean((node as { questionToken?: ts.QuestionToken }).questionToken);
}

function hasExclamationToken(node: ts.Node): boolean {
  return "exclamationToken" in node && Boolean((node as { exclamationToken?: ts.ExclamationToken }).exclamationToken);
}
