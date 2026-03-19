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

function renderNode(node) {
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
      lines.push(
        `  - \`${sigToLine(sig)}\`${sigDesc ? ' — ' + sigDesc : ''}`,
      );
    }
  }

  const ctors = (node.children || []).filter((c) => c.kind === 512);
  if (ctors.length) {
    lines.push('- Constructor:');
    for (const c of ctors) {
      for (const sig of c.signatures || []) {
        lines.push(`  - \`new ${node.name}${sigToLine(sig)}\``);
      }
    }
  }

  const methods = (node.children || []).filter((c) => c.kind === 2048);
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

  const props = (node.children || []).filter((c) => c.kind === 1024);
  if (props.length) {
    lines.push('- Properties:');
    for (const p of props) {
      const pDesc = commentText(p.comment);
      lines.push(
        `  - \`${p.name}: ${typeToString(p.type)}\`${pDesc ? ' — ' + pDesc : ''}`,
      );
    }
  }

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

// Emit per-entrypoint sections (excluding shared types)
for (const {entry, exports} of entryExports) {
  const specific = exports
    .filter((n) => !sharedNames.has(n.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!specific.length) continue;

  apiLines.push(`### \`${entry.heading}\``, '');
  for (const node of specific) {
    apiLines.push(...renderNode(node));
  }
}

// Emit shared section
if (sharedNames.size) {
  apiLines.push('### Shared', '');
  const sharedNodes = entryExports[0].exports
    .filter((n) => sharedNames.has(n.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const node of sharedNodes) {
    apiLines.push(...renderNode(node));
  }
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
