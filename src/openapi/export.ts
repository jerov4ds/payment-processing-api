import { writeFileSync } from "node:fs";
import { buildOpenApiSpec } from "./spec";

const spec = buildOpenApiSpec();
writeFileSync("openapi.json", `${JSON.stringify(spec, null, 2)}\n`);
