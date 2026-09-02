import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("composite action renders screenshots only behind an explicit input", async () => {
  const action = await readFile(new URL("../action.yml", import.meta.url), "utf8");
  assert.match(action, /render-screenshots:\n[\s\S]*?default: "false"/);
  assert.match(action, /if: \$\{\{ inputs\['render-screenshots'\] == 'true' \}\}/);
  assert.match(action, /npm ci --ignore-scripts --prefix "\$\{marketing_path\}"/);
  assert.match(action, /SHIPLAYER_PW_CHANNEL=chrome npm run export --prefix "\$\{marketing_path\}"/);
});
