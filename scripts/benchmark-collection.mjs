/** Synthetic, deterministic collection benchmark; no database or user metadata is read. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = process.argv[2] || "src/lib/collect-choice.ts";
const bundle = await build({ absWorkingDir: root, entryPoints: [source], bundle: true, platform: "node", format: "esm", write: false });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

function fixture(count, incomingCount) {
  const words = ["Blue", "River", "Silent", "Morning", "Memory", "Light", "Summer", "Night", "Rain", "Home", "Beyond", "Island", "Street", "Winter", "Echo", "Ocean", "Cloud", "Dream", "Silver", "World", "Young", "Song", "Distant", "Golden", "Road", "Forever", "Northern", "Fields", "Dawn", "Time", "Falling", "Heart"];
  let seed = 80391;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 16; };
  const songs = Array.from({ length: count }, (_, i) => ({
    id: String(i), platform: ["qq", "wyy", "kw"][i % 3],
    title: Array.from({ length: 3 + next() % 5 }, () => words[next() % words.length]).join(" "),
    singer: "Artist " + words[next() % words.length] + " " + words[next() % words.length],
    album: Array.from({ length: 3 }, () => words[next() % words.length]).join(" "), picUrl: "", duration: 180 + i % 120,
  }));
  const incoming = Array.from({ length: incomingCount }, (_, i) => ({
    ...songs[(i * 71) % count], platform: "kg", id: "new-" + i,
    title: songs[(i * 71) % count].title + (i % 3 === 0 ? " (Live)" : ""),
  }));
  return { songs, incoming };
}

const measurements = [];
for (const [count, adds] of [[200, 1], [1000, 50], [5000, 100], [10000, 200]]) {
  const { songs, incoming } = fixture(count, adds);
  const start = performance.now();
  const plan = api.buildCollectChoice(songs, incoming);
  const syncMs = performance.now() - start;
  assert.equal(plan.groups.length, adds);
  const row = { count, adds, groups: plan.groups.length, syncMs };
  if (api.buildCollectChoiceAsync) {
    let maxHeartbeatGapMs = 0, heartbeats = 0, last = performance.now();
    const heartbeat = setInterval(() => {
      const now = performance.now();
      maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, now - last); last = now; heartbeats++;
    }, 1);
    const asyncStart = performance.now();
    let result;
    try { result = await api.buildCollectChoiceAsync(songs, incoming, () => true); }
    finally { clearInterval(heartbeat); }
    Object.assign(row, { asyncMs: performance.now() - asyncStart, maxHeartbeatGapMs: Math.max(maxHeartbeatGapMs, performance.now() - last), heartbeats });
    assert.deepEqual(result, plan);
  }
  measurements.push(row);
}
console.log(JSON.stringify({ node: process.version, source, measurements }, null, 2));
