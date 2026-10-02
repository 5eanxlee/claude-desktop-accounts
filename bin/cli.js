#!/usr/bin/env node
import { main } from '../lib/cli.js'

process.exitCode = main(process.argv.slice(2))
