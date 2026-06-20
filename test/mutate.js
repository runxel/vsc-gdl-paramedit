'use strict';

/**
 * Beweist die chirurgische Edit-Sicherheit:
 * Eine einzelne Wertänderung ändert NUR genau diesen Bereich; der gesamte
 * Rest des Dokuments (Header, andere Parameter, Whitespace, BOM) bleibt
 * byte-identisch. Außerdem: nach erneutem Parsen ist der neue Wert da.
 *
 * Läuft über die erste paramlist.xml mit editierbaren Werten unter der Wurzel.
 *
 * Aufruf:  node test/mutate.js [SUCHWURZEL]
 */

const fs = require('fs');
const path = require('path');
const P = require('../src/paramlist');

const ROOT = process.argv[2] || '/Users/Jochen/Documents/1_GDL_DEVELOP';

function findParamlists(dir, out) {
	out = out || [];
	let entries;
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
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

/** Anzahl zusammenhängender Unterschiedsregionen zwischen zwei Strings. */
function diffRegions(a, b) {
	const regions = [];
	let i = 0, j = 0;
	const la = a.length, lb = b.length;
	// gemeinsamer Präfix
	let p = 0;
	while (p < Math.min(la, lb) && a[p] === b[p]) p++;
	// gemeinsamer Suffix
	let sa = la - 1, sb = lb - 1;
	while (sa >= p && sb >= p && a[sa] === b[sb]) { sa--; sb--; }
	if (p <= sa || p <= sb || la !== lb) {
		regions.push({ at: p, oldText: a.slice(p, sa + 1), newText: b.slice(p, sb + 1) });
	}
	return regions;
}

let failures = 0;
function check(cond, msg) {
	if (cond) { console.log('  ✓ ' + msg); }
	else { console.log('  ✗ ' + msg); failures++; }
}

function main() {
	const files = findParamlists(ROOT);
	let target = null, original = null, victim = null;

	for (const f of files) {
		const text = fs.readFileSync(f, 'utf8');
		const doc = P.parse(text);
		const params = P.getParameters(doc);
		const v = params.find((p) => p.isValue && p.value !== null && !p.array);
		if (v) { target = f; original = text; victim = v.name; break; }
	}

	if (!target) { console.log('Keine geeignete Testdatei gefunden.'); process.exit(1); }

	console.log('Testdatei: ' + path.relative(ROOT, target));
	console.log('Parameter: ' + victim + '\n');

	// 1) Wert ändern
	const doc = P.parse(original);
	const params = P.getParameters(doc);
	const p = params.find((x) => x.name === victim);
	const oldValue = p.value;
	const newValue = oldValue === '42' ? '43' : '42';
	P.setValue(p.node, newValue);
	const out = P.serialize(doc);

	// 2) Genau EINE Änderungsregion?
	const regions = diffRegions(original, out);
	check(regions.length === 1, 'genau eine zusammenhängende Änderungsregion (gefunden: ' + regions.length + ')');
	if (regions.length === 1) {
		// Erwartete Region: derselbe gemeinsame Prä-/Suffix-Trim wie im Dokument,
		// daher den Wert-Diff identisch trimmen (z.B. "1.2"->"42" teilt das "2").
		const valDiff = diffRegions(oldValue, newValue)[0];
		check(regions[0].oldText === valDiff.oldText,
			'Änderung lokal im Wert (alt ' + JSON.stringify(regions[0].oldText) + ')');
		check(regions[0].newText === valDiff.newText,
			'Änderung lokal im Wert (neu ' + JSON.stringify(regions[0].newText) + ')');
	}

	// 3) Re-Parse liefert neuen Wert, sonst alles gleich
	const doc2 = P.parse(out);
	const p2 = P.getParameters(doc2).find((x) => x.name === victim);
	check(p2 && p2.value === newValue, 'nach Re-Parse ist der neue Wert gesetzt');

	// 4) Zurücksetzen ergibt wieder das Original (byte-identisch)
	P.setValue(p2.node, oldValue);
	check(P.serialize(doc2) === original, 'Zurücksetzen ergibt byte-identisches Original');

	console.log('\n────────────────────────────────────────');
	console.log(failures === 0 ? 'ALLE CHECKS GRÜN' : (failures + ' CHECK(S) FEHLGESCHLAGEN'));
	process.exit(failures === 0 ? 0 : 1);
}

main();
