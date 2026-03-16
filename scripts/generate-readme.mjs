import {readFile, writeFile} from 'node:fs/promises';

const outPath = new URL('../README.md', import.meta.url);

const ENTRY_POINTS = [
  {json: '../.typedoc/server.json', heading: 'signal-wire/server'},
  {json: '../.typedoc/client.json', heading: 'signal-wire/client'},
];

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
        .map((p) => `${p.name}${p.flags?.isOptional ? '?' : ''}: ${typeToString(p.type)}`)
        .join('; ');
      return `{ ${entries} }`;
    }
    return '{ … }';
  }
  if (t.type === 'predicate') return `${t.name} is ${typeToString(t.targetType)}`;
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
  return parts.map((p) => p.text || '').join('').trim();
}

const apiLines = ['## API', '', '_Generated from TypeScript declarations._', ''];

for (const entry of ENTRY_POINTS) {
  const jsonPath = new URL(entry.json, import.meta.url);
  const doc = JSON.parse(await readFile(jsonPath, 'utf8'));
  const exports = (doc.children || []).filter(
    (n) => n.variant === 'declaration' && n.kind !== 4,
  );

  apiLines.push(`### \`${entry.heading}\``, '');

  for (const node of exports.sort((a, b) => a.name.localeCompare(b.name))) {
    const kind = KIND[node.kind] || 'Value';
    const desc = commentText(node.comment);

    apiLines.push(`#### \`${node.name}\``);
    apiLines.push('');
    apiLines.push(`- Kind: **${kind}**`);
    if (desc) apiLines.push(`- ${desc}`);

    if (node.signatures?.length) {
      apiLines.push('- Signatures:');
      for (const sig of node.signatures) {
        const sigDesc = commentText(sig.comment);
        apiLines.push(`  - \`${sigToLine(sig)}\`${sigDesc ? ' — ' + sigDesc : ''}`);
      }
    }

    const ctors = (node.children || []).filter((c) => c.kind === 512);
    if (ctors.length) {
      apiLines.push('- Constructor:');
      for (const c of ctors) {
        for (const sig of c.signatures || []) {
          apiLines.push(`  - \`new ${node.name}${sigToLine(sig)}\``);
        }
      }
    }

    const methods = (node.children || []).filter((c) => c.kind === 2048);
    if (methods.length) {
      apiLines.push('- Methods:');
      for (const m of methods) {
        const sig = m.signatures?.[0];
        const mDesc = commentText(sig?.comment);
        apiLines.push(
          `  - \`${m.name}${sig ? sigToLine(sig) : '()'}\`${mDesc ? ' — ' + mDesc : ''}`,
        );
      }
    }

    const props = (node.children || []).filter((c) => c.kind === 1024);
    if (props.length) {
      apiLines.push('- Properties:');
      for (const p of props) {
        const pDesc = commentText(p.comment);
        apiLines.push(
          `  - \`${p.name}: ${typeToString(p.type)}\`${pDesc ? ' — ' + pDesc : ''}`,
        );
      }
    }

    if (node.type) {
      apiLines.push(`- Type: \`${typeToString(node.type)}\``);
    }

    apiLines.push('');
  }
}

// Preserve authored content above ## API marker
let authored = '# signal-wire\n\n';
try {
  const existing = await readFile(outPath, 'utf8');
  const marker = /\n## API\b[\s\S]*$/m;
  authored = marker.test(existing)
    ? existing.replace(marker, '').replace(/\s+$/, '') + '\n\n'
    : existing.replace(/\s+$/, '') + '\n\n';
} catch {}

await writeFile(outPath, authored + apiLines.join('\n') + '\n');
console.log('wrote README.md (authored content preserved above ## API)');
