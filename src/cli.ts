#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import type { ConstantValidationResult, ValidationResult } from './validator';
import { validateJsonText } from './validator';

const USAGE =
  '用法：vmcheck [--constant-aware] [program.json]；不传文件参数时从标准输入读取';

interface CliOptions {
  constantAware: boolean;
  filePath?: string;
}

function parseArgs(args: string[]): CliOptions {
  let constantAware = false;
  let filePath: string | undefined;

  for (const arg of args) {
    if (arg === '--constant-aware') {
      constantAware = true;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new UsageError(`未知参数 ${arg}\n${USAGE}`);
    }
    if (filePath !== undefined) {
      throw new UsageError(USAGE);
    }
    filePath = arg;
  }

  return { constantAware, filePath };
}

async function readInput(filePath: string | undefined): Promise<string> {
  if (filePath !== undefined) {
    return fs.readFile(filePath, 'utf8');
  }

  return readStdin();
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

class UsageError extends Error {}

function printResult(result: ValidationResult | ConstantValidationResult): void {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function main(): Promise<number> {
  try {
    const options = parseArgs(process.argv.slice(2));
    const input = await readInput(options.filePath);
    const result = options.constantAware
      ? validateJsonText(input, { constantAware: true })
      : validateJsonText(input);
    printResult(result);
    if (result.kind === 'program') {
      return result.ok ? 0 : 1;
    }
    if (result.kind === 'invalid_options') {
      return 2;
    }
    return 1;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`读取输入失败：${message}\n`);
    return 2;
  }
}

main().then((exitCode) => {
  process.exitCode = exitCode;
});
