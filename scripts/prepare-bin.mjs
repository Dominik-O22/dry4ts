import { chmodSync } from "node:fs";

chmodSync("dist/bin/dry-ts.js", 0o755);
