'use strict';

/**
 * Breiter Round-trip-Stresstest.
 *
 * Sucht ALLE .xml-Dateien (über mehrere Wurzeln), die ein <ParamSection>
 * enthalten — also paramlist.xml, Parameters.xml, libpartdata.xml (komplettes
 * dekompiliertes Objekt inkl. Scripte!), XML-Backups, Im-/Exporte usw. — und
 * prüft parse()->serialize() auf BYTE-Identität.
 *
 * Aufruf:  node test/roundtrip-all.js [WURZEL ...]
 */

const fs = require('fs');
const path = require('path');
const { parse, serialize } = require('../src/paramlist');

const ROOTS = process.argv.slice(2);
if (ROOTS.length === 0) {
	ROOTS.push('/Users/Jochen/Documents/1_GDL_DEVELOP');
	ROOTS.push('/Users/Jochen/Sites/localhost/gdl-workbench');
}

function findXml(dir, out) {
	out = out || [];
	let entries;
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
	for (const e of entries) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === '.git' || e.name === 'node_modules') continue;
			findXml(full, out);
		} else if (e.isFile() && e.name.toLowerCase().endsWith('.xml')) {
			out.push(full);
		}
	}
	return out;
}

function firstDiff(a, b) {
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) if (a[i] !== b[i]) return i;
	return a.length !== b.length ? len : -1;
}
function snippet(buf, pos) {
	const from = Math.max(0, pos - 30), to = Math.min(buf.length, pos + 30);
	return JSON.stringify(buf.slice(from, to).toString('utf8'));
}

function main() {
	let candidates = [];
	for (const r of ROOTS) candidates = candidates.concat(findXml(r));

	// nur Dateien mit ParamSection
	const files = candidates.filter((f) => {
		try { return fs.readFileSync(f, 'utf8').includes('<ParamSection'); }
		catch { return false; }
	});

	console.log('XML mit <ParamSection>: ' + files.length + '  (von ' + candidates.length + ' .xml)\n');

	let pass = 0, fail = 0;
	const byName = {};
	const failures = [];

	for (const file of files) {
		const base = path.basename(file);
		byName[base] = byName[base] || { pass: 0, fail: 0 };
		const original = fs.readFileSync(file);
		try {
			const doc = parse(original.toString('utf8'));
			const out = Buffer.from(serialize(doc), 'utf8');
			if (Buffer.compare(original, out) === 0) { pass++; byName[base].pass++; }
			else {
				fail++; byName[base].fail++;
				const pos = firstDiff(original, out);
				failures.push(file + '\n      Byte-Diff @' + pos +
					' (orig ' + original.length + 'B/out ' + out.length + 'B)\n' +
					'      orig: ' + snippet(original, pos) + '\n      out : ' + snippet(out, pos));
			}
		} catch (err) {
			fail++; byName[base].fail++;
			failures.push(file + '\n      PARSE-FEHLER: ' + err.message);
		}
	}

	if (failures.length) {
		console.log('FEHLER:\n');
		for (const f of failures.slice(0, 40)) console.log('✗ ' + f + '\n');
		if (failures.length > 40) console.log('… und ' + (failures.length - 40) + ' weitere\n');
	}

	console.log('Nach Dateiname:');
	for (const [name, s] of Object.entries(byName).sort()) {
		console.log('  ' + (s.fail ? '✗' : '✓') + ' ' + name + ': ' + s.pass + ' ok' + (s.fail ? ', ' + s.fail + ' FAIL' : ''));
	}

	console.log('\n────────────────────────────────────────');
	console.log('PASS ' + pass + '   FAIL ' + fail + '   (von ' + files.length + ')');
	process.exit(fail === 0 ? 0 : 1);
}

main();
