import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RetailState, ToolExecution } from '../agentLoop/retailRuntime.js';
import { DockerSession } from './sessionRunner.js';

const RUNNER = String.raw`
import { readFileSync, writeFileSync } from 'node:fs';
import { executeRetailTool } from './retailRuntime.mjs';
const statePath = '/workspace/__zx_retail_state.json';
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const request = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
const outcome = executeRetailTool(state, request.tool, request.args, request.turn);
writeFileSync(statePath, JSON.stringify(state));
process.stdout.write(JSON.stringify(outcome));
`;

/** Runs the existing retail policy engine inside an isolated persistent container. */
export class DockerRetailRuntime {
  private constructor(private readonly session: DockerSession) {}
  get imageId(): string { return this.session.imageId; }

  static async create(initialState: RetailState, expectedImageId?: string, timeoutMs = 180_000): Promise<DockerRetailRuntime> {
    const enginePath = fileURLToPath(new URL('../agentLoop/retailRuntime.js', import.meta.url));
    const engine = readFileSync(enginePath, 'utf8');
    const session = await DockerSession.create({ image: 'node:22-alpine', expectedImageId, timeoutMs,
      files: [
        { path: 'retailRuntime.mjs', content: engine },
        { path: '__zx_retail_runner.mjs', content: RUNNER },
        { path: '__zx_retail_state.json', content: JSON.stringify(initialState) },
      ] });
    return new DockerRetailRuntime(session);
  }

  async call(tool: string, args: Record<string, unknown>, turn: number): Promise<ToolExecution> {
    const payload = Buffer.from(JSON.stringify({ tool, args, turn }), 'utf8').toString('base64');
    const result = await this.session.exec(`node __zx_retail_runner.mjs ${payload}`);
    if (result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded) {
      throw new Error(`Retail Docker execution failed: ${result.stderr.slice(0, 500)}`);
    }
    return JSON.parse(result.stdout) as ToolExecution;
  }

  snapshot(): RetailState {
    return JSON.parse(this.session.readArtifact('__zx_retail_state.json')) as RetailState;
  }

  close(): Promise<void> { return this.session.close(); }
}
