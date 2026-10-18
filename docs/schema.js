/**
 * The schema is the single source of truth for the bot's configuration.
 * It drives:
 *   - default values (config.example.json is generated from it)
 *   - validation (used by the bot and the dashboard)
 *   - the dashboard's form fields (/docs)
 *
 * Loaded both from Node (bot/tests) and from the browser (dashboard), UMD-style.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CommunitySchema = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FEATURES = [
    {
      key: 'general',
      icon: '⚙️',
      name: 'General',
      blurb: 'Which server the bot runs in, admin roles, and the default log channel.',
      fields: [
        { key: 'guildId', label: 'Server', type: 'guild', hint: 'Pick from the dropdown (from the bot’s server snapshot). The bot ignores other servers.' },
        { key: 'adminRoleIds', label: 'Admin roles', type: 'roles', hint: 'These roles can use admin commands (config reload, warnings, give XP) and every ticket action.' },
        { key: 'logChannelId', label: 'Log channel', type: 'channel', hint: 'Default channel for bot logs: strikes, ticket transcripts, reaction-role errors.' },
      ],
    },
    {
      key: 'tickets',
      icon: '🎫',
      name: 'Tickets',
      blurb: 'A panel members punch to open a private ticket, choosing a reason you define. Staff can claim, close with a reason, reopen, and transcripts get posted to a log channel.',
      fields: [
        { key: 'enabled', label: 'Enabled', type: 'bool', def: true },
        { key: 'panelChannelId', label: 'Panel channel', type: 'channel', hint: 'Where the “Open a ticket” panel lives.' },
        { key: 'panelTitle', label: 'Panel embed title', type: 'text', def: 'Need help?' },
        { key: 'panelText', label: 'Panel embed text', type: 'textarea', def: 'Click the button below and pick a reason to open a private ticket with the team.' },
        { key: 'panelColor', label: 'Panel embed colour', type: 'color', def: '#5865F2' },
        { key: 'reasons', label: 'Ticket reasons (the dropdown)', type: 'list', def: [
          { label: 'Modpack / mod issue', emoji: '🧩', description: 'Something is broken with a mod or the modpack', pingRoleIds: [] },
          { label: 'Server help', emoji: '🖥️', description: 'Cannot join, crashes, lag, whitelist', pingRoleIds: [] },
          { label: 'Report a player', emoji: '🚩', description: 'Report rules-breaking behaviour (screenshots help)', pingRoleIds: [] },
        ], item: [
          { key: 'label', label: 'Name', type: 'text', required: true, max: 60, hint: 'Shown in the dropdown.' },
          { key: 'description', label: 'Description', type: 'text', max: 100 },
          { key: 'emoji', label: 'Emoji', type: 'emoji', hint: 'Unicode emoji, e.g. 🧩' },
          { key: 'pingRoleIds', label: 'Roles pinged in this ticket type', type: 'roles' },
          { key: 'greeting', label: 'First message for this reason', type: 'textarea', hint: 'Leave empty to use the default first message further down. Same placeholders: {user}, {username}, {reason}, {server}.' },
        ] },
        { key: 'categoryName', label: 'Open tickets category', type: 'category', def: 'Tickets', hint: 'Existing name from the dropdown, or type a new one — the bot creates it if missing.' },
        { key: 'claimRoleIds', label: 'Roles that can claim/close', type: 'roles', def: [], hint: '“Claim” shows for these roles (and admins).' },
        { key: 'pingRoleIds', label: 'Roles pinged in every ticket', type: 'roles', def: [] },
        { key: 'logChannelId', label: 'Transcript log channel', type: 'channel' },
        { key: 'transcripts', label: 'Keep a transcript when a ticket closes', type: 'bool', def: true, hint: 'Staff read it with the “View transcript” button on the closed-ticket log.' },
        { key: 'dmUserOnClose', label: 'DM the opener a transcript link', type: 'bool', def: true },
        { key: 'maxOpenPerUser', label: 'Max open tickets per user', type: 'number', def: 1, min: 1, max: 10 },
        { key: 'autoCloseHours', label: 'Auto-close after hours of silence', type: 'number', def: 0, min: 0, max: 720, hint: '0 = never.' },
        { key: 'greeting', label: 'Default first message inside a ticket', type: 'textarea', hint: 'The embed the opener sees, for every reason that has no message of its own. Placeholders: {user} pings them, {username} is their name, {reason} is the ticket type, {server} is the server name.', def: 'Hey {user}, thanks for reaching out about **{reason}**.\nA team member will claim this ticket soon — meanwhile, describe the problem and add screenshots if you have them.' },
      ],
    },
    {
      key: 'reactionRoles',
      icon: '🔁',
      name: 'Reaction roles',
      blurb: 'Panels where reacting to a message grants a role and un-reacting removes it. Each panel is a channel + a message (bot posts it, or paste an ID of one you posted) + emoji→role pairs.',
      fields: [
        { key: 'enabled', label: 'Enabled', type: 'bool', def: true },
        { key: 'removeOnUnreact', label: 'Remove the role when un-reacting', type: 'bool', def: true },
        { key: 'panels', label: 'Panels', type: 'list', def: [], item: [
          { key: 'name', label: 'Panel name', type: 'text', required: true, max: 50, hint: 'Just for you, in the dashboard.' },
          { key: 'channelId', label: 'Channel', type: 'channel' },
          { key: 'style', label: 'How members pick', type: 'select', def: 'reactions', options: [
            { value: 'reactions', label: 'Reactions (classic)' },
            { value: 'buttons', label: 'Buttons' },
            { value: 'dropdown', label: 'Dropdown menu' },
          ] },
          { key: 'createMode', label: 'Message source', type: 'select', def: 'new', options: [
            { value: 'new', label: 'Bot posts a new message' },
            { value: 'existing', label: 'Use a message you posted' },
          ] },
          { key: 'messageContent', label: 'Message text (bot posts it)', type: 'textarea', hint: 'Your intro line. The emoji → role list below is added underneath automatically, so you do not have to write it out.' },
          { key: 'embedTitle', label: 'Extra embed title (optional)', type: 'text' },
          { key: 'messageId', label: 'Existing message ID', type: 'text', hint: 'Only for “use a message you posted”: right-click the message → Copy Message ID.' },
          { key: 'bindings', label: 'Emoji → role pairs', type: 'list', def: [], item: [
            { key: 'emoji', label: 'Emoji', type: 'emoji', required: true, hint: 'Unicode (🎮) is easiest. Server emoji can be pasted as :name:id.' },
            { key: 'roleId', label: 'Role', type: 'role', required: true },
            { key: 'description', label: 'What this role is', type: 'text', max: 80, hint: 'Shown beside the emoji in the message, and used as the button / dropdown label. Empty = the role name is used.' },
          ] },
        ] },
      ],
    },
    {
      key: 'levels',
      icon: '📶',
      name: 'Levels (XP)',
      blurb: 'Arcane-style levelling: XP per message with a cooldown, a curve you control, a max level, custom level-up messages, and roles granted at levels.',
      fields: [
        { key: 'enabled', label: 'Enabled', type: 'bool', def: true },
        { key: 'xpMin', label: 'XP per message — minimum', type: 'number', def: 5, min: 0, max: 1000 },
        { key: 'xpMax', label: 'XP per message — maximum', type: 'number', def: 15, min: 1, max: 1000, hint: 'Each message grants a random amount between min and max.' },
        { key: 'cooldownSeconds', label: 'Cooldown per user (seconds)', type: 'number', def: 60, min: 0, max: 3600, hint: 'Arcane’s idea: spam shouldn’t farm XP. One XP drop per cooldown.' },
        { key: 'xpBase', label: 'XP for the first level', type: 'number', def: 100, min: 1, max: 100000 },
        { key: 'xpGrowth', label: 'XP multiplier per level', type: 'number', def: 1.4, min: 1.05, max: 3, step: 0.05, hint: 'Level 2 costs base; level 3 costs base × multiplier; and so on.' },
        { key: 'maxLevel', label: 'Max level', type: 'number', def: 100, min: 1, max: 500, hint: 'At max level no more XP is granted.' },
        { key: 'xpMultipliers', label: 'XP multipliers (per role)', type: 'list', def: [], item: [
          { key: 'roleId', label: 'Role', type: 'role', required: true },
          { key: 'percent', label: 'XP multiplier %', type: 'number', def: 100, min: 0, max: 1000, hint: '150 = these members earn 1.5× XP. Multiple roles stack additively.' },
        ] },
        { key: 'voiceXpPerMinute', label: 'XP per minute in voice', type: 'number', def: 0, min: 0, max: 1000, hint: '0 = off. Arcane-style voice XP; no-XP roles still apply.' },
        { key: 'noXpChannelIds', label: 'No-XP channels', type: 'channels', def: [] },
        { key: 'noXpRoleIds', label: 'No-XP roles', type: 'roles', def: [], hint: 'Members holding any of these never gain XP.' },
        { key: 'announceChannelId', label: 'Level-up announcement channel', type: 'channel', hint: 'Empty = announce in the same channel the message came from.' },
        { key: 'announceMessage', label: 'Level-up message', type: 'textarea', def: '{user} just hit **level {level}**! 🎉', hint: 'Placeholders: {user} {username} {level} {server}' },
        { key: 'dmLevelUp', label: 'Also DM the level-up', type: 'bool', def: false },
        { key: 'roleRewards', label: 'Role rewards', type: 'list', def: [], item: [
          { key: 'level', label: 'At level', type: 'number', required: true, min: 1, max: 999 },
          { key: 'roleId', label: 'Role to grant', type: 'role', required: true },
        ] },
        { key: 'rewardMode', label: 'How rewards stack', type: 'select', def: 'stack', options: [
          { value: 'stack', label: 'Stack — keep all earned roles' },
          { value: 'replace', label: 'Replace — only the highest earned role' },
        ] },
      ],
    },
    {
      key: 'automod',
      icon: '🛡️',
      name: 'Auto-moderation',
      blurb: 'Carl-bot-style filters: banned words, invites, links, caps, emoji spam, mention spam, message spam — with a strike ladder (timeout → kick → ban) you control.',
      fields: [
        { key: 'enabled', label: 'Enabled', type: 'bool', def: true },
        { key: 'logChannelId', label: 'Mod-log channel', type: 'channel', hint: 'Empty = the General log channel.' },
        { key: 'exemptChannelIds', label: 'Exempt channels', type: 'channels', def: [] },
        { key: 'exemptRoleIds', label: 'Exempt roles', type: 'roles', def: [] },
        { key: 'bannedWords', label: 'Banned words', type: 'group', def: {}, fields: [
          { key: 'enabled', label: 'Enabled', type: 'bool', def: false },
          { key: 'words', label: 'Word list', type: 'wordlist', def: [], hint: 'One word or phrase per line. 1337-style swaps (a@e:3, o→0) get caught too.' },
          { key: 'action', label: 'Action', type: 'action', def: 'delete+warn' },
        ] },
        { key: 'inviteLinks', label: 'Discord invites', type: 'group', def: {}, fields: [
          { key: 'enabled', label: 'Enabled', type: 'bool', def: false },
          { key: 'allowlist', label: 'Allowed invite codes (one per line)', type: 'wordlist', def: [], hint: 'The code after discord.gg/, e.g. NgCeKeMxAJ — leave empty to block all invites.' },
          { key: 'action', label: 'Action', type: 'action', def: 'delete' },
        ] },
        { key: 'externalLinks', label: 'Any links', type: 'group', def: {}, fields: [
          { key: 'enabled', label: 'Enabled', type: 'bool', def: false },
          { key: 'allowlist', label: 'Allowed domains (one per line)', type: 'wordlist', def: [], hint: 'e.g. youtube.com — subdomains included automatically.' },
          { key: 'action', label: 'Action', type: 'action', def: 'delete' },
        ] },
        { key: 'duplicateMessages', label: 'Duplicate messages', type: 'group', def: {}, fields: [
          { key: 'enabled', label: 'Enabled', type: 'bool', def: false },
          { key: 'withinSeconds', label: 'Same text within seconds', type: 'number', def: 30, min: 2, max: 600 },
          { key: 'action', label: 'Action', type: 'action', def: 'delete+warn' },
        ] },
        { key: 'everyoneMentions', label: '@everyone / @here pings', type: 'group', def: {}, fields: [
          { key: 'enabled', label: 'Enabled (blocks members who CAN ping)', type: 'bool', def: false, hint: 'Members without the permission can never ping anyway; this also stops those who can.' },
          { key: 'action', label: 'Action', type: 'action', def: 'delete+warn' },
        ] },
        { key: 'excessiveCaps', label: 'Excessive CAPS', type: 'group', def: {}, fields: [
          { key: 'enabled', label: 'Enabled', type: 'bool', def: false },
          { key: 'minLength', label: 'Only check messages longer than', type: 'number', def: 12, min: 1, max: 200 },
          { key: 'percent', label: 'Percent of CAPS considered excessive', type: 'number', def: 70, min: 1, max: 100 },
          { key: 'action', label: 'Action', type: 'action', def: 'delete+warn' },
        ] },
        { key: 'excessiveEmojis', label: 'Emoji spam', type: 'group', def: {}, fields: [
          { key: 'enabled', label: 'Enabled', type: 'bool', def: false },
          { key: 'max', label: 'Max emojis per message', type: 'number', def: 8, min: 1, max: 50 },
          { key: 'action', label: 'Action', type: 'action', def: 'delete+warn' },
        ] },
        { key: 'massMentions', label: 'Mention spam', type: 'group', def: {}, fields: [
          { key: 'enabled', label: 'Enabled', type: 'bool', def: false },
          { key: 'max', label: 'Max users mentioned', type: 'number', def: 5, min: 2, max: 50 },
          { key: 'action', label: 'Action', type: 'action', def: 'delete+timeout' },
        ] },
        { key: 'messageSpam', label: 'Fast message spam', type: 'group', def: {}, fields: [
          { key: 'enabled', label: 'Enabled', type: 'bool', def: false },
          { key: 'messages', label: 'Messages', type: 'number', def: 5, min: 2, max: 50 },
          { key: 'withinSeconds', label: 'Within seconds', type: 'number', def: 5, min: 2, max: 120 },
          { key: 'action', label: 'Action', type: 'action', def: 'delete+timeout' },
          { key: 'timeoutMinutes', label: 'Timeout minutes (for timeout actions)', type: 'number', def: 10, min: 1, max: 10080 },
        ] },
        { key: 'timeoutMinutes', label: 'Default timeout minutes', type: 'number', def: 10, min: 1, max: 10080, hint: 'For timeout rules without their own minutes.' },
        { key: 'strikes', label: 'Strike ladder', type: 'group', def: {}, hint: 'Every caught message adds one strike. The ladder escalates automatically.', fields: [
          { key: 'timeoutAt', label: 'Timeout after N strikes', type: 'number', def: 3, min: 1, max: 100 },
          { key: 'timeoutMinutes', label: 'Timeout minutes', type: 'number', def: 60, min: 1, max: 10080 },
          { key: 'kickAt', label: 'Kick after N strikes', type: 'number', def: 0, min: 0, max: 100, hint: '0 = never.' },
          { key: 'banAt', label: 'Ban after N strikes', type: 'number', def: 0, min: 0, max: 100, hint: '0 = never.' },
        ] },
        { key: 'strikeRoles', label: 'Warning roles', type: 'list', def: [], hint: 'Give a role once someone reaches N strikes. They keep only the highest tier they have reached — set one at 1 strike to mark anyone caught at all. The bot must sit ABOVE these roles in the role list.', item: [
          { key: 'strikes', label: 'At how many strikes', type: 'number', def: 1, min: 1, max: 100 },
          { key: 'roleId', label: 'Role', type: 'role', required: true },
        ] },
        { key: 'notifyUser', label: 'Tell the user why a message was removed', type: 'bool', def: true },
      ],
    },
    {
      key: 'welcome',
      icon: '👋',
      name: 'Welcome & goodbye',
      blurb: 'Greet joiners in a channel or DM, hand them an auto role, and wave goodbye. Placeholders: {user} {username} {server} {memberCount}.',
      fields: [
        { key: 'enabled', label: 'Enabled', type: 'bool', def: true },
        { key: 'welcomeChannelId', label: 'Welcome channel', type: 'channel' },
        { key: 'welcomeMessage', label: 'Welcome message', type: 'textarea', def: 'Welcome {user} to **{server}**! You are member #{memberCount}.' },
        { key: 'dmWelcome', label: 'DM message (empty = off)', type: 'textarea', def: '', hint: 'Off unless you write something here. An unasked-for DM is the fastest way to get a bot reported.' },
        { key: 'leaveChannelId', label: 'Goodbye channel', type: 'channel' },
        { key: 'leaveMessage', label: 'Goodbye message', type: 'textarea', def: '{username} left the server. 😔' },
        { key: 'autoroleIds', label: 'Auto role on join', type: 'roles', def: [] },
      ],
    },
  ];

  function defaults() {
    const cfg = {};
    for (const f of FEATURES) {
      cfg[f.key] = {};
      collect(f.fields, cfg[f.key]);
    }
    return cfg;
  }

  function collect(fields, into) {
    for (const field of fields) {
      if (field.type === 'list') {
        into[field.key] = deepCopy(field.def || []);
      } else if (field.type === 'group') {
        collect(field.fields, (into[field.key] = {}));
      } else {
        into[field.key] = field.def !== undefined ? deepCopy(field.def) : typeDefault(field.type);
      }
    }
  }

  function typeDefault(type) {
    switch (type) {
      case 'bool': return false;
      case 'number': return 0;
      case 'channels': case 'roles': return [];
      case 'wordlist': case 'list': return [];
      default: return '';
    }
  }

  function deepCopy(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }

  /**
   * Coerces + validates an incoming (partial) config against the schema.
   * Returns { ok, config, errors } — the result starts from the defaults, so
   * missing keys fall back to defaults automatically; invalid values keep the
   * default and add an error; unknown keys are dropped.
   */
  function validate(input) {
    const config = defaults();
    const errors = [];
    if (input === null || input === undefined) {
      return { ok: true, config, errors: [] };
    }
    if (typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, config, errors: ['config must be a JSON object'] };
    }
    for (const f of FEATURES) {
      validateGroup(f.fields, input[f.key], config[f.key], f.key, errors);
    }
    return { ok: errors.length === 0, config, errors };
  }

  function validateGroup(fields, given, out, path, errors) {
    if (given === undefined || given === null) return; // defaults already in place
    if (typeof given !== 'object' || Array.isArray(given)) {
      errors.push(`${path}: expected an object, got ${Array.isArray(given) ? 'array' : typeof given}`);
      return;
    }
    for (const field of fields) {
      const p = `${path}.${field.key}`;
      const v = given[field.key];
      if (field.type === 'group') {
        validateGroup(field.fields, v, out[field.key], p, errors);
      } else if (field.type === 'list') {
        if (v === undefined) continue;
        const items = listItems(field, v, p, errors);
        if (items !== undefined) out[field.key] = items;
      } else if (v !== undefined) {
        const coerced = coerce(field, v, p, errors);
        if (coerced !== undefined) out[field.key] = coerced;
        // on error: the pre-filled default stays
      }
    }
  }

  /**
   * Validates the items of a list field. Lists nest — a reaction-role panel
   * holds a list of emoji→role pairs — so this has to be callable from
   * coerce() as well as from the top-level walk. Keeping one implementation
   * is the point: the two drifted before, and a nested list came back
   * "unsupported field type" on save.
   */
  function listItems(field, v, p, errors) {
    if (!Array.isArray(v)) {
      errors.push(`${p}: expected a list`);
      return undefined;
    }
    const items = [];
    for (const raw of v.slice(0, 25)) {
      const item = {};
      let broken = false;
      for (const sub of field.item || []) {
        const has = raw !== null && raw !== undefined && Object.prototype.hasOwnProperty.call(raw, sub.key);
        if (!has && !sub.required) {
          item[sub.key] = sub.def !== undefined ? deepCopy(sub.def) : typeDefault(sub.type);
          continue;
        }
        const before = errors.length;
        const coerced = coerce(sub, has ? raw[sub.key] : undefined, `${p}[].${sub.key}`, errors);
        if (coerced !== undefined) item[sub.key] = coerced;
        // A bad entry in a NESTED list has already been dropped on its own;
        // it must not take the whole parent with it. One mistyped emoji→role
        // pair should not delete the panel's channel, style and other pairs.
        if (sub.type !== 'list' && errors.length > before) broken = true;
      }
      if (!broken) items.push(item);
    }
    return items;
  }

  function coerce(field, v, p, errors) {
    const t = field.type;
    const fail = (msg) => { errors.push(`${p}: ${msg}`); return undefined; };
    if (t === 'bool') {
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 1 || v === '1') return true;
      if (v === 'false' || v === 0 || v === '0') return false;
      return fail('expected true/false, got something else');
    }
    if (t === 'number') {
      const n = typeof v === 'number' ? v : parseFloat(v);
      if (!Number.isFinite(n)) return fail('expected a number');
      let clamped = n;
      if (field.min !== undefined && clamped < field.min) clamped = field.min;
      if (field.max !== undefined && clamped > field.max) clamped = field.max;
      if (field.step) clamped = Math.round(clamped / field.step) * field.step;
      return Math.round(clamped * 10000) / 10000;
    }
    if (t === 'text' || t === 'textarea' || t === 'emoji' || t === 'color' || t === 'category' || t === 'guild') {
      if (typeof v !== 'string') return fail('expected text');
      const s = v.trim();
      if (field.required && !s) return fail('required, cannot be empty');
      if (field.max && s.length > field.max) return fail(`keep it under ${field.max} characters`);
      if (t === 'color' && s && !/^#[0-9a-fA-F]{6}$/.test(s)) return fail('expected a hex colour like #5865F2');
      return s;
    }
    if (t === 'channel' || t === 'role') {
      if (v === null || v === undefined || v === '') return '';
      const s = String(v).trim();
      const digits = s.replace(/[<#@&>]/g, '');
      if (!/^[0-9]{15,21}$/.test(digits)) return fail('expected a channel/role ID (15–21 digits) or empty');
      return digits;
    }
    if (t === 'channels' || t === 'roles') {
      if (!Array.isArray(v)) {
        v = String(v === undefined || v === null ? '' : v).split(/[,\s]+/).filter(Boolean);
      }
      const out = [];
      for (const raw of v.slice(0, 50)) {
        if (raw === null || raw === undefined) continue;
        const s = String(raw).trim().replace(/[<#@&>]/g, '');
        if (!s) continue;
        if (!/^[0-9]{15,21}$/.test(s)) return fail(`"${s.slice(0, 30)}" is not a valid ID`);
        if (out.indexOf(s) === -1) out.push(s);
      }
      return out;
    }
    if (t === 'wordlist') {
      const arr = Array.isArray(v) ? v.map(String) : String(v === undefined || v === null ? '' : v).split(/\r?\n/);
      const out = [];
      for (const line of arr.slice(0, 500)) {
        const s = line.trim();
        if (s) out.push(s);
      }
      return out;
    }
    if (t === 'select') {
      const vals = (field.options || []).map((o) => o.value);
      if (vals.indexOf(v) === -1) return fail(`must be one of: ${vals.join(', ')}`);
      return v;
    }
    if (t === 'action') {
      const allowed = ['none', 'delete', 'delete+warn', 'delete+timeout'];
      if (allowed.indexOf(v) === -1) return fail(`action must be one of: ${allowed.join(', ')}`);
      return v;
    }
    if (t === 'list') return listItems(field, v, p, errors);
    return fail('unsupported field type');
  }

  // --- level math (shared with the dashboard preview) -----------------------
  function costToNext(level, base, growth) {
    return Math.max(1, Math.round(base * Math.pow(growth, level)));
  }
  function totalXpForLevel(level, base, growth) {
    let sum = 0;
    for (let i = 0; i < level; i++) sum += costToNext(i, base, growth);
    return sum;
  }
  function levelFromTotalXp(total, base, growth, maxLevel) {
    let level = 0;
    let remaining = total;
    while (level < maxLevel) {
      const cost = costToNext(level, base, growth);
      if (remaining < cost) break;
      remaining -= cost;
      level++;
    }
    return level;
  }

  return { FEATURES, defaults, validate, costToNext, totalXpForLevel, levelFromTotalXp };
});