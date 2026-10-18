import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import * as cp   from 'child_process';
import { AsyncResource } from 'async_hooks';
import { ensureBotasaurus, StealthOptions } from './BotasaurusSearch';

/**
 * Claude (claude.ai), ChatGPT (chatgpt.com) and Gemini (gemini.google.com) used as models through their websites,
 * driven by Botasaurus (a real Chrome with anti-detection). The user signs in once, by hand, in the Chrome window that
 * opens; the sign-in lives in a private Chrome profile on this machine and Autopilot never sees a password.
 *
 * One long-lived Chrome per site: the Python process below keeps it open and answers JSON lines on stdin with JSON
 * events on stdout, so a model call is "type the prompt, press send, read the answer while it streams".
 *
 * The websites have no tool-calling API, so the model is told to write tool calls as `TOOL_CALL {json}` lines, which
 * LLMClient turns back into real tool calls.
 */
export type WebSite = 'claude' | 'chatgpt' | 'gemini';

export interface SiteConfig {
  url: string;
  input: string[];       // the message box, also the sign-in check
  send: string[];        // the send button (Enter is pressed when none is found)
  assistant: string[];   // one element per answer
  streaming: string[];   // visible while the model is still writing
  signedOut?: string[];  // visible only while nobody is signed in (some sites show a guest chat box even then)
  account?: string[];    // shows the signed-in account's name (best effort, only used in the confirmation message)
  signedIn?: string[];   // visible only while somebody is signed in (an extra check for sites that show a guest chat box)
  level?: string;        // the button that opens the site's model/reasoning menu (Gemini, Claude): three of its reasoning levels are the modes
  levelKind?: 'gemini' | 'claude';   // how that menu is laid out (default gemini)
  think?: string;        // regex for the label of the composer's "Think" switch (instant / thinking mode); sites without one leave it out
  attachLimit?: string;  // regex for the page's "no more attachments" message
}

/** Best-effort selectors: these pages change often. ragAssistant.webChatSites patches single fields without a new release. */
export const DEFAULT_SITES: Record<WebSite, SiteConfig> = {
  claude: {
    url: 'https://claude.ai/new',
    // Checked against the signed-in page: data-testid attributes are stable and do not depend on the account's language.
    input: ['div[contenteditable="true"][role="textbox"]', 'div.ProseMirror[contenteditable="true"]', 'fieldset div[contenteditable="true"]'],
    send: ['button[data-testid="chat-input-send"]', 'button[aria-label="Send message"]', 'button[aria-label="Send Message"]'],
    assistant: ['div.font-claude-response', '[data-testid="assistant-message"]', 'div.font-claude-message'],
    streaming: ['button[data-testid="chat-input-stop"]', 'button[aria-label="Stop response"]', 'div[data-is-streaming="true"]'],
    signedIn: ['button[data-testid="user-menu-button"]'],
    account: ['button[data-testid="user-menu-button"]'],
    level: 'button[data-testid="model-selector-dropdown"]',
    levelKind: 'claude'
  },
  chatgpt: {
    url: 'https://chatgpt.com/',
    // Checked against the signed-in page: the box is a ProseMirror div inside form[data-chatgpt-composer] (no #prompt-textarea any more)
    // and the send button is button[type=submit][aria-label=Send], which only appears once something is typed.
    input: ['form[data-chatgpt-composer] div.ProseMirror[contenteditable="true"]', 'div.ProseMirror[contenteditable="true"][role="textbox"]', '#prompt-textarea', 'textarea[name="prompt-textarea"]'],
    send: ['form[data-chatgpt-composer] button[type="submit"]', 'button[data-testid="send-button"]', 'button[aria-label="Send"]', 'button[aria-label="Send prompt"]'],
    // The answer is a div[data-dil-message-id] (its class names are hashed and change); the older role attribute is kept as a fallback
    assistant: ['div[data-dil-message-id]', 'div[class*="DilResponseRoot"]', 'div[data-message-author-role="assistant"]', 'article[data-turn="assistant"]'],
    streaming: ['button[data-testid="stop-button"]', 'button[aria-label="Stop streaming"]', 'button[aria-label="Stop generating"]', 'button[aria-label="Stop"]'],
    signedOut: ['a[href*="auth/login"]'],
    account: ['button[aria-label="Open profile menu"]', '[data-testid="accounts-profile-button"]'],
    think: '^Think',
    attachLimit: "reached the limit for file attachments|limit for file (uploads|attachments)|can.t upload more|upload limit"
  },
  gemini: {
    url: 'https://gemini.google.com/app',
    // Checked against the signed-in page (its labels follow the account language, so the selectors lean on structure, not on label text):
    // the send button sits in gem-icon-button.send-button, which only exists once something is typed, gets class "submit" then and "stop" while answering.
    input: ['rich-textarea div.ql-editor[contenteditable="true"]', 'div.ql-editor[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]'],
    send: ['.send-button.submit button', 'gem-icon-button.send-button.submit button', 'button[aria-label="Send message"]'],
    assistant: ['message-content', 'model-response .markdown', '.model-response-text'],
    streaming: ['.send-button.stop button', 'button[aria-label*="Stop"]', 'button[aria-label*="Hentikan"]'],
    signedOut: ['a[href*="accounts.google.com/ServiceLogin"]', 'a[href*="accounts.google.com/signin"]', 'a[href*="accounts.google.com/v3/signin"]'],
    signedIn: ['a[aria-label*="@"]'],
    account: ['a[aria-label*="@"]'],
    level: 'button[data-test-id="bard-mode-menu-button"]'
  }
};

export const SITE_NAMES: Record<WebSite, string> = { claude: 'Claude (claude.ai)', chatgpt: 'ChatGPT (chatgpt.com)', gemini: 'Gemini (gemini.google.com)' };

const BASE = process.env['RAG_BOTASAURUS_HOME'] || path.join(os.homedir(), '.rag-assistant', 'mcp-packages', 'botasaurus');

const RUNNER = `import json, sys, time, threading, queue, traceback, os, re
from botasaurus.browser import browser, Driver

cfg = json.loads(open(sys.argv[1], encoding='utf-8').read())
SITE = cfg['site']
SC = cfg['config']

def emit(obj):
    sys.stdout.write('@@EVT@@' + json.dumps(obj) + '\\n')
    sys.stdout.flush()

commands = queue.Queue()
def read_stdin():
    for line in sys.stdin:
        line = line.strip()
        if line:
            try:
                commands.put(json.loads(line))
            except Exception:
                pass
    commands.put({'cmd': 'quit'})
threading.Thread(target=read_stdin, daemon=True).start()

def js(driver, body, **vars):
    pre = ''.join('const %s = %s;\\n' % (k, json.dumps(v)) for k, v in vars.items())
    return driver.run_js(pre + body)

FIND = """for (const s of SELS) { for (const e of document.querySelectorAll(s)) { if (e.offsetParent !== null || e.getClientRects().length) return s; } } return '';"""
COUNT = """let n = 0; for (const s of SELS) { n = Math.max(n, document.querySelectorAll(s).length); } return n;"""
LAST = """let best = null, bestN = 0; for (const s of SELS) { const all = document.querySelectorAll(s); if (all.length > bestN) { best = all[all.length - 1]; bestN = all.length; } } return best ? (best.innerText || '') : '';"""
LASTID = """let best = null, bestN = 0; for (const s of SELS) { const all = document.querySelectorAll(s); if (all.length > bestN) { best = all[all.length - 1]; bestN = all.length; } } if (!best) return ''; return (best.getAttribute('data-dil-message-id') || best.getAttribute('data-message-id') || best.id || '');"""
BOXLEN = """const el = document.querySelector(INPUT); if (!el) return -1; return (el.value !== undefined ? el.value : (el.innerText || '')).trim().length;"""
BUSY = """for (const s of SELS) { for (const e of document.querySelectorAll(s)) { if (e.offsetParent !== null || e.getClientRects().length) return true; } } return false;"""
TYPE = """const el = document.querySelector(SEL); if (!el) return -1; el.focus();
if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, TEXT);
  el.dispatchEvent(new Event('input', {bubbles: true}));
} else {
  document.execCommand('selectAll', false, null); document.execCommand('delete', false, null);
  document.execCommand('insertText', false, TEXT);
}
return (el.value !== undefined ? el.value : el.innerText || '').length;"""
TYPEMORE = """const el = document.querySelector(SEL); if (!el) return -1;
if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, el.value + TEXT);
  el.dispatchEvent(new Event('input', {bubbles: true}));
} else { document.execCommand('insertText', false, TEXT); }
return 1;"""
SEND = """for (const s of SELS) { const b = document.querySelector(s); if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') { b.click(); return 'button'; } }
const el = document.querySelector(INPUT); if (!el) return 'none';
const form = el.closest('form'); if (form && typeof form.requestSubmit === 'function') { form.requestSubmit(); return 'submit'; }
for (const t of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(t, {key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true}));
return 'enter';"""
ATTACH = """const el = document.querySelector(INPUT); if (!el) return 'no input'; el.focus();
const dt = new DataTransfer();
for (const f of FILES) { const bin = atob(f.b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); dt.items.add(new File([u8], f.name, {type: f.mime})); }
const ev = new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true});
el.dispatchEvent(ev);
return ev.defaultPrevented ? 'pasted' : 'ignored';"""
LIMITMSG = """const t = document.body ? document.body.innerText : ''; const m = new RegExp(RX, 'i').exec(t); return m ? t.slice(m.index, m.index + 160) : '';"""
SENDREADY = """for (const s of SELS) { const b = document.querySelector(s); if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') return true; } return false;"""
THINK = """const forms = document.querySelectorAll('form'); const re = new RegExp(RX, 'i');
for (const f of forms) { for (const b of f.querySelectorAll('button')) { if (re.test((b.innerText || '').trim())) {
  const on = b.getAttribute('aria-pressed') === 'true';
  if (WANT !== on) { b.click(); }
  return WANT === on ? 'kept' : 'clicked';
} } }
return 'none';"""
THINKSTATE = """const re = new RegExp(RX, 'i');
for (const b of document.querySelectorAll('form button')) { if (re.test((b.innerText || '').trim())) return b.getAttribute('aria-pressed') === 'true'; } return null;"""
LEVELOPEN = """const b = document.querySelector(BTN); if (!b) return 'nobutton'; b.click(); return 'opened';"""
LEVELEXPAND = """const vis = e => e.offsetParent !== null || e.getClientRects().length;
const items = [...document.querySelectorAll('[role=menuitem]')].filter(e => !e.getAttribute('data-test-id'));
if (items.length < 4) return 'items:' + items.length;
if (vis(items[1])) return 'open';
if (!vis(items[0])) return 'noheader';
items[0].click(); return 'expanded';"""
LEVELPICK = """const vis = e => e.offsetParent !== null || e.getClientRects().length;
const items = [...document.querySelectorAll('[role=menuitem]')].filter(e => !e.getAttribute('data-test-id') && vis(e));
if (items.length < 4) return 'items:' + items.length;
items[1 + IDX].click();
return 'clicked';"""
CLAUDEEXPAND = """const vis = e => e.offsetParent !== null || e.getClientRects().length;
const menus = [...document.querySelectorAll('[role=menu]')].filter(vis);
if (menus.length >= 2) return 'open';
const subs = [...document.querySelectorAll('[role=menuitem]')].filter(e => vis(e) && e.getAttribute('aria-haspopup') === 'menu');
if (!subs.length) return 'items:0';
subs[0].click(); return 'expanded';"""
CLAUDEPICK = """const vis = e => e.offsetParent !== null || e.getClientRects().length;
const menus = [...document.querySelectorAll('[role=menu]')].filter(vis);
if (menus.length < 2) return 'items:menus' + menus.length;
const radios = [...menus[menus.length - 1].querySelectorAll('[role=menuitemradio]')].filter(vis);
if (radios.length < 3) return 'items:' + radios.length;
radios[IDX].click(); return 'clicked';"""
LEVELCLOSE = """const m = document.querySelector('[role=menu]'); if (m && (m.offsetParent !== null || m.getClientRects().length)) { const b = document.querySelector(BTN); if (b) b.click(); } return true;"""
FULLCHAT = """return new RegExp(RX, 'i').test((document.body ? document.body.innerText : '').slice(-5000));"""
ACCOUNT = """for (const s of SELS) { const e = document.querySelector(s); if (e) { let t = (e.innerText || e.getAttribute('aria-label') || '').trim(); const NL = String.fromCharCode(10); t = (t.indexOf(' \u00b7 ') >= 0 ? t.split(NL).join(' ') : t.split(NL)[0]).trim(); const c = t.indexOf(':'); if (c >= 0 && c < 25) t = t.slice(c + 1).trim(); const p = t.indexOf(' ('); if (p > 0) t = t.slice(0, p); const dot = t.indexOf(' \u00b7 '); if (dot > 0) { t = t.slice(0, dot); const sp = t.indexOf(' '); if (sp === 1) t = t.slice(2); } if (t) return t.slice(0, 60); } } return '';"""
STOP = """for (const s of SELS) { const b = document.querySelector(s); if (b && b.tagName === 'BUTTON') { b.click(); return true; } } return false;"""

def sjs(driver, body, default=None, **vars):
    """A page read that must not end the answer: a slow or busy tab can make one CDP call time out, the next one works."""
    try:
        return js(driver, body, **vars)
    except Exception:
        return default

def surl(driver):
    try:
        return driver.current_url
    except Exception:
        return ''

def find(driver, sels):
    return js(driver, FIND, SELS=sels) or ''

CHALLENGE = """return /just a moment|verify you are human|checking your browser/i.test((document.body ? document.body.innerText : '').slice(0, 1500));"""

def open_site(driver, url):
    try:
        driver.get(url)
    except Exception:
        driver.google_get(url, bypass_cloudflare=True)
    driver.sleep(0.8)
    try:
        if driver.run_js(CHALLENGE):
            driver.google_get(url, bypass_cloudflare=True)
            driver.sleep(2.0)
    except Exception:
        pass

def wait_for_input(driver, timeout):
    """The message box is also the sign-in check: it only exists once the user is signed in."""
    t0 = time.time()
    warned = False
    while time.time() - t0 < timeout:
        sel = find(driver, SC['input'])
        if sel and not find(driver, SC.get('signedOut', [])) and (not SC.get('signedIn') or find(driver, SC['signedIn'])):
            return sel
        if not warned and time.time() - t0 > (15 if SC.get('signedIn') else 6):       # Gemini draws the account button late
            emit({'type': 'login_required', 'site': SITE})
            warned = True
        driver.sleep(0.6)
    return ''

def ready_event(driver):
    acct = ''
    for _ in range(3):                          # the profile button says "Loading profile" for a moment
        try:
            acct = js(driver, ACCOUNT, SELS=SC.get('account', [])) or ''
        except Exception:
            acct = ''
        if acct and 'loading' not in acct.lower():
            break
        driver.sleep(0.6)
    if 'loading' in acct.lower() or len(acct) < 2:           # an avatar initial alone is no name
        acct = ''
    emit({'type': 'ready', 'site': SITE, 'account': acct})

def settle(driver, limit=12.0):
    """A chat opened by address draws its old messages bit by bit: wait until the number of answers and the last one stop changing."""
    t0 = time.time()
    last = None
    same_since = time.time()
    while time.time() - t0 < limit:
        cur = (sjs(driver, COUNT, None, SELS=SC['assistant']), sjs(driver, LASTID, '', SELS=SC['assistant']))
        if cur != last:
            last = cur
            same_since = time.time()
        elif time.time() - same_since > 1.6:
            return
        driver.sleep(0.4)

def ask(driver, req):
    rid = req['id']
    want = req.get('url') or ''
    if req.get('new_chat'):
        if not cfg.get('at_home'):                   # the home page just loaded IS an empty new chat: no second load
            open_site(driver, SC['url'])
    elif want:
        if not cfg.get('opened') or not driver.current_url.split('?')[0].startswith(want.split('?')[0]):
            open_site(driver, want)                  # back into the chat this IDE session already has
    elif not cfg.get('opened'):
        open_site(driver, SC['url'])
    cfg['opened'] = True
    cfg['at_home'] = False
    inp = wait_for_input(driver, 300)
    if not inp:
        emit({'type': 'error', 'id': rid, 'message': 'The message box of %s did not appear: sign in in the Chrome window, or the page layout changed (ragAssistant.webChatSites)' % SITE})
        return
    ready_event(driver)
    settle(driver)
    if req.get('mode') and SC.get('think'):
        want = req['mode'] == 'thinking'
        try:
            got = js(driver, THINK, RX=SC['think'], WANT=want)
            if got == 'none':
                emit({'type': 'note', 'message': 'The Think switch of %s was not found: its mode stays as the website has it (patch ragAssistant.webChatSites, field think).' % SITE})
            elif got == 'clicked':
                driver.sleep(0.5)
                if js(driver, THINKSTATE, RX=SC['think']) is not want:
                    emit({'type': 'note', 'message': 'Could not switch %s to %s mode.' % (SITE, req['mode'])})
        except Exception as e:
            emit({'type': 'note', 'message': 'Could not set the mode: %s' % str(e)[:120]})
    if req.get('mode') and SC.get('level') and cfg.get('level_set') != req['mode']:       # reasoning level (Gemini): Low / Medium / High
        idx = {'instant': 0, 'balanced': 1, 'thinking': 2}.get(req['mode'], 0)
        try:
            if sjs(driver, LEVELOPEN, '', BTN=SC['level']) == 'opened':
                driver.sleep(0.9)
                got = ''
                claude_menu = SC.get('levelKind') == 'claude'
                for _w in range(16):                                # the menu draws itself a moment after the click (longer right after the page loaded)
                    got = sjs(driver, CLAUDEEXPAND if claude_menu else LEVELEXPAND, '') or ''        # "reasoning level" is a sub menu: its entries show once it is opened
                    if not got.startswith('items:'):
                        break
                    driver.sleep(0.5)
                if got == 'expanded':
                    driver.sleep(0.8)
                    got = ''
                if got in ('', 'expanded', 'open'):
                    got = sjs(driver, CLAUDEPICK if claude_menu else LEVELPICK, '', IDX=idx)
                driver.sleep(0.5)
                sjs(driver, LEVELCLOSE, True, BTN=SC['level'])
                if got == 'clicked':
                    cfg['level_set'] = req['mode']
                else:
                    emit({'type': 'note', 'message': 'The reasoning level menu of %s looked different than expected (%s): its mode stays as the website has it.' % (SITE, got)})
        except Exception as e:
            emit({'type': 'note', 'message': 'Could not set the mode: %s' % str(e)[:120]})
    files = req.get('files') or []
    lim = SC.get('attachLimit') or 'reached the limit for file attachments'
    lim0 = False
    if files:
        lim0 = bool(js(driver, FULLCHAT, RX=lim))       # a notice that was already there does not count
        how = js(driver, ATTACH, INPUT=inp, FILES=files)
        if how != 'pasted':
            emit({'type': 'error', 'id': rid, 'message': 'The page of %s did not accept the attached file(s) (%s). Patch ragAssistant.webChatSites or send without attachments.' % (SITE, how)})
            return
        driver.sleep(1.0)
    before = js(driver, COUNT, SELS=SC['assistant']) or 0
    before_id = sjs(driver, LASTID, '', SELS=SC['assistant']) or ''      # long chats unload old messages, so the count alone can stand still while a new answer arrives
    before_text = (sjs(driver, LAST, '', SELS=SC['assistant']) or '') if before else ''
    # A long prompt (instructions, 80+ tools) typed in one piece freezes the page's editor for minutes: it goes in small pieces
    txt = req['text']
    CHUNK = 1500
    cut = CHUNK
    if len(txt) > CHUNK and 0xD800 <= ord(txt[CHUNK - 1]) <= 0xDBFF:
        cut = CHUNK - 1
    n = js(driver, TYPE, SEL=inp, TEXT=txt[:cut])
    pos = cut
    while n and n > 0 and pos < len(txt):
        end = pos + CHUNK
        if end < len(txt) and 0xD800 <= ord(txt[end - 1]) <= 0xDBFF:
            end -= 1
        js(driver, TYPEMORE, SEL=inp, TEXT=txt[pos:end])
        pos = end
    if not n or n < 0:
        emit({'type': 'error', 'id': rid, 'message': 'Could not type into the message box of %s (selector %s)' % (SITE, inp)})
        return
    driver.sleep(0.6)
    # The send button shows up (and, with files, stops being disabled) only once the page has taken in the text: a long prompt needs a while
    t_up = time.time()
    while time.time() - t_up < (120 if files else 25):
        if files and not lim0 and sjs(driver, FULLCHAT, False, RX=lim):
            emit({'type': 'error', 'id': rid, 'message': 'ATTACH_LIMIT: %s does not take more attachments right now. It says: %s' % (SITE, (sjs(driver, LIMITMSG, '', RX=lim) or '').strip().replace(chr(10), ' ')[:200])})
            return
        if sjs(driver, SENDREADY, False, SELS=SC['send']):
            break
        driver.sleep(0.4)
    how = sjs(driver, SEND, None, SELS=SC['send'], INPUT=inp) or 'unknown'
    # Check that the message really left the box (the box empties, or the page starts answering); otherwise press send again
    for _try in range(3):
        t_v = time.time()
        left = False
        while time.time() - t_v < 6:
            if (sjs(driver, BOXLEN, -1, INPUT=inp) or 0) < 5 or sjs(driver, BUSY, False, SELS=SC['streaming']):
                left = True
                break
            driver.sleep(0.4)
        if left:
            break
        how = sjs(driver, SEND, None, SELS=SC['send'], INPUT=inp) or how
    t0 = time.time()
    timeout = float(req.get('timeout', 300))
    last = ''
    stable = time.time()
    fail0 = time.time()
    seen_busy = False
    while time.time() - t0 < timeout:
        try:
            while True:
                c = commands.get_nowait()
                if c.get('cmd') == 'cancel':
                    js(driver, STOP, SELS=SC['streaming'])
                    emit({'type': 'done', 'id': rid, 'text': last, 'cancelled': True})
                    return
                if c.get('cmd') == 'quit':
                    commands.put(c)
                    return
        except queue.Empty:
            pass
        count = sjs(driver, COUNT, None, SELS=SC['assistant'])
        if count is None:                                                # the page did not answer: wait and ask again
            if time.time() - fail0 > 90:
                break
            driver.sleep(1.0)
            continue
        fail0 = time.time()
        busy = bool(sjs(driver, BUSY, False, SELS=SC['streaming']))
        seen_busy = seen_busy or busy
        cur_id = sjs(driver, LASTID, '', SELS=SC['assistant']) or ''
        fresh = count > before or (before_id != '' and cur_id != '' and cur_id != before_id) or (seen_busy and count > 0)       # a new answer exists
        if not fresh and time.time() - t0 > 4 and not busy:        # nothing started: has the chat hit its length limit?
            if sjs(driver, FULLCHAT, False, RX=SC.get('chatFull') or 'maximum length for this conversation|conversation is too long|reached the (maximum|max) (length|limit)|start a new chat to continue'):
                emit({'type': 'error', 'id': rid, 'message': 'CHAT_FULL'})
                return
        text = (sjs(driver, LAST, last, SELS=SC['assistant']) or '') if fresh else ''
        if fresh and not seen_busy and before_text and text == before_text:       # still the old answer: the new one has not started
            text = ''
        if text != last:
            last = text
            stable = time.time()
            emit({'type': 'delta', 'id': rid, 'text': text})
        if fresh and text and not busy and time.time() - stable > (2.2 if seen_busy else 10.0):       # an answer the page was never seen writing must stay unchanged much longer: it may still be a placeholder
            emit({'type': 'done', 'id': rid, 'text': text, 'url': surl(driver)})
            return
        driver.sleep(0.35)
    if last:
        emit({'type': 'done', 'id': rid, 'text': last, 'timeout': True, 'url': surl(driver)})
    else:
        emit({'type': 'error', 'id': rid, 'message': 'No answer appeared on %s within %d s (sent with %s). The page layout may have changed: patch ragAssistant.webChatSites.' % (SITE, int(timeout), how)})

@browser(profile='autopilot-' + SITE + os.environ.get('RAG_WEBCHAT_PROFILE_SUFFIX', ''), headless=bool(cfg.get('headless')), block_images=False, output=None, create_error_logs=False, reuse_driver=False,
         window_size=(1100, 850), raise_exception=True, close_on_crash=False)
def serve(driver: Driver, data):
    open_site(driver, SC['url'])
    cfg['opened'] = True
    cfg['at_home'] = True
    if wait_for_input(driver, 300):
        ready_event(driver)
    else:
        emit({'type': 'fatal', 'message': 'Not signed in to %s within 5 minutes.' % SITE})
        return 'not signed in'
    while True:
        cmd = commands.get()
        if cmd.get('cmd') == 'quit':
            return 'bye'
        if cmd.get('cmd') == 'ask':
            try:
                ask(driver, cmd)
            except Exception as e:
                gone = re.search(r'10061|actively refused|Failed to connect|connection (failure|closed|lost)|target (closed|crashed)|no such window|disconnected|not connected', str(e), re.I)
                if gone:                                      # Chrome is gone: leave, the extension starts a fresh one
                    emit({'type': 'error', 'id': cmd.get('id'), 'message': 'BROWSER_GONE: ' + str(e)[:200]})
                    return 'browser gone'
                emit({'type': 'error', 'id': cmd.get('id'), 'message': str(e)[:400] + ' | ' + traceback.format_exc()[-300:]})

try:
    serve(cfg)
except Exception as e:
    emit({'type': 'fatal', 'message': str(e)[:500]})
`;

// ── Node side ────────────────────────────────────────────────────────────────
/** Closes any Chrome still running on this profile (it survives a restart of the extension host and then blocks the next start). */
function freeProfile(profile: string): Promise<void> {
  return new Promise(resolve => {
    const done = () => setTimeout(resolve, 800);                                  // let the profile lock go
    if (process.platform === 'win32') {
      const script = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match 'profiles\\\\${profile}(["\\s]|$)' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      cp.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 }, done);
    } else {
      cp.execFile('pkill', ['-f', `profiles/${profile}`], { timeout: 10000 }, done);
    }
  });
}

export interface WebReply { text: string; cancelled?: boolean; url?: string; }
interface Handlers { onText?: (full: string) => void; resolve: (r: WebReply) => void; reject: (e: Error) => void; }

class SiteSession {
  private proc?: cp.ChildProcess;
  private buf = '';
  private pending = new Map<string, Handlers>();
  private idle?: NodeJS.Timeout;
  convo = '';                                    // which conversation the open chat belongs to
  private tail = '';
  onNotice?: (m: string) => void;

  constructor(readonly site: WebSite, private config: SiteConfig, readonly opts: StealthOptions) {}

  private headless = false;
  private outcome?: (r: { state: 'ready' | 'login'; account: string }) => void;
  private failStart?: (e: Error) => void;

  /** Starts the Python runner and resolves when the page is usable ('ready') or, in the background, when nobody is signed in ('login'). */
  private async spawnRunner(python: string, headless: boolean): Promise<{ state: 'ready' | 'login'; account: string }> {
    await freeProfile(`autopilot-${this.site}${process.env['RAG_WEBCHAT_PROFILE_SUFFIX'] || ''}`);   // a Chrome left over from a previous IDE session would lock the profile
    const cfgFile = path.join(os.tmpdir(), `autopilot-webchat-${this.site}.json`);
    fs.writeFileSync(cfgFile, JSON.stringify({ site: this.site, config: this.config, headless }), 'utf8');
    this.headless = headless;
    this.buf = '';
    const result = new Promise<{ state: 'ready' | 'login'; account: string }>((resolve, reject) => { this.outcome = resolve; this.failStart = reject; });
    const proc = cp.spawn(python, ['-u', path.join(BASE, 'webchat_runner.py'), cfgFile], { cwd: path.join(BASE, 'work'), windowsHide: false, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    this.proc = proc;
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (d: string) => this.onData(d));
    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', (d: string) => { this.tail = (this.tail + d).slice(-1200); });
    proc.on('exit', () => {
      if (this.proc !== proc) return;                       // stopped on purpose
      const e = new Error(`The ${SITE_NAMES[this.site]} browser closed${this.tail ? ': ' + this.tail.trim().split('\n').pop() : ''}`);
      this.pending.forEach(h => h.reject(e)); this.pending.clear();
      this.failStart?.(e);
      this.proc = undefined; this.convo = '';
    });
    return result;
  }

  private async stopRunner(): Promise<void> {
    const p = this.proc;
    if (!p) return;
    this.proc = undefined; this.convo = '';
    try { p.stdin?.write(JSON.stringify({ cmd: 'quit' }) + '\n'); } catch { /* gone */ }
    if (p.exitCode === null) await new Promise<void>(res => { p.once('exit', () => res()); setTimeout(() => { try { p.kill(); } catch { /* gone */ } res(); }, 8000); });
    await new Promise(r => setTimeout(r, 1500));            // let Chrome release the profile
  }

  private async start(): Promise<void> {
    const python = await ensureBotasaurus(this.opts.progress);
    fs.mkdirSync(path.join(BASE, 'work'), { recursive: true });
    fs.writeFileSync(path.join(BASE, 'webchat_runner.py'), RUNNER, 'utf8');
    const name = SITE_NAMES[this.site];
    const confirm = (account: string, extra: string) => this.onNotice?.(`✓ Signed in to ${name}${account ? ' as ' + account : ''}. ${extra}`);
    // 1) Try the saved sign-in in a background (invisible) Chrome: when it works the message goes straight to the model
    this.opts.progress(`Checking your ${name} sign-in…`);
    let r = await this.spawnRunner(python, true);
    if (r.state === 'ready') { confirm(r.account, 'Sending your message…'); return; }
    // 2) Not signed in: a visible window, so the user can sign in (five minutes)
    await this.stopRunner();
    this.onNotice?.(`Not signed in to ${name} yet. A Chrome window opens: sign in there (Autopilot waits 5 minutes, never sees your password). Your message is sent automatically afterwards.`);
    r = await this.spawnRunner(python, false);
    if (r.state !== 'ready') throw new Error(`Not signed in to ${name}.`);
    confirm(r.account, 'Moving its browser to the background and sending your message…');
    // 3) Signed in: the same profile now runs invisibly
    await this.stopRunner();
    r = await this.spawnRunner(python, true);
    if (r.state !== 'ready') throw new Error(`The ${name} sign-in was not kept. Try again.`);
  }

  private onData(d: string): void {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
      const at = line.indexOf('@@EVT@@');
      if (at < 0) continue;                                  // Botasaurus' own log lines
      let ev: { type: string; id?: string; text?: string; message?: string; cancelled?: boolean; account?: string; url?: string };
      try { ev = JSON.parse(line.slice(at + 7)); } catch { continue; }
      if (ev.type === 'note') this.onNotice?.((ev as { message?: string }).message ?? '');
      else if (ev.type === 'login_required') { if (this.headless) this.outcome?.({ state: 'login', account: '' }); }
      else if (ev.type === 'ready') this.outcome?.({ state: 'ready', account: (ev as { account?: string }).account ?? '' });
      else if (ev.type === 'fatal') { const e = new Error(ev.message ?? 'web chat failed'); this.pending.forEach(h => h.reject(e)); this.pending.clear(); this.failStart?.(e); }
      else if (ev.id && this.pending.has(ev.id)) {
        const h = this.pending.get(ev.id)!;
        if (ev.type === 'delta') h.onText?.(ev.text ?? '');
        else if (ev.type === 'done') { this.pending.delete(ev.id); h.resolve({ text: ev.text ?? '', cancelled: ev.cancelled, url: ev.url }); }
        else if (ev.type === 'error') { this.pending.delete(ev.id); h.reject(new Error(ev.message ?? 'web chat error')); }
      }
    }
  }

  /** Sends one prompt and resolves with the finished answer; onText gets the whole answer so far, repeatedly. */
  async ask(text: string, newChat: boolean, url: string | undefined, onText: (full: string) => void, abort?: { aborted: () => boolean }, mode?: 'instant' | 'balanced' | 'thinking', files?: WebFile[]): Promise<WebReply> {
    let got = false;
    const seen = (full: string) => { got = true; onText(full); };
    try { return await this.askOnce(text, newChat, url, seen, abort, mode, files); }
    catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (got || !/BROWSER_GONE|browser closed/.test(m)) throw e;
      // Chrome died while the extension still held its runner (closed by hand, crashed, or another program used the profile): start over once
      this.onNotice?.(`The ${SITE_NAMES[this.site]} browser had closed. Restarting it…`);
      await this.stopRunner();
      return await this.askOnce(text, newChat, url, onText, abort, mode, files);
    }
  }

  private async askOnce(text: string, newChat: boolean, url: string | undefined, onText: (full: string) => void, abort?: { aborted: () => boolean }, mode?: 'instant' | 'balanced' | 'thinking', files?: WebFile[]): Promise<WebReply> {
    if (!this.proc) await this.start();
    clearTimeout(this.idle);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const result = new Promise<WebReply>((resolve, reject) => { this.pending.set(id, { onText, resolve, reject }); });
    this.proc!.stdin!.write(JSON.stringify({ cmd: 'ask', id, text, new_chat: newChat, url, mode, files: files?.length ? files : undefined, timeout: 300 }) + '\n');
    const watch = abort ? setInterval(() => { if (abort.aborted()) { this.proc?.stdin?.write(JSON.stringify({ cmd: 'cancel' }) + '\n'); clearInterval(watch); } }, 400) : undefined;
    try { return await result; }
    finally { if (watch) clearInterval(watch); this.idle = setTimeout(() => this.dispose(), 60 * 60_000); }   // close Chrome after an idle hour
  }

  dispose(): void {
    clearTimeout(this.idle);
    try { this.proc?.stdin?.write(JSON.stringify({ cmd: 'quit' }) + '\n'); } catch { /* gone */ }
    const p = this.proc; setTimeout(() => { try { p?.kill(); } catch { /* gone */ } }, 3000);
    this.proc = undefined; this.convo = '';
  }
}

const sessions = new Map<WebSite, SiteSession>();
let chain = new Map<WebSite, Promise<unknown>>();

export interface WebFile { name: string; mime: string; b64: string; }

export interface WebAskOptions {
  site: WebSite;
  prompt: string;
  newChat: boolean;                              // true: start a new chat on the site
  mode?: 'instant' | 'balanced' | 'thinking';    // the site's Think switch (ChatGPT) or reasoning level (Gemini)
  files?: WebFile[];                             // attached to the message (pasted into the page, as if the user dropped them in)
  url?: string;                                  // otherwise: continue the chat at this URL (opened first when the browser is on another one)
  overrides?: Partial<SiteConfig>;
  progress: (m: string) => void;
  notice: (m: string) => void;
  proxy?: string;
  onText: (full: string) => void;
  abort?: { aborted: () => boolean };
}

/** One call at a time per site: the page can only type one message. */
export function webChatAsk(o: WebAskOptions): Promise<WebReply> {
  // The runner's output arrives on a stream that was opened by the FIRST task: without binding, later tasks' text would be
  // posted from that old task's context (the chat provider tells runs apart through it) and never show up in the right turn.
  o = { ...o, onText: AsyncResource.bind(o.onText), notice: AsyncResource.bind(o.notice), progress: AsyncResource.bind(o.progress) };
  const prev = chain.get(o.site) ?? Promise.resolve();
  const run = prev.then(async () => {
    let s = sessions.get(o.site);
    if (!s) {
      const cfg = { ...DEFAULT_SITES[o.site], ...(o.overrides ?? {}) };
      s = new SiteSession(o.site, cfg, { progress: o.progress, proxy: o.proxy });
      sessions.set(o.site, s);
    }
    s.opts.progress = o.progress;
    s.onNotice = o.notice;
    return s.ask(o.prompt, o.newChat, o.url, o.onText, o.abort, o.mode, o.files);
  });
  chain.set(o.site, run.catch(() => undefined));
  return run;
}

export function disposeWebChats(): void { for (const s of sessions.values()) s.dispose(); sessions.clear(); chain = new Map(); }

/** TOOL_CALL {json} lines in a reply -> real tool calls, and the text without them. */
export function parseToolCalls(text: string): { text: string; calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let out = '', i = 0;
  // Some pages (claude.ai) typeset what the model wrote: straight quotes come back curly, which breaks the JSON. The scan reads a
  // copy with straight quotes (same length, so positions match); the visible text keeps what the page showed.
  const src = text.replace(/[\u201c\u201d\u201e\u201f]/g, '"').replace(/[\u2018\u2019\u201a\u201b]/g, "'");
  const re = /TOOL_CALL\s*[:\-]?\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const start = src.indexOf('{', m.index + m[0].length);
    if (start < 0 || src.slice(m.index + m[0].length, start).replace(/[\s`]|json/gi, '') !== '') continue;     // JSON must follow directly (a code fence label may sit between)
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let k = start; k < src.length; k++) {
      const c = src[k];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { end = k + 1; break; }
    }
    if (end < 0) continue;
    try {
      const j = JSON.parse(src.slice(start, end)) as { name?: string; tool?: string; arguments?: Record<string, unknown>; args?: Record<string, unknown> };
      const name = j.name ?? j.tool;
      if (name) {
        calls.push({ name, args: j.arguments ?? j.args ?? {} });
        out += text.slice(i, m.index);
        i = end; re.lastIndex = end;
        while (src[i] === '`') i++;                          // the closing code fence
      }
    } catch { /* not JSON: leave it in the text */ }
  }
  // a code fence that held only tool calls is left empty: drop it
  return { text: (out + text.slice(i)).replace(/```[A-Za-z]*\s*```/g, '').replace(/\n{3,}/g, '\n\n').trim(), calls };
}
