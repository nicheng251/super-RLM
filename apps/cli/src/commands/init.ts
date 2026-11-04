
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function runInit(cwd = process.cwd()): number {
  const marker = join(cwd, ".super-rlm-project.json");
  if (existsSync(marker)) {
    console.log(`Project marker already exists: ${marker}`);
  } else {
    const projectId = `prj_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    writeFileSync(marker, JSON.stringify({ project_id: projectId }, null, 2) + "\n", "utf8");
    console.log(`Created ${marker} with project_id=${projectId}`);
  }

  const gitignore = join(cwd, ".gitignore");
  const line = ".super-rlm-project.json";
  if (existsSync(gitignore)) {
    const body = readFileSync(gitignore, "utf8");
    if (!body.split(/\r?\n/).includes(line)) {
      writeFileSync(gitignore, body.replace(/\s*$/, "") + `\n${line}\n`, "utf8");
      console.log(`Added ${line} to .gitignore`);
    }
  } else {
    writeFileSync(gitignore, `${line}\n`, "utf8");
    console.log(`Created .gitignore with ${line}`);
  }
  return 0;
}
