import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const rootPkgPath = path.join(root, 'package.json');
const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
const seen = new Map();

function readPackageJson(packageDir) {
  return JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
}

function resolvePackageDir(name, fromDir) {
  const req = createRequire(path.join(fromDir, 'package.json'));
  try {
    return path.dirname(req.resolve(`${name}/package.json`));
  } catch {
    const entry = req.resolve(name);
    let current = path.dirname(entry);
    while (current !== path.dirname(current)) {
      if (fs.existsSync(path.join(current, 'package.json'))) return current;
      current = path.dirname(current);
    }
    throw new Error(`Cannot resolve package.json for ${name} from ${fromDir}`);
  }
}

function buildPackageTree(aliasName, packageDir, optional) {
  const realDir = fs.realpathSync(packageDir);
  const cacheKey = `${aliasName}\0${realDir}`;
  if (seen.has(cacheKey)) return seen.get(cacheKey);

  const pkg = readPackageJson(realDir);
  const node = {
    from: aliasName,
    name: pkg.name || aliasName,
    version: pkg.version || '0.0.0',
    path: realDir,
  };
  seen.set(cacheKey, node);

  const deps = {};
  for (const depName of Object.keys(pkg.dependencies || {})) {
    try {
      deps[depName] = buildPackageTree(depName, resolvePackageDir(depName, realDir), false);
    } catch (err) {
      throw new Error(`${pkg.name || aliasName} dependency ${depName} is missing: ${err.message}`);
    }
  }
  if (Object.keys(deps).length > 0) node.dependencies = deps;

  const optionalDeps = {};
  for (const depName of Object.keys(pkg.optionalDependencies || {})) {
    try {
      optionalDeps[depName] = buildPackageTree(depName, resolvePackageDir(depName, realDir), true);
    } catch {
      // Optional dependencies may be absent for the current platform.
    }
  }
  if (Object.keys(optionalDeps).length > 0) node.optionalDependencies = optionalDeps;
  if (optional) node.optional = true;
  return node;
}

const rootTree = {
  from: rootPkg.name,
  name: rootPkg.name,
  version: rootPkg.version || '0.0.0',
  path: root,
  dependencies: {},
  optionalDependencies: {},
};

for (const depName of Object.keys(rootPkg.dependencies || {})) {
  rootTree.dependencies[depName] = buildPackageTree(depName, resolvePackageDir(depName, root), false);
}

for (const depName of Object.keys(rootPkg.optionalDependencies || {})) {
  try {
    rootTree.optionalDependencies[depName] = buildPackageTree(depName, resolvePackageDir(depName, root), true);
  } catch {
    // Optional dependencies may be absent for the current platform.
  }
}

if (Object.keys(rootTree.dependencies).length === 0) delete rootTree.dependencies;
if (Object.keys(rootTree.optionalDependencies).length === 0) delete rootTree.optionalDependencies;

process.stdout.write(`${JSON.stringify([rootTree])}\n`);
