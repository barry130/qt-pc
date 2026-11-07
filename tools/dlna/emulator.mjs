/**
 * Local DLNA MediaRenderer for repeatable development checks.
 * It exercises SSDP + SOAP and probes the sender's real media HTTP endpoint.
 * It does not decode audio and cannot replace a television compatibility test.
 */
import http from "node:http";
import dgram from "node:dgram";
import { networkInterfaces } from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const ROOT_DEVICE = "urn:schemas-upnp-org:device:MediaRenderer:1";
const SERVICE_PREFIX = "urn:schemas-upnp-org:service:";
const SERVICES = {
  AVTransport: {
    SetAVTransportURI: [["InstanceID", "in"], ["CurrentURI", "in"], ["CurrentURIMetaData", "in"]],
    Play: [["InstanceID", "in"], ["Speed", "in"]],
    Pause: [["InstanceID", "in"]],
    Stop: [["InstanceID", "in"]],
    Seek: [["InstanceID", "in"], ["Unit", "in"], ["Target", "in"]],
    GetTransportInfo: [["InstanceID", "in"], ["CurrentTransportState", "out"], ["CurrentTransportStatus", "out"], ["CurrentSpeed", "out"]],
    GetPositionInfo: [["InstanceID", "in"], ["Track", "out"], ["TrackDuration", "out"], ["TrackMetaData", "out"], ["TrackURI", "out"], ["RelTime", "out"], ["AbsTime", "out"], ["RelCount", "out"], ["AbsCount", "out"]],
    GetMediaInfo: [["InstanceID", "in"], ["NrTracks", "out"], ["MediaDuration", "out"], ["CurrentURI", "out"], ["CurrentURIMetaData", "out"], ["NextURI", "out"], ["NextURIMetaData", "out"], ["PlayMedium", "out"], ["RecordMedium", "out"], ["WriteStatus", "out"]],
    GetCurrentTransportActions: [["InstanceID", "in"], ["Actions", "out"]],
  },
  RenderingControl: {
    GetVolume: [["InstanceID", "in"], ["Channel", "in"], ["CurrentVolume", "out"]],
    SetVolume: [["InstanceID", "in"], ["Channel", "in"], ["DesiredVolume", "in"]],
    GetMute: [["InstanceID", "in"], ["Channel", "in"], ["CurrentMute", "out"]],
    SetMute: [["InstanceID", "in"], ["Channel", "in"], ["DesiredMute", "in"]],
  },
  ConnectionManager: {
    GetProtocolInfo: [["Source", "out"], ["Sink", "out"]],
  },
};
const xml = value => String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[ch]));
const unxml = value => value.replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" }[entity]));
const valueOf = (body, name) => unxml(new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`).exec(body)?.[1] ?? "");
const clock = () => performance.now() / 1000;
const timeOf = seconds => {
  const value = Math.max(0, Math.floor(seconds));
  return [Math.floor(value / 3600), Math.floor(value / 60) % 60, value % 60].map(n => String(n).padStart(2, "0")).join(":");
};
const secondsOf = value => {
  const match = /^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(value);
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4] ?? "0"}`);
};

function scpd(service, allowSeek) {
  const entries = Object.entries(SERVICES[service]).filter(([action]) => allowSeek || action !== "Seek");
  const variables = new Map();
  const actions = entries.map(([name, args]) => {
    const list = args.map(([arg, direction]) => {
      const variable = arg === "DesiredVolume" || arg === "CurrentVolume" ? "Volume" : `A_ARG_TYPE_${arg}`;
      variables.set(variable, arg);
      return `<argument><name>${arg}</name><direction>${direction}</direction><relatedStateVariable>${variable}</relatedStateVariable></argument>`;
    }).join("");
    return `<action><name>${name}</name><argumentList>${list}</argumentList></action>`;
  }).join("");
  const stateVariables = [...variables].map(([name, arg]) => {
    const numeric = /^(InstanceID|Track|NrTracks|DesiredVolume|CurrentVolume|DesiredMute|CurrentMute)$/.test(arg);
    const range = name === "Volume" ? "<allowedValueRange><minimum>0</minimum><maximum>100</maximum><step>1</step></allowedValueRange>" : "";
    return `<stateVariable sendEvents="no"><name>${name}</name><dataType>${numeric ? "ui4" : "string"}</dataType>${range}</stateVariable>`;
  }).join("");
  return `<?xml version="1.0"?><scpd xmlns="urn:schemas-upnp-org:service-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><actionList>${actions}</actionList><serviceStateTable>${stateVariables}</serviceStateTable></scpd>`;
}

function silenceWave(seconds) {
  const length = Math.ceil(seconds * 8000) * 2;
  const bytes = Buffer.alloc(44 + length);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(36 + length, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(length, 40);
  return bytes;
}

function serveBytes(req, res, bytes, type) {
  let start = 0, end = bytes.length - 1, status = 200;
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      res.writeHead(416, { "Content-Range": `bytes */${bytes.length}` }); res.end(); return;
    }
    if (match[1]) { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end; }
    else { start = Math.max(0, bytes.length - Number(match[2])); }
    if (start > end || start >= bytes.length || (!match[1] && Number(match[2]) === 0)) {
      res.writeHead(416, { "Content-Range": `bytes */${bytes.length}` }); res.end(); return;
    }
    status = 206;
  }
  const headers = { "Content-Type": type, "Content-Length": end - start + 1, "Accept-Ranges": "bytes" };
  if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${bytes.length}`;
  res.writeHead(status, headers);
  res.end(req.method === "HEAD" ? undefined : bytes.subarray(start, end + 1));
}

export async function startEmulator({
  host = "0.0.0.0", advertisedHost = "127.0.0.1", port = 49160,
  ssdpPort = 1900, enableSsdp = true, duration = 12, allowSeek = true,
  soapDelayMs = 0, probeMedia = true, log = () => {},
} = {}) {
  const udn = `uuid:${randomUUID()}`;
  const bytes = silenceWave(Math.max(1, Math.min(duration, 120)));
  const events = [];
  const state = { transport: "NO_MEDIA_PRESENT", uri: "", metadata: "", position: 0, anchor: clock(), volume: 50, mute: false, probe: null };
  let baseUrl = "";
  let udp = null;
  const position = () => {
    const current = state.position + (state.transport === "PLAYING" ? clock() - state.anchor : 0);
    if (state.transport === "PLAYING" && current >= duration) {
      state.position = duration; state.anchor = clock(); state.transport = "STOPPED";
    }
    return Math.min(duration, current);
  };
  const record = event => {
    events.push({ at: Date.now(), ...event });
    if (events.length > 100) events.shift();
    log(event);
  };
  const probe = async uri => {
    const result = { uri };
    try {
      const head = await fetch(uri, { method: "HEAD", signal: AbortSignal.timeout(5000) });
      result.headStatus = head.status; result.length = head.headers.get("content-length");
      const response = await fetch(uri, { headers: { Range: "bytes=0-31" }, signal: AbortSignal.timeout(5000) });
      result.rangeStatus = response.status; result.contentRange = response.headers.get("content-range");
      const reader = response.body?.getReader();
      if (reader) { const chunk = await reader.read(); result.firstBytes = chunk.value?.length ?? 0; await reader.cancel(); }
      result.ok = head.ok && response.ok;
    } catch (error) { result.ok = false; result.error = String(error); }
    state.probe = result; record({ type: "media-probe", ...result });
  };
  const reply = (res, service, action, fields) => {
    const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action}Response xmlns:u="${SERVICE_PREFIX}${service}:1">${Object.entries(fields).map(([key, value]) => `<${key}>${xml(value)}</${key}>`).join("")}</u:${action}Response></s:Body></s:Envelope>`;
    res.writeHead(200, { "Content-Type": 'text/xml; charset="utf-8"', "Content-Length": Buffer.byteLength(body) }); res.end(body);
  };
  const fault = (res, code, description) => {
    const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${xml(description)}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`;
    res.writeHead(500, { "Content-Type": "text/xml" }); res.end(body);
  };
  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (req.method === "GET" && path === "/description.xml") {
        const services = Object.keys(SERVICES).map(service => `<service><serviceType>${SERVICE_PREFIX}${service}:1</serviceType><serviceId>urn:upnp-org:serviceId:${service}</serviceId><SCPDURL>/scpd/${service}.xml</SCPDURL><controlURL>/control/${service}</controlURL><eventSubURL>/event/${service}</eventSubURL></service>`).join("");
        res.setHeader("Content-Type", "text/xml");
        res.end(`<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><URLBase>${baseUrl}/</URLBase><device><deviceType>${ROOT_DEVICE}</deviceType><friendlyName>QuietMusic DLNA Test Renderer</friendlyName><manufacturer>QuietMusic Development</manufacturer><modelName>Protocol Emulator</modelName><UDN>${udn}</UDN><serviceList>${services}</serviceList></device></root>`);
        return;
      }
      const serviceDescription = /^\/scpd\/(\w+)\.xml$/.exec(path);
      if (req.method === "GET" && serviceDescription && SERVICES[serviceDescription[1]]) {
        res.setHeader("Content-Type", "text/xml"); res.end(scpd(serviceDescription[1], allowSeek)); return;
      }
      if (req.method === "GET" && path === "/state") {
        position(); res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ udn, baseUrl, duration, ...state, position: position(), events })); return;
      }
      if (["GET", "HEAD"].includes(req.method) && ["/fixture/audio.wav", "/fixture/protected.wav"].includes(path)) {
        if (path.includes("protected") && req.headers.referer !== "https://dlna-test.invalid/") {
          res.writeHead(403); res.end("Expected Referer: https://dlna-test.invalid/"); return;
        }
        serveBytes(req, res, bytes, "audio/wav"); return;
      }
      const service = /^\/control\/(\w+)$/.exec(path)?.[1];
      if (req.method !== "POST" || !SERVICES[service]) { res.writeHead(404); res.end(); return; }
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 65536) { res.writeHead(413); res.end(); return; }
      }
      const action = /#(\w+)"?$/.exec(String(req.headers.soapaction ?? ""))?.[1];
      record({ type: "soap", service, action, uri: valueOf(body, "CurrentURI"), target: valueOf(body, "Target") });
      if (soapDelayMs) await new Promise(resolve => setTimeout(resolve, soapDelayMs));
      if (!action || !SERVICES[service][action] || (!allowSeek && action === "Seek")) { fault(res, 401, "Invalid Action"); return; }
      if (action !== "GetProtocolInfo" && valueOf(body, "InstanceID") !== "0") { fault(res, 718, "Invalid InstanceID"); return; }
      position();
      let fields = {};
      switch (action) {
        case "SetAVTransportURI": {
          const uri = valueOf(body, "CurrentURI");
          if (!/^https?:\/\//i.test(uri)) { fault(res, 714, "Illegal MIME-type"); return; }
          state.uri = uri; state.metadata = valueOf(body, "CurrentURIMetaData");
          state.position = 0; state.anchor = clock(); state.transport = "STOPPED"; state.probe = null;
          break;
        }
        case "Play":
          if (!state.uri) { fault(res, 701, "Transition not available"); return; }
          if (probeMedia && !state.probe) await probe(state.uri);
          if (probeMedia && !state.probe?.ok) { fault(res, 714, "Unable to fetch media"); return; }
          state.position = position();
          if (state.position >= duration) state.position = 0;
          state.anchor = clock(); state.transport = "PLAYING"; break;
        case "Pause": state.position = position(); state.anchor = clock(); state.transport = "PAUSED_PLAYBACK"; break;
        case "Stop": state.position = position(); state.anchor = clock(); state.transport = "STOPPED"; break;
        case "Seek": {
          if (valueOf(body, "Unit") !== "REL_TIME") { fault(res, 710, "Seek mode not supported"); return; }
          const target = secondsOf(valueOf(body, "Target"));
          if (target === null || target > duration) { fault(res, 711, "Illegal seek target"); return; }
          state.position = target; state.anchor = clock(); break;
        }
        case "GetTransportInfo": fields = { CurrentTransportState: state.transport, CurrentTransportStatus: "OK", CurrentSpeed: "1" }; break;
        case "GetPositionInfo": fields = { Track: state.uri ? 1 : 0, TrackDuration: timeOf(duration), TrackMetaData: state.metadata, TrackURI: state.uri, RelTime: timeOf(position()), AbsTime: timeOf(position()), RelCount: -1, AbsCount: -1 }; break;
        case "GetMediaInfo": fields = { NrTracks: state.uri ? 1 : 0, MediaDuration: timeOf(duration), CurrentURI: state.uri, CurrentURIMetaData: state.metadata, NextURI: "", NextURIMetaData: "", PlayMedium: "NETWORK", RecordMedium: "NOT_IMPLEMENTED", WriteStatus: "NOT_IMPLEMENTED" }; break;
        case "GetCurrentTransportActions": fields = { Actions: `Play,Pause,Stop${allowSeek ? ",Seek" : ""}` }; break;
        case "GetVolume": fields = { CurrentVolume: state.volume }; break;
        case "SetVolume": state.volume = Math.max(0, Math.min(100, Number(valueOf(body, "DesiredVolume")))); break;
        case "GetMute": fields = { CurrentMute: state.mute ? 1 : 0 }; break;
        case "SetMute": state.mute = valueOf(body, "DesiredMute") === "1"; break;
        case "GetProtocolInfo": fields = { Source: "", Sink: ["audio/mpeg", "audio/mp4", "audio/aac", "audio/wav", "audio/x-wav", "audio/flac"].map(type => `http-get:*:${type}:*`).join(",") }; break;
      }
      reply(res, service, action, fields);
    } catch (error) {
      record({ type: "error", error: String(error) });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  server.requestTimeout = 10000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  baseUrl = `http://${advertisedHost}:${server.address().port}`;
  if (enableSsdp) {
    udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
    udp.on("error", error => record({ type: "ssdp-error", error: String(error) }));
    udp.on("message", (message, remote) => {
      const text = message.toString();
      if (!/^M-SEARCH \* HTTP\/1\.1/i.test(text)) return;
      const st = /^ST:\s*(.+)\r?$/im.exec(text)?.[1]?.trim();
      const supported = [ROOT_DEVICE, `${SERVICE_PREFIX}AVTransport:1`, "upnp:rootdevice", udn];
      if (st !== "ssdp:all" && !supported.includes(st)) return;
      for (const target of st === "ssdp:all" ? supported : [st]) {
        const response = `HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nEXT:\r\nLOCATION: ${baseUrl}/description.xml\r\nSERVER: Node UPnP/1.0 QuietMusic-Test/1.0\r\nST: ${target}\r\nUSN: ${target === udn ? udn : `${udn}::${target}`}\r\n\r\n`;
        udp.send(response, remote.port, remote.address);
      }
      record({ type: "discovery", remote: remote.address, st });
    });
    await new Promise((resolve, reject) => { udp.once("error", reject); udp.bind(ssdpPort, "0.0.0.0", resolve); });
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family === "IPv4" && !entry.internal) {
          try { udp.addMembership("239.255.255.250", entry.address); }
          catch (error) { record({ type: "membership-error", address: entry.address, error: String(error) }); }
        }
      }
    }
  }
  return {
    baseUrl, udn, server, getState: () => ({ ...state, position: position(), events: [...events] }),
    close: async () => {
      if (udp) await new Promise(resolve => udp.close(resolve));
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const option = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
  const emulator = await startEmulator({
    advertisedHost: option("--host") ?? "127.0.0.1",
    port: Number(option("--port") ?? 49160),
    duration: Number(option("--duration") ?? 12),
    allowSeek: !process.argv.includes("--reject-seek"),
    soapDelayMs: Number(option("--soap-delay-ms") ?? 0),
    log: event => console.log(JSON.stringify(event)),
  });
  console.log(`DLNA renderer: ${emulator.baseUrl}/description.xml`);
  console.log(`Test audio: ${emulator.baseUrl}/fixture/audio.wav`);
  console.log(`Protected audio: ${emulator.baseUrl}/fixture/protected.wav (Referer: https://dlna-test.invalid/)`);
  console.log("Send 'stop' on stdin or Ctrl+C to stop the emulator.");
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await emulator.close(); process.exit(0); };
  process.on("SIGINT", close); process.on("SIGTERM", close);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", data => { if (data.trim() === "stop") void close(); });
}
