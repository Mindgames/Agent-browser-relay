const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function createFixture(t) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'relay syntax check '));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify(pkg));
  for (const directory of ['extension', 'scripts', 'tests']) {
    fs.mkdirSync(path.join(fixture, directory));
    for (const file of fs.readdirSync(path.join(root, directory))) {
      if (file.endsWith('.js')) {
        fs.writeFileSync(path.join(fixture, directory, file), 'throw new Error("Source must not execute");\n');
      }
    }
  }
  fs.copyFileSync(path.join(root, 'extension/package.json'), path.join(fixture, 'extension/package.json'));
  fs.writeFileSync(path.join(fixture, 'relay-server.js'), 'throw new Error("Source must not execute");\n');
  fs.writeFileSync(path.join(fixture, 'extension/options.js'), 'export const validModule = true;\n');

  const checker = path.join(root, 'scripts/check-syntax.js');
  if (fs.existsSync(checker)) {
    fs.copyFileSync(checker, path.join(fixture, 'scripts/check-syntax.js'));
  }
  for (const directory of ['node_modules', 'scripts/node_modules/dependency']) {
    fs.mkdirSync(path.join(fixture, directory), { recursive: true });
    fs.writeFileSync(path.join(fixture, directory, 'invalid.js'), 'const dependency = ;\n');
  }
  return fixture;
}

function runCheck(command, fixture) {
  return spawnSync(pkg.scripts[command], {
    cwd: fixture,
    shell: true,
    encoding: 'utf8',
    timeout: 20000,
  });
}

for (const command of ['lint', 'build']) {
  test(`${command} checks valid CommonJS and ESM without executing source or checking dependencies`, (t) => {
    const result = runCheck(command, createFixture(t));
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  });

  for (const file of [
    'relay-server.js',
    'extension/popup.js',
    'scripts/sync-extension-version.js',
    'tests/nested/late file.test.js',
  ]) {
    test(`${command} fails for invalid syntax in ${file}`, (t) => {
      const fixture = createFixture(t);
      const target = path.join(fixture, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'const broken = ;\n');

      const result = runCheck(command, fixture);
      assert.ifError(result.error);
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      assert.ok(result.stderr.includes(file.split('/').join(path.sep)), result.stderr);
      assert.match(result.stderr, /SyntaxError/);
    });
  }
}
