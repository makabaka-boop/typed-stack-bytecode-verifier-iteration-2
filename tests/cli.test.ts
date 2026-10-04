import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const cliPath = join(process.cwd(), 'dist', 'cli.js');
const validExample = join(process.cwd(), 'examples', 'valid.json');
const invalidExample = join(process.cwd(), 'examples', 'merge-conflict.json');
const constantDeadExample = join(process.cwd(), 'examples', 'constant-dead.json');

function runCli(args: string[], input?: string) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    input,
    encoding: 'utf8',
  });
}

describe('JSON command-line entrypoint', () => {
  it('exits 0 and prints signatures for a valid file', () => {
    const result = runCli([validExample]);
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(true);
    expect(output.analysis.pcSignatures).toMatchObject({
      0: [],
      5: ['bool'],
    });
  });

  it('exits 1 and prints a control-flow witness for an invalid file', () => {
    const result = runCli([invalidExample]);
    expect(result.status).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(false);
    expect(output.analysis.issues[0].code).toBe('stack_merge_conflict');
    expect(output.analysis.issues[0].witness.conflicts.existingPath.length).toBeGreaterThan(0);
    expect(output.analysis.issues[0].witness.conflicts.incomingPath.length).toBeGreaterThan(0);
  });

  it('reads JSON from stdin when no file is given', () => {
    const result = runCli([], '{"instructions":[{"op":"PUSH_BOOL","value":true},{"op":"HALT"}]}');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).analysis.maxStackDepth).toBe(1);
  });
});

describe('constant-aware command-line mode', () => {
  it('proves the bad instruction behind a constant branch dead and exits 0', () => {
    const result = runCli(['--constant-aware', constantDeadExample]);
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(true);
    expect(output.mode).toBe('constant_aware');
    expect(output.analysis.deadPcs).toEqual([4]);
    expect(output.analysis.pcSignatures[1]).toEqual([{ type: 'bool', value: true }]);
  });

  it('reports the same bad instruction in default mode and exits 1', () => {
    const result = runCli([constantDeadExample]);
    expect(result.status).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(false);
    expect(output).not.toHaveProperty('mode');
    expect(output.analysis.issues[0].code).toBe('malformed_instruction');
  });

  it('accepts --constant-aware with stdin input', () => {
    const result = runCli(
      ['--constant-aware'],
      '{"instructions":[{"op":"PUSH_BOOL","value":true},{"op":"HALT"}]}'
    );
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.mode).toBe('constant_aware');
    expect(output.analysis.pcSignatures[1]).toEqual([{ type: 'bool', value: true }]);
  });

  it('rejects unknown flags with exit code 2', () => {
    const result = runCli(['--constant']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('未知参数');
  });
});
