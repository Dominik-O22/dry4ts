# Candidate Selection and Normalization

dry-ts creates candidates from TypeScript declaration and function-like AST nodes, then compares each candidate's normalized fingerprint set.

Candidate roots include:

- classes, interfaces, type aliases, enums, and modules
- functions, methods, constructors, accessors, arrow functions, and function expressions
- properties, property signatures, method signatures, call signatures, construct signatures, and index signatures
- variable statements and enum members

Normalization keeps syntax shape while ignoring names and literal values:

- identifiers and private identifiers are removed
- string, number, template, regexp, bigint, boolean, and null literals are removed
- JSDoc comment nodes are removed
- decorators, modifiers, operators, variable declaration kind, heritage clauses, optional markers, and definite assignment markers are preserved as structural markers

Similarity is Jaccard similarity:

```text
score = shared fingerprints / all fingerprints seen in either candidate
```

Candidates in the same file are skipped when their line ranges overlap.
