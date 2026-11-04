
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ensureDirs, type CliConfig } from "../config.ts";

export interface BootstrapStep {
  title: string;
  command: string;
  args: string[];
}

export interface BootstrapPlan {
  python: string;
  steps: BootstrapStep[];
}

const DEFAULT_PACKAGES = [
  "requests",
  "httpx",
  "pyyaml",
  "tomli",
  "python-dotenv",
  "pandas",
  "numpy",
  "scipy",
  "beautifulsoup4",
  "lxml",
];

export function bootstrapPlan(config: CliConfig): BootstrapPlan {
  const uv = process.platform === "win32" ? "uv.exe" : "uv";
  const python = config.kernelPython;
  const runtime = join(config.repoRoot, "runtime", "prime-agent", "prime-agent-runtime");
  return {
    python,
    steps: [
      {
        title: `Create kernel venv at ${config.kernelVenv}`,
        command: uv,
        args: ["venv", "--python", "3.11", "--allow-existing", config.kernelVenv],
      },
      {
        title: "Install prime-agent-runtime",
        command: uv,
        args: ["pip", "install", "--python", python, "-e", runtime],
      },
      {
        title: "Install kernel defaults",
        command: uv,
        args: ["pip", "install", "--python", python, "mcp>=2,<3", "tyro", ...DEFAULT_PACKAGES],
      },
      {
        title: "Install super-rlm-report skill",
        command: uv,
        args: ["pip", "install", "--python", python, "-e", config.reportSkill],
      },
    ],
  };
}

async function runStep(step: BootstrapStep): Promise<void> {
  console.log(`\n[bootstrap] ${step.title}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(step.command, step.args, { stdio: "inherit" });
    child.on("error", (error) => reject(new Error(`${step.command}: ${error.message}`)));
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${step.command} exited with ${code}`)));
  });
}

export async function runBootstrap(config: CliConfig, options: { dryRun?: boolean } = {}): Promise<number> {
  ensureDirs(config);
  const plan = bootstrapPlan(config);
  if (!existsSync(join(config.repoRoot, "runtime", "prime-agent", "prime-agent-runtime"))) {
    console.error("Prime Agent runtime package is missing under runtime/prime-agent.");
    return 1;
  }
  if (!existsSync(config.reportSkill)) {
    console.error(`super-rlm-report skill is missing: ${config.reportSkill}`);
    return 1;
  }
  if (options.dryRun) {
    for (const step of plan.steps) {
      console.log(`[bootstrap] ${step.title}`);
      console.log(`  ${step.command} ${step.args.map((arg) => arg.includes(" ") ? `"${arg}"` : arg).join(" ")}`);
    }
    console.log(`\nKernel python: ${plan.python}`);
    return 0;
  }
  try {
    for (const step of plan.steps) await runStep(step);
  } catch (error) {
    console.error(`\n[bootstrap] failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  console.log(`\n[bootstrap] done. Kernel python: ${plan.python}`);
  console.log("[bootstrap] Configure models.json next, then run: super-rlm doctor");
  return 0;
}
