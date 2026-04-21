import {execFileSync} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';

const root = new URL('..', import.meta.url);
const outPath = new URL('README.md', root);
const typedocDir = new URL('.typedoc/', root);

const ENTRY_POINTS = [
  {
    src: 'server/index.ts',
    json: 'server.json',
    heading: 'mixed-signals/server',
  },
  {
    src: 'client/index.ts',
    json: 'client.json',
    heading: 'mixed-signals/client',
  },
  {
    src: 'codecs/index.ts',
    json: 'codecs.json',
    heading: 'mixed-signals/codecs',
  },
];

// Run typedoc to generate JSON for each entry point
await mkdir(typedocDir, {recursive: true});
for (const entry of ENTRY_POINTS) {
  const jsonPath = new URL(entry.json, typedocDir).pathname;
  const typedoc = new URL('../node_modules/.bin/typedoc', import.meta.url)
    .pathname;
  execFileSync(
    typedoc,
    ['--json', jsonPath, '--excludePrivate', '--excludeInternal', entry.src],
    {
      cwd: root.pathname,
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );
}

const KIND = {
  64: 'Function',
  128: 'Class',
  256: 'Interface',
  2097152: 'Type alias',
};

function typeToString(t) {
  if (!t) return 'unknown';
  if (t.type === 'reference') {
    const args = t.typeArguments?.length
      ? `<${t.typeArguments.map(typeToString).join(', ')}>`
      : '';
    return (t.name || 'reference') + args;
  }
  if (t.type === 'intrinsic') return t.name;
  if (t.type === 'array') return `${typeToString(t.elementType)}[]`;
  if (t.type === 'union') return t.types.map(typeToString).join(' | ');
  if (t.type === 'intersection') return t.types.map(typeToString).join(' & ');
  if (t.type === 'literal') return JSON.stringify(t.value);
  if (t.type === 'reflection') {
    const sig = t.declaration?.signatures?.[0];
    if (sig) return sigToLine(sig);
    const props = t.declaration?.children;
    if (props?.length) {
      const entries = props
        .map(
          (p) =>
            `${p.name}${p.flags?.isOptional ? '?' : ''}: ${typeToString(p.type)}`,
        )
        .join('; ');
      return `{ ${entries} }`;
    }
    return '{ … }';
  }
  if (t.type === 'predicate')
    return `${t.name} is ${typeToString(t.targetType)}`;
  if (t.name) return t.name;
  return t.type || 'unknown';
}

function sigToLine(sig) {
  const params = (sig.parameters || [])
    .map(
      (p) =>
        `${p.name}${p.flags?.isOptional ? '?' : ''}: ${typeToString(p.type)}`,
    )
    .join(', ');
  const ret = typeToString(sig.type);
  return `(${params}) => ${ret}`;
}

function commentText(comment) {
  if (!comment) return '';
  const parts = comment.summary || [];
  return parts
    .map((p) => p.text || '')
    .join('')
    .trim();
}

/**
 * Canonical key for a child member — methods (kind 2048), properties (1024),
 * and constructors (512). Two members sharing this key across interfaces are
 * considered "the same member" and eligible to be factored into a shared
 * base entry.
 */
function memberKey(m) {
  const sig = m.signatures?.[0];
  const sigStr = sig ? sigToLine(sig) : '';
  const sigDoc = commentText(sig?.comment || m.comment);
  const typ = m.type ? typeToString(m.type) : '';
  return `${m.kind}::${m.name}::${sigStr}::${typ}::${sigDoc}`;
}

/**
 * Given a set of interfaces (kind 256), find members that appear identically
 * across 2+ of them and return (a) synthetic "shared base" groups to emit
 * separately, and (b) the set of member keys to exclude from each
 * interface's own rendering.
 *
 * Generic: any interface with members matching another interface's members
 * triggers extraction. The group is keyed by the *set* of interface names it
 * appears in, so A+B share one block, A+C share another, A+B+C share a
 * third — each distinct participation set becomes its own synthesized entry.
 */
function extractSharedBase(interfaces) {
  // memberKey → {member: Node, ifaces: Set<string>}
  const keyIndex = new Map();
  for (const iface of interfaces) {
    for (const child of iface.children || []) {
      if (child.kind !== 2048 && child.kind !== 1024 && child.kind !== 512)
        continue;
      const key = memberKey(child);
      let entry = keyIndex.get(key);
      if (!entry) {
        entry = {member: child, ifaces: new Set()};
        keyIndex.set(key, entry);
      }
      entry.ifaces.add(iface.name);
    }
  }

  // Group keys by the sorted interface-name list they appear in. Any
  // group with 2+ participating interfaces becomes a synthetic entry.
  const groups = new Map();
  for (const [key, {member, ifaces}] of keyIndex) {
    if (ifaces.size < 2) continue;
    const sortedNames = [...ifaces].sort();
    const groupKey = sortedNames.join('|');
    let group = groups.get(groupKey);
    if (!group) {
      group = {ifaces: sortedNames, members: [], keys: new Set()};
      groups.set(groupKey, group);
    }
    group.members.push(member);
    group.keys.add(key);
  }

  // Per-interface exclusion: drop any member whose key got factored out.
  const exclude = new Map();
  for (const group of groups.values()) {
    for (const name of group.ifaces) {
      let set = exclude.get(name);
      if (!set) {
        set = new Set();
        exclude.set(name, set);
      }
      for (const key of group.keys) set.add(key);
    }
  }

  return {groups: [...groups.values()], exclude};
}

/** Render a synthesized "shared by X, Y" entry for a group of common members. */
function renderSharedGroup(group) {
  const lines = [];
  const names = group.ifaces.map((n) => `\`${n}\``).join(', ');
  lines.push(`#### Shared by ${names}`);
  lines.push('');
  lines.push(`- Kind: **Shared base**`);
  emitMembers(lines, group.members);
  lines.push('');
  return lines;
}

/**
 * Emit a children-list block (constructors, methods, properties) with an
 * optional per-key filter. Extracted so `renderNode` and `renderSharedGroup`
 * share the same formatting.
 */
function emitMembers(lines, children, ownerName, excludeKeys) {
  const filter = (c) =>
    !excludeKeys || !excludeKeys.has(memberKey(c));

  const ctors = children.filter((c) => c.kind === 512 && filter(c));
  if (ctors.length) {
    lines.push('- Constructor:');
    for (const c of ctors) {
      for (const sig of c.signatures || []) {
        lines.push(`  - \`new ${ownerName}${sigToLine(sig)}\``);
      }
    }
  }

  const methods = children.filter((c) => c.kind === 2048 && filter(c));
  if (methods.length) {
    lines.push('- Methods:');
    for (const m of methods) {
      const sig = m.signatures?.[0];
      const mDesc = commentText(sig?.comment);
      lines.push(
        `  - \`${m.name}${sig ? sigToLine(sig) : '()'}\`${mDesc ? ' — ' + mDesc : ''}`,
      );
    }
  }

  const props = children.filter((c) => c.kind === 1024 && filter(c));
  if (props.length) {
    lines.push('- Properties:');
    for (const p of props) {
      const pDesc = commentText(p.comment);
      lines.push(
        `  - \`${p.name}: ${typeToString(p.type)}\`${pDesc ? ' — ' + pDesc : ''}`,
      );
    }
  }
}

function renderNode(node, excludeKeys) {
  const lines = [];
  const kind = KIND[node.kind] || 'Value';
  const desc = commentText(node.comment);

  lines.push(`#### \`${node.name}\``);
  lines.push('');
  lines.push(`- Kind: **${kind}**`);
  if (desc) lines.push(`- ${desc}`);

  if (node.signatures?.length) {
    lines.push('- Signatures:');
    for (const sig of node.signatures) {
      const sigDesc = commentText(sig.comment);
      lines.push(`  - \`${sigToLine(sig)}\`${sigDesc ? ' — ' + sigDesc : ''}`);
    }
  }

  emitMembers(lines, node.children || [], node.name, excludeKeys);

  if (node.type) {
    lines.push(`- Type: \`${typeToString(node.type)}\``);
  }

  lines.push('');
  return lines;
}

// Collect exports from each entrypoint, keyed by name → rendered markdown
const entryExports = [];
for (const entry of ENTRY_POINTS) {
  const jsonPath = new URL(entry.json, typedocDir);
  const doc = JSON.parse(await readFile(jsonPath, 'utf8'));
  const exports = (doc.children || []).filter(
    (n) => n.variant === 'declaration' && n.kind !== 4,
  );
  const rendered = new Map();
  for (const node of exports) {
    rendered.set(node.name, renderNode(node).join('\n'));
  }
  entryExports.push({entry, exports, rendered});
}

// Find types that appear identically across multiple entrypoints
const nameCounts = new Map();
for (const {rendered} of entryExports) {
  for (const [name, md] of rendered) {
    const prev = nameCounts.get(name);
    if (!prev) {
      nameCounts.set(name, {md, count: 1});
    } else if (prev.md === md) {
      prev.count++;
    }
  }
}
const sharedNames = new Set(
  [...nameCounts].filter(([, v]) => v.count > 1).map(([k]) => k),
);

const apiLines = [
  '## API',
  '',
  '_Generated from TypeScript declarations._',
  '',
];

/**
 * Emit a set of exports, factoring out any members shared across 2+
 * interfaces in the set into synthesized "Shared by …" entries. Each
 * interface is then rendered with its shared members filtered out.
 */
function emitSection(nodes) {
  const interfaces = nodes.filter((n) => n.kind === 256);
  const {groups, exclude} = extractSharedBase(interfaces);

  // Sort synthetic groups by their stringified iface list for stability.
  const sorted = groups
    .slice()
    .sort((a, b) => a.ifaces.join(',').localeCompare(b.ifaces.join(',')));
  for (const group of sorted) {
    apiLines.push(...renderSharedGroup(group));
  }

  for (const node of nodes) {
    apiLines.push(...renderNode(node, exclude.get(node.name)));
  }
}

// Emit per-entrypoint sections (excluding shared types)
for (const {entry, exports} of entryExports) {
  const specific = exports
    .filter((n) => !sharedNames.has(n.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!specific.length) continue;

  apiLines.push(`### \`${entry.heading}\``, '');
  emitSection(specific);
}

// Emit shared section
if (sharedNames.size) {
  apiLines.push('### Shared', '');
  const sharedNodes = entryExports[0].exports
    .filter((n) => sharedNames.has(n.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  emitSection(sharedNodes);
}

// Preserve authored content above ## API marker
let authored = '# mixed-signals\n\n';
try {
  const existing = await readFile(outPath, 'utf8');
  const marker = /\n## API\b[\s\S]*$/m;
  authored = marker.test(existing)
    ? existing.replace(marker, '').replace(/\s+$/, '') + '\n\n'
    : existing.replace(/\s+$/, '') + '\n\n';
} catch {}

await writeFile(outPath, authored + apiLines.join('\n') + '\n');
console.log('wrote README.md (authored content preserved above ## API)');
