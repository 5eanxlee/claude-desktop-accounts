#!/usr/bin/env node
import { main } from '../src/cli.js'

const code = main(process.argv.slice(2))
if (code !== null) process.exitCode = code
