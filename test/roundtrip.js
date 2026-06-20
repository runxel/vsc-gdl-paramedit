'use strict';

/**
 * Round-trip-Sicherheitsnetz.
 *
 * Liest ALLE echten paramlist.xml im GDL-Develop-Bereich, parst sie und
 * serialisiert sie zurück. Erfolg = BYTE-IDENTISCH. Erst wenn das 100 %
 * grün ist, darf der Editor echte Dateien anfassen.
 *
 * Aufruf:  node test/roundtrip.js [SUCHWURZEL]
 * Default-Suchwurzel: /Users/Jochen/Documents/1_GDL_DEVELOP
 */

const fs = require('fs');
const path = require('path');
const { parse, serialize } = require('../src/paramlist');

const ROOT = process.argv[2] || '/Users/Jochen/Documents/1_GDL_DEVELOP';

/** Sammelt rekursiv alle .../07_HSF/.../paramlist.xml */
function findParamlists(dir, out) {
	out = out || [];
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (e) {
		return out;
	}
	for (const e of entries) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === '.git' || e.name === 'node_modules') continue;
			findParamlists(full, out);
		} else if (e.isFile() && e.name.toLowerCase() === 'paramlist.xml') {
			out.push(full);
		}
	}
	return out;
}

/** Erstes abweichendes Byte für aussagekräftige Fehlermeldung. */
function firstDiff(a, b) {
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		if (a[i] !== b[i]) return i;
	}
	if (a.length !== b.length) return len;
	return -1;
}

function snippet(buf, pos) {
	const from = Math.max(0, pos - 30);
	const to = Math.min(buf.length, pos + 30);
	return JSON.stringify(buf.slice(from, to).toString('utf8'));
}

function main() {
	const files = findParamlists(ROOT);
	console.log('Gefundene paramlist.xml: ' + files.length + '  (Wurzel: ' + ROOT + ')\n');

	let pass = 0;
	let fail = 0;
	const failures = [];

	for (const file of files) {
		const original = fs.readFileSync(file);
		const text = original.toString('utf8');
		try {
			const doc = parse(text);
			const out = Buffer.from(serialize(doc), 'utf8');
			if (Buffer.compare(original, out) === 0) {
				pass++;
			} else {
				fail++;
				const pos = firstDiff(original, out);
				failures.push({
					file,
					reason:
						'Byte-Unterschied bei Offset ' + pos +
						' (orig ' + original.length + 'B / out ' + out.length + 'B)\n' +
						'      orig: ' + snippet(original, pos) + '\n' +
						'      out : ' + snippet(out, pos),
				});
			}
		} catch (err) {
			fail++;
			failures.push({ file, reason: 'PARSE-FEHLER: ' + err.message });
		}
	}

	for (const f of failures) {
		console.log('✗ ' + path.relative(ROOT, f.file));
		console.log('      ' + f.reason + '\n');
	}

	console.log('────────────────────────────────────────');
	console.log('PASS ' + pass + '   FAIL ' + fail + '   (von ' + files.length + ')');
	process.exit(fail === 0 ? 0 : 1);
}

main();
