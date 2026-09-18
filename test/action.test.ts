import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import YAML from "yaml";

test("composite action manifest is valid YAML", async () => {
  const action = await readFile(new URL("../action.yml", import.meta.url), "utf8");
  const parsed = YAML.parse(action) as Record<string, unknown>;
  assert.equal(parsed.name, "ShipLayer Store Delivery");
  assert.ok(parsed.runs);
});

test("composite action renders screenshots only behind an explicit input", async () => {
  const action = await readFile(new URL("../action.yml", import.meta.url), "utf8");
  assert.match(action, /render-screenshots:\n[\s\S]*?default: "false"/);
  assert.match(action, /if: \$\{\{ inputs\['render-screenshots'\] == 'true' \}\}/);
  assert.match(action, /npm install --ignore-scripts --no-audit --no-fund --package-lock=false --prefix "\$\{marketing_path\}"/);
  assert.match(action, /SHIPLAYER_PRESERVE_COMPLETE_DECKS=true SHIPLAYER_PW_CHANNEL=chrome npm run export/);
  assert.match(action, /SHIPLAYER_PW_CHANNEL=chrome npm run export --prefix "\$\{marketing_path\}"/);
});
