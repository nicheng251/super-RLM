import { loadConfig } from "../../cli/src/config.ts";
import { TuiApp } from "./app.ts";

const config = loadConfig();
const app = new TuiApp(config);

app.run().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
