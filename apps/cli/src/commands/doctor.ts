
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

import type { CliConfig } from "../config.ts";

interface Check {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
}

function nodeOk(): boolean {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 19);
}

async function health(url: string, token: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    });
    return { ok: response.ok, detail: `${response.status}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function runDoctor(config: CliConfig, options: { json?: boolean } = {}): Promise<number> {
  const kernelPython = config.kernelPython;
  const kernelImport = existsSync(kernelPython)
    ? spawnSync(kernelPython, ["-c", "import rlm, super_rlm_report"], { timeout: 20_000, encoding: "utf8" })
    : null;
  const workerImport = existsSync(config.workerPython)
    ? spawnSync(config.workerPython, ["-c", "import super_rlm_worker"], { timeout: 20_000, encoding: "utf8" })
    : null;

  const orchestrator = await health(`${config.orchestratorUrl}/health`, config.routerToken);
  const worker = await health(`http://127.0.0.1:${config.workerPort}/v1/health`, config.workerToken);

  const checks: Check[] = [
    { name: "node", ok: nodeOk(), required: true, detail: process.versions.node },
    { name: "pi-cli", ok: existsSync(config.piCli), required: true, detail: config.piCli },
    { name: "router-extension", ok: existsSync(config.routerExtension), required: true, detail: config.routerExtension },
    { name: "prime-agent", ok: existsSync(config.primeAgent), required: true, detail: config.primeAgent },
    { name: "kernel-python", ok: existsSync(kernelPython), required: true, detail: kernelPython },
    {
      name: "kernel-imports",
      ok: kernelImport?.status === 0,
      required: true,
      detail: kernelImport ? (kernelImport.stderr || kernelImport.stdout || `exit ${kernelImport.status}`).trim() : "kernel python missing",
    },
    { name: "worker-python", ok: existsSync(config.workerPython), required: true, detail: config.workerPython },
    {
      name: "worker-imports",
      ok: workerImport?.status === 0,
      required: true,
      detail: workerImport ? (workerImport.stderr || workerImport.stdout || `exit ${workerImport.status}`).trim() : "worker python missing",
    },
    { name: "report-skill", ok: existsSync(config.reportSkill), required: true, detail: config.reportSkill },
    { name: "orchestrator-health", ok: orchestrator.ok, required: false, detail: `${config.orchestratorUrl} ${orchestrator.detail}` },
    { name: "worker-health", ok: worker.ok, required: false, detail: `http://127.0.0.1:${config.workerPort} ${worker.detail}` },
  ];

  if (options.json) {
    console.log(JSON.stringify({ config, checks }, null, 2));
  } else {
    for (const check of checks) {
      const mark = check.ok ? "ok" : check.required ? "FAIL" : "warn";
      console.log(`${mark.padEnd(4)} ${check.name.padEnd(20)} ${check.detail}`);
    }
  }
  return checks.some((check) => check.required && !check.ok) ? 1 : 0;
}
