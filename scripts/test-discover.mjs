import { execSync, execFileSync } from 'node:child_process';

function extractArg(commandLine, name) {
  const match = new RegExp('(?:^|\\s)--' + name + '[ =](\\S+)').exec(commandLine);
  return match ? match[1] : undefined;
}

function listProcesses() {
  try {
    const psScript = 'Get-CimInstance Win32_Process | Where-Object { $_.Name -like "*language_server*" } | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress';
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    }).trim();
    if (!out) return [];
    const parsed = JSON.parse(out);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map(r => ({ pid: Number(r.ProcessId), commandLine: String(r.CommandLine || '') }))
      .filter(r => Number.isFinite(r.pid) && r.commandLine.includes('language_server'));
  } catch (e) {
    console.error('listProcesses error:', e);
    return [];
  }
}

function getListeningPortsForPids(pids) {
  const portsByPid = new Map();
  for (const pid of pids) portsByPid.set(pid, new Set());
  try {
    const output = execSync('netstat -ano', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const pidSet = new Set(pids);
    for (const line of output.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5 && parts[0] === 'TCP' && parts[3] === 'LISTENING') {
        const pid = parseInt(parts[4], 10);
        if (pidSet.has(pid)) {
          const addr = parts[1];
          const colonIdx = addr.lastIndexOf(':');
          if (colonIdx !== -1) {
            const port = parseInt(addr.slice(colonIdx + 1), 10);
            if (!isNaN(port)) portsByPid.get(pid)?.add(port);
          }
        }
      }
    }
  } catch (e) {
    console.error('netstat error:', e);
  }
  return portsByPid;
}

async function discover() {
  const procs = listProcesses();
  console.log('Procs found:', procs.length);
  const pids = procs.map(p => p.pid);
  const portsMap = getListeningPortsForPids(pids);

  for (const proc of procs) {
    const csrfToken = extractArg(proc.commandLine, 'csrf_token');
    if (!csrfToken) continue;

    const candidatePorts = new Set(portsMap.get(proc.pid) || []);
    for (const argName of ['extension_server_port', 'https_server_port', 'lsp_port']) {
      const p = extractArg(proc.commandLine, argName);
      if (p) {
        const num = parseInt(p, 10);
        if (!isNaN(num)) {
          candidatePorts.add(num);
          candidatePorts.add(num + 1);
          candidatePorts.add(num + 2);
          candidatePorts.add(num + 3);
        }
      }
    }

    console.log('PID:', proc.pid, 'Testing candidate ports:', [...candidatePorts]);
    for (const port of candidatePorts) {
      try {
        const res = await fetch('http://127.0.0.1:' + port + '/exa.language_server_pb.LanguageServerService/Heartbeat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-codeium-csrf-token': csrfToken,
          },
          body: '{}',
        });
        if (res.ok) {
          const modelRes = await fetch('http://127.0.0.1:' + port + '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-codeium-csrf-token': csrfToken,
            },
            body: '{}',
          });
          if (modelRes.ok) {
            const data = await modelRes.json();
            const models = data.clientModelConfigs || [];
            console.log(`>>> SUCCESS! Found valid instance on port ${port} with ${models.length} models!`);
            return { port, csrfToken, pid: proc.pid };
          }
        }
      } catch (err) {}
    }
  }
  return undefined;
}

discover().then(res => console.log('Final Discovered Instance:', res));
