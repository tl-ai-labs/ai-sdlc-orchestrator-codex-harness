#!/usr/bin/env node
import { main } from "../plugin/scripts/report.mjs";

process.exitCode = main(process.argv.slice(2));
