import * as vscode from 'vscode';
import * as fs     from 'fs';
import * as path   from 'path';
import * as cp     from 'child_process';
import * as https  from 'https';
import * as http   from 'http';
import * as crypto from 'crypto';
import * as net    from 'net';
import { getPolicyGuardian } from './PolicyGuardian';
import { RESEARCH_TOOL_DEFS, RESEARCH_TOOL_NAMES, runResearchTool, ResearchOpts } from './ResearchTools';

// ── Shell used by run_command ──────────────────────────────────
// Models almost always write POSIX commands (ls, cat, grep, 2>/dev/null) but Node's default shell on
// Windows is cmd.exe. Prefer Git Bash, fall back to PowerShell, and tell the model which one it gets.
interface ShellSpec { file: string; args: (cmd: string) => string[]; label: string; }

function resolveShell(): ShellSpec | undefined {
  if (process.platform !== 'win32') return undefined; // exec() default (/bin/sh) is already POSIX
  const candidates = [
    path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'Git', 'bin', 'bash.exe')
  ];
  const bash = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
  if (bash) {
    return { file: bash, args: c => ['-c', c], label: 'Git Bash on Windows (POSIX commands such as ls, cat, grep work; use forward slashes)' };
  }
  return {
    file: 'powershell.exe',
    args: c => ['-NoProfile', '-NonInteractive', '-Command', c],
    label: 'Windows PowerShell (use PowerShell syntax; `&&` is not supported, use `;`; no /dev/null, use $null)'
  };
}
export const RUN_SHELL = resolveShell();
export const SHELL_LABEL = RUN_SHELL?.label ?? 'POSIX sh';

// ── Tool definitions (OpenAI function schema) ──────────────────
export const TOOL_DEFS = [
  {
    type: 'function' as const,
    function: {
      name: 'view_file',
      description: 'View file contents with line numbers. Returns the file text.',
      parameters: {
        type: 'object',
        properties: {
          path:       { type: 'string', description: 'File path relative to workspace root' },
          start_line: { type: 'number', description: 'Start line (1-based)' },
          end_line:   { type: 'number', description: 'End line (1-based)' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_multiple_files',
      description: 'Read several files at once. Returns concatenated contents.',
      parameters: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: 'Array of file paths relative to workspace root' }
        },
        required: ['paths']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_file',
      description: 'Create a new file. Parent directories are created automatically.',
      parameters: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'File path relative to workspace root' },
          content: { type: 'string', description: 'Complete file content' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'edit_file',
      description: 'Replace a specific string in a file with new content. Use allow_multiple=true to replace all occurrences (SINGLE_MULTI variant).',
      parameters: {
        type: 'object',
        properties: {
          path:           { type: 'string',  description: 'File path relative to workspace root' },
          old_str:        { type: 'string',  description: 'Exact string to find and replace' },
          new_str:        { type: 'string',  description: 'Replacement string' },
          allow_multiple: { type: 'boolean', description: 'Replace all occurrences instead of just the first (SINGLE_MULTI variant)' }
        },
        required: ['path', 'old_str', 'new_str']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'insert_at_line',
      description: 'Insert text at a specific line number in a file. Existing lines shift down.',
      parameters: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'File path relative to workspace root' },
          line:    { type: 'number', description: 'Line number to insert before (1-based)' },
          content: { type: 'string', description: 'Text to insert (newline appended automatically)' }
        },
        required: ['path', 'line', 'content']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'apply_diff',
      description: 'Apply a unified diff (patch) to a file. Diff must be in standard unified format.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace root' },
          diff: { type: 'string', description: 'Unified diff content (starting with @@)' }
        },
        required: ['path', 'diff']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'move_file',
      description: 'Move or rename a file within the workspace.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Current file path relative to workspace root' },
          to:   { type: 'string', description: 'New file path relative to workspace root' }
        },
        required: ['from', 'to']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_file',
      description: 'Delete a file from the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace root' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_directory',
      description: 'List files and directories in a path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to workspace root (empty = root)' }
        }
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_file_outline',
      description: 'Get a structural outline of a file: classes, functions, exports, and their line numbers.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace root' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'view_file_outline',
      description: 'Get high-level outline of a file — functions, classes, methods without full source. Alias for get_file_outline.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace root' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'grep_search',
      description: 'Search file contents using a regex pattern across the workspace.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          glob:    { type: 'string', description: 'File glob filter (e.g. **/*.ts)' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_symbol',
      description: 'Find where a symbol (function, class, variable) is defined in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Symbol name to search for' },
          kind: { type: 'string', description: 'Symbol kind: function, class, interface, type, const, variable' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'run_command',
      description: `Execute a shell command in the workspace directory and return its output. Shell: ${SHELL_LABEL}.`,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: `Shell command to run (${SHELL_LABEL})` },
          timeout: { type: 'number', description: 'Timeout in milliseconds (default 120000, max 600000). Long builds (cargo, npm install) may need more, or background:true' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'web_fetch',
      description: 'Fetch the text content of a URL (GET request). Returns response body as text.',
      parameters: {
        type: 'object',
        properties: {
          url:       { type: 'string', description: 'URL to fetch' },
          max_chars: { type: 'number', description: 'Maximum characters to return (default 4000)' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_diagnostics',
      description: 'Get current errors and warnings from the IDE for the active file.',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: 'active_file (default) or workspace' }
        }
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_directory',
      description: 'Delete a directory and all its contents recursively.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to workspace root' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'view_code_item',
      description: 'View a specific function, class, or method by name within a file. Returns the item signature and body with line numbers.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace root' },
          name: { type: 'string', description: 'Function, class, or method name to find' }
        },
        required: ['path', 'name']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'view_content_chunk',
      description: 'View a specific byte range of a file. Useful for large files.',
      parameters: {
        type: 'object',
        properties: {
          path:   { type: 'string', description: 'File path relative to workspace root' },
          offset: { type: 'number', description: 'Byte offset to start reading from' },
          length: { type: 'number', description: 'Number of bytes to read (default 2000)' }
        },
        required: ['path', 'offset']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'find_all_references',
      description: 'Find all places where a symbol or identifier is used across the workspace.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Symbol name to find all references for' },
          glob: { type: 'string', description: 'File glob filter (default: **/*.{ts,tsx,js,jsx,py,go,rs})' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_blob',
      description: 'Write base64-encoded binary content to a file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace root' },
          data: { type: 'string', description: 'Base64-encoded binary content' }
        },
        required: ['path', 'data']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_terminal',
      description: 'Read the current contents of the terminal output buffer.',
      parameters: {
        type: 'object',
        properties: {
          lines: { type: 'number', description: 'Maximum number of lines to return from the end (default 50)' }
        }
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'send_command_input',
      description: 'Send text input to the currently active terminal (stdin inject).',
      parameters: {
        type: 'object',
        properties: {
          text:    { type: 'string', description: 'Text to send to the terminal' },
          newline: { type: 'boolean', description: 'Append newline/Enter (default true)' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'git_commit',
      description: 'Stage files and create a git commit in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Commit message' },
          files:   { type: 'array', items: { type: 'string' }, description: 'Specific files to stage. Leave empty to stage all changes.' }
        },
        required: ['message']
      }
    }
  },
  // ── Notebook tools ─────────────────────────────────────────────
  {
    type: 'function' as const,
    function: {
      name: 'read_notebook',
      description: 'Read a Jupyter Notebook (.ipynb) file, showing all cells with their source code and outputs.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the .ipynb file relative to workspace root' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'edit_notebook',
      description: 'Edit a Jupyter Notebook at cell level. Can add, modify, or delete cells without risking JSON corruption.',
      parameters: {
        type: 'object',
        properties: {
          path:      { type: 'string', description: 'Path to the .ipynb file relative to workspace root' },
          operation: { type: 'string', description: 'Operation: "set_source" | "insert_cell" | "delete_cell" | "set_cell_type"' },
          cell_index:{ type: 'number', description: 'Zero-based cell index (for set_source, delete_cell, set_cell_type)' },
          source:    { type: 'string', description: 'New source content for the cell' },
          cell_type: { type: 'string', description: 'Cell type: "code" | "markdown" | "raw"' },
          after_index:{ type: 'number', description: 'Insert new cell after this index (-1 = prepend)' }
        },
        required: ['path', 'operation']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'execute_notebook',
      description: 'Execute specified cells in a Jupyter Notebook by running jupyter nbconvert. Requires Jupyter to be installed.',
      parameters: {
        type: 'object',
        properties: {
          path:       { type: 'string', description: 'Path to the .ipynb file relative to workspace root' },
          cell_ids:   { type: 'array', items: { type: 'number' }, description: 'Zero-based cell indices to execute. Execute all cells if omitted.' },
          timeout_sec:{ type: 'number', description: 'Execution timeout in seconds (default 60)' }
        },
        required: ['path']
      }
    }
  },
  // ── Agent management tools ─────────────────────────────────────
  {
    type: 'function' as const,
    function: {
      name: 'send_message',
      description: 'Send a message to another agent or subagent by conversation ID. NOT for communicating with the user.',
      parameters: {
        type: 'object',
        properties: {
          conversation_id: { type: 'string', description: 'Conversation ID of the target agent' },
          message:         { type: 'string', description: 'Message content to send' }
        },
        required: ['conversation_id', 'message']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'define_subagent',
      description: 'Define and spawn a specialized subagent with custom tools, system prompt, and model.',
      parameters: {
        type: 'object',
        properties: {
          role:          { type: 'string', description: 'Agent role: "armed_worker" | "explorer" | "orchestrator" | "inherit"' },
          system_prompt: { type: 'string', description: 'Custom system prompt for the subagent' },
          model:         { type: 'string', description: 'Model alias: "inherit" | "flash" | "flash_lite" | "pro"' },
          task:          { type: 'string', description: 'Initial task description to send to the subagent' }
        },
        required: ['role', 'task']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'manage_task',
      description: 'Manage background tasks — list running tasks or get the output of a specific background task.',
      parameters: {
        type: 'object',
        properties: {
          action:  { type: 'string', description: 'Action: "list" | "get" | "cancel"' },
          task_id: { type: 'string', description: 'Task ID (for get/cancel operations)' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'manage_inbox',
      description: 'Manage the message inbox — list all messages or read the full content of a specific message. Do not use to poll.',
      parameters: {
        type: 'object',
        properties: {
          action:     { type: 'string', description: 'Action: "list" | "read" | "clear"' },
          message_id: { type: 'string', description: 'Message ID (for read operation)' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'ask_question',
      description: 'Ask a clarifying question to the user. Use when you need information before proceeding.',
      parameters: {
        type: 'object',
        properties: {
          question:     { type: 'string', description: 'The question to ask the user' },
          placeholder:  { type: 'string', description: 'Placeholder text for the input field' }
        },
        required: ['question']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_timer',
      description: 'Set a timer that fires after a duration. The system will notify you when the timer expires.',
      parameters: {
        type: 'object',
        properties: {
          duration_seconds: { type: 'number', description: 'Duration in seconds until the timer fires' },
          label:            { type: 'string', description: 'Optional label to identify this timer' }
        },
        required: ['duration_seconds']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'wait_for_mention',
      description: 'Wait for an update from a specific subagent or task, with configurable timeout.',
      parameters: {
        type: 'object',
        properties: {
          conversation_id: { type: 'string', description: 'Conversation ID of the subagent to wait for' },
          timeout_seconds: { type: 'number', description: 'Timeout in seconds (default 30)' }
        },
        required: ['conversation_id']
      }
    }
  },
  // ── Permission tools ───────────────────────────────────────────
  {
    type: 'function' as const,
    function: {
      name: 'ask_permission',
      description: 'Ask for permission to access a resource or perform an action that requires explicit user approval.',
      parameters: {
        type: 'object',
        properties: {
          resource:    { type: 'string', description: 'The resource or action needing permission' },
          reason:      { type: 'string', description: 'Why this permission is needed' },
          permission_type: { type: 'string', description: 'Type: "file_read" | "file_write" | "terminal" | "network"' }
        },
        required: ['resource', 'reason']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_permission_grants',
      description: 'List all currently active permission grants to understand what resources can be accessed without prompting.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'ask_multiple_choice',
      description: 'Ask the user one or more multiple-choice questions and return their selections.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask' },
          choices:  { type: 'array', items: { type: 'string' }, description: 'Array of choice options' },
          multi:    { type: 'boolean', description: 'Allow multiple selections (default false)' }
        },
        required: ['question', 'choices']
      }
    }
  },
  // ── Browser tools (CDP-based) ──────────────────────────────────
  {
    type: 'function' as const,
    function: {
      name: 'open_browser_url',
      description: 'Open a URL in the system browser or VS Code simple browser.',
      parameters: {
        type: 'object',
        properties: {
          url:      { type: 'string', description: 'URL to open' },
          external: { type: 'boolean', description: 'Open in external system browser (default false = VS Code browser)' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_browser_page',
      description: 'Fetch and read the content of a web page. Returns page text. For pages requiring JS execution, use with caution.',
      parameters: {
        type: 'object',
        properties: {
          url:       { type: 'string', description: 'URL to read' },
          max_chars: { type: 'number', description: 'Maximum characters to return (default 8000)' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'capture_browser_screenshot',
      description: 'Capture a screenshot of the current browser page (requires browser sidecar to be running).',
      parameters: {
        type: 'object',
        properties: {
          page_id:   { type: 'string', description: 'Browser page/tab identifier (optional)' },
          save_path: { type: 'string', description: 'Path to save the screenshot (optional, relative to workspace)' }
        }
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'capture_browser_console_logs',
      description: 'Capture browser console logs (log/warn/error/info) from the current page via CDP.',
      parameters: {
        type: 'object',
        properties: {
          page_id:   { type: 'string', description: 'Browser page/tab identifier (optional)' },
          level:     { type: 'string', description: 'Filter by level: "all" | "error" | "warn" | "log" (default "all")' }
        }
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_get_dom',
      description: 'Get the DOM snapshot of the current browser page for analysis.',
      parameters: {
        type: 'object',
        properties: {
          page_id:  { type: 'string', description: 'Browser page/tab identifier (optional)' },
          selector: { type: 'string', description: 'CSS selector to scope the DOM snapshot (optional)' }
        }
      }
    }
  },
  // ── Additional browser CDP tools (§14, §25) ─────────────────────
  {
    type: 'function' as const,
    function: {
      name: 'list_browser_pages',
      description: 'List all open browser tabs/pages. Requires Chrome with --remote-debugging-port=9222.',
      parameters: { type: 'object', properties: { port: { type: 'number', description: 'CDP port (default 9222)' } } }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_input',
      description: 'Type text into the focused element in the browser page.',
      parameters: {
        type: 'object',
        properties: {
          text:    { type: 'string', description: 'Text to type' },
          page_id: { type: 'string', description: 'CDP page id (optional, uses first page if omitted)' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_click_element',
      description: 'Click a DOM element matching a CSS selector in the browser.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector for the element to click' },
          page_id:  { type: 'string' }
        },
        required: ['selector']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'click_browser_pixel',
      description: 'Click at exact pixel coordinates in the browser viewport.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X coordinate in CSS pixels' },
          y: { type: 'number', description: 'Y coordinate in CSS pixels' },
          button:  { type: 'string', description: '"left" | "right" | "middle" (default left)' },
          page_id: { type: 'string' }
        },
        required: ['x', 'y']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_drag_pixel_to_pixel',
      description: 'Drag from one pixel coordinate to another (mousedown→mousemove→mouseup). NOTE: Do not call in parallel with other browser tools.',
      parameters: {
        type: 'object',
        properties: {
          from_x: { type: 'number' }, from_y: { type: 'number' },
          to_x:   { type: 'number' }, to_y:   { type: 'number' },
          page_id: { type: 'string' }
        },
        required: ['from_x', 'from_y', 'to_x', 'to_y']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_scroll',
      description: 'Scroll the browser page by pixel delta.',
      parameters: {
        type: 'object',
        properties: {
          delta_x: { type: 'number', description: 'Horizontal scroll delta (pixels)' },
          delta_y: { type: 'number', description: 'Vertical scroll delta (pixels)' },
          x: { type: 'number', description: 'Scroll origin X (default 0)' },
          y: { type: 'number', description: 'Scroll origin Y (default 0)' },
          page_id: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_scroll_up',
      description: 'Scroll the browser page upward.',
      parameters: {
        type: 'object',
        properties: {
          amount:  { type: 'number', description: 'Pixels to scroll up (default 300)' },
          page_id: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_scroll_down',
      description: 'Scroll the browser page downward.',
      parameters: {
        type: 'object',
        properties: {
          amount:  { type: 'number', description: 'Pixels to scroll down (default 300)' },
          page_id: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_press_key',
      description: 'Press a keyboard key in the browser (e.g. Enter, Escape, Tab, ArrowDown, ArrowUp).',
      parameters: {
        type: 'object',
        properties: {
          key:     { type: 'string', description: 'Key name per Chrome DevTools Input.dispatchKeyEvent spec, e.g. "Enter", "Tab", "Escape"' },
          page_id: { type: 'string' }
        },
        required: ['key']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_select_option',
      description: 'Select an option from a <select> dropdown by CSS selector and value.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector for the <select> element' },
          value:    { type: 'string', description: 'Option value to select' },
          page_id:  { type: 'string' }
        },
        required: ['selector', 'value']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_refresh_page',
      description: 'Reload/refresh the current browser page.',
      parameters: {
        type: 'object',
        properties: {
          ignore_cache: { type: 'boolean', description: 'Hard reload, bypassing cache (default false)' },
          page_id:      { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_resize_window',
      description: 'Resize the browser viewport to specified dimensions. NOTE: Do not call in parallel due to window state race condition.',
      parameters: {
        type: 'object',
        properties: {
          width:   { type: 'number', description: 'Viewport width in pixels' },
          height:  { type: 'number', description: 'Viewport height in pixels' },
          page_id: { type: 'string' }
        },
        required: ['width', 'height']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_move_mouse',
      description: 'Move the mouse cursor to coordinates in the browser.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number' }, y: { type: 'number' },
          page_id: { type: 'string' }
        },
        required: ['x', 'y']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_mouse_down',
      description: 'Press (hold down) the mouse button at coordinates.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number' }, y: { type: 'number' },
          button:  { type: 'string', description: '"left" | "right" | "middle" (default left)' },
          page_id: { type: 'string' }
        },
        required: ['x', 'y']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_mouse_up',
      description: 'Release the mouse button at coordinates.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number' }, y: { type: 'number' },
          button:  { type: 'string', description: '"left" | "right" | "middle" (default left)' },
          page_id: { type: 'string' }
        },
        required: ['x', 'y']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_mouse_wheel',
      description: 'Simulate mouse wheel scroll at specific coordinates.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number' }, y: { type: 'number' },
          delta_x: { type: 'number', description: 'Horizontal delta' },
          delta_y: { type: 'number', description: 'Vertical delta' },
          page_id: { type: 'string' }
        },
        required: ['x', 'y']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_get_network_request',
      description: 'Get details of a specific network request recorded during the current page session.',
      parameters: {
        type: 'object',
        properties: {
          url_pattern: { type: 'string', description: 'URL pattern to match (substring or regex)' },
          index:       { type: 'number', description: 'Request index in the network log' },
          page_id:     { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_list_network_requests',
      description: 'List all network requests recorded during the current browser session.',
      parameters: {
        type: 'object',
        properties: {
          filter_url: { type: 'string', description: 'Filter by URL substring' },
          page_id:    { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'execute_browser_javascript',
      description: 'Execute JavaScript code in the browser page context and return the result.',
      parameters: {
        type: 'object',
        properties: {
          code:       { type: 'string', description: 'JavaScript expression or statement to execute' },
          await_promise: { type: 'boolean', description: 'Await the result if it returns a Promise (default false)' },
          page_id:    { type: 'string' }
        },
        required: ['code']
      }
    }
  },
  // ── Web & code search (§25) ─────────────────────────────────────
  {
    type: 'function' as const,
    function: {
      name: 'web_search',
      description: 'Search the web using DuckDuckGo and return titles, URLs, and snippets of results.',
      parameters: {
        type: 'object',
        properties: {
          query:       { type: 'string', description: 'Search query' },
          max_results: { type: 'number', description: 'Maximum results to return (default 5, max 10)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_url_content',
      description: 'Fetch content from a URL via HTTP. Converts HTML to plain text/markdown. No JS execution, no auth. For pages requiring login or JS, use read_browser_page instead.',
      parameters: {
        type: 'object',
        properties: {
          url:       { type: 'string', description: 'URL to fetch' },
          max_chars: { type: 'number', description: 'Maximum characters to return (default 8000)' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'code_search',
      description: 'Search for symbols, functions, classes, or patterns semantically across the workspace using VS Code\'s workspace symbol provider.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Symbol name or search query' },
          kind:  { type: 'string', description: 'Filter by kind: "function" | "class" | "interface" | "variable" | "all" (default all)' }
        },
        required: ['query']
      }
    }
  },
  // ── Code review tools (§25) ────────────────────────────────────
  {
    type: 'function' as const,
    function: {
      name: 'start_code_review',
      description: 'Start a code review of specified files or the most recent git diff. Returns analysis of issues, improvements, and suggestions.',
      parameters: {
        type: 'object',
        properties: {
          files:     { type: 'array', items: { type: 'string' }, description: 'Files to review. Leave empty to review last git diff.' },
          diff_only: { type: 'boolean', description: 'Only review changed lines in git diff (default false)' },
          focus:     { type: 'string', description: 'Focus area: "security" | "performance" | "style" | "all" (default all)' }
        }
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'post_pr_review',
      description: 'Post a review comment on a file at a specific line (appends to a .review file in workspace).',
      parameters: {
        type: 'object',
        properties: {
          comment: { type: 'string', description: 'Review comment text' },
          file:    { type: 'string', description: 'File path being reviewed' },
          line:    { type: 'number', description: 'Line number the comment applies to' },
          severity:{ type: 'string', description: '"error" | "warning" | "suggestion" | "praise" (default suggestion)' }
        },
        required: ['comment']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'propose_code',
      description: 'Propose a code change as a diff/patch without applying it. Saves the proposal to a .proposals file for review.',
      parameters: {
        type: 'object',
        properties: {
          file:    { type: 'string', description: 'File to propose changes for' },
          old_str: { type: 'string', description: 'Exact existing code to replace' },
          new_str: { type: 'string', description: 'Proposed replacement code' },
          reason:  { type: 'string', description: 'Explanation of why this change is proposed' }
        },
        required: ['file', 'old_str', 'new_str']
      }
    }
  },
  // ── Knowledge / resource tools (§25) ─────────────────────────────
  {
    type: 'function' as const,
    function: {
      name: 'knowledge_artifacts',
      description: 'Manage knowledge artifacts in the workspace knowledge base: create, read, list, or search items.',
      parameters: {
        type: 'object',
        properties: {
          action:  { type: 'string', description: '"create" | "read" | "list" | "search"' },
          title:   { type: 'string', description: 'Title (for create/read)' },
          content: { type: 'string', description: 'Content to store (for create)' },
          query:   { type: 'string', description: 'Search query (for search)' },
          id:      { type: 'string', description: 'Item ID (for read)' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_resource',
      description: 'Read a named resource by URI. Supports workspace files (file://), URLs (http://), and knowledge base items (kb://).',
      parameters: {
        type: 'object',
        properties: {
          uri: { type: 'string', description: 'Resource URI: file://path, http://url, or kb://item-id' }
        },
        required: ['uri']
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_resources',
      description: 'List available resources in the workspace: files matching patterns, knowledge base items, and MCP resources.',
      parameters: {
        type: 'object',
        properties: {
          type_filter: { type: 'string', description: '"file" | "kb" | "mcp" | "all" (default all)' },
          pattern:     { type: 'string', description: 'File glob pattern for file resources (e.g. **/*.md)' }
        }
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'restart_dev_server',
      description: 'Restart a running development server (e.g. npm run dev, vite, webpack-dev-server).',
      parameters: {
        type: 'object',
        properties: {
          command:    { type: 'string', description: 'Command to restart the dev server (default: auto-detect from package.json)' },
          port:       { type: 'number', description: 'Port the dev server runs on (default 3000)' },
          timeout_ms: { type: 'number', description: 'Max ms to wait for server ready (default 15000)' }
        }
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'check_deploy_status',
      description: 'Check the status of a Firebase Hosting or Cloud Run deployment.',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Firebase/GCP project ID' },
          service:    { type: 'string', description: '"hosting" | "cloud_run" | "functions" (default hosting)' }
        }
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_up_firebase',
      description: 'Initialize Firebase in the current project (firebase init), configuring Hosting, Functions, or Firestore.',
      parameters: {
        type: 'object',
        required: ['project_id'],
        properties: {
          project_id: { type: 'string', description: 'Firebase project ID' },
          features:   { type: 'array',  items: { type: 'string' }, description: 'Features to init: hosting, functions, firestore, storage, emulators' }
        }
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'deploy_firebase',
      description: 'Deploy the current project to Firebase Hosting (or Functions/Firestore rules).',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Firebase project ID' },
          only:       { type: 'string', description: 'Comma-separated targets: hosting,functions,firestore (default: all)' }
        }
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_up_cloud_sql',
      description: 'Create or configure a Cloud SQL instance for the project.',
      parameters: {
        type: 'object',
        required: ['project_id', 'instance_name'],
        properties: {
          project_id:    { type: 'string', description: 'GCP project ID' },
          instance_name: { type: 'string', description: 'Cloud SQL instance name' },
          database_type: { type: 'string', description: '"postgres" | "mysql" | "sqlserver" (default postgres)' },
          region:        { type: 'string', description: 'GCP region (default us-central1)' }
        }
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'cloud_sql_execute_sql',
      description: 'Execute a SQL statement against a Cloud SQL instance via the Cloud SQL proxy or direct connection.',
      parameters: {
        type: 'object',
        required: ['instance_connection_name', 'sql'],
        properties: {
          instance_connection_name: { type: 'string', description: 'Cloud SQL connection name (project:region:instance)' },
          database:                 { type: 'string', description: 'Database name' },
          sql:                      { type: 'string', description: 'SQL statement to execute' },
          user:                     { type: 'string', description: 'Database user (default postgres)' }
        }
      }
    }
  },
  {
    type: 'function' as const,
    function: {
      name: 'generate_image',
      description: 'Generate an image from a text prompt using an image generation API (Imagen / Gemini image generation).',
      parameters: {
        type: 'object',
        required: ['prompt'],
        properties: {
          prompt:      { type: 'string', description: 'Text description of the image to generate' },
          output_path: { type: 'string', description: 'File path to save the generated image (PNG)' },
          width:       { type: 'number', description: 'Image width in pixels (default 1024)' },
          height:      { type: 'number', description: 'Image height in pixels (default 1024)' },
          model:       { type: 'string', description: 'Image model to use (default: imagen-3.0-generate-001)' }
        }
      }
    }
  }
];

export interface ToolCall {
  name:      string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolName: string;
  ok:       boolean;
  output:   string;
}

export class ToolRunner {
  stealthFetch:  ((url: string, maxChars: number) => Promise<string>) | undefined;   // set by the chat provider: Botasaurus
  researchOpts:  (() => Promise<ResearchOpts>) | undefined;   // GitHub token / Google key for the research tools
  terminalBufFn: (() => string) | undefined;
  onBackground:  ((msg: string) => void) | undefined;
  // ── Agent management state ─────────────────────────────────────
  private inbox:        Array<{ id: string; from: string; content: string; ts: string }> = [];
  private bgTasks:      Map<string, { cmd: string; status: string; output: string }> = new Map();
  private permGrants:   Set<string> = new Set(['file_read:workspace', 'terminal:workspace']);
  private subagents:    Map<string, { role: string; model: string; conversationId: string }> = new Map();

  async run(call: ToolCall): Promise<ToolResult> {
    // A call without its required arguments must fail loudly; otherwise String(undefined) turns into
    // a real file or path named "undefined" in the workspace.
    const def = [...TOOL_DEFS, ...RESEARCH_TOOL_DEFS].find(d => d.function.name === call.name);
    const required = (def?.function.parameters as { required?: string[] } | undefined)?.required ?? [];
    const missing = required.filter(k => {
      const v = (call.arguments ?? {})[k];
      return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    });
    if (missing.length) {
      const props = ((def?.function.parameters as { properties?: Record<string, { type?: string; description?: string }> } | undefined)?.properties) ?? {};
      const spec  = Object.entries(props).map(([k, v]) => `  - ${k}${required.includes(k) ? ' (required)' : ''}: ${v.description ?? v.type ?? ''}`).join('\n');
      const example = JSON.stringify(Object.fromEntries(required.map(k => [k, `<${k}>`])));
      return { toolName: call.name, ok: false, output:
        `Error: ${call.name} was called without: ${missing.join(', ')}.\nParameters:\n${spec}\nExample: ${call.name} ${example}\nCall it again with every required argument filled in.` };
    }
    try {
      const output = await this.dispatch(call);
      return { toolName: call.name, ok: true, output };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { toolName: call.name, ok: false, output: `Error: ${msg}` };
    }
  }

  /** Local-file tools only see the workspace; point the model to the GitHub tools when it passes a repository path. */
  private notFoundHint(p: string): string {
    const looksRemote = /^[\w.-]+\/[\w.-]+\/.+/.test(p) && !p.startsWith('.rag/') && !p.startsWith('src/') && !p.startsWith('./');
    return `File not found in the workspace: ${p}.` + (looksRemote
      ? ' This tool reads LOCAL files only. For a GitHub repository, download it with github_download_repository (then read it under .rag/references/) or use github_file_content with repo="owner/name".'
      : '');
  }

  private root(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  private abs(rel: string): string {
    const r = String(rel);
    if (path.isAbsolute(r)) return r;
    return path.join(this.root(), r);
  }

  private async dispatch(call: ToolCall): Promise<string> {
    const a = call.arguments;

    switch (call.name) {

      // ── view_file ──────────────────────────────────────────────
      case 'view_file': {
        if (!fs.existsSync(this.abs(String(a.path)))) throw new Error(this.notFoundHint(String(a.path)));
        const text  = fs.readFileSync(this.abs(String(a.path)), 'utf8');
        const lines = text.split('\n');
        const start = Math.max(0, (Number(a.start_line ?? 1)) - 1);
        const end   = Math.min(lines.length, Number(a.end_line ?? lines.length));
        return lines.slice(start, end)
          .map((l, i) => `${String(start + i + 1).padStart(4)}: ${l}`)
          .join('\n');
      }

      // ── read_multiple_files ────────────────────────────────────
      case 'read_multiple_files': {
        const paths  = a.paths as string[];
        const parts: string[] = [];
        for (const p of paths.slice(0, 10)) {
          try {
            const text = fs.readFileSync(this.abs(p), 'utf8');
            parts.push(`=== ${p} ===\n${text}`);
          } catch { parts.push(`=== ${p} === ERROR: ${this.notFoundHint(p)}`); }
        }
        return parts.join('\n\n');
      }

      // ── create_file ────────────────────────────────────────────
      case 'create_file': {
        const fp = this.abs(String(a.path));
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, String(a.content ?? ''), 'utf8');
        return `Created: ${a.path}`;
      }

      // ── edit_file ──────────────────────────────────────────────
      // Supports SEARCH_REPLACE (default) and SINGLE_MULTI (allow_multiple=true)
      case 'edit_file': {
        const fp       = this.abs(String(a.path));
        const original = fs.readFileSync(fp, 'utf8');
        const oldStr   = String(a.old_str);
        if (!original.includes(oldStr)) {
          throw new Error(`old_str not found in ${a.path}`);
        }
        const allowMultiple = Boolean(a.allow_multiple ?? false);
        const newStr = String(a.new_str ?? '');
        if (oldStr === newStr) throw new Error('old_str and new_str are identical: nothing would change');
        // SINGLE_MULTI variant: replace all occurrences when allow_multiple=true
        const updated = allowMultiple
          ? original.split(oldStr).join(newStr)
          : original.replace(oldStr, newStr);
        const count = allowMultiple ? (original.split(oldStr).length - 1) : 1;
        fs.writeFileSync(fp, updated, 'utf8');
        const line = original.slice(0, original.indexOf(oldStr)).split('\n').length;
        const peek = (t: string) => t.split('\n')[0].trim().slice(0, 100);
        // Say where it landed and what changed: a repeated call then fails with "old_str not found", and the model must know why
        return `Edited: ${a.path} at line ${line}${allowMultiple && count > 1 ? ` (${count} occurrences replaced)` : ''}\n- ${peek(oldStr)}\n+ ${peek(newStr)}`;
      }

      // ── insert_at_line ─────────────────────────────────────────
      case 'insert_at_line': {
        const fp    = this.abs(String(a.path));
        const lines = fs.readFileSync(fp, 'utf8').split('\n');
        const ln    = Math.max(0, Math.min(Number(a.line) - 1, lines.length));
        lines.splice(ln, 0, String(a.content ?? ''));
        fs.writeFileSync(fp, lines.join('\n'), 'utf8');
        return `Inserted at line ${a.line}: ${a.path}`;
      }

      // ── apply_diff ─────────────────────────────────────────────
      case 'apply_diff': {
        const fp   = this.abs(String(a.path));
        const orig = fs.readFileSync(fp, 'utf8').split('\n');
        const diff = String(a.diff);
        const result = applyUnifiedDiff(orig, diff);
        fs.writeFileSync(fp, result.join('\n'), 'utf8');
        return `Applied diff to ${a.path}`;
      }

      // ── move_file ──────────────────────────────────────────────
      case 'move_file': {
        const from = this.abs(String(a.from));
        const to   = this.abs(String(a.to));
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(from, to);
        return `Moved ${a.from} → ${a.to}`;
      }

      // ── delete_file ────────────────────────────────────────────
      case 'delete_file': {
        fs.unlinkSync(this.abs(String(a.path)));
        return `Deleted: ${a.path}`;
      }

      // ── list_directory ─────────────────────────────────────────
      case 'list_directory': {
        const dp      = this.abs(String(a.path ?? ''));
        const entries = fs.readdirSync(dp, { withFileTypes: true });
        return entries
          .sort((x, y) => {
            if (x.isDirectory() !== y.isDirectory()) return x.isDirectory() ? -1 : 1;
            return x.name.localeCompare(y.name);
          })
          .map(e => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`)
          .join('\n') || '(empty directory)';
      }

      // ── get_file_outline / view_file_outline ──────────────────
      case 'get_file_outline':
      case 'view_file_outline': {
        const text  = fs.readFileSync(this.abs(String(a.path)), 'utf8');
        return extractOutline(text, String(a.path));
      }

      // ── grep_search ────────────────────────────────────────────
      case 'grep_search': {
        const pattern = String(a.pattern);
        const glob    = String(a.glob ?? '**/*');
        const uris    = await vscode.workspace.findFiles(glob, '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}', 200);
        const regex   = new RegExp(pattern, 'gm');
        const results: string[] = [];

        for (const uri of uris) {
          if (results.length >= 100) break;
          try {
            const lines = fs.readFileSync(uri.fsPath, 'utf8').split('\n');
            lines.forEach((line, idx) => {
              if (regex.test(line)) {
                results.push(`${vscode.workspace.asRelativePath(uri)}:${idx + 1}: ${line.trim()}`);
              }
              regex.lastIndex = 0;
            });
          } catch { /* binary */ }
        }
        return results.length ? results.join('\n') : `No matches for: ${pattern}`;
      }

      // ── search_symbol ──────────────────────────────────────────
      case 'search_symbol': {
        const name = String(a.name);
        const kind = String(a.kind ?? '');
        const patterns = buildSymbolPatterns(name, kind);
        const uris = await vscode.workspace.findFiles(
          '**/*.{ts,tsx,js,jsx,py,go,rs,java,c,cpp,h}',
          '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}',
          300
        );
        const results: string[] = [];
        for (const uri of uris) {
          if (results.length >= 20) break;
          try {
            const lines = fs.readFileSync(uri.fsPath, 'utf8').split('\n');
            lines.forEach((line, idx) => {
              if (patterns.some(p => p.test(line))) {
                const rel = vscode.workspace.asRelativePath(uri);
                results.push(`${rel}:${idx + 1}: ${line.trim()}`);
              }
            });
          } catch { /* skip */ }
        }
        return results.length ? results.join('\n') : `Symbol not found: ${name}`;
      }

      // ── run_command ────────────────────────────────────────────
      case 'run_command': {
        const cmd        = String(a.command);
        const timeout    = Math.min(600_000, Math.max(1000, Number(a.timeout ?? 120_000)));
        const background = Boolean(a.background ?? false);
        await getPolicyGuardian().vet(cmd);

        if (background) {
          const proc = RUN_SHELL
            ? cp.spawn(RUN_SHELL.file, RUN_SHELL.args(cmd), { cwd: this.root(), detached: true, windowsHide: true })
            : cp.spawn(cmd, [], { cwd: this.root(), shell: true, detached: true, windowsHide: true });
          const pid  = proc.pid ?? 0;
          let bgOut  = '';
          proc.stdout?.on('data', (d: Buffer) => { bgOut = (bgOut + d.toString()).slice(-2000); });
          proc.stderr?.on('data', (d: Buffer) => { bgOut = (bgOut + d.toString()).slice(-2000); });
          proc.on('close', (code) => {
            this.onBackground?.(`Background command exited (code ${code ?? '?'}): \`${cmd}\`\n\`\`\`\n${bgOut || '(no output)'}\n\`\`\``);
          });
          proc.unref();
          return `Started background process (PID ${pid}): ${cmd}`;
        }

        return new Promise((resolve, reject) => {
          const done = (err: (Error & { code?: number | string | null; killed?: boolean; signal?: string | null }) | null, stdout: string, stderr: string) => {
            let out = [stdout, stderr].filter(Boolean).join('\n').trim();
            if (out.length > 12000) out = '[…output cut, last 12000 characters…]\n' + out.slice(-12000);
            if (!err) { resolve(out || '(no output)'); return; }
            // A failed command must say WHY, with its real output: the agent cannot fix what it cannot see.
            const why = err.killed
              ? `[timed out after ${Math.round(timeout / 1000)}s and was killed. A build or install that takes longer needs a bigger "timeout" ` +
                `(milliseconds, up to 600000) or background:true, then read its output with read_terminal.]`
              : `[exit code ${typeof err.code === 'number' ? err.code : (err.signal ?? err.code ?? '?')}]`;
            reject(new Error(`${out || '(no output)'}\n${why}`));
          };
          const opts = { cwd: this.root(), timeout, encoding: 'utf8' as const, windowsHide: true, maxBuffer: 20 * 1024 * 1024 };
          if (RUN_SHELL) cp.execFile(RUN_SHELL.file, RUN_SHELL.args(cmd), opts, done);
          else cp.exec(cmd, opts, done);
        });
      }

      // ── web_fetch ──────────────────────────────────────────────
      case 'web_fetch': {
        const url      = String(a.url);
        const maxChars = Number(a.max_chars ?? 4000);
        try { return await fetchUrl(url, maxChars); }
        catch (e) {
          if (!(e as { challenge?: boolean }).challenge || !this.stealthFetch) throw e;
          return this.stealthFetch(url, maxChars);               // Botasaurus: a real Chrome gets through Cloudflare-style challenges
        }
      }

      // ── get_diagnostics ────────────────────────────────────────
      case 'get_diagnostics': {
        const scope = String(a.scope ?? 'active_file');
        const editor = vscode.window.activeTextEditor;
        if (!editor) return 'No active file open.';

        const uri   = editor.document.uri;
        const diags = vscode.languages.getDiagnostics(
          scope === 'workspace' ? undefined as unknown as vscode.Uri : uri
        ) as vscode.Diagnostic[] | [vscode.Uri, vscode.Diagnostic[]][];

        if (!Array.isArray(diags) || !diags.length) return 'No diagnostics.';

        if (scope === 'workspace') {
          const pairs = diags as [vscode.Uri, vscode.Diagnostic[]][];
          const lines = pairs.flatMap(([u, ds]) => ds.slice(0, 5).map(d => {
            const rel  = vscode.workspace.asRelativePath(u);
            const sev  = d.severity === 0 ? 'ERROR' : 'WARN';
            return `${sev} ${rel}:${d.range.start.line + 1} — ${d.message}`;
          }));
          return lines.slice(0, 40).join('\n') || 'No diagnostics.';
        }

        const simple = diags as vscode.Diagnostic[];
        return simple.slice(0, 20).map(d => {
          const sev = d.severity === 0 ? 'ERROR' : 'WARN';
          return `${sev} line ${d.range.start.line + 1}: ${d.message}`;
        }).join('\n') || 'No diagnostics.';
      }

      // ── delete_directory ──────────────────────────────────────
      case 'delete_directory': {
        const dp = this.abs(String(a.path));
        fs.rmSync(dp, { recursive: true, force: true });
        return `Deleted directory: ${a.path}`;
      }

      // ── view_code_item ─────────────────────────────────────────
      case 'view_code_item': {
        const text   = fs.readFileSync(this.abs(String(a.path)), 'utf8');
        const lines  = text.split('\n');
        const name   = String(a.name);
        const nameRe = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        let startIdx = -1;
        for (let i = 0; i < lines.length; i++) {
          if (nameRe.test(lines[i])) { startIdx = i; break; }
        }
        if (startIdx === -1) return `Symbol "${name}" not found in ${a.path}`;
        // Walk forward to find block end (balanced braces)
        let depth = 0, endIdx = startIdx;
        for (let i = startIdx; i < lines.length; i++) {
          for (const ch of lines[i]) {
            if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth === 0 && i > startIdx) { endIdx = i; break; } }
          }
          if (depth === 0 && i > startIdx) break;
          endIdx = i;
        }
        const snippet = lines.slice(startIdx, endIdx + 1);
        return snippet.map((l, i) => `${String(startIdx + i + 1).padStart(4)}: ${l}`).join('\n');
      }

      // ── view_content_chunk ─────────────────────────────────────
      case 'view_content_chunk': {
        const fp     = this.abs(String(a.path));
        const buf    = fs.readFileSync(fp);
        const offset = Math.max(0, Number(a.offset ?? 0));
        const length = Number(a.length ?? 2000);
        const chunk  = buf.subarray(offset, offset + length);
        const total  = buf.length;
        return `File: ${a.path} [bytes ${offset}–${offset + chunk.length} of ${total}]\n${chunk.toString('utf8')}`;
      }

      // ── find_all_references ────────────────────────────────────
      case 'find_all_references': {
        const refName = String(a.name);
        const globPat = String(a.glob ?? '**/*.{ts,tsx,js,jsx,py,go,rs,java,c,cpp,h}');
        const uris    = await vscode.workspace.findFiles(globPat, '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}', 300);
        const refRe   = new RegExp(`\\b${refName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        const refs: string[] = [];
        for (const uri of uris) {
          if (refs.length >= 150) break;
          try {
            const lines = fs.readFileSync(uri.fsPath, 'utf8').split('\n');
            lines.forEach((line, idx) => {
              if (refRe.test(line)) {
                refs.push(`${vscode.workspace.asRelativePath(uri)}:${idx + 1}: ${line.trim()}`);
              }
            });
          } catch { /* skip binary */ }
        }
        return refs.length ? refs.join('\n') : `No references found for: ${refName}`;
      }

      // ── write_blob ─────────────────────────────────────────────
      case 'write_blob': {
        const fp  = this.abs(String(a.path));
        const buf = Buffer.from(String(a.data), 'base64');
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, buf);
        return `Written ${buf.length} bytes to ${a.path}`;
      }

      // ── read_terminal ──────────────────────────────────────────
      case 'read_terminal': {
        const buf      = this.terminalBufFn?.() ?? '';
        const maxLines = Number(a.lines ?? 50);
        const lines    = buf.split('\n').filter(l => l.trim());
        return lines.slice(-maxLines).join('\n') || '(terminal buffer is empty)';
      }

      // ── send_command_input ─────────────────────────────────────
      case 'send_command_input': {
        const term     = vscode.window.activeTerminal;
        if (!term) return 'No active terminal. Open a terminal first.';
        const addNl    = a.newline !== false;
        term.sendText(String(a.text), addNl);
        return `Sent to terminal: ${String(a.text).slice(0, 80)}`;
      }

      // ── git_commit ─────────────────────────────────────────────
      case 'git_commit': {
        const msg   = String(a.message).replace(/"/g, '\\"');
        const files = (a.files as string[] | undefined) ?? [];
        const stage = files.length
          ? `git add ${files.map(f => `"${f}"`).join(' ')}`
          : 'git add -A';
        const cmd   = `${stage} && git commit -m "${msg}"`;
        await getPolicyGuardian().vet('git commit');
        return new Promise((resolve, reject) => {
          cp.exec(cmd, { cwd: this.root(), timeout: 15000, encoding: 'utf8' }, (err, stdout, stderr) => {
            const out = [stdout, stderr].filter(Boolean).join('\n').trim();
            if (err && !out) reject(new Error(err.message));
            else resolve(out || 'Committed successfully');
          });
        });
      }

      // ── read_notebook ──────────────────────────────────────────
      case 'read_notebook': {
        const fp       = this.abs(String(a.path));
        const nb       = JSON.parse(fs.readFileSync(fp, 'utf8')) as NotebookFile;
        const cells    = nb.cells ?? [];
        const lines: string[] = [`Notebook: ${a.path} (${cells.length} cells, kernel: ${nb.metadata?.kernelspec?.display_name ?? 'unknown'})\n`];
        cells.forEach((cell, idx) => {
          const src = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source ?? '');
          lines.push(`--- Cell ${idx} [${cell.cell_type}] ---`);
          lines.push(src.slice(0, 2000));
          if (cell.outputs?.length) {
            const outText = cell.outputs.map(o => {
              if (o.output_type === 'stream') return (Array.isArray(o.text) ? o.text.join('') : String(o.text ?? '')).slice(0, 500);
              if (o.output_type === 'execute_result' || o.output_type === 'display_data') {
                const d = o.data as Record<string, unknown> | undefined;
                return String((d?.['text/plain'] as string[] | string | undefined) ?? '').slice(0, 500);
              }
              return `[${o.output_type}]`;
            }).join('\n');
            lines.push(`Output:\n${outText}`);
          }
          lines.push('');
        });
        return lines.join('\n');
      }

      // ── edit_notebook ──────────────────────────────────────────
      case 'edit_notebook': {
        const fp  = this.abs(String(a.path));
        const nb  = JSON.parse(fs.readFileSync(fp, 'utf8')) as NotebookFile;
        const op  = String(a.operation);
        const cells = nb.cells ?? [];

        if (op === 'set_source') {
          const idx = Number(a.cell_index ?? 0);
          if (idx < 0 || idx >= cells.length) throw new Error(`Cell index ${idx} out of range (0-${cells.length - 1})`);
          cells[idx].source = String(a.source ?? '').split('\n').map((l, i, arr) => i < arr.length - 1 ? l + '\n' : l);
          cells[idx].outputs = [];
          cells[idx].execution_count = null;
        } else if (op === 'insert_cell') {
          const after = Number(a.after_index ?? cells.length - 1);
          const newCell: NotebookCell = {
            cell_type: String(a.cell_type ?? 'code') as NotebookCell['cell_type'],
            metadata:  {},
            source:    String(a.source ?? '').split('\n').map((l, i, arr) => i < arr.length - 1 ? l + '\n' : l),
            outputs:   [],
            execution_count: null
          };
          cells.splice(after + 1, 0, newCell);
        } else if (op === 'delete_cell') {
          const idx = Number(a.cell_index ?? 0);
          if (idx < 0 || idx >= cells.length) throw new Error(`Cell index ${idx} out of range`);
          cells.splice(idx, 1);
        } else if (op === 'set_cell_type') {
          const idx = Number(a.cell_index ?? 0);
          if (idx < 0 || idx >= cells.length) throw new Error(`Cell index ${idx} out of range`);
          cells[idx].cell_type = String(a.cell_type ?? 'code') as NotebookCell['cell_type'];
          if (cells[idx].cell_type !== 'code') { cells[idx].outputs = []; cells[idx].execution_count = null; }
        } else {
          throw new Error(`Unknown notebook operation: ${op}`);
        }

        nb.cells = cells;
        fs.writeFileSync(fp, JSON.stringify(nb, null, 1), 'utf8');
        return `Notebook ${op} applied to ${a.path} (${cells.length} cells)`;
      }

      // ── execute_notebook ───────────────────────────────────────
      case 'execute_notebook': {
        const fp      = this.abs(String(a.path));
        const timeout = Number(a.timeout_sec ?? 60) * 1000;
        const cmd     = `jupyter nbconvert --to notebook --execute --inplace "${fp}"`;
        await getPolicyGuardian().vet('jupyter nbconvert');
        return new Promise((resolve) => {
          cp.exec(cmd, { cwd: this.root(), timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
            if (err) resolve(`Jupyter execution error: ${err.message}\n${stderr}`.slice(0, 2000));
            else resolve(`Notebook executed: ${a.path}\n${stdout || stderr || '(no output)'}`.slice(0, 2000));
          });
        });
      }

      // ── send_message ───────────────────────────────────────────
      case 'send_message': {
        const convId = String(a.conversation_id);
        const msgId  = `msg_${Date.now().toString(36)}`;
        const entry  = { id: msgId, from: 'orchestrator', content: String(a.message), ts: new Date().toISOString() };
        this.inbox.push(entry);
        const sub    = this.subagents.get(convId);
        const target = sub ? `subagent[${sub.role}]` : convId;
        return `Message sent to ${target} (id: ${msgId}): ${String(a.message).slice(0, 100)}`;
      }

      // ── define_subagent ────────────────────────────────────────
      case 'define_subagent': {
        const role    = String(a.role ?? 'inherit');
        const model   = String(a.model ?? 'inherit');
        const task    = String(a.task);
        const convId  = `sub_${role}_${Date.now().toString(36)}`;
        this.subagents.set(convId, { role, model, conversationId: convId });
        return `Subagent defined — conversation_id: ${convId}\nRole: ${role}\nModel: ${model}\nInitial task: ${task.slice(0, 200)}\n\nSubagent is isolated. Use send_message(${convId}, ...) to communicate and wait_for_mention(${convId}) to await response.`;
      }

      // ── manage_task ────────────────────────────────────────────
      case 'manage_task': {
        const action = String(a.action ?? 'list');
        if (action === 'list') {
          if (!this.bgTasks.size) return 'No background tasks running.';
          const rows = [...this.bgTasks.entries()].map(([id, t]) => `• ${id}: [${t.status}] ${t.cmd.slice(0, 60)}`);
          return `Background tasks:\n${rows.join('\n')}`;
        }
        if (action === 'get') {
          const t = this.bgTasks.get(String(a.task_id ?? ''));
          if (!t) return `Task not found: ${a.task_id}`;
          return `Task ${a.task_id} [${t.status}]\nCommand: ${t.cmd}\nOutput:\n${t.output || '(no output yet)'}`;
        }
        if (action === 'cancel') {
          const id = String(a.task_id ?? '');
          if (this.bgTasks.has(id)) { this.bgTasks.delete(id); return `Task ${id} cancelled.`; }
          return `Task not found: ${id}`;
        }
        return `Unknown action: ${action}. Use list, get, or cancel.`;
      }

      // ── manage_inbox ───────────────────────────────────────────
      case 'manage_inbox': {
        const action = String(a.action ?? 'list');
        if (action === 'list') {
          if (!this.inbox.length) return 'Inbox is empty.';
          return this.inbox.map(m => `• [${m.id}] from:${m.from} at ${m.ts.slice(0, 19)}: ${m.content.slice(0, 80)}`).join('\n');
        }
        if (action === 'read') {
          const msg = this.inbox.find(m => m.id === String(a.message_id ?? ''));
          if (!msg) return `Message not found: ${a.message_id}`;
          return `Message ${msg.id}\nFrom: ${msg.from}\nAt: ${msg.ts}\n\n${msg.content}`;
        }
        if (action === 'clear') {
          const n = this.inbox.length;
          this.inbox = [];
          return `Cleared ${n} message(s) from inbox.`;
        }
        return `Unknown action: ${action}. Use list, read, or clear.`;
      }

      // ── ask_question ───────────────────────────────────────────
      case 'ask_question': {
        const answer = await vscode.window.showInputBox({
          prompt:      String(a.question),
          placeHolder: String(a.placeholder ?? 'Type your answer here...'),
          title:       'Agent Question'
        });
        if (answer === undefined) return '[User dismissed the question — no answer provided]';
        return `User answered: ${answer}`;
      }

      // ── set_timer ──────────────────────────────────────────────
      case 'set_timer': {
        const secs  = Math.max(1, Math.min(3600, Number(a.duration_seconds ?? 30)));
        const label = String(a.label ?? `timer_${Date.now().toString(36)}`);
        setTimeout(() => {
          this.onBackground?.(`⏰ Timer "${label}" fired after ${secs}s`);
        }, secs * 1000);
        return `Timer "${label}" set for ${secs}s. You will be notified when it fires.`;
      }

      // ── wait_for_mention ───────────────────────────────────────
      case 'wait_for_mention': {
        const convId  = String(a.conversation_id);
        const timeout = Math.min(120, Number(a.timeout_seconds ?? 30));
        const sub     = this.subagents.get(convId);
        return new Promise(resolve => {
          const deadline = setTimeout(() => {
            resolve(`Timeout waiting for mention from ${convId} (${timeout}s). Check inbox with manage_inbox.`);
          }, timeout * 1000);
          const checkInterval = setInterval(() => {
            const msg = this.inbox.find(m => m.from === convId || m.id.includes(convId));
            if (msg) {
              clearInterval(checkInterval);
              clearTimeout(deadline);
              resolve(`Received from ${sub?.role ?? convId}: ${msg.content.slice(0, 500)}`);
            }
          }, 500);
        });
      }

      // ── ask_permission ─────────────────────────────────────────
      case 'ask_permission': {
        const resource  = String(a.resource);
        const reason    = String(a.reason);
        const pType     = String(a.permission_type ?? 'file_read');
        const grantKey  = `${pType}:${resource}`;
        if (this.permGrants.has(grantKey)) {
          return `Permission already granted: ${grantKey}`;
        }
        const choice = await vscode.window.showWarningMessage(
          `Permission Request: ${pType}`,
          { modal: true, detail: `Resource: ${resource}\nReason: ${reason}` },
          'Grant', 'Deny'
        );
        if (choice === 'Grant') {
          this.permGrants.add(grantKey);
          return `Permission granted: ${grantKey}`;
        }
        return `Permission denied: ${grantKey}`;
      }

      // ── list_permission_grants ─────────────────────────────────
      case 'list_permission_grants': {
        if (!this.permGrants.size) return 'No permission grants active.';
        return `Active permission grants:\n${[...this.permGrants].map(g => `• ${g}`).join('\n')}`;
      }

      // ── ask_multiple_choice ────────────────────────────────────
      case 'ask_multiple_choice': {
        const question = String(a.question);
        const choices  = (a.choices as string[]) ?? [];
        const multi    = Boolean(a.multi ?? false);
        if (multi) {
          const picks = await vscode.window.showQuickPick(choices, {
            title: question, canPickMany: true, placeHolder: 'Select one or more options'
          });
          if (!picks) return '[User dismissed]';
          return `User selected: ${picks.join(', ')}`;
        }
        const pick = await vscode.window.showQuickPick(choices, {
          title: question, placeHolder: 'Select an option'
        });
        if (!pick) return '[User dismissed]';
        return `User selected: ${pick}`;
      }

      // ── open_browser_url ───────────────────────────────────────
      case 'open_browser_url': {
        const url      = String(a.url);
        const external = Boolean(a.external ?? false);
        if (external) {
          await vscode.env.openExternal(vscode.Uri.parse(url));
          return `Opened externally: ${url}`;
        }
        await vscode.commands.executeCommand('simpleBrowser.show', url);
        return `Opened in VS Code browser: ${url}`;
      }

      // ── read_browser_page ──────────────────────────────────────
      case 'read_browser_page': {
        const url      = String(a.url);
        const maxChars = Number(a.max_chars ?? 8000);
        return fetchUrl(url, maxChars);
      }

      // ── list_browser_pages ────────────────────────────────────
      case 'list_browser_pages': {
        const port = Number(a.port ?? 9222);
        const pages = await cdpListPages(port);
        if (!pages.length) return `No browser pages found. Start Chrome with: --remote-debugging-port=${port}`;
        return pages.map((p, i) =>
          `${i}: [${p.type}] ${p.title}\n   URL: ${p.url}\n   ID: ${p.id}`
        ).join('\n\n');
      }

      // ── browser_input ──────────────────────────────────────────
      case 'browser_input': {
        const wsUrl = await cdpGetPageWsUrl(String(a.page_id ?? ''));
        if (!wsUrl) return 'No browser page available. Start Chrome with --remote-debugging-port=9222';
        await cdpCommand(wsUrl, 'Input.insertText', { text: String(a.text) });
        return `Typed "${String(a.text).slice(0, 80)}" into browser`;
      }

      // ── browser_click_element ──────────────────────────────────
      case 'browser_click_element': {
        const wsUrl = await cdpGetPageWsUrl(String(a.page_id ?? ''));
        if (!wsUrl) return 'No browser page available.';
        const selector = String(a.selector);
        // Get element center via JS then dispatch click
        const result = await cdpCommand(wsUrl, 'Runtime.evaluate', {
          expression: `(function(){const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`,
          returnByValue: true
        }) as { result?: { value?: { x: number; y: number } } } | null;
        const coords = result && 'result' in result ? (result as Record<string, unknown>).result as { value?: { x: number; y: number } } : null;
        if (!coords?.value) return `Element not found: ${selector}`;
        const { x, y } = coords.value;
        await cdpMouseEvent(wsUrl, 'mousePressed',  x, y, 'left');
        await cdpMouseEvent(wsUrl, 'mouseReleased', x, y, 'left');
        return `Clicked element: ${selector} at (${Math.round(x)}, ${Math.round(y)})`;
      }

      // ── click_browser_pixel ────────────────────────────────────
      case 'click_browser_pixel': {
        const wsUrl = await cdpGetPageWsUrl(String(a.page_id ?? ''));
        if (!wsUrl) return 'No browser page available.';
        const x = Number(a.x), y = Number(a.y);
        const btn = String(a.button ?? 'left') as 'left' | 'right' | 'middle';
        await cdpMouseEvent(wsUrl, 'mousePressed',  x, y, btn);
        await cdpMouseEvent(wsUrl, 'mouseReleased', x, y, btn);
        return `Clicked (${x}, ${y}) with ${btn} button`;
      }

      // ── browser_drag_pixel_to_pixel ────────────────────────────
      case 'browser_drag_pixel_to_pixel': {
        const wsUrl = await cdpGetPageWsUrl(String(a.page_id ?? ''));
        if (!wsUrl) return 'No browser page available.';
        const fx = Number(a.from_x), fy = Number(a.from_y);
        const tx = Number(a.to_x),   ty = Number(a.to_y);
        await cdpMouseEvent(wsUrl, 'mousePressed', fx, fy, 'left');
        // Move in steps for realistic drag
        const steps = 5;
        for (let i = 1; i <= steps; i++) {
          await cdpMouseEvent(wsUrl, 'mouseMoved', fx + (tx - fx) * i / steps, fy + (ty - fy) * i / steps, 'left');
        }
        await cdpMouseEvent(wsUrl, 'mouseReleased', tx, ty, 'left');
        return `Dragged from (${fx},${fy}) to (${tx},${ty})`;
      }

      // ── browser_scroll ────────────────────────────────────────
      case 'browser_scroll': {
        const wsUrl = await cdpGetPageWsUrl(String(a.page_id ?? ''));
        if (!wsUrl) return 'No browser page available.';
        await cdpCommand(wsUrl, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: Number(a.x ?? 0), y: Number(a.y ?? 0),
          deltaX: Number(a.delta_x ?? 0), deltaY: Number(a.delta_y ?? 0)
        });
        return `Scrolled by (${a.delta_x ?? 0}, ${a.delta_y ?? 0})`;
      }

      // ── browser_scroll_up ─────────────────────────────────────
      case 'browser_scroll_up': {
        const wsUrl = await cdpGetPageWsUrl(String(a.page_id ?? ''));
        if (!wsUrl) return 'No browser page available.';
        const amount = Number(a.amount ?? 300);
        await cdpCommand(wsUrl, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 0, y: 0, deltaX: 0, deltaY: -amount });
        return `Scrolled up ${amount}px`;
      }

      // ── browser_scroll_down ───────────────────────────────────
      case 'browser_scroll_down': {
        const wsUrl = await cdpGetPageWsUrl(String(a.page_id ?? ''));
        if (!wsUrl) return 'No browser page available.';
        const amount = Number(a.amount ?? 300);
        await cdpCommand(wsUrl, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 0, y: 0, deltaX: 0, deltaY: amount });
        return `Scrolled down ${amount}px`;
      }

      // ── browser_press_key ─────────────────────────────────────
      case 'browser_press_key': {
        const wsUrl = await cdpGetPageWsUrl(String(a.page_id ?? ''));
        if (!wsUrl) return 'No browser page available.';
        const key = String(a.key);
        await cdpCommand(wsUrl, 'Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode: cdpKeyCode(key) });
        await cdpCommand(wsUrl, 'Input.dispatchKeyEvent', { type: 'keyUp',   key, windowsVirtualKeyCode: cdpKeyCode(key) });
        return `Pressed key: ${key}`;
      }

      // ── browser_select_option ────────────────────────────────
      case 'browser_select_option': {
        const wsUrl = await cdpGetPageWsUrl(String(a.page_id ?? ''));
        if (!wsUrl) return 'No browser page available.';
        const sel = String(a.selector), val = String(a.value);
        const res = await cdpCommand(wsUrl, 'Runtime.evaluate', {
          expression: `(function(){const el=document.querySelector(${JSON.stringify(sel)});if(!el)return'not found';el.value=${JSON.stringify(val)};el.dispatchEvent(new Event('change',{bubbles:true}));return'ok'})()`,
          returnByValue: true
        }) as { result?: { value?: string } } | null;
        const v = res && 'result' in res ? (res as { result?: { value?: string } }).result?.value : null;
        return v === 'ok' ? `Selected "${val}" in ${sel}` : `Element not found: ${sel}`;
      }

      // ── browser_refresh_page ─────────────────────────────────
      case 'browser_refresh_page': {
        const wsUrl = await cdpGetPageWsUrl(String(a.page_id ?? ''));
        if (!wsUrl) return 'No browser page available.';
        await cdpCommand(wsUrl, 'Page.reload', { ignoreCache: Boolean(a.ignore_cache ?? false) });
        return 'Page refreshed';
      }

      // ── browser_resize_window ────────────────────────────────
      case 'browser_resize_window': {
        const wsUrl = await cdpGetPageWsUrl(String(a.page_id ?? ''));
        if (!wsUrl) return 'No browser page available.';
        const w = Number(a.width), h = Number(a.height);
        await cdpCommand(wsUrl, 'Emulation.setDeviceMetricsOverride', {
          width: w, height: h, deviceScaleFactor: 1, mobile: false
        });
        return `Viewport resized to ${w}×${h}`;
      }

      // ── browser_move_mouse ───────────────────────────────────
      case 'browser_move_mouse': {
        const wsUrl = await cdpGetPageWsUrl(String(a.page_id ?? ''));
        if (!wsUrl) return 'No browser page available.';
        await cdpMouseEvent(wsUrl, 'mouseMoved', Number(a.x), Number(a.y), 'none');
        return `Mouse moved to (${a.x}, ${a.y})`;
      }

      // ── browser_mouse_down ───────────────────────────────────
      case 'browser_mouse_down': {
        const wsUrl = await cdpGetPageWsUrl(String(a.page_id ?? ''));
        if (!wsUrl) return 'No browser page available.';
        await cdpMouseEvent(wsUrl, 'mousePressed', Number(a.x), Number(a.y), String(a.button ?? 'left') as 'left'|'right'|'middle');
        return `Mouse button pressed at (${a.x}, ${a.y})`;
      }

      // ── browser_mouse_up ─────────────────────────────────────
      case 'browser_mouse_up': {
        const wsUrl = await cdpGetPageWsUrl(String(a.page_id ?? ''));
        if (!wsUrl) return 'No browser page available.';
        await cdpMouseEvent(wsUrl, 'mouseReleased', Number(a.x), Number(a.y), String(a.button ?? 'left') as 'left'|'right'|'middle');
        return `Mouse button released at (${a.x}, ${a.y})`;
      }

      // ── browser_mouse_wheel ──────────────────────────────────
      case 'browser_mouse_wheel': {
        const wsUrl = await cdpGetPageWsUrl(String(a.page_id ?? ''));
        if (!wsUrl) return 'No browser page available.';
        await cdpCommand(wsUrl, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: Number(a.x), y: Number(a.y),
          deltaX: Number(a.delta_x ?? 0), deltaY: Number(a.delta_y ?? 0)
        });
        return `Mouse wheel at (${a.x},${a.y}) delta=(${a.delta_x ?? 0},${a.delta_y ?? 0})`;
      }

      // ── browser_get_network_request ──────────────────────────
      case 'browser_get_network_request': {
        const wsUrl = await cdpGetPageWsUrl(String(a.page_id ?? ''));
        if (!wsUrl) return 'No browser page available.';
        const pattern = a.url_pattern ? String(a.url_pattern) : null;
        const reqs = await cdpGetNetworkRequests(wsUrl);
        const req = pattern
          ? reqs.find(r => r.url?.includes(pattern))
          : (a.index !== undefined ? reqs[Number(a.index)] : reqs[0]);
        if (!req) return `No matching network request${pattern ? ` for pattern "${pattern}"` : ''}`;
        return JSON.stringify(req, null, 2).slice(0, 3000);
      }

      // ── browser_list_network_requests ─────────────────────────
      case 'browser_list_network_requests': {
        const wsUrl = await cdpGetPageWsUrl(String(a.page_id ?? ''));
        if (!wsUrl) return 'No browser page available.';
        const filter = a.filter_url ? String(a.filter_url) : null;
        let reqs = await cdpGetNetworkRequests(wsUrl);
        if (filter) reqs = reqs.filter(r => r.url?.includes(filter));
        if (!reqs.length) return 'No network requests recorded.';
        return reqs.slice(0, 30).map((r, i) =>
          `${i}: [${r.method ?? 'GET'}] ${r.url ?? '?'} → ${r.status ?? '?'}`
        ).join('\n');
      }

      // ── execute_browser_javascript ────────────────────────────
      case 'execute_browser_javascript': {
        const wsUrl = await cdpGetPageWsUrl(String(a.page_id ?? ''));
        if (!wsUrl) return 'No browser page available.';
        const code    = String(a.code);
        const awaitP  = Boolean(a.await_promise ?? false);
        const res     = await cdpCommand(wsUrl, 'Runtime.evaluate', {
          expression:   code,
          returnByValue: true,
          awaitPromise:  awaitP
        }) as { result?: { type?: string; value?: unknown; description?: string } } | null;
        const r = res && 'result' in res ? (res as { result?: { type?: string; value?: unknown; description?: string } }).result : null;
        if (!r) return 'null';
        if (r.type === 'string') return String(r.value);
        if (r.value !== undefined) return JSON.stringify(r.value).slice(0, 2000);
        return r.description ?? 'undefined';
      }

      // ── capture_browser_screenshot (upgraded with real CDP) ───
      case 'capture_browser_screenshot': {
        const wsUrl = await cdpGetPageWsUrl(String(a.page_id ?? ''));
        if (!wsUrl) return 'No browser page available. Start Chrome with --remote-debugging-port=9222.';
        const res = await cdpCommand(wsUrl, 'Page.captureScreenshot', { format: 'png', quality: 85 }) as { data?: string } | null;
        const b64 = res && 'data' in res ? (res as { data?: string }).data : null;
        if (!b64) return 'Screenshot failed: no data returned from CDP';
        if (a.save_path) {
          const fp = this.abs(String(a.save_path));
          fs.mkdirSync(path.dirname(fp), { recursive: true });
          fs.writeFileSync(fp, Buffer.from(b64, 'base64'));
          return `Screenshot saved to: ${a.save_path} (${Math.round(b64.length * 0.75 / 1024)}KB)`;
        }
        return `Screenshot captured (${Math.round(b64.length * 0.75 / 1024)}KB base64 PNG). Use save_path to save to file.`;
      }

      // ── capture_browser_console_logs (upgraded with real CDP) ─
      case 'capture_browser_console_logs': {
        const wsUrl = await cdpGetPageWsUrl(String(a.page_id ?? ''));
        if (!wsUrl) return 'No browser page available. Start Chrome with --remote-debugging-port=9222.';
        const level = String(a.level ?? 'all');
        // Fetch console messages stored in page via JS
        const res = await cdpCommand(wsUrl, 'Runtime.evaluate', {
          expression: `JSON.stringify(window.__cdp_console_log || [])`,
          returnByValue: true
        }) as { result?: { value?: string } } | null;
        let logs: Array<{ level: string; text: string; ts: number }> = [];
        try {
          const v = res && 'result' in res ? (res as { result?: { value?: string } }).result?.value : null;
          if (v) logs = JSON.parse(v) as Array<{ level: string; text: string; ts: number }>;
        } catch { /* empty log */ }
        if (level !== 'all') logs = logs.filter(l => l.level === level);
        if (!logs.length) {
          return `No console logs captured (level: ${level}).\nNote: inject window.__cdp_console_log capture before page load, or check real-time via CDP Log.entryAdded. Try reloading the page.`;
        }
        return logs.slice(-50).map(l => `[${l.level.toUpperCase()}] ${l.text}`).join('\n');
      }

      // ── browser_get_dom (upgraded with real CDP) ──────────────
      case 'browser_get_dom': {
        const wsUrl = await cdpGetPageWsUrl(String(a.page_id ?? ''));
        if (!wsUrl) return 'No browser page available. Start Chrome with --remote-debugging-port=9222.';
        const selector = a.selector ? String(a.selector) : null;
        let html: string;
        if (selector) {
          const res = await cdpCommand(wsUrl, 'Runtime.evaluate', {
            expression: `(function(){const el=document.querySelector(${JSON.stringify(selector)});return el?el.outerHTML:'not found'})()`,
            returnByValue: true
          }) as { result?: { value?: string } } | null;
          html = (res && 'result' in res ? (res as { result?: { value?: string } }).result?.value : null) ?? 'not found';
        } else {
          const docRes = await cdpCommand(wsUrl, 'DOM.getDocument', { depth: 0 }) as { root?: { nodeId?: number } } | null;
          const nodeId = docRes && 'root' in docRes ? (docRes as { root?: { nodeId?: number } }).root?.nodeId : null;
          if (!nodeId) return 'Failed to get document root';
          const outerRes = await cdpCommand(wsUrl, 'DOM.getOuterHTML', { nodeId }) as { outerHTML?: string } | null;
          html = (outerRes && 'outerHTML' in outerRes ? (outerRes as { outerHTML?: string }).outerHTML : null) ?? '';
        }
        return `DOM snapshot${selector ? ` (${selector})` : ''}:\n${html.slice(0, 8000)}`;
      }

      // ── read_url_content ─────────────────────────────────────
      case 'read_url_content': {
        const url      = String(a.url);
        const maxChars = Number(a.max_chars ?? 8000);
        const raw      = await fetchUrl(url, maxChars * 3);
        // Strip HTML tags for a markdown-like plain text output
        const text = raw
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/\s{2,}/g, ' ')
          .trim();
        return text.slice(0, maxChars);
      }

      // ── web_search ────────────────────────────────────────────
      // Same backend as google_search. (The old DuckDuckGo Instant Answer API only knows encyclopedia topics,
      // so technical queries always came back as "No results".)
      case 'web_search': {
        return runResearchTool('google_search', { query: a.query, limit: a.max_results ?? 8 }, (await this.researchOpts?.()) ?? {});
      }

      // ── code_search ───────────────────────────────────────────
      case 'code_search': {
        const query = String(a.query);
        const kind  = String(a.kind ?? 'all').toLowerCase();
        try {
          const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            'vscode.executeWorkspaceSymbolProvider', query
          );
          if (!symbols?.length) {
            // Fall back to grep if no symbols found
            return `No workspace symbols for "${query}". Try grep_search for text-based search.`;
          }
          const kindMap: Record<number, string> = {
            [vscode.SymbolKind.Function]: 'function', [vscode.SymbolKind.Class]: 'class',
            [vscode.SymbolKind.Interface]: 'interface', [vscode.SymbolKind.Variable]: 'variable',
            [vscode.SymbolKind.Method]: 'method', [vscode.SymbolKind.Constant]: 'constant',
          };
          const filtered = kind === 'all' ? symbols : symbols.filter(s => kindMap[s.kind] === kind);
          return filtered.slice(0, 20).map(s => {
            const k    = kindMap[s.kind] ?? 'symbol';
            const loc  = s.location.uri ? vscode.workspace.asRelativePath(s.location.uri) : '?';
            const ln   = (s.location.range?.start?.line ?? 0) + 1;
            return `${k} ${s.name} @ ${loc}:${ln}`;
          }).join('\n');
        } catch {
          return `code_search requires VS Code language server. Try grep_search for text-based search.`;
        }
      }

      // ── start_code_review ─────────────────────────────────────
      case 'start_code_review': {
        const focus   = String(a.focus ?? 'all');
        const diffOnly = Boolean(a.diff_only ?? false);
        let content = '';
        const files   = (a.files as string[] | undefined) ?? [];
        if (files.length) {
          for (const f of files.slice(0, 5)) {
            try {
              const text = fs.readFileSync(this.abs(f), 'utf8').slice(0, 3000);
              content += `\n=== ${f} ===\n${text}`;
            } catch { content += `\n=== ${f} === (not found)`; }
          }
        } else {
          // Use git diff
          const diff = await new Promise<string>(res =>
            cp.exec('git diff HEAD~1..HEAD --unified=3', { cwd: this.root(), timeout: 10000, encoding: 'utf8' },
              (_, stdout, stderr) => res((stdout || stderr || 'No diff available').slice(0, 6000))
            )
          );
          content = diff;
        }
        const issues: string[] = [];
        // Simple static analysis
        if (!diffOnly || content.includes('+')) {
          if (/eval\s*\(/.test(content))          issues.push('⚠️ eval() usage detected');
          if (/innerHTML\s*=/.test(content))      issues.push('⚠️ innerHTML assignment — potential XSS');
          if (/password\s*=\s*["'][^"']{3,}/i.test(content)) issues.push('🔴 Possible hardcoded password');
          if (/console\.log\(/.test(content))     issues.push('💡 Debug console.log found — remove before production');
          if (/TODO|FIXME|HACK|XXX/.test(content)) issues.push('💡 TODO/FIXME markers found in code');
          if (/http:\/\/(?!localhost)/.test(content)) issues.push('⚠️ Non-HTTPS URL found');
          if (focus === 'security' || focus === 'all') {
            if (/sql.*\+.*req\.(body|params)/i.test(content)) issues.push('🔴 Possible SQL injection');
          }
        }
        const summary = issues.length
          ? `Code Review (focus: ${focus}) — ${issues.length} issue(s) found:\n${issues.join('\n')}`
          : `Code Review (focus: ${focus}) — No obvious issues found. Manual review recommended.`;
        return summary + `\n\n${files.length ? `Reviewed: ${files.join(', ')}` : 'Source: git diff HEAD~1..HEAD'}`;
      }

      // ── post_pr_review ────────────────────────────────────────
      case 'post_pr_review': {
        const comment  = String(a.comment);
        const file     = a.file ? String(a.file) : 'general';
        const line     = a.line !== undefined ? Number(a.line) : 0;
        const severity = String(a.severity ?? 'suggestion');
        const entry    = `[${severity.toUpperCase()}] ${file}:${line > 0 ? line : '?'} — ${comment}\n`;
        const root     = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.root();
        const reviewFile = path.join(root, '.review');
        try {
          fs.appendFileSync(reviewFile, entry, 'utf8');
          return `Review comment posted to .review:\n${entry}`;
        } catch (e) {
          return `Review comment (not saved — ${e}):\n${entry}`;
        }
      }

      // ── propose_code ──────────────────────────────────────────
      case 'propose_code': {
        const file    = String(a.file);
        const oldStr  = String(a.old_str);
        const newStr  = String(a.new_str ?? '');
        const reason  = String(a.reason ?? 'No reason provided');
        const diff    = [
          `--- a/${file}`,
          `+++ b/${file}`,
          `@@ proposed change @@`,
          ...oldStr.split('\n').map(l => `- ${l}`),
          ...newStr.split('\n').map(l => `+ ${l}`),
          ''
        ].join('\n');
        const entry   = `\n### Proposal: ${file}\nReason: ${reason}\n\`\`\`diff\n${diff}\`\`\`\n`;
        const root    = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.root();
        const propFile = path.join(root, '.proposals.md');
        try {
          fs.appendFileSync(propFile, entry, 'utf8');
          return `Code proposal saved to .proposals.md:\n${diff.slice(0, 500)}`;
        } catch (e) {
          return `Code proposal (not saved — ${e}):\n${diff.slice(0, 500)}`;
        }
      }

      // ── knowledge_artifacts ───────────────────────────────────
      case 'knowledge_artifacts': {
        const action = String(a.action ?? 'list');
        // Delegate to VS Code global state knowledge store
        const key = 'ragAssistant:knowledgeArtifacts';
        const items = (vscode.workspace.getConfiguration('ragAssistant').get<Array<{id:string;title:string;content:string;created:string}>>('knowledgeArtifacts')) ?? [];
        if (action === 'list') {
          if (!items.length) return 'No knowledge artifacts stored.';
          return items.map((i, idx) => `${idx}: [${i.id}] ${i.title}`).join('\n');
        }
        if (action === 'read') {
          const id = a.id ? String(a.id) : null;
          const item = id ? items.find(i => i.id === id || i.title === id) : items[0];
          if (!item) return `Knowledge artifact not found: ${id}`;
          return `**${item.title}**\n\n${item.content}`;
        }
        if (action === 'create') {
          const title   = String(a.title ?? 'Untitled');
          const content = String(a.content ?? '');
          const newItem = { id: Date.now().toString(36), title, content, created: new Date().toISOString() };
          const updated = [...items, newItem];
          await vscode.workspace.getConfiguration('ragAssistant').update('knowledgeArtifacts', updated, vscode.ConfigurationTarget.Global);
          return `Knowledge artifact created: "${title}" (id: ${newItem.id})`;
        }
        if (action === 'search') {
          const q = String(a.query ?? '').toLowerCase();
          const matches = items.filter(i => i.title.toLowerCase().includes(q) || i.content.toLowerCase().includes(q));
          if (!matches.length) return `No artifacts match "${q}"`;
          return matches.map(i => `• [${i.id}] ${i.title}: ${i.content.slice(0, 80)}...`).join('\n');
        }
        return `Unknown action: ${action}. Use list, read, create, or search.`;
      }

      // ── read_resource ──────────────────────────────────────────
      case 'read_resource': {
        const uri = String(a.uri);
        if (uri.startsWith('file://')) {
          const fp = uri.replace('file://', '');
          try { return fs.readFileSync(this.abs(fp), 'utf8').slice(0, 8000); }
          catch (e) { return `Cannot read file: ${fp} — ${e}`; }
        }
        if (uri.startsWith('kb://')) {
          const id = uri.replace('kb://', '');
          const items = (vscode.workspace.getConfiguration('ragAssistant').get<Array<{id:string;title:string;content:string}>>('knowledgeArtifacts')) ?? [];
          const item  = items.find(i => i.id === id || i.title === id);
          if (!item) return `Knowledge artifact not found: ${id}`;
          return `**${item.title}**\n\n${item.content}`;
        }
        if (uri.startsWith('http://') || uri.startsWith('https://')) {
          return fetchUrl(uri, 8000);
        }
        // Treat as relative file path
        try { return fs.readFileSync(this.abs(uri), 'utf8').slice(0, 8000); }
        catch { return `Unknown resource URI: ${uri}. Use file://, kb://, or http://.`; }
      }

      // ── list_resources ────────────────────────────────────────
      case 'list_resources': {
        const typeFilter = String(a.type_filter ?? 'all');
        const pattern    = a.pattern ? String(a.pattern) : '**/*.md';
        const lines: string[] = [];

        if (typeFilter === 'file' || typeFilter === 'all') {
          try {
            const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 50);
            uris.slice(0, 20).forEach(u => lines.push(`📄 file://${vscode.workspace.asRelativePath(u)}`));
          } catch { /* no workspace */ }
        }

        if (typeFilter === 'kb' || typeFilter === 'all') {
          const items = (vscode.workspace.getConfiguration('ragAssistant').get<Array<{id:string;title:string}>>('knowledgeArtifacts')) ?? [];
          items.forEach(i => lines.push(`📚 kb://${i.id} — ${i.title}`));
        }

        if (!lines.length) return 'No resources found.';
        return `Resources (${typeFilter}):\n${lines.join('\n')}`;
      }

      // ── restart_dev_server ────────────────────────────────────
      case 'restart_dev_server': {
        const cmd     = a.command ? String(a.command) : 'npm run dev';
        const timeout = Number(a.timeout_ms ?? 15000);
        // Kill any process on the target port first
        const port = Number(a.port ?? 3000);
        try {
          if (process.platform === 'win32') {
            cp.execSync(`FOR /F "tokens=5" %a IN ('netstat -ano ^| findstr :${port}') DO taskkill /PID %a /F`, { stdio: 'ignore' });
          } else {
            cp.execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
          }
        } catch { /* port might not be in use */ }
        // Start the dev server in background
        const proc = cp.spawn(cmd, [], {
          shell: true, detached: true, stdio: 'ignore',
          cwd: this.root(), windowsHide: true
        });
        proc.unref();
        await new Promise(r => setTimeout(r, Math.min(timeout, 3000)));
        return `Dev server restarted: "${cmd}" on port ${port} (pid: ${proc.pid ?? 'unknown'})`;
      }

      // ── check_deploy_status ───────────────────────────────────
      case 'check_deploy_status': {
        const projectId = String(a.project_id ?? '');
        const service   = String(a.service ?? 'hosting');
        const flag      = projectId ? `--project ${projectId}` : '';
        try {
          const out = cp.execSync(`firebase ${flag} hosting:channel:list 2>&1`, {
            cwd: this.root(), timeout: 20000, encoding: 'utf8'
          });
          return `Deploy status (${service}):\n${out.slice(0, 3000)}`;
        } catch (e) {
          return `Deploy status check failed: ${e instanceof Error ? e.message : String(e)}\nEnsure Firebase CLI is installed: npm install -g firebase-tools`;
        }
      }

      // ── set_up_firebase ───────────────────────────────────────
      case 'set_up_firebase': {
        const projectId = String(a.project_id);
        const features  = Array.isArray(a.features) ? (a.features as string[]).join(',') : 'hosting';
        try {
          const out = cp.execSync(
            `firebase init ${features} --project ${projectId} --non-interactive 2>&1`,
            { cwd: this.root(), timeout: 60000, encoding: 'utf8' }
          );
          return `Firebase initialized (features: ${features}):\n${out.slice(0, 3000)}`;
        } catch (e) {
          return `firebase init failed: ${e instanceof Error ? e.message : String(e)}\nEnsure Firebase CLI is installed: npm install -g firebase-tools`;
        }
      }

      // ── deploy_firebase ───────────────────────────────────────
      case 'deploy_firebase': {
        const projectId = a.project_id ? `--project ${String(a.project_id)}` : '';
        const only      = a.only ? `--only ${String(a.only)}` : '';
        try {
          const out = cp.execSync(
            `firebase deploy ${projectId} ${only} 2>&1`.trim(),
            { cwd: this.root(), timeout: 120000, encoding: 'utf8' }
          );
          return `Firebase deploy complete:\n${out.slice(0, 3000)}`;
        } catch (e) {
          return `firebase deploy failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      // ── set_up_cloud_sql ──────────────────────────────────────
      case 'set_up_cloud_sql': {
        const projectId    = String(a.project_id);
        const instanceName = String(a.instance_name);
        const dbType       = String(a.database_type ?? 'POSTGRES_15');
        const region       = String(a.region ?? 'us-central1');
        try {
          const out = cp.execSync(
            `gcloud sql instances create ${instanceName} --project=${projectId} --database-version=${dbType.toUpperCase()} --region=${region} --tier=db-f1-micro 2>&1`,
            { cwd: this.root(), timeout: 120000, encoding: 'utf8' }
          );
          return `Cloud SQL instance created:\n${out.slice(0, 3000)}`;
        } catch (e) {
          return `gcloud sql instances create failed: ${e instanceof Error ? e.message : String(e)}\nEnsure gcloud CLI is installed and authenticated.`;
        }
      }

      // ── cloud_sql_execute_sql ─────────────────────────────────
      case 'cloud_sql_execute_sql': {
        const connName = String(a.instance_connection_name);
        const database = String(a.database ?? 'postgres');
        const sql      = String(a.sql);
        const user     = String(a.user ?? 'postgres');
        // Use cloud_sql_proxy if available, otherwise gcloud sql connect
        try {
          const out = cp.execSync(
            `gcloud sql connect ${connName.split(':').pop()} --user=${user} --database=${database} --quiet 2>&1 <<'EOF'\n${sql}\nEOF`,
            { cwd: this.root(), timeout: 30000, encoding: 'utf8', shell: '/bin/bash' }
          );
          return `SQL result:\n${out.slice(0, 4000)}`;
        } catch (e) {
          return `Cloud SQL execute failed: ${e instanceof Error ? e.message : String(e)}\nEnsure gcloud CLI is installed and Cloud SQL proxy is configured.`;
        }
      }

      // ── generate_image ────────────────────────────────────────
      case 'generate_image': {
        const prompt     = String(a.prompt);
        const outputPath = a.output_path ? this.abs(String(a.output_path)) : undefined;
        const width      = Number(a.width  ?? 1024);
        const height     = Number(a.height ?? 1024);
        // Delegate to Imagen via Gemini API if API key available
        const cfg        = vscode.workspace.getConfiguration('ragAssistant');
        const apiKey     = cfg.get<string>('geminiApiKey') ?? cfg.get<string>('apiKey') ?? '';
        if (!apiKey) return 'generate_image requires a Gemini/Imagen API key. Set ragAssistant.geminiApiKey in settings.';
        const body = JSON.stringify({
          instances: [{ prompt }],
          parameters: { sampleCount: 1, width, height }
        });
        const apiUrl = `https://us-central1-aiplatform.googleapis.com/v1/projects/imagen-public-preview/locations/us-central1/publishers/google/models/${String(a.model ?? 'imagen-3.0-generate-001')}:predict`;
        try {
          const raw = await fetchUrl(apiUrl, 1000000);
          const data = JSON.parse(raw) as { predictions?: Array<{ bytesBase64Encoded?: string }> };
          const b64  = data.predictions?.[0]?.bytesBase64Encoded;
          if (!b64) return `Image generation failed: no image data in response`;
          if (outputPath) {
            const { mkdirSync, writeFileSync } = await import('fs');
            mkdirSync(require('path').dirname(outputPath), { recursive: true });
            writeFileSync(outputPath, Buffer.from(b64, 'base64'));
            return `Image generated and saved to: ${a.output_path} (${Math.round(b64.length * 0.75 / 1024)}KB)`;
          }
          return `Image generated (${Math.round(b64.length * 0.75 / 1024)}KB base64 PNG). Provide output_path to save.`;
        } catch (e) {
          return `generate_image failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      default:
        if (RESEARCH_TOOL_NAMES.has(call.name)) {
          return runResearchTool(call.name, a, (await this.researchOpts?.()) ?? {});
        }
        return `Unknown tool: ${call.name}`;
    }
  }
}

// ── Notebook types ─────────────────────────────────────────────
interface NotebookCell {
  cell_type: 'code' | 'markdown' | 'raw';
  metadata:  Record<string, unknown>;
  source:    string | string[];
  outputs?:  Array<{ output_type: string; text?: string | string[]; data?: unknown; [k: string]: unknown }>;
  execution_count?: number | null;
}
interface NotebookFile {
  cells:    NotebookCell[];
  metadata: { kernelspec?: { display_name?: string }; [k: string]: unknown };
  nbformat: number;
  nbformat_minor: number;
}

// ── Helpers ───────────────────────────────────────────────────
function extractOutline(text: string, filePath: string): string {
  const ext   = path.extname(filePath).toLowerCase();
  const lines = text.split('\n');
  const hits: string[] = [];

  // Patterns for TypeScript/JavaScript/Python/Go
  const patterns = [
    /^(export\s+)?(default\s+)?(async\s+)?function\s+(\w+)/,
    /^(export\s+)?(abstract\s+)?class\s+(\w+)/,
    /^(export\s+)?interface\s+(\w+)/,
    /^(export\s+)?type\s+(\w+)\s*=/,
    /^(export\s+)?(const|let|var)\s+(\w+)\s*[=:]/,
    /^\s*(public|private|protected|static|async)?\s+(\w+)\s*\([^)]*\)\s*[:{]/,
    /^def\s+(\w+)/,
    /^class\s+(\w+)/,
    /^func\s+(\w+)/,
  ];

  lines.forEach((line, idx) => {
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('#')) return;
    if (patterns.some(p => p.test(t))) {
      hits.push(`${String(idx + 1).padStart(4)}: ${t.slice(0, 80)}`);
    }
  });

  return hits.length
    ? `File outline for ${filePath}:\n${hits.join('\n')}`
    : `No outline found for ${filePath}`;
}

function buildSymbolPatterns(name: string, kind: string): RegExp[] {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`\\bfunction\\s+${esc}\\b`),
    new RegExp(`\\bclass\\s+${esc}\\b`),
    new RegExp(`\\binterface\\s+${esc}\\b`),
    new RegExp(`\\btype\\s+${esc}\\b`),
    new RegExp(`\\bconst\\s+${esc}\\s*[=:]`),
    new RegExp(`\\bdef\\s+${esc}\\b`),
    new RegExp(`\\bfunc\\s+${esc}\\b`),
  ];
}

function applyUnifiedDiff(orig: string[], diff: string): string[] {
  const result = [...orig];
  const lines  = diff.split('\n');
  let offset   = 0;

  for (let i = 0; i < lines.length; i++) {
    const hunk = lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!hunk) continue;

    let lineNum = parseInt(hunk[1]) - 1 + offset;
    let removeCount = 0;
    const adds: string[] = [];

    i++;
    while (i < lines.length && !lines[i].startsWith('@@')) {
      const l = lines[i];
      if (l.startsWith('-')) { removeCount++; }
      else if (l.startsWith('+')) { adds.push(l.slice(1)); }
      i++;
    }
    i--;

    result.splice(lineNum, removeCount, ...adds);
    offset += adds.length - removeCount;
  }
  return result;
}

function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const text = html
    .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?(br|p|div|li|ul|ol|h[1-6]|tr|pre|section|article|header|footer|table)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return (title ? '# ' + title.replace(/\s+/g, ' ').trim() + '\n\n' : '') + text;
}

function fetchUrl(url: string, maxChars: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https:');
    const lib     = isHttps ? https : http;
    const req     = lib.get(url, {
      headers: { 'User-Agent': 'RAG-Assistant/0.1', Accept: 'text/html,application/json,text/plain,*/*' },
      timeout: 15000
    }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        fetchUrl(new URL(res.headers.location, url).toString(), maxChars).then(resolve).catch(reject);   // location may be relative
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { if (body.length < 2_000_000) body += c; });
      res.on('end', () => {
        const code = res.statusCode ?? 0;
        // 403 / 429 / 503 or a "just a moment…" page: a bot challenge, not content. The caller may retry in the stealth browser.
        if (code === 403 || code === 429 || code === 503 || (code >= 400 && /just a moment|cf-chl|attention required|verify you are (a )?human|enable javascript and cookies/i.test(body.slice(0, 4000)))) {
          reject(Object.assign(new Error(`HTTP ${code} (the site blocked the request or asked for a bot challenge)`), { challenge: true }));
          return;
        }
        const type = String(res.headers['content-type'] ?? '');
        const isHtml = /html/i.test(type) || /^\s*(<!doctype html|<html)/i.test(body);
        resolve((isHtml ? htmlToText(body) : body).slice(0, maxChars));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ════════════════════════════════════════════════════════════════
// CDP (Chrome DevTools Protocol) Bridge — §11, §14, §25
// Connects to Chrome via --remote-debugging-port=9222
// ════════════════════════════════════════════════════════════════

interface CDPPage {
  id:                   string;
  title:                string;
  url:                  string;
  type:                 string;
  webSocketDebuggerUrl?: string;
}

function cdpListPages(port = 9222): Promise<CDPPage[]> {
  return new Promise(resolve => {
    http.get(`http://localhost:${port}/json`, { timeout: 3000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body) as CDPPage[]); } catch { resolve([]); } });
    }).on('error', () => resolve([]));
  });
}

async function cdpGetPageWsUrl(pageId: string, port = 9222): Promise<string | null> {
  const pages = await cdpListPages(port);
  if (!pages.length) return null;
  if (pageId) {
    const match = pages.find(p => p.id === pageId);
    if (match?.webSocketDebuggerUrl) return match.webSocketDebuggerUrl;
  }
  // Return first page-type tab
  const page = pages.find(p => p.type === 'page') ?? pages[0];
  return page?.webSocketDebuggerUrl ?? null;
}

function cdpCommand(wsUrl: string, method: string, params: Record<string, unknown> = {}, timeoutMs = 8000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try { parsed = new URL(wsUrl); }
    catch (e) { reject(new Error(`Invalid WS URL: ${wsUrl}`)); return; }

    const host = parsed.hostname;
    const port = parseInt(parsed.port || '9222', 10);
    const wPath = parsed.pathname;
    const key   = crypto.randomBytes(16).toString('base64');

    const socket = net.connect(port, host, () => {
      const handshake = [
        `GET ${wPath} HTTP/1.1`,
        `Host: ${host}:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '', ''
      ].join('\r\n');
      socket.write(handshake);
    });

    let handshakeDone = false;
    let buf = Buffer.alloc(0);
    const cmdId = Date.now() % 100000;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      socket.destroy();
      reject(new Error(`CDP timeout: ${method}`));
    }, timeoutMs);

    socket.on('data', (chunk: Buffer) => {
      if (timedOut) return;
      buf = Buffer.concat([buf, chunk]);

      if (!handshakeDone) {
        const headerEnd = buf.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const header = buf.slice(0, headerEnd).toString('ascii');
        if (!header.includes('101')) {
          clearTimeout(timer); socket.destroy();
          reject(new Error('WebSocket upgrade failed'));
          return;
        }
        handshakeDone = true;
        buf = buf.slice(headerEnd + 4);
        // Send CDP command
        socket.write(wsEncode(JSON.stringify({ id: cmdId, method, params })));
      }

      if (handshakeDone) {
        while (buf.length > 0) {
          const frame = wsDecode(buf);
          if (!frame) break;
          buf = buf.slice(frame.consumed);
          try {
            const resp = JSON.parse(frame.payload) as { id?: number; result?: unknown; error?: { message?: string } };
            if (resp.id === cmdId) {
              clearTimeout(timer);
              socket.destroy();
              if (resp.error) reject(new Error(resp.error.message ?? JSON.stringify(resp.error)));
              else resolve(resp.result ?? null);
              return;
            }
          } catch { /* ignore non-matching frames */ }
        }
      }
    });

    socket.on('error', (e) => { if (!timedOut) { clearTimeout(timer); reject(e); } });
    socket.on('close', () => { if (!timedOut) { clearTimeout(timer); reject(new Error('CDP socket closed')); } });
  });
}

function cdpMouseEvent(wsUrl: string, type: string, x: number, y: number, button: 'left'|'right'|'middle'|'none'): Promise<unknown> {
  const btnMap: Record<string, number> = { left: 1, right: 2, middle: 4, none: 0 };
  return cdpCommand(wsUrl, 'Input.dispatchMouseEvent', {
    type, x: Math.round(x), y: Math.round(y),
    button: button === 'none' ? 'none' : button,
    buttons: btnMap[button] ?? 0,
    clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0
  });
}

async function cdpGetNetworkRequests(wsUrl: string): Promise<Array<{url?:string;method?:string;status?:number;type?:string}>> {
  // Enable network domain and get stored requests via JS
  await cdpCommand(wsUrl, 'Network.enable', {}).catch(() => { /* already enabled */ });
  const res = await cdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: `JSON.stringify(window.__cdp_network_log||[])`,
    returnByValue: true
  }) as { result?: { value?: string } } | null;
  try {
    const v = res && 'result' in res ? (res as { result?: { value?: string } }).result?.value : null;
    if (v) return JSON.parse(v) as Array<{url?:string;method?:string;status?:number}>;
  } catch { /* empty */ }
  return [];
}

function wsEncode(msg: string): Buffer {
  const payload = Buffer.from(msg, 'utf8');
  const maskKey = crypto.randomBytes(4);
  const masked  = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ maskKey[i % 4];

  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x81; header[1] = 0x80 | payload.length;
    maskKey.copy(header, 2);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(8);
    header[0] = 0x81; header[1] = 0xfe;
    header.writeUInt16BE(payload.length, 2);
    maskKey.copy(header, 4);
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x81; header[1] = 0xff;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
    maskKey.copy(header, 10);
  }
  return Buffer.concat([header, masked]);
}

function wsDecode(buf: Buffer): { payload: string; consumed: number } | null {
  if (buf.length < 2) return null;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2); offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    payloadLen = Number(buf.readBigUInt64BE(2)); offset = 10;
  }
  const masked = (buf[1] & 0x80) !== 0;
  if (masked) offset += 4;
  if (buf.length < offset + payloadLen) return null;
  let payloadBuf: Buffer;
  if (masked) {
    const mk = buf.slice(offset - 4, offset);
    payloadBuf = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) payloadBuf[i] = buf[offset + i] ^ mk[i % 4];
  } else {
    payloadBuf = buf.slice(offset, offset + payloadLen);
  }
  return { payload: payloadBuf.toString('utf8'), consumed: offset + payloadLen };
}

function cdpKeyCode(key: string): number {
  const codes: Record<string, number> = {
    'Enter': 13, 'Escape': 27, 'Tab': 9, 'Backspace': 8, 'Delete': 46,
    'ArrowUp': 38, 'ArrowDown': 40, 'ArrowLeft': 37, 'ArrowRight': 39,
    'Home': 36, 'End': 35, 'PageUp': 33, 'PageDown': 34,
    'F1': 112, 'F2': 113, 'F3': 114, 'F4': 115, 'F5': 116,
    'Space': 32, 'Insert': 45,
  };
  return codes[key] ?? 0;
}
