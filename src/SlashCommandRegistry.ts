// ── OWL Slash Command System (§21) ────────────────────────────
// Extensible registry for slash commands. Built-in commands are registered
// at startup; plugins and users can register custom commands at runtime.

export interface OWLCommandContext {
  args:      string[];
  rawInput:  string;
}

export type OWLHandler = (ctx: OWLCommandContext) => Promise<string> | string;

export interface OWLCommandOptions {
  description:  string;
  usage?:       string;
  category?:    'system' | 'agent' | 'knowledge' | 'tools' | 'custom';
  hidden?:      boolean;
}

export interface OWLCommand {
  name:     string;
  handler:  OWLHandler;
  options:  OWLCommandOptions;
}

export class SlashCommandRegistry {
  private static instance: SlashCommandRegistry;
  private commands: Map<string, OWLCommand> = new Map();
  private enabled = true;

  static getInstance(): SlashCommandRegistry {
    if (!this.instance) this.instance = new SlashCommandRegistry();
    return this.instance;
  }

  setEnabled(v: boolean): void { this.enabled = v; }
  isEnabled(): boolean { return this.enabled; }

  // Register a slash command. Overrides existing if same name.
  register(name: string, handler: OWLHandler, options: OWLCommandOptions): void {
    const key = name.toLowerCase().replace(/^\/+/, '');
    this.commands.set(key, { name: key, handler, options });
  }

  // Unregister a slash command by name.
  unregister(name: string): boolean {
    return this.commands.delete(name.toLowerCase().replace(/^\/+/, ''));
  }

  // Check if a command exists.
  has(name: string): boolean {
    return this.commands.has(name.toLowerCase().replace(/^\/+/, ''));
  }

  // Invoke a command. Returns null if not found.
  async invoke(input: string): Promise<string | null> {
    if (!this.enabled) return null;
    const parts = input.trim().replace(/^\//, '').split(/\s+/);
    const name  = (parts[0] ?? '').toLowerCase();
    const cmd   = this.commands.get(name);
    if (!cmd) return null;
    const ctx: OWLCommandContext = {
      args:     parts.slice(1),
      rawInput: input
    };
    return cmd.handler(ctx);
  }

  // List all registered commands (excluding hidden ones).
  list(includeHidden = false): OWLCommand[] {
    return [...this.commands.values()].filter(c => includeHidden || !c.options.hidden);
  }

  // Get help text for all registered commands.
  helpText(): string {
    const cmds = this.list();
    if (!cmds.length) return 'No custom OWL commands registered.';
    const byCategory = new Map<string, OWLCommand[]>();
    for (const cmd of cmds) {
      const cat = cmd.options.category ?? 'custom';
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(cmd);
    }
    const lines: string[] = ['**Registered Slash Commands:**\n'];
    for (const [cat, group] of byCategory) {
      lines.push(`**${cat.toUpperCase()}**`);
      for (const cmd of group) {
        const usage = cmd.options.usage ? ` ${cmd.options.usage}` : '';
        lines.push(`  /${cmd.name}${usage} — ${cmd.options.description}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }
}

// ── Register built-in OWL commands ────────────────────────────
export function registerBuiltinOWLCommands(registry: SlashCommandRegistry): void {

  // /owl — show OWL system info
  registry.register('owl', async () => {
    return `**OWL Slash Command System (§21)**\n\nStatus: ${registry.isEnabled() ? '✅ enabled' : '❌ disabled'}\nRegistered commands: ${registry.list().length}\n\n${registry.helpText()}`;
  }, {
    description: 'Show OWL slash command system info and registered commands',
    category:    'system'
  });

  // /owl-register — dynamically register a command
  registry.register('owl-register', async (ctx) => {
    const [name, ...descParts] = ctx.args;
    if (!name) return 'Usage: /owl-register <name> [description]';
    const desc = descParts.join(' ') || `Custom command: ${name}`;
    registry.register(name, async (c) => {
      return `OWL command /${name} invoked with args: ${c.args.join(' ') || '(none)'}`;
    }, { description: desc, category: 'custom' });
    return `✅ OWL command registered: /${name}`;
  }, {
    description: 'Dynamically register a new custom slash command',
    usage:       '<name> [description]',
    category:    'system'
  });

  // /owl-unregister — remove a command
  registry.register('owl-unregister', async (ctx) => {
    const name = ctx.args[0];
    if (!name) return 'Usage: /owl-unregister <name>';
    const ok = registry.unregister(name);
    return ok ? `✅ Unregistered: /${name}` : `Command not found: /${name}`;
  }, {
    description: 'Unregister a custom slash command',
    usage:       '<name>',
    category:    'system'
  });

  // /owl-list — list all OWL commands
  registry.register('owl-list', async () => registry.helpText(), {
    description: 'List all registered OWL slash commands',
    category:    'system'
  });

  // /owl-disable / /owl-enable
  registry.register('owl-disable', async () => {
    registry.setEnabled(false);
    return '⛔ OWL slash commands disabled.';
  }, { description: 'Disable the OWL slash command system', category: 'system' });

  registry.register('owl-enable', async () => {
    registry.setEnabled(true);
    return '✅ OWL slash commands enabled.';
  }, { description: 'Enable the OWL slash command system', category: 'system' });
}
