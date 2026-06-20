'use strict';

/**
 * Sicherheitsnetz für Array-Struktur-Edits.
 *
 * Kern: setArrayDims im Ist-Zustand (gleiche Dimension, gleiche Zellen) muss das
 * Dokument BYTE-IDENTISCH lassen — beweist, dass der Array-Neuaufbau das echte
 * Format (Reihenfolge, Einrückung, CDATA, Attribut-Reihenfolge) exakt trifft.
 * Danach funktionale Checks für Zeile/Spalte hinzufügen/entfernen, anlegen/entfernen.
 *
 * Aufruf:  node test/arrays.js [SUCHWURZEL]
 */

const fs = require('fs');
const path = require('path');
const P = require('../src/paramlist');

const ROOT = process.argv[2] || '/Users/Jochen/Documents/1_GDL_DEVELOP';

function findParamFiles(dir, out) {
	out = out || [];
	let entries;
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
	for (const e of entries) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === '.git' || e.name === 'node_modules') continue;
			findParamFiles(full, out);
		} else if (e.isFile() && /^(paramlist|Parameters)\.xml$/i.test(e.name)) {
			out.push(full);
		}
	}
	return out;
}

let fails = 0;
function check(cond, msg) { if (!cond) { console.log('  ✗ ' + msg); fails++; } }

function main() {
	const files = findParamFiles(ROOT);
	let identityOk = 0, identityTotal = 0;
	let sample2D = null, sample1D = null;

	for (const file of files) {
		const original = fs.readFileSync(file, 'utf8');
		const doc = P.parse(original);
		const arrays = P.getParameters(doc).filter((p) => p.array);
		if (!arrays.length) continue;

		// 1) Zeile am Ende anhängen + wieder entfernen → byte-identisch
		identityTotal++;
		let ok = true;
		for (const a of arrays) {
			const f0 = a.array.first;
			P.addArrayRow(a.node);
			P.removeArrayRow(a.node, f0 + 1);
		}
		if (P.serialize(doc) === original) identityOk++;
		else { ok = false; check(false, 'addRow+removeRow ändert Bytes: ' + path.relative(ROOT, file)); }

		for (const a of arrays) {
			if (!sample2D && a.array.second > 0) sample2D = { file, name: a.name };
			if (!sample1D && a.array.second === 0 && a.array.first >= 2) sample1D = { file, name: a.name };
		}
	}

	// 2) Funktional 1D: hinzufügen erhöht first; eine mittlere Zeile entfernen
	if (sample1D) {
		const doc = P.parse(fs.readFileSync(sample1D.file, 'utf8'));
		const p = P.getParameters(doc).find((x) => x.name === sample1D.name);
		const f0 = p.array.first;
		P.addArrayRow(p.node);
		let re = P.getParameters(P.parse(P.serialize(doc))).find((x) => x.name === sample1D.name);
		check(re.array.first === f0 + 1, '1D: addArrayRow erhöht first (' + f0 + '→' + re.array.first + ')');
		const p2 = P.getParameters(doc).find((x) => x.name === sample1D.name);
		P.removeArrayRow(p2.node, 1);
		re = P.getParameters(P.parse(P.serialize(doc))).find((x) => x.name === sample1D.name);
		check(re.array.first === f0, '1D: removeArrayRow senkt first wieder');
	} else { console.log('  (kein 1D-Array gefunden – Skip)'); }

	// 3) Funktional 2D: Spalte hinzufügen + entfernen
	if (sample2D) {
		const doc = P.parse(fs.readFileSync(sample2D.file, 'utf8'));
		const p = P.getParameters(doc).find((x) => x.name === sample2D.name);
		const s0 = p.array.second;
		P.addArrayCol(p.node);
		let re = P.getParameters(P.parse(P.serialize(doc))).find((x) => x.name === sample2D.name);
		check(re.array.second === s0 + 1, '2D: addArrayCol erhöht second (' + s0 + '→' + re.array.second + ')');
		const p2 = P.getParameters(doc).find((x) => x.name === sample2D.name);
		P.removeArrayCol(p2.node, s0 + 1);
		re = P.getParameters(P.parse(P.serialize(doc))).find((x) => x.name === sample2D.name);
		check(re.array.second === s0, '2D: removeArrayCol senkt second wieder');
	} else { console.log('  (kein 2D-Array gefunden – Skip)'); }

	// 4) Array anlegen / entfernen auf skalarem Parameter (strukturell)
	{
		const file = files.find((f) => P.getParameters(P.parse(fs.readFileSync(f, 'utf8'))).some((p) => p.isValue && !p.array));
		const doc = P.parse(fs.readFileSync(file, 'utf8'));
		const scalar = P.getParameters(doc).find((p) => p.isValue && !p.array);
		const nm = scalar.name;
		P.createArray(scalar.node, 3, 0);
		let re = P.getParameters(P.parse(P.serialize(doc))).find((p) => p.name === nm);
		check(re.array && re.array.first === 3, 'createArray macht 3-Zeilen-Array');
		const p2 = P.getParameters(doc).find((p) => p.name === nm);
		P.removeArray(p2.node);
		re = P.getParameters(P.parse(P.serialize(doc))).find((p) => p.name === nm);
		check(re && !re.array && re.value !== null, 'removeArray macht wieder skalar');
	}

	console.log('\naddRow+removeRow byte-identisch: ' + identityOk + '/' + identityTotal + ' Dateien mit Arrays');
	console.log('────────────────────────────────────────');
	console.log(fails === 0 ? 'ALLE ARRAY-CHECKS GRÜN' : (fails + ' CHECK(S) FEHLGESCHLAGEN'));
	process.exit(fails === 0 ? 0 : 1);
}

main();
