import * as vscode from 'vscode';
import * as https  from 'https';
import * as http   from 'http';

// ── Dangerous command patterns ─────────────────────────────────
const BLOCK_PATTERNS: Array<[RegExp, string]> = [
  [/rm\s+-[rf]+\s+\/(?!\w)/i,      'Deletes entire filesystem root'],
  [/:\(\)\s*\{\s*:\|:&\s*\}/,      'Fork bomb detected'],
  [/dd\s+if=.*\bof=\/dev\/(sd|hd|xvd)/i, 'Overwrites raw disk device'],
  [/mkfs(\.\w+)?\s+\/dev\//i,      'Formats a raw disk device'],
  [/format\s+c:/i,                 'Formats C: drive (Windows)'],
  [/del\s+\/[fqs]+\s+[a-z]:\\/i,  'Recursive delete on Windows drive'],
  [/>\s*\/dev\/(sd|hd|xvd|nvme)/i, 'Writes directly to block device'],
];

// ── Suspicious patterns — require confirmation ─────────────────
const CONFIRM_PATTERNS: Array<[RegExp, string]> = [
  [/\bsudo\b/,                    'Command requires elevated privileges (sudo)'],
  [/curl\s+.*\|\s*(bash|sh)\b/i,  'Pipes remote script directly to shell'],
  [/wget\s+.*\|\s*(bash|sh)\b/i,  'Pipes remote download directly to shell'],
  [/chmod\s+[0-7]*7[0-7]*\s+\//,  'Sets world-writable permissions on system path'],
  [/\breg\s+delete\b/i,           'Deletes Windows Registry keys'],
  [/net\s+user\s+.*\/add/i,       'Creates new Windows user account'],
  [/taskkill\s+\/f/i,             'Force-kills processes'],
  [/rm\s+-[rf]+\b/i,              'Recursive delete — please confirm'],
  [/shutdown\b/i,                  'System shutdown command'],
  [/reboot\b/i,                    'System reboot command'],
];

// ── Shell config files that should not be modified without warning ─
const SHELL_CONFIG_PATTERNS: RegExp[] = [
  /\.(bash_profile|bashrc|bash_logout|zshrc|zprofile|profile|zshenv)\b/,
  /\/(etc\/profile|etc\/bashrc|etc\/environment)\b/,
  /\bautoexec\.bat\b/i,
  /\$(?:HOME|USERPROFILE).*\.profile\b/,
];

export class PolicyGuardian {
  private enabled = true;

  setEnabled(v: boolean): void { this.enabled = v; }

  // Returns null if safe, throws/rejects if blocked, returns string if needs confirmation
  async vet(command: string): Promise<void> {
    if (!this.enabled) return;

    // Hard block
    for (const [pattern, reason] of BLOCK_PATTERNS) {
      if (pattern.test(command)) {
        throw new Error(
          `🛡️ PolicyGuardian BLOCKED: "${command}"\nReason: ${reason}\n` +
          `This command is too dangerous to execute.`
        );
      }
    }

    // Requires confirmation
    for (const [pattern, reason] of CONFIRM_PATTERNS) {
      if (pattern.test(command)) {
        const choice = await vscode.window.showWarningMessage(
          `⚠️ PolicyGuardian: Potentially dangerous command`,
          { modal: true, detail: `Command: ${command}\nWarning: ${reason}` },
          'Allow Once', 'Block'
        );
        if (choice !== 'Allow Once') {
          throw new Error(`🛡️ PolicyGuardian blocked command: ${command}`);
        }
        return; // user approved, allow
      }
    }

    // Supply chain check: deps.dev for install commands
    await this.vetInstallCommand(command);

    // Shell config detection — warn if command touches shell config files
    if (this.touchesShellConfig(command)) {
      const choice = await vscode.window.showWarningMessage(
        `⚠️ PolicyGuardian: Shell config modification detected`,
        { modal: true, detail: `Command appears to modify shell startup files (e.g. .bashrc, .zshrc).\nThis can persist across sessions and affect future commands.\n\nCommand: ${command.slice(0, 150)}` },
        'Allow Once', 'Block'
      );
      if (choice !== 'Allow Once') {
        throw new Error('PolicyGuardian blocked shell config modification');
      }
      return;
    }

    // Scan for common credential exposure patterns
    if (this.looksLikeCredentialExposure(command)) {
      const choice = await vscode.window.showWarningMessage(
        `⚠️ PolicyGuardian: Possible credential exposure`,
        { modal: true, detail: `Command may print secrets to terminal: ${command.slice(0, 100)}` },
        'Allow', 'Block'
      );
      if (choice !== 'Allow') {
        throw new Error('PolicyGuardian blocked credential exposure risk');
      }
    }
  }

  // Data flow vetting — check if a URL/command sends data to external host
  vetDataFlow(description: string, target: string): string[] {
    const warnings: string[] = [];
    const lower = target.toLowerCase();

    // Check for suspicious data destinations
    if (/https?:\/\/(?!localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(target)) {
      if (/api[_-]?key|secret|token|password|credential|auth/i.test(description)) {
        warnings.push(`🛡️ Data flow: "${description}" is being sent to external host "${target}". This may expose secrets.`);
      }
    }

    // Check for suspicious outbound methods
    if (/\b(exfil|upload|send|post|put)\b/i.test(description) && /https?:\/\//.test(target)) {
      warnings.push(`🛡️ Data flow: outbound data transfer to ${target}. Verify this is intentional.`);
    }

    return warnings;
  }

  // deps.dev supply chain check (§18)
  // Queries deps.dev API to check license and known vulnerabilities for a package.
  async checkDepsdev(packageManager: string, packageName: string): Promise<{ ok: boolean; warnings: string[] }> {
    const warnings: string[] = [];
    try {
      const encoded = encodeURIComponent(packageName);
      const url     = `https://api.deps.dev/v3alpha/query?versionKey.system=${packageManager.toUpperCase()}&versionKey.name=${encoded}&versionKey.version=`;
      const result  = await fetchJson(url);
      const info    = result as { version?: { licenses?: string[]; advisories?: Array<{ title: string; severity: string }> } };
      const ver     = info?.version;
      if (ver?.advisories?.length) {
        for (const adv of ver.advisories) {
          if (adv.severity === 'CRITICAL' || adv.severity === 'HIGH') {
            warnings.push(`🛡️ deps.dev: ${packageName} has ${adv.severity} advisory: "${adv.title}"`);
          }
        }
      }
      const licenses = ver?.licenses ?? [];
      const badLicenses = licenses.filter(l => /gpl|agpl|sspl|busl/i.test(l));
      if (badLicenses.length) {
        warnings.push(`🛡️ deps.dev: ${packageName} uses potentially restrictive license(s): ${badLicenses.join(', ')}`);
      }
    } catch {
      // Non-fatal: deps.dev unavailable
    }
    return { ok: warnings.length === 0, warnings };
  }

  // Google Safe Browsing API check (§18)
  // Checks URLs against Google's Safe Browsing threat lists.
  async checkSafeBrowsing(urls: string[]): Promise<{ ok: boolean; warnings: string[] }> {
    const warnings: string[] = [];
    const cfg    = vscode.workspace.getConfiguration('ragAssistant');
    const apiKey = cfg.get<string>('safeBrowsingApiKey') ?? '';
    if (!apiKey || !urls.length) return { ok: true, warnings: [] };

    try {
      const body = JSON.stringify({
        client:      { clientId: 'rag-assistant', clientVersion: '1.0' },
        threatInfo:  {
          threatTypes:      ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
          platformTypes:    ['ANY_PLATFORM'],
          threatEntryTypes: ['URL'],
          threatEntries:    urls.map(url => ({ url }))
        }
      });

      const result = await postJson(
        `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${apiKey}`,
        body
      );

      const matches = (result as { matches?: Array<{ threat: { url: string }; threatType: string }> })?.matches ?? [];
      for (const m of matches) {
        warnings.push(`🛡️ SafeBrowsing: ${m.threat.url} flagged as ${m.threatType}`);
      }
    } catch {
      // Non-fatal: SafeBrowsing unavailable
    }
    return { ok: warnings.length === 0, warnings };
  }

  // Check if a command installs dependencies (npm install, pip install, etc.)
  async vetInstallCommand(cmd: string): Promise<void> {
    const installMatch = cmd.match(/(?:npm\s+install|yarn\s+add|pip\s+install|pip3\s+install|cargo\s+add|go\s+get)\s+([^\s@]+)/i);
    if (!installMatch) return;

    const pkgName = installMatch[1];
    const pm      = installMatch[0].startsWith('npm') || installMatch[0].startsWith('yarn') ? 'npm'
      : installMatch[0].startsWith('pip') ? 'pypi'
      : installMatch[0].startsWith('cargo') ? 'cargo'
      : 'go';

    const { warnings } = await this.checkDepsdev(pm, pkgName);
    if (warnings.length) {
      const choice = await vscode.window.showWarningMessage(
        `⚠️ PolicyGuardian: Supply chain warning for "${pkgName}"`,
        { modal: true, detail: warnings.join('\n') },
        'Install Anyway', 'Block'
      );
      if (choice !== 'Install Anyway') {
        throw new Error(`PolicyGuardian blocked install of ${pkgName}: ${warnings[0]}`);
      }
    }
  }

  private touchesShellConfig(cmd: string): boolean {
    return SHELL_CONFIG_PATTERNS.some(p => p.test(cmd));
  }

  private looksLikeCredentialExposure(cmd: string): boolean {
    const lower = cmd.toLowerCase();
    return (lower.includes('cat') || lower.includes('type') || lower.includes('echo')) &&
      (lower.includes('.env') || lower.includes('secret') || lower.includes('password') ||
       lower.includes('token') || lower.includes('apikey'));
  }

  // Scan LLM-generated code for security issues before showing to user
  scanCode(code: string, filename: string): string[] {
    const warnings: string[] = [];

    if (/eval\s*\(/.test(code)) warnings.push('eval() usage detected — potential code injection');
    if (/exec\s*\(/.test(code) && /http/.test(code)) warnings.push('exec() with HTTP content — potential RCE');
    if (/password\s*=\s*["'][^"']{3,}["']/i.test(code)) warnings.push('Hardcoded password in code');
    if (/api[_-]?key\s*=\s*["'][A-Za-z0-9]{20,}["']/i.test(code)) warnings.push('Hardcoded API key in code');
    if (/secret\s*=\s*["'][^"']{8,}["']/i.test(code)) warnings.push('Hardcoded secret in code');
    if (/http:\/\/(?!localhost|127\.)/.test(code)) warnings.push('HTTP (not HTTPS) URL in code — insecure');
    if (/sql.*\+.*req\.(body|params|query)/i.test(code)) warnings.push('Possible SQL injection vulnerability');
    if (/innerHTML\s*=/.test(code)) warnings.push('innerHTML usage — potential XSS vulnerability');

    return warnings;
  }
}

let _guardian: PolicyGuardian | undefined;
export function getPolicyGuardian(): PolicyGuardian {
  if (!_guardian) _guardian = new PolicyGuardian();
  return _guardian;
}

// ── HTTP helpers for external API calls ───────────────────────
function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'RAG-Assistant/1.0', 'Accept': 'application/json' }, timeout: 8000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
      res.on('error', reject);
    }).on('error', reject).on('timeout', function(this: { destroy: () => void }) { this.destroy(); reject(new Error('timeout')); });
  });
}

function postJson(url: string, body: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'RAG-Assistant/1.0' },
      timeout:  8000
    };
    const req = https.request(options, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}
