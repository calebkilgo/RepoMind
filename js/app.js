/*
 * Pipeline: GitHub REST API → tree-sitter (WASM) → graphology → ForceAtlas2 → Sigma.js (WebGL)
 *
 * graphology, sigma, and graphology-library are loaded as UMD globals via <script> tags in
 * index.html. Loading them via esm.sh causes "Class constructor E cannot be invoked without 'new'"
 * on some repos due to default-export wrapping. web-tree-sitter loads as an ES module here
 * because it side-loads a WASM binary and needs module semantics to resolve its locateFile hook.
 */

import Parser from 'https://esm.sh/web-tree-sitter@0.20.8';

function showStartupError(msg) {
  const banner = document.getElementById('error-banner');
  const text = document.getElementById('error-text');
  if (banner && text) {
    text.textContent = msg;
    banner.classList.remove('rm-hide');
  }
  console.error('[RepoMind startup]', msg);
}

if (!window.graphology || !window.graphology.Graph) {
  showStartupError('Failed to load graphology library. Check your network connection or CDN availability.');
  throw new Error('graphology not loaded');
}
if (!window.Sigma) {
  showStartupError('Failed to load Sigma.js. Check your network connection or CDN availability.');
  throw new Error('Sigma not loaded');
}
if (!window.graphologyLibrary || !window.graphologyLibrary.layoutForceAtlas2) {
  showStartupError('Failed to load ForceAtlas2 layout. Check your network connection or CDN availability.');
  throw new Error('graphologyLibrary.layoutForceAtlas2 not loaded');
}

const Graph = window.graphology.Graph;
const Sigma = window.Sigma;
const forceAtlas2 = window.graphologyLibrary.layoutForceAtlas2;

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const STATE = {
  repos: [],
  graph: null,
  sigma: null,
  selected: null,
  parsers: {},
  maxFiles: 400,
  token: '',
  _neighborhood: null,
  _resultSet: null,
};

const LANG_BY_EXT = {
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'tsx',
  '.py': 'python',
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp',
};

const WASM_URLS = {
  javascript: 'https://unpkg.com/tree-sitter-wasms@0.1.12/out/tree-sitter-javascript.wasm',
  typescript: 'https://unpkg.com/tree-sitter-wasms@0.1.12/out/tree-sitter-typescript.wasm',
  tsx:        'https://unpkg.com/tree-sitter-wasms@0.1.12/out/tree-sitter-tsx.wasm',
  python:     'https://unpkg.com/tree-sitter-wasms@0.1.12/out/tree-sitter-python.wasm',
  c:          'https://unpkg.com/tree-sitter-wasms@0.1.12/out/tree-sitter-c.wasm',
  cpp:        'https://unpkg.com/tree-sitter-wasms@0.1.12/out/tree-sitter-cpp.wasm',
};
const TREE_SITTER_CORE_WASM = 'https://unpkg.com/web-tree-sitter@0.20.8/tree-sitter.wasm';

const COLOR = {
  dir: '#86c888',
  file: '#89b4fa',
  class: '#c58afa',
  function: '#f0b866',
  repo: '#e2e2e8',
};
const KIND_ICON = {
  dir: 'folder',
  file: 'description',
  class: 'data_object',
  function: 'functions',
  repo: 'hub',
};

function setLoader(phase, detail) {
  $('#loader-phase').textContent = phase;
  if (detail !== undefined) $('#loader-detail').textContent = detail;
}
function showLoader(show) { $('#loader').classList.toggle('rm-hide', !show); }
function showHero(show) { $('#hero').classList.toggle('rm-hide', !show); }
function setError(msg) {
  const b = $('#error-banner');
  if (msg) {
    $('#error-text').textContent = msg;
    b.classList.remove('rm-hide');
  } else {
    b.classList.add('rm-hide');
  }
}
function setTopStat({ mode, nodes, edges }) {
  if (mode !== undefined) $('#stat-mode-text').textContent = mode;
  if (nodes !== undefined) $('#num-nodes').textContent = nodes;
  if (edges !== undefined) $('#num-edges').textContent = edges;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function parseRepoUrl(u) {
  u = u.trim()
    .replace(/^https?:\/\//, '')
    .replace(/^github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
  const [owner, name] = u.split('/');
  if (!owner || !name) throw new Error(`Invalid URL: ${u}`);
  return { owner, name: name.split('/')[0] };
}

async function ghFetch(url) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (STATE.token) headers.Authorization = `Bearer ${STATE.token}`;
  const r = await fetch(url, { headers });
  if (!r.ok) {
    if (r.status === 403 || r.status === 429) {
      throw new Error(
        STATE.token
          ? 'GitHub rate limit exceeded even with a token. Wait an hour or use a different token.'
          : 'GitHub rate limit hit (60 req/hour without a token). Click the icon next to the token field to create a free one — it raises the limit to 5000/hour. The token stays in your browser.'
      );
    }
    if (r.status === 404) throw new Error('Repository not found. Check the URL.');
    throw new Error(`GitHub returned ${r.status}`);
  }
  return r.json();
}

async function fetchRepoFiles(owner, name, maxFiles) {
  const meta = await ghFetch(`https://api.github.com/repos/${owner}/${name}`);
  const branch = meta.default_branch || 'main';
  const tree = await ghFetch(`https://api.github.com/repos/${owner}/${name}/git/trees/${branch}?recursive=1`);

  const parseable = tree.tree
    .filter(e => e.type === 'blob')
    .filter(e => !isSkipped(e.path))
    .filter(e => extOf(e.path) in LANG_BY_EXT)
    .map(e => ({ ...e, score: pathScore(e.path), ext: extOf(e.path) }));

  parseable.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  const chosen = parseable.slice(0, maxFiles);

  const BATCH = 8;
  const out = [];
  for (let i = 0; i < chosen.length; i += BATCH) {
    const batch = chosen.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (entry) => {
      try {
        const blob = await ghFetch(`https://api.github.com/repos/${owner}/${name}/git/blobs/${entry.sha}`);
        if (blob.encoding !== 'base64') return null;
        let content;
        try { content = atob(blob.content.replace(/\n/g, '')); } catch { return null; }
        if (content.length > 400_000) return null;
        return { path: entry.path, content, ext: entry.ext, lang: LANG_BY_EXT[entry.ext] };
      } catch { return null; }
    }));
    for (const r of results) if (r) out.push(r);
    setLoader('Fetching source', `${out.length} of ${chosen.length} files`);
  }
  return { owner, name, branch, files: out };
}

function extOf(p) {
  const m = p.match(/\.[a-zA-Z0-9]+$/);
  return m ? m[0].toLowerCase() : '';
}
function isSkipped(p) {
  const parts = p.split('/');
  const skipDirs = new Set([
    'node_modules','dist','build','vendor','third_party','test','tests',
    '__tests__','fixtures','examples','example','docs','doc','.git','.github','generated',
  ]);
  for (const part of parts.slice(0, -1)) {
    if (skipDirs.has(part.toLowerCase())) return true;
    if (part.startsWith('.')) return true;
  }
  if (/\.(min|bundle)\.js$/.test(p)) return true;
  if (/\.(test|spec)\.(js|ts|tsx|jsx|py)$/.test(p)) return true;
  return false;
}
function pathScore(p) {
  let s = 0;
  if (/^src\//.test(p) || /\/src\//.test(p)) s += 10;
  if (/^lib\//.test(p) || /\/lib\//.test(p)) s += 6;
  if (/^packages\//.test(p)) s += 5;
  if (/^app\//.test(p)) s += 4;
  if (/\.d\.ts$/.test(p)) s -= 5;
  if (p.split('/').length <= 2) s += 2;
  return s;
}

let TS_READY = false;
async function initTreeSitter() {
  if (TS_READY) return;
  await Parser.init({
    locateFile: (name) => name.endsWith('.wasm') ? TREE_SITTER_CORE_WASM : name,
  });
  TS_READY = true;
}
async function loadParser(lang) {
  if (STATE.parsers[lang]) return STATE.parsers[lang];
  const Lang = await Parser.Language.load(WASM_URLS[lang]);
  const parser = new Parser();
  parser.setLanguage(Lang);
  STATE.parsers[lang] = parser;
  return parser;
}

function extractSymbols(tree, content, lang) {
  const symbols = [];
  const imports = [];
  const calls = [];
  function text(node) { return content.slice(node.startIndex, node.endIndex); }
  function nameOf(node) {
    const n = node.childForFieldName ? node.childForFieldName('name') : null;
    return n ? text(n) : null;
  }
  function walk(node, scope) {
    const t = node.type;
    let newScope = scope;

    if (lang === 'javascript' || lang === 'typescript' || lang === 'tsx') {
      if (t === 'import_statement' || t === 'import_declaration') {
        const txt = text(node);
        const m = txt.match(/from\s+['"`]([^'"`]+)['"`]/) || txt.match(/import\s+['"`]([^'"`]+)['"`]/);
        if (m) imports.push({ target: m[1] });
      }
      if (t === 'call_expression') {
        const fn = node.childForFieldName?.('function');
        if (fn) {
          const m = text(fn).match(/([\w$]+)\s*$/);
          if (m) calls.push({ from: scope, to: m[1] });
        }
      }
      if (t === 'class_declaration' || t === 'class') {
        const nm = nameOf(node);
        if (nm) { symbols.push({ kind: 'class', name: nm, line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 }); newScope = nm; }
      }
      if (t === 'function_declaration' || t === 'function' || t === 'generator_function_declaration' ||
          t === 'arrow_function' || t === 'function_expression' || t === 'method_definition') {
        let nm = nameOf(node);
        if (!nm && node.parent?.type === 'variable_declarator') nm = nameOf(node.parent);
        if (!nm && node.parent?.type === 'pair') {
          const k = node.parent.childForFieldName?.('key');
          if (k) nm = text(k);
        }
        if (nm && nm.length < 80) {
          symbols.push({ kind: 'function', name: nm, line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 });
          newScope = nm;
        }
      }
    }

    if (lang === 'python') {
      if (t === 'import_statement' || t === 'import_from_statement') {
        const txt = text(node);
        const m = txt.match(/^\s*from\s+([\w\.]+)/) || txt.match(/^\s*import\s+([\w\.]+)/);
        if (m) imports.push({ target: m[1] });
      }
      if (t === 'class_definition') {
        const nm = nameOf(node);
        if (nm) { symbols.push({ kind: 'class', name: nm, line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 }); newScope = nm; }
      }
      if (t === 'function_definition') {
        const nm = nameOf(node);
        if (nm) { symbols.push({ kind: 'function', name: nm, line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 }); newScope = nm; }
      }
      if (t === 'call') {
        const fn = node.childForFieldName?.('function');
        if (fn) {
          const m = text(fn).match(/([A-Za-z_][\w]*)\s*$/);
          if (m) calls.push({ from: scope, to: m[1] });
        }
      }
    }

    if (lang === 'c' || lang === 'cpp') {
      if (t === 'preproc_include') {
        const m = text(node).match(/#\s*include\s*[<"]([^>"]+)[>"]/);
        if (m) imports.push({ target: m[1] });
      }
      if (t === 'class_specifier' || t === 'struct_specifier') {
        const nm = nameOf(node);
        if (nm) { symbols.push({ kind: 'class', name: nm, line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 }); newScope = nm; }
      }
      if (t === 'function_definition') {
        const decl = node.childForFieldName?.('declarator');
        let nm = null;
        if (decl) {
          const m = text(decl).match(/(?:::)?([A-Za-z_][\w]*)\s*\(/);
          if (m) nm = m[1];
        }
        if (nm) { symbols.push({ kind: 'function', name: nm, line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 }); newScope = nm; }
      }
      if (t === 'call_expression') {
        const fn = node.childForFieldName?.('function');
        if (fn) {
          const m = text(fn).match(/([A-Za-z_][\w]*)\s*$/);
          if (m) calls.push({ from: scope, to: m[1] });
        }
      }
    }

    const cc = node.childCount;
    for (let i = 0; i < cc; i++) walk(node.child(i), newScope || scope);
  }
  walk(tree.rootNode, null);
  return { symbols, imports, calls };
}

function buildGraph(repos) {
  const g = new Graph({ multi: false, type: 'directed' });

  for (const repo of repos) {
    const repoId = `repo:${repo.id}`;
    g.addNode(repoId, {
      label: `${repo.owner}/${repo.name}`,
      kind: 'repo', repoId: repo.id, repoOwner: repo.owner, repoName: repo.name,
      size: 14, color: COLOR.repo,
      x: repo.id === 'A' ? -200 : 200, y: 0,
    });

    const dirSet = new Set();
    for (const f of repo.files) {
      const parts = f.path.split('/');
      for (let i = 1; i < parts.length; i++) dirSet.add(parts.slice(0, i).join('/'));
    }
    for (const d of dirSet) {
      const id = `${repo.id}::dir::${d}`;
      g.addNode(id, {
        label: d.split('/').pop(), fullLabel: d, kind: 'dir', repoId: repo.id, path: d,
        size: 4 + Math.min(8, d.split('/').length),
        color: COLOR.dir, x: Math.random() * 100 - 50, y: Math.random() * 100 - 50,
      });
      const parent = d.includes('/') ? d.split('/').slice(0, -1).join('/') : null;
      const parentId = parent ? `${repo.id}::dir::${parent}` : repoId;
      if (g.hasNode(parentId) && !g.hasEdge(parentId, id)) {
        g.addEdge(parentId, id, { kind: 'contains', color: 'rgba(134,200,136,0.15)', size: 0.5 });
      }
    }

    const fileIdByPath = new Map();
    const nameIndex = new Map();

    for (const f of repo.files) {
      const id = `${repo.id}::file::${f.path}`;
      fileIdByPath.set(f.path, id);
      g.addNode(id, {
        label: f.path.split('/').pop(), fullLabel: f.path,
        kind: 'file', repoId: repo.id, path: f.path, ext: f.ext, lang: f.lang,
        size: 5, color: COLOR.file,
        x: Math.random() * 100 - 50, y: Math.random() * 100 - 50,
        sourcePreview: f.content.slice(0, 3000),
      });
      const dirPath = f.path.includes('/') ? f.path.split('/').slice(0, -1).join('/') : null;
      const dirId = dirPath ? `${repo.id}::dir::${dirPath}` : repoId;
      if (g.hasNode(dirId)) {
        g.addEdge(dirId, id, { kind: 'contains', color: 'rgba(134,200,136,0.15)', size: 0.5 });
      }

      if (f.parsed) {
        for (const s of f.parsed.symbols) {
          const sid = `${repo.id}::sym::${f.path}::${s.kind}::${s.name}::${s.line}`;
          if (g.hasNode(sid)) continue;
          g.addNode(sid, {
            label: s.name, fullLabel: `${s.name} (${f.path}:${s.line})`,
            kind: s.kind, repoId: repo.id, path: f.path, line: s.line, endLine: s.endLine,
            size: s.kind === 'class' ? 6 : 4,
            color: COLOR[s.kind] || COLOR.function,
            x: Math.random() * 100 - 50, y: Math.random() * 100 - 50,
            symbolName: s.name,
          });
          g.addEdge(id, sid, { kind: 'contains', color: 'rgba(134,200,136,0.08)', size: 0.4 });
          if (!nameIndex.has(s.name)) nameIndex.set(s.name, []);
          nameIndex.get(s.name).push(sid);
        }
      }
    }

    for (const f of repo.files) {
      if (!f.parsed) continue;
      const fromId = fileIdByPath.get(f.path);
      for (const imp of f.parsed.imports) {
        const resolved = resolveImport(imp.target, f.path, fileIdByPath);
        if (resolved && resolved !== fromId && !g.hasEdge(fromId, resolved)) {
          g.addEdge(fromId, resolved, { kind: 'imports', color: 'rgba(137,180,250,0.35)', size: 0.8 });
        }
      }
    }

    for (const f of repo.files) {
      if (!f.parsed) continue;
      for (const call of f.parsed.calls) {
        if (!call.from || !call.to) continue;
        const srcIds = (nameIndex.get(call.from) || []).filter(id => g.getNodeAttribute(id, 'path') === f.path);
        const dstIds = nameIndex.get(call.to) || [];
        for (const s of srcIds) {
          for (const d of dstIds) {
            if (s !== d && !g.hasEdge(s, d)) {
              g.addEdge(s, d, { kind: 'calls', color: 'rgba(240,184,102,0.3)', size: 0.6 });
            }
          }
        }
      }
    }

    repo.fileIdByPath = fileIdByPath;
    repo.nameIndex = nameIndex;
  }

  if (repos.length > 1) {
    const [rA, rB] = repos;
    for (const repo of repos) {
      const other = repo === rA ? rB : rA;
      for (const f of repo.files) {
        if (!f.parsed) continue;
        const fromId = repo.fileIdByPath.get(f.path);
        for (const imp of f.parsed.imports) {
          if (imp.target.includes(other.name) || imp.target.includes(`${other.owner}/${other.name}`)) {
            const otherRepoNode = `repo:${other.id}`;
            if (g.hasNode(otherRepoNode) && !g.hasEdge(fromId, otherRepoNode)) {
              g.addEdge(fromId, otherRepoNode, { kind: 'cross-repo', color: 'rgba(235,114,114,0.6)', size: 1.2 });
            }
          }
        }
      }
    }
  }

  return g;
}

function resolveImport(target, fromPath, fileIdByPath) {
  if (target.startsWith('.')) {
    const fromDir = fromPath.includes('/') ? fromPath.split('/').slice(0, -1).join('/') : '';
    const joined = normalizePath(fromDir + '/' + target);
    const tries = [
      joined, joined + '.js', joined + '.jsx', joined + '.ts', joined + '.tsx',
      joined + '.py', joined + '/index.js', joined + '/index.ts', joined + '/index.tsx',
      joined + '/__init__.py',
    ];
    for (const p of tries) if (fileIdByPath.has(p)) return fileIdByPath.get(p);
    return null;
  }
  for (const [p, id] of fileIdByPath) {
    if (p === target || p.endsWith('/' + target)) return id;
    for (const ext of ['.js','.jsx','.ts','.tsx','.py']) {
      if (p === target + ext || p.endsWith('/' + target + ext)) return id;
    }
  }
  return null;
}
function normalizePath(p) {
  const parts = p.split('/').filter(Boolean);
  const out = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return out.join('/');
}

function layoutAndRender(graph) {
  setLoader('Computing layout', 'ForceAtlas2');

  const byRepoA = [], byRepoB = [], byRepoN = [];
  graph.forEachNode((n, a) => {
    if (a.repoId === 'A') byRepoA.push(n);
    else if (a.repoId === 'B') byRepoB.push(n);
    else byRepoN.push(n);
  });
  const seed = (ids, cx) => {
    const n = ids.length;
    ids.forEach((id, i) => {
      const angle = (i / n) * Math.PI * 2;
      const r = 40 + Math.sqrt(i) * 8;
      graph.setNodeAttribute(id, 'x', cx + Math.cos(angle) * r);
      graph.setNodeAttribute(id, 'y', Math.sin(angle) * r);
    });
  };
  if (byRepoB.length > 0) { seed(byRepoA, -200); seed(byRepoB, 200); }
  else seed(byRepoA.concat(byRepoN), 0);

  const iterations = Math.min(400, Math.max(120, Math.floor(30000 / Math.max(1, graph.order))));
  forceAtlas2.assign(graph, {
    iterations,
    settings: {
      gravity: 0.5,
      scalingRatio: 10,
      barnesHutOptimize: graph.order > 1000,
      barnesHutTheta: 0.5,
      adjustSizes: true,
      slowDown: 4,
    },
  });

  if (STATE.sigma) { STATE.sigma.kill(); STATE.sigma = null; }
  STATE.sigma = new Sigma(graph, $('#sigma-container'), {
    renderEdgeLabels: false,
    defaultEdgeColor: 'rgba(255,255,255,0.06)',
    labelColor: { color: '#c3c6d2' },
    labelFont: 'Inter, system-ui, sans-serif',
    labelSize: 12,
    labelWeight: '500',
    labelDensity: 0.4,
    labelGridCellSize: 100,
    labelRenderedSizeThreshold: 5,
    minCameraRatio: 0.03,
    maxCameraRatio: 10,
    zIndex: true,
  });

  STATE.sigma.on('clickNode', ({ node }) => selectNode(node));
  STATE.sigma.on('clickStage', () => selectNode(null));

  const tip = $('#tooltip');
  STATE.sigma.on('enterNode', ({ node }) => {
    const a = graph.getNodeAttributes(node);
    $('#tip-name').textContent = a.fullLabel || a.label;
    $('#tip-kind').textContent = `${a.kind}${a.repoId ? ' · ' + a.repoId : ''}`;
    tip.style.display = 'block';
  });
  STATE.sigma.on('leaveNode', () => { tip.style.display = 'none'; });
  document.addEventListener('mousemove', (e) => {
    if (tip.style.display === 'block') {
      tip.style.left = (e.clientX + 14) + 'px';
      tip.style.top = (e.clientY + 14) + 'px';
    }
  });

  STATE.sigma.setSetting('nodeReducer', nodeReducer);
  STATE.sigma.setSetting('edgeReducer', edgeReducer);

  showHero(false);
  showLoader(false);
  $('#canvas-controls').classList.remove('rm-hide');
  $('#canvas-legend').classList.remove('rm-hide');
  setTopStat({ nodes: graph.order, edges: graph.size });
}

function nodeReducer(node, data) {
  const out = { ...data };
  const active = getActiveKinds();
  if (data.kind && data.kind !== 'repo' && !active.has(data.kind)) out.hidden = true;
  if (STATE.selected) {
    const nb = STATE._neighborhood || new Set();
    if (node === STATE.selected) {
      out.size = (data.size || 5) * 1.6; out.zIndex = 10;
    } else if (!nb.has(node)) {
      out.color = 'rgba(130,138,155,0.2)'; out.label = '';
    }
  }
  if (STATE._resultSet && !STATE._resultSet.has(node) && !STATE.selected) {
    out.color = 'rgba(130,138,155,0.2)'; out.label = '';
  }
  if (STATE.graph) {
    const deg = STATE.graph.degree(node);
    out.size = Math.max(out.size || 4, Math.min(14, 3 + Math.sqrt(deg) * 1.2));
  }
  return out;
}
function edgeReducer(edge, data) {
  const out = { ...data };
  if (STATE.selected) {
    const [s, t] = STATE.graph.extremities(edge);
    if (s !== STATE.selected && t !== STATE.selected) {
      out.color = 'rgba(130,138,155,0.04)';
    } else {
      out.color =
        data.kind === 'calls' ? 'rgba(240,184,102,0.9)' :
        data.kind === 'imports' ? 'rgba(137,180,250,0.9)' :
        data.kind === 'cross-repo' ? 'rgba(235,114,114,1)' :
        'rgba(134,200,136,0.6)';
      out.size = (data.size || 1) * 2;
    }
  }
  return out;
}
function getActiveKinds() {
  const s = new Set();
  $$('.f-kind').forEach(cb => { if (cb.checked) s.add(cb.value); });
  s.add('repo');
  return s;
}

function selectNode(id) {
  STATE.selected = id;
  if (id && STATE.graph) {
    const nb = new Set([id]);
    STATE.graph.forEachNeighbor(id, n => nb.add(n));
    STATE._neighborhood = nb;
  } else {
    STATE._neighborhood = null;
  }
  renderInspector(id);
  if (STATE.sigma) STATE.sigma.refresh();
}

// Selects and pans the camera to a node. Uses Sigma's normalized
// display coordinates — passing raw graph coords to camera.animate()
// sends the camera off-screen.
function focusNode(id) {
  if (!id || !STATE.graph || !STATE.graph.hasNode(id) || !STATE.sigma) return;
  selectNode(id);
  const displayPos = STATE.sigma.getNodeDisplayData(id);
  if (!displayPos) return;
  STATE.sigma.getCamera().animate(
    { x: displayPos.x, y: displayPos.y, ratio: 0.3 },
    { duration: 500 }
  );
}

function kindColor(k) { return COLOR[k] || COLOR.function; }

function renderInspector(id) {
  const box = $('#inspector');
  if (!id || !STATE.graph || !STATE.graph.hasNode(id)) {
    box.innerHTML = `
      <div class="flex flex-col items-center justify-center h-full min-h-[300px] p-10 text-center gap-3">
        <span class="material-symbols-outlined text-[32px] text-on-surface-variant/40">ads_click</span>
        <div class="font-headline text-sm font-medium text-on-surface">Nothing selected</div>
        <p class="text-xs text-on-surface-variant/60 leading-relaxed">Click any node in the graph to inspect its connections, source, and metadata.</p>
      </div>`;
    return;
  }
  const a = STATE.graph.getNodeAttributes(id);
  const inE = STATE.graph.inEdges(id);
  const outE = STATE.graph.outEdges(id);

  const groupBy = (edges, dir) => {
    const g = {};
    for (const e of edges) {
      const ea = STATE.graph.getEdgeAttributes(e);
      const other = dir === 'in' ? STATE.graph.source(e) : STATE.graph.target(e);
      if (!g[ea.kind]) g[ea.kind] = [];
      g[ea.kind].push(other);
    }
    return g;
  };
  const outG = groupBy(outE, 'out');
  const inG = groupBy(inE, 'in');

  const kindLabel = { contains: 'Contains', imports: 'Imports', calls: 'Calls', 'cross-repo': 'Cross-repo link' };
  const kindLabelIn = { contains: 'Contained by', imports: 'Imported by', calls: 'Called by', 'cross-repo': 'Linked from' };

  const sectionHtml = (groups, labels, direction) => {
    const keys = Object.keys(groups);
    if (keys.length === 0) return '';
    return keys.map(k => {
      const items = groups[k].slice(0, 30);
      const more = groups[k].length > 30 ? groups[k].length - 30 : 0;
      return `
        <section class="flex flex-col gap-3">
          <div class="flex items-center justify-between border-b border-outline-variant/10 pb-2">
            <h3 class="font-headline text-xs font-semibold uppercase tracking-widest text-on-surface-variant">${direction} — ${escapeHtml(labels[k] || k)}</h3>
            <span class="text-[0.65rem] font-mono text-on-surface-variant/60">${groups[k].length}</span>
          </div>
          <div class="flex flex-col gap-1">
            ${items.map(n => {
              const oa = STATE.graph.getNodeAttributes(n);
              const icon = KIND_ICON[oa.kind] || 'circle';
              return `
                <div class="edge-item flex items-center gap-2 p-2 rounded-lg hover:bg-surface-container-low cursor-pointer transition-colors group" data-node="${escapeHtml(n)}">
                  <span class="material-symbols-outlined text-[14px]" style="color:${kindColor(oa.kind)}">${icon}</span>
                  <span class="font-mono text-xs text-on-surface group-hover:text-primary-container transition-colors truncate flex-1">${escapeHtml(oa.label || n)}</span>
                  <span class="text-[0.6rem] text-on-surface-variant/60">${escapeHtml(oa.kind || '')}</span>
                </div>`;
            }).join('')}
            ${more ? `<div class="text-[0.65rem] text-on-surface-variant/60 px-2 pt-1">+${more} more</div>` : ''}
          </div>
        </section>`;
    }).join('');
  };

  const badgeClass = {
    function: 'bg-[#f0b866]/10 text-[#f0b866] border-[#f0b866]/30',
    class: 'bg-[#c58afa]/10 text-[#c58afa] border-[#c58afa]/30',
    file: 'bg-[#89b4fa]/10 text-[#89b4fa] border-[#89b4fa]/30',
    dir: 'bg-[#86c888]/10 text-[#86c888] border-[#86c888]/30',
    repo: 'bg-on-surface/10 text-on-surface border-on-surface/30',
  }[a.kind] || 'bg-surface-container-high text-on-surface-variant border-outline-variant/20';

  let html = `
    <div class="p-6 border-b border-[#333539]/20 flex flex-col gap-4">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="px-1.5 py-0.5 rounded-DEFAULT text-[0.6rem] font-mono uppercase tracking-widest font-bold border ${badgeClass}">${escapeHtml(a.kind)}</span>
        ${a.repoId ? `<span class="px-1.5 py-0.5 rounded-DEFAULT bg-surface-container-high text-on-surface-variant text-[0.6rem] font-mono font-medium border border-outline-variant/20">${escapeHtml(a.repoOwner ? `${a.repoOwner}/${a.repoName}` : a.repoId)}</span>` : ''}
      </div>
      <h2 class="font-mono text-lg font-bold text-on-surface break-words leading-tight">${escapeHtml(a.label)}</h2>
      ${a.path ? `
        <div class="flex items-center gap-2 text-on-surface-variant/80 font-mono text-xs bg-surface-container-low px-2 py-1.5 rounded-lg border border-outline-variant/10">
          <span class="material-symbols-outlined text-[14px]">description</span>
          <span class="truncate">${escapeHtml(a.path)}${a.line ? `:${a.line}${a.endLine && a.endLine !== a.line ? `–${a.endLine}` : ''}` : ''}</span>
        </div>` : ''}
    </div>
    <div class="px-6 py-6 flex flex-col gap-8">
      ${sectionHtml(outG, kindLabel, 'Outgoing')}
      ${sectionHtml(inG, kindLabelIn, 'Incoming')}
  `;

  if (a.sourcePreview) {
    const preview = a.sourcePreview.split('\n').slice(0, 40).join('\n');
    const repo = STATE.repos.find(r => r.id === a.repoId);
    const ghUrl = repo ? `https://github.com/${repo.owner}/${repo.name}/blob/${repo.branch}/${a.path}${a.line ? `#L${a.line}` : ''}` : null;
    html += `
      <section class="flex flex-col gap-3">
        <div class="flex items-center justify-between border-b border-outline-variant/10 pb-2">
          <h3 class="font-headline text-xs font-semibold uppercase tracking-widest text-on-surface-variant">Source</h3>
          ${ghUrl ? `<a class="text-[0.65rem] font-medium text-primary-container hover:text-primary flex items-center gap-1 transition-colors" href="${ghUrl}" target="_blank" rel="noopener">Open on GitHub <span class="material-symbols-outlined text-[12px]">open_in_new</span></a>` : ''}
        </div>
        <div class="bg-surface-container-low rounded-lg p-3 border border-outline-variant/20 overflow-x-auto max-h-64 overflow-y-auto">
          <pre class="font-mono text-[0.65rem] text-on-surface-variant leading-relaxed whitespace-pre">${escapeHtml(preview)}</pre>
        </div>
      </section>`;
  }

  html += `</div>`;
  box.innerHTML = html;

  box.querySelectorAll('.edge-item[data-node]').forEach(el => {
    el.addEventListener('click', () => {
      const n = el.getAttribute('data-node');
      focusNode(n);
    });
  });
}

function runQuery(q) {
  const results = $('#results');
  const count = $('#results-count');

  if (!q.trim() || !STATE.graph) {
    results.innerHTML = `
      <div class="flex flex-col items-center justify-center py-8 bg-surface-container-low/50 rounded-lg border border-outline-variant/10 border-dashed">
        <span class="material-symbols-outlined text-[24px] text-on-surface-variant/40 mb-2">account_tree</span>
        <p class="text-xs text-on-surface-variant/60 font-medium text-center px-4">Build a graph to see relationships.</p>
      </div>`;
    count.textContent = '';
    STATE._resultSet = null;
    if (STATE.sigma) STATE.sigma.refresh();
    return;
  }

  const tokens = q.toLowerCase().split(/[^a-z0-9_]+/).filter(t => t.length > 1);
  if (tokens.length === 0) return;

  const scores = new Map();
  STATE.graph.forEachNode((n, a) => {
    if (a.kind === 'repo') return;
    const hay = [
      (a.label || '').toLowerCase(),
      (a.fullLabel || '').toLowerCase(),
      (a.path || '').toLowerCase(),
      (a.symbolName || '').toLowerCase(),
    ].join(' ');
    let score = 0;
    for (const t of tokens) {
      const re = new RegExp(`\\b${escapeRx(t)}\\b`);
      if (re.test(hay)) score += 3;
      else if (hay.includes(t)) score += 1;
      if ((a.label || '').toLowerCase() === t) score += 8;
      if ((a.symbolName || '').toLowerCase() === t) score += 6;
    }
    if (score > 0) {
      if (a.kind === 'function') score *= 1.15;
      if (a.kind === 'class') score *= 1.2;
      if (a.kind === 'dir') score *= 0.8;
      score += Math.log(1 + STATE.graph.degree(n)) * 0.5;
      scores.set(n, score);
    }
  });

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);

  const highlight = new Set();
  for (const [id] of ranked.slice(0, 10)) {
    highlight.add(id);
    STATE.graph.forEachNeighbor(id, n => highlight.add(n));
  }
  STATE._resultSet = highlight;
  count.textContent = ranked.length ? `${ranked.length} matches` : '';

  if (ranked.length === 0) {
    results.innerHTML = `
      <div class="flex flex-col items-center justify-center py-8 bg-surface-container-low/50 rounded-lg border border-outline-variant/10 border-dashed">
        <p class="text-xs text-on-surface-variant/60 font-medium text-center px-4">No matches. Try a simpler term.</p>
      </div>`;
  } else {
    const kindBadge = {
      function: 'text-[#f0b866] bg-[#f0b866]/10',
      class: 'text-[#c58afa] bg-[#c58afa]/10',
      file: 'text-[#89b4fa] bg-[#89b4fa]/10',
      dir: 'text-[#86c888] bg-[#86c888]/10',
    };
    results.innerHTML = ranked.slice(0, 20).map(([id]) => {
      const a = STATE.graph.getNodeAttributes(id);
      const bc = kindBadge[a.kind] || 'text-on-surface-variant bg-surface-container-high';
      return `
        <div class="result-item px-3 py-2 rounded-lg hover:bg-surface-container-low cursor-pointer transition-colors border border-transparent hover:border-outline-variant/10" data-node="${escapeHtml(id)}">
          <div class="flex items-center justify-between gap-2">
            <span class="font-mono text-xs text-on-surface truncate">${escapeHtml(a.label)}</span>
            <span class="text-[0.6rem] px-1.5 py-0.5 rounded-DEFAULT font-mono shrink-0 ${bc}">${escapeHtml(a.kind)}</span>
          </div>
          <div class="font-mono text-[0.65rem] text-on-surface-variant/60 truncate mt-0.5">${escapeHtml(a.path || a.fullLabel || '')}${a.line ? `:${a.line}` : ''}</div>
        </div>`;
    }).join('');
    results.querySelectorAll('.result-item').forEach(el => {
      el.addEventListener('click', () => {
        const n = el.getAttribute('data-node');
        focusNode(n);
      });
    });
  }
  if (STATE.sigma) STATE.sigma.refresh();
}

async function build() {
  const urlA = $('#url-a').value.trim();
  const urlB = $('#url-b').value.trim();
  if (!urlA && !urlB) { setError('Paste at least one repository URL to analyze.'); return; }
  setError(null);

  STATE.token = $('#gh-token').value.trim();
  STATE.maxFiles = parseInt($('#max-files').value, 10);

  $('#btn-build').disabled = true;
  showHero(false);
  showLoader(true);
  $('#canvas-controls').classList.add('rm-hide');
  $('#canvas-legend').classList.add('rm-hide');
  setTopStat({ nodes: 0, edges: 0 });

  try {
    setLoader('Initializing', 'Loading tree-sitter runtime');
    await initTreeSitter();

    const repoUrls = [urlA, urlB].filter(Boolean);
    const repos = [];
    for (let i = 0; i < repoUrls.length; i++) {
      const id = i === 0 ? 'A' : 'B';
      const { owner, name } = parseRepoUrl(repoUrls[i]);
      setLoader('Fetching repository', `${owner}/${name}`);
      const repo = await fetchRepoFiles(owner, name, STATE.maxFiles);
      repo.id = id;
      repos.push(repo);
    }

    setTopStat({
      mode: repos.length > 1
        ? `${repos[0].owner}/${repos[0].name} ↔ ${repos[1].owner}/${repos[1].name}`
        : `${repos[0].owner}/${repos[0].name}`,
    });
    $('#legend-cross').classList.toggle('rm-hide', repos.length < 2);

    let total = repos.reduce((s, r) => s + r.files.length, 0);
    let parsed = 0;
    setLoader('Parsing source', `0 of ${total} files`);
    for (const repo of repos) {
      for (const f of repo.files) {
        try {
          const parser = await loadParser(f.lang);
          const tree = parser.parse(f.content);
          f.parsed = extractSymbols(tree, f.content, f.lang);
          tree.delete();
        } catch (e) {
          console.warn('parse failed', f.path, e);
          f.parsed = { symbols: [], imports: [], calls: [] };
        }
        parsed++;
        if (parsed % 10 === 0) setLoader('Parsing source', `${parsed} of ${total} files`);
      }
    }

    setLoader('Building graph', 'Resolving imports and calls');
    STATE.repos = repos;
    STATE.graph = buildGraph(repos);
    layoutAndRender(STATE.graph);
    $('#stat-mode').querySelector('.material-symbols-outlined').textContent = 'folder_open';
  } catch (e) {
    console.error(e);
    setError(e.message);
    showLoader(false);
    showHero(true);
    setTopStat({ mode: 'No repository loaded' });
  } finally {
    $('#btn-build').disabled = false;
  }
}

$('#btn-build').addEventListener('click', build);

$('#btn-toggle-compare')?.addEventListener('click', () => {
  const wrap = $('#repo-b-wrap');
  const text = $('#compare-toggle-text');
  const icon = $('#btn-toggle-compare').querySelector('.material-symbols-outlined');
  const isHidden = wrap.classList.contains('rm-hide');
  if (isHidden) {
    wrap.classList.remove('rm-hide');
    text.textContent = 'Hide comparison';
    if (icon) icon.textContent = 'remove';
    setTimeout(() => $('#url-b').focus(), 50);
  } else {
    wrap.classList.add('rm-hide');
    $('#url-b').value = '';
    text.textContent = 'Compare with another repo';
    if (icon) icon.textContent = 'add';
  }
});

let qt = null;
$('#q').addEventListener('input', (e) => {
  clearTimeout(qt);
  qt = setTimeout(() => runQuery(e.target.value), 150);
});
$$('.chip').forEach(b => b.addEventListener('click', () => {
  $('#q').value = b.dataset.q;
  runQuery(b.dataset.q);
}));
$$('.f-kind').forEach(cb => cb.addEventListener('change', () => {
  if (STATE.sigma) STATE.sigma.refresh();
}));

$('#btn-zoom-in')?.addEventListener('click', () => STATE.sigma?.getCamera().animatedZoom({ duration: 300 }));
$('#btn-zoom-out')?.addEventListener('click', () => STATE.sigma?.getCamera().animatedUnzoom({ duration: 300 }));
$('#btn-fit')?.addEventListener('click', () => STATE.sigma?.getCamera().animatedReset({ duration: 400 }));
$('#btn-layout')?.addEventListener('click', () => { if (STATE.graph) layoutAndRender(STATE.graph); });
$('#btn-export')?.addEventListener('click', () => {
  if (!STATE.graph) return;
  const data = STATE.graph.export();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'repomind-graph.json'; a.click();
  URL.revokeObjectURL(url);
});

$('#btn-about')?.addEventListener('click', () => $('#about-modal').classList.remove('rm-hide'));
$('#btn-about-close')?.addEventListener('click', () => $('#about-modal').classList.add('rm-hide'));
$('#about-modal')?.addEventListener('click', (e) => {
  if (e.target === $('#about-modal')) $('#about-modal').classList.add('rm-hide');
});

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
    e.preventDefault();
    $('#q').focus();
  }
  if (e.key === 'Escape') {
    if (!$('#about-modal').classList.contains('rm-hide')) {
      $('#about-modal').classList.add('rm-hide');
    } else {
      selectNode(null);
    }
  }
});