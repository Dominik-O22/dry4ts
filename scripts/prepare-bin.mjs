import { chmodSync } from "node:fs";

chmodSync("dist/bin/dry4ts.js", 0o755);
